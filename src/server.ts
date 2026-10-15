/**
 * ReGBY broker. Wires the transport, store, and rate limiter together and
 * dispatches inbound events:
 *   request_regby_code    → mint a code, reply `i:regby_code` (content = code,
 *                           or a reason string on failure)
 *   request_regby_content → look up code, reply `i:regby_content` (content =
 *                           the stored content, single-use, or a reason
 *                           string on failure); a successful one also sends
 *                           the merchant `i:regby_content_delivered`
 *                           (content = the code)
 * Content is opaque: never judged here, only carried (see `protocol.ts`).
 * There is no `error` intent - a failure reuses the request's success intent and
 * puts a fixed `REPLY_REASON` in `content`. Every reply links to the request
 * via the `e` tag.
 */
import type { Event } from 'nostr-tools';
import type { Config } from './config.ts';
import { createTransport, type ReGBYTransport, type ReplyTarget } from './nostr.ts';
import {
  RotatingCodeStore,
  type CodeOrigin,
  type CodeStoreLike,
  type RedeemFailureReason,
} from './store.ts';
import { RateLimiter } from './rate-limit.ts';
import { Blacklist } from './blacklist.ts';
import { BoundedMap } from './bounded-map.ts';
import { nowSeconds } from './time.ts';
import {
  CONTENT_DELIVERED_INTENT,
  extractIntent,
  FROM_TAG,
  parseInbound,
  REPLY_INTENT,
  REPLY_REASON,
  TO_TAG,
  type InboundMessage,
  type OutboundIntent,
} from './protocol.ts';
import { HttpAuditSink, NO_AUDIT, type AuditEntry, type AuditSink } from './audit-sender.ts';
import { errorMessage, logger } from './logger.ts';

/** What a call site adds to an audit record; the target supplies the rest. */
type AuditFields = Omit<AuditEntry, 'pubkey' | 'requestEvent'>;

/** Remember processed event ids so a relay re-delivery can't double-mint. */
const SEEN_MAX = 50_000;

/** Reply content per redeem refusal (see `REPLY_REASON` for the app contract). */
const REDEEM_FAILURE_REPLY: Record<RedeemFailureReason, string> = {
  redeemed: REPLY_REASON.redeemed,
  expired: REPLY_REASON.expired,
  'not-found': REPLY_REASON.notFound,
};

/** Collaborators a test can swap; production builds each from `Config`. */
export interface BrokerDeps {
  transport: ReGBYTransport;
  store: CodeStoreLike;
  auditSink: AuditSink;
}

/** Single bucket key for the global (all-sender) limiters. */
const GLOBAL_KEY = 'all';

