/**
 * ReGBY broker. Wires the transport, store, and rate limiter together and
 * dispatches inbound events:
 *   request_regby_code    → mint a code, reply `i:regby_code` (content = code,
 *                           or a reason string on failure)
 *   request_regby_content → look up code, reply `i:regby_content` (content =
 *                           uri, single-use, or a reason string on failure)
 * There is no `error` intent - a failure reuses the request's success intent and
 * puts the reason in `content`; the client distinguishes value from error by the
 * content's shape. Every reply links to the request via the `e` tag.
 */
import type { Event } from 'nostr-tools';
import type { Config } from './config.ts';
import { createTransport, type ReGBYTransport, type ReplyTarget } from './nostr.ts';
import { RotatingCodeStore, type CodeStoreLike } from './store.ts';
import { RateLimiter } from './rate-limit.ts';
import { Blacklist } from './blacklist.ts';
import { BoundedMap } from './bounded-map.ts';
import { nowSeconds } from './time.ts';
import { extractIntent, parseInbound, REPLY_INTENT, type InboundMessage } from './protocol.ts';
import { logger } from './logger.ts';

/** Remember processed event ids so a relay re-delivery can't double-mint. */
const SEEN_MAX = 50_000;

/** Single bucket key for the global (all-sender) redeem limiter. */
const GLOBAL_REDEEM_KEY = 'all';

export class ReGBYBroker {
  private readonly transport: ReGBYTransport;
  private readonly store: CodeStoreLike;
  private readonly limiter: RateLimiter;
  // Aggregate redeem cap across every sender - a per-pubkey limit alone can't
  // stop enumeration by an attacker who rotates through free, fresh pubkeys.
  private readonly redeemLimiter: RateLimiter;
  // Per-sender not-found redeem strikes; exceeding the cap blacklists a guesser.
  private readonly redeemFails: RateLimiter;
  private readonly blacklist: Blacklist;
  private readonly seen = new BoundedMap<string, true>(SEEN_MAX);
  private subscription: { close: () => void } | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: Config) {
    this.transport = createTransport(
      config.secretKey,
      config.publicKey,
      config.relays,
      config.eventExpirySeconds,
    );
    this.store = new RotatingCodeStore(
      config.codeTtlSeconds,
      config.codeRetainSeconds,
      config.storeMax,
      config.dbPath,
    );
    this.limiter = new RateLimiter(config.rateMax, config.rateWindowSeconds);
    this.redeemLimiter = new RateLimiter(config.redeemRateMax, config.redeemRateWindowSeconds);
    this.redeemFails = new RateLimiter(config.redeemFailMax, config.redeemRateWindowSeconds);
    this.blacklist = new Blacklist(config.blacklistSeconds);
  }

  start(): void {
    this.subscription = this.transport.subscribe((event) => {
      void this.handleEvent(event);
    });
    // No boot wipe: codes persist in SQLite across restarts, so prior reply
    // events are NOT orphaned and must not be blanket-deleted. Expired replies
    // are still cleaned by the deletion queue (purgeExpired) on the sweep timer.
    // Periodic store/limiter/blacklist hygiene + NIP-09 deletion of our replies.
    this.sweepTimer = setInterval(() => {
      this.store.sweep();
      this.limiter.sweep();
      this.redeemLimiter.sweep();
      this.redeemFails.sweep();
      this.blacklist.sweep();
      void this.transport.purgeExpired();
    }, 60_000);
    this.sweepTimer.unref?.();
    logger.info('Broker started', { pubkey: this.config.publicKey });
  }

  stop(): void {
    this.subscription?.close();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.transport.close();
    this.store.close();
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
    // Raw decrypted inbound content (the URI or code). Debug only - sensitive.
    logger.debug('Inbound plaintext', { intent, from: event.pubkey.slice(0, 12), plaintext });

    const target: ReplyTarget = { recipientPubkey: event.pubkey, requestEventId: event.id };
    const parsed = parseInbound(intent, plaintext);
    if (!parsed.ok) {
      if (parsed.reason === 'silent') {
        logger.debug('Unusable content - dropping', { id: event.id.slice(0, 12), intent });
        return;
      }
      // Both remaining verdicts answer the sender; only `malicious` punishes.
      // A `malformed` payload was `defito://` but omitted a required
      // field, which is a broken client - telling them is the useful response,
      // and a 24 h lockout would just make a POS bug look like an outage.
      if (parsed.reason === 'malicious') {
        // Aiming a foreign scheme at us after proving they hold the
        // conversation key is deliberate. Block the sender and tell them once.
        this.blacklist.block(event.pubkey);
        logger.warn('Blacklisted sender - malicious request_regby_code', {
          from: event.pubkey.slice(0, 12),
        });
      } else {
        logger.info('Rejected malformed request_regby_code', { from: event.pubkey.slice(0, 12) });
      }
      // Neither verdict arises for request_regby_content, so the failure
      // reuses request_regby_code's success intent (`regby_code`); the
      // non-code content reads as an error. `Invalid Request` is one of the
      // four reasons the app will surface verbatim, anything else renders as
      // its generic fallback.
      await this.transport.reply(target, REPLY_INTENT.request_regby_code, 'Invalid Request');
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
      const minted = this.store.mint(message.uri, this.clampStart(createdAt));
      if (!minted) {
        logger.warn('Mint failed (store full / no free code)', { size: this.store.size });
        await this.transport.reply(
          target,
          REPLY_INTENT.request_regby_code,
          'Service Busy, Try Again',
        );
        return;
      }
      logger.info('Minted code', {
        from,
        expiresAt: minted.expiresAt,
      });
      await this.transport.reply(target, REPLY_INTENT.request_regby_code, minted.code);
      return;
    }

    // request_regby_content (redeem, single-use). A global ceiling bounds total
    // guess rate regardless of how many pubkeys an attacker rotates through.
    if (!this.redeemLimiter.allow(GLOBAL_REDEEM_KEY)) {
      logger.warn('Global redeem rate limit hit - dropping', {
        from,
      });
      return;
    }

    const result = this.store.redeem(message.code);
    if (!result.ok) {
      // A not-found (as opposed to expired) is a miss against the code space -
      // i.e. a guess. Count strikes per sender and blacklist a persistent
      // guesser; return no reply so the failure isn't an enumeration oracle.
      if (result.reason === 'not-found' && !this.redeemFails.allow(target.recipientPubkey)) {
        this.blacklist.block(target.recipientPubkey);
        logger.warn('Blacklisted sender - repeated code guessing', {
          from,
        });
        return;
      }
      logger.info('Redeem rejected', {
        from,
        reason: result.reason,
      });
      await this.transport.reply(
        target,
        REPLY_INTENT.request_regby_content,
        result.reason === 'expired' ? 'Code Expired' : 'Code Not Found',
      );
      return;
    }
    logger.info('Redeemed code', { from });
    // Consume-before-publish is the at-most-once order, so a reply no relay
    // took has already burnt the code: the customer's retry reads Code Expired
    // and the merchant must re-mint. Surface it, or it looks like user error.
    const delivered = await this.transport.reply(
      target,
      REPLY_INTENT.request_regby_content,
      result.uri,
    );
    if (!delivered) {
      logger.warn('Code consumed but its reply reached no relay', {
        from,
      });
    }
  }
}