export class ReGBYBroker {
  private readonly transport: ReGBYTransport;
  private readonly store: CodeStoreLike;
  private readonly limiter: RateLimiter;
  // Aggregate caps across every sender: a per-pubkey limit alone can't bind an
  // attacker who rotates through free, fresh pubkeys (see `Config`).
  private readonly mintLimiter: RateLimiter;
  private readonly redeemLimiter: RateLimiter;
  // Per-sender not-found redeem strikes; exceeding the cap blacklists a guesser.
  private readonly redeemFails: RateLimiter;
  private readonly blacklist: Blacklist;
  private readonly auditSink: AuditSink;
  private readonly seen = new BoundedMap<string, true>(SEEN_MAX);
  private subscription: { close: () => void } | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config,
    deps: Partial<BrokerDeps> = {},
  ) {
    this.transport =
      deps.transport ??
      createTransport(config.secretKey, config.publicKey, config.relays, config.eventExpirySeconds);
    this.store =
      deps.store ??
      new RotatingCodeStore(config.codeTtlSeconds, config.codeRetainSeconds, config.storeMax, config.dbPath);
    this.limiter = new RateLimiter(config.rateMax, config.rateWindowSeconds);
    this.mintLimiter = new RateLimiter(config.mintRateMax, config.mintRateWindowSeconds);
    this.redeemLimiter = new RateLimiter(config.redeemRateMax, config.redeemRateWindowSeconds);
    this.redeemFails = new RateLimiter(config.redeemFailMax, config.redeemRateWindowSeconds);
    this.blacklist = new Blacklist(config.blacklistSeconds);
    this.auditSink = deps.auditSink ?? (config.audit ? new HttpAuditSink(config.audit) : NO_AUDIT);
  }

  start(): void {
    this.subscription = this.transport.subscribe((event) => {
      // A throw past the consume (the code already burnt) must cost this one
      // event, not crash the process for every other merchant and customer.
      this.handleEvent(event).catch((err: unknown) => {
        logger.error('Event handling failed', { id: event.id.slice(0, 12), error: errorMessage(err) });
      });
    });
    // No boot wipe: codes persist in SQLite across restarts, so prior reply
    // events are NOT orphaned and must not be blanket-deleted. Expired replies
    // are still cleaned by the deletion queue (purgeExpired) on the sweep timer.
    // Periodic store/limiter/blacklist hygiene + NIP-09 deletion of our replies.
    this.sweepTimer = setInterval(() => {
      this.store.sweep();
      for (const l of [this.limiter, this.mintLimiter, this.redeemLimiter, this.redeemFails]) {
        l.sweep();
      }
      this.blacklist.sweep();
      void this.transport.purgeExpired();
    }, 60_000);
    this.sweepTimer.unref?.();
    logger.info('Broker started', { pubkey: this.config.publicKey });
  }

  /** Async only for the audit's last flush; everything else closes at once. */
  async stop(): Promise<void> {
    this.subscription?.close();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.transport.close();
    this.store.close();
    await this.auditSink.close();
    logger.info('Broker stopped');
  }

  private markSeen(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.set(id, true); // BoundedMap evicts the oldest id once at capacity.
    return true;
  }

  private async handleEvent(event: Event): Promise<void> {
    // Ignore our own replies and any relay re-delivery of a handled event.
    if (event.pubkey === this.config.publicKey) return;
    if (!this.markSeen(event.id)) return;

    // Blacklisted senders are dropped before any work (decrypt included).
    if (this.blacklist.blocked(event.pubkey)) {
      logger.debug('Dropped event from blacklisted sender', { from: event.pubkey.slice(0, 12) });
      return;
    }

    const intent = extractIntent(event.tags);
    if (intent === null) return;

    if (!this.limiter.allow(event.pubkey)) {
      logger.warn('Rate limited', { from: event.pubkey.slice(0, 12) });
      return;
    }

    let plaintext: string;
    try {
      plaintext = this.transport.decrypt(event.pubkey, event.content);
    } catch {
      logger.debug('Decrypt failed - dropping', { id: event.id.slice(0, 12) });
      return;
    }
    // Raw decrypted inbound content (the sender's content or code). Debug only - sensitive.
    logger.debug('Inbound plaintext', { intent, from: event.pubkey.slice(0, 12), plaintext });

    const target: ReplyTarget = { recipientPubkey: event.pubkey, requestEventId: event.id };
    const parsed = parseInbound(intent, plaintext);
    if (!parsed.ok) {
      if (parsed.reason === 'binary') {
        // Bytes, not text: no reply, nothing stored. Info, not warn: any
        // signer can send bytes, and a flood must not drown the warn log.
        logger.info('Binary content - dropping', {
          id: event.id.slice(0, 12),
          from: event.pubkey.slice(0, 12),
          intent,
        });
        return;
      }
      logger.debug('Unusable content - dropping', { id: event.id.slice(0, 12), intent });
      return;
    }

    await this.dispatch(target, parsed.message, event.created_at);
  }

  /**
   * Clamp a merchant event's `created_at` to the server clock so the code TTL
   * anchor can't be abused: a future-dated stamp (would never expire) snaps to
   * now; a stale stamp is capped to `now - skew`, which `loadConfig` keeps
   * under the TTL so the code is still live when minted. Within tolerance the merchant value passes through, keeping the POS
   * and server countdowns in sync.
   */
  private clampStart(createdAt: number): number {
    const now = nowSeconds();
    const skew = this.config.clockSkewSeconds;
    if (createdAt > now + skew) return now;
    if (createdAt < now - skew) return now - skew;
    return createdAt;
  }

  private async dispatch(
    target: ReplyTarget,
    message: InboundMessage,
    createdAt: number,
  ): Promise<void> {
    const from = target.recipientPubkey.slice(0, 12);
    if (message.intent === 'request_regby_code') {
      // No reply past the ceiling: answering would publish one event per
      // flooded request, the very load the ceiling exists to stop.
      if (!this.mintLimiter.allow(GLOBAL_KEY)) {
        logger.warn('Global mint rate limit hit - dropping', { from });
        return;
      }
      const minted = this.store.mint(message.content, this.clampStart(createdAt), {
        merchantPubkey: target.recipientPubkey,
        requestEvent: target.requestEventId,
      });
      if (!minted) {
        logger.warn('Mint failed (store full / no free code)', { size: this.store.size });
        await this.answer(target, REPLY_INTENT.request_regby_code, REPLY_REASON.busy, {
          event: 'regby_busy',
          content: message.content,
        });
        return;
      }
      logger.info('Minted code', {
        from,
        expiresAt: minted.expiresAt,
      });
      await this.answer(target, REPLY_INTENT.request_regby_code, minted.code, {
        event: 'code_issued',
        code: minted.code,
        content: message.content,
      });
      return;
    }

    // request_regby_content (redeem, single-use). A global ceiling bounds total
    // guess rate regardless of how many pubkeys an attacker rotates through.
    if (!this.redeemLimiter.allow(GLOBAL_KEY)) {
      logger.warn('Global redeem rate limit hit - dropping', {
        from,
      });
      return;
    }

    const result = this.store.redeem(message.code);
    if (!result.ok) {
      // A not-found (as opposed to expired/redeemed) is a miss against the code space -
      // i.e. a guess. Count strikes per sender and blacklist a persistent
      // guesser; return no reply so the failure isn't an enumeration oracle.
      if (result.reason === 'not-found' && !this.redeemFails.allow(target.recipientPubkey)) {
        this.blacklist.block(target.recipientPubkey);
        logger.warn('Blacklisted sender - repeated code guessing', {
          from,
        });
        this.audit(target, { event: 'blacklisted', code: message.code, reason: 'guessing' });
        return;
      }
      logger.info('Redeem rejected', {
        from,
        reason: result.reason,
      });
      await this.answer(
        target,
        REPLY_INTENT.request_regby_content,
        REDEEM_FAILURE_REPLY[result.reason],
        { event: 'redeem_refused', code: message.code, reason: result.reason },
      );
      return;
    }
    logger.info('Redeemed code', { from });
    // Consume-before-publish is the at-most-once order, so a reply no relay
    // took has already burnt the code: the customer's retry is refused and the
    // merchant must re-mint. Surface it, or it looks like user error.
    const delivered = await this.answer(
      target,
      REPLY_INTENT.request_regby_content,
      result.content,
      { event: 'redeem', code: message.code, content: result.content },
      result.origin ? [[FROM_TAG, result.origin.merchantPubkey]] : [],
    );
    if (!delivered) {
      logger.warn('Code consumed but its reply reached no relay', {
        from,
      });
    }
    // After the customer's reply, on purpose: the customer is the one waiting
    // on screen. Sent whether or not that reply landed: the code is burnt
    // either way, and the merchant must know it is gone to re-mint.
    if (result.origin) await this.notifyMerchant(result.origin, message.code, target.recipientPubkey);
  }

  /** Tell the merchant their code was redeemed, on the thread of their own request. */
  private async notifyMerchant(origin: CodeOrigin, code: string, customerPubkey: string): Promise<void> {
    const target: ReplyTarget = {
      recipientPubkey: origin.merchantPubkey,
      requestEventId: origin.requestEvent,
    };
    const delivered = await this.answer(
      target,
      CONTENT_DELIVERED_INTENT,
      code,
      { event: 'merchant_notified', code },
      [[TO_TAG, customerPubkey]],
    );
    if (!delivered) {
      logger.warn('Merchant content-delivered notice reached no relay', {
        to: origin.merchantPubkey.slice(0, 12),
      });
    }
  }

  /**
   * Reply, then record the request with whether the reply reached a relay: one
   * record per answered request (plus one per merchant notice), so a reply no
   * relay took keeps its content and code on record (for a redeem, the code is
   * already burnt).
   */
  private async answer(
    target: ReplyTarget,
    intent: OutboundIntent,
    content: string,
    fields: AuditFields,
    extraTags: readonly string[][] = [],
  ): Promise<boolean> {
    const delivered = await this.transport.reply(target, intent, content, extraTags);
    this.audit(target, { ...fields, delivered });
    return delivered;
  }

  private audit(target: ReplyTarget, fields: AuditFields): void {
    this.auditSink.record({
      ...fields,
      pubkey: target.recipientPubkey,
      requestEvent: target.requestEventId,
    });
  }
}
