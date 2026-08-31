/**
 * Nostr transport: relay pool, NIP-04 encrypt/decrypt, and regby event
 * build/publish. The middleman secret key never leaves this module's closure.
 *
 * NIP-04, not NIP-44, and deliberately: regby rides kind 4, and every client on
 * the other side of these relays opens a kind 4 with `nip04.decrypt` and
 * nothing else. One scheme per kind, in both directions — a reply this
 * middleman can encrypt is one the app can read.
 *
 * NIP-04 is unauthenticated (AES-256-CBC, no MAC), so unlike NIP-44 a
 * successful decrypt is NOT evidence of who wrote the ciphertext. Authorship
 * rests entirely on the event signature, which the pool verifies, plus the
 * `p`-tag filter. Nothing here may treat "it decrypted" as "the sender is who
 * they claim".
 */
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { type EventTemplate, finalizeEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { nip04 } from 'nostr-tools';
import type { Event, Filter } from 'nostr-tools';
import WebSocket from 'ws';
import { REGBY_KIND, INTENT_TAG, INBOUND_INTENTS, type OutboundIntent } from './protocol.ts';
import { DeletionQueue } from './deletion-queue.ts';
import { nowSeconds } from './time.ts';
import { logger } from './logger.ts';

/** NIP-09 deletion request kind. */
const DELETION_KIND = 5;

/**
 * The DM relays REJECT any write without a `client` tag
 * (`invalid: missing required tag: client`), so every event we publish carries
 * one. The app tags its own events the same way (`clientTag()` in the app's
 * `config/nostr.ts`).
 */
const CLIENT_TAG: string[] = ['client', 'regby-middleware'];

/** Max `e` refs per deletion event — chunk larger batches across events. */
const MAX_DELETE_REFS = 500;

// nostr-tools' SimplePool needs a WebSocket implementation in Node.
useWebSocketImplementation(WebSocket);

export interface ReplyTarget {
  /** Pubkey to encrypt + address the reply to. */
  recipientPubkey: string;
  /** Event id of the request this reply answers — goes in the `e` tag. */
  requestEventId: string;
}

export interface ReGBYTransport {
  /** Subscribe to inbound regby events addressed to the middleman. */
  subscribe(onEvent: (event: Event) => void): { close: () => void };
  /** Encrypt + sign + publish a raw-content reply of `intent` to a target. */
  reply(target: ReplyTarget, intent: OutboundIntent, content: string): Promise<void>;
  /** Decrypt an inbound event's content with the sender's conversation key. */
  decrypt(senderPubkey: string, content: string): string;
  /** Publish NIP-09 deletions for our reply events whose expiry has passed. */
  purgeExpired(): Promise<void>;
  close(): void;
}

/**
 * Per-relay rejection reasons from a `pool.publish` settle. A relay's OK:false
 * message, an AUTH refusal, or a socket failure all land here — without them an
 * `accepted: 0` publish says nothing about why.
 */
function collectRejections(
  results: PromiseSettledResult<unknown>[],
  relays: string[],
): { relay: string; reason: string }[] {
  return results.flatMap((r, i) =>
    r.status === 'rejected'
      ? [{ relay: relays[i] ?? 'unknown', reason: r.reason instanceof Error ? r.reason.message : String(r.reason) }]
      : [],
  );
}

export function createTransport(
  secretKey: Uint8Array,
  publicKey: string,
  relays: string[],
  eventExpirySeconds: number,
): ReGBYTransport {
  const pool = new SimplePool();
  const deletions = new DeletionQueue();

  // The DM relays gate write (and may gate read) operations behind NIP-42 AUTH.
  // On a relay's `auth-required` challenge, sign its kind-22242 template with the
  // middleman key so publish/subscribe is authorised. Fires only on an actual
  // challenge — an open relay never invokes it, so this is safe if AUTH is off.
  const onauth = (evt: EventTemplate): Promise<VerifiedEvent> =>
    Promise.resolve(finalizeEvent(evt, secretKey));

  // AUTH must complete BEFORE the first REQ/EVENT, not merely be reachable.
  // nostr-tools sends a subscription's REQ (and a publish's EVENT) the moment
  // the socket opens and only auths reactively, when the relay's `AUTH` frame
  // arrives (abstract-relay `case "AUTH"`). The two DM relays refuse an
  // unauthenticated kind-4 read differently, and only one of the refusals is
  // recoverable on its own:
  //   - dm1 (ORLY) CLOSEs the sub with `auth-required:`, which nostr-tools
  //     answers by authing and re-issuing the REQ internally.
  //   - dm2 (nostr-rs-relay) returns a plain EOSE with zero events. No error,
  //     no CLOSED — so nothing tells nostr-tools to redo the REQ and the
  //     subscription stays deaf for the life of that connection.
  // Waiting for the challenge and awaiting `relay.auth` first makes both
  // behave. `connect()` clears `challenge`/`authPromise` per connection and
  // `auth()` returns the in-flight promise, so this is idempotent and cheap
  // once authed.
  const AUTH_WAIT_MS = 3_000;
  const AUTH_POLL_MS = 50;

  // `relay.challenge` is private in nostr-tools' types, so poll `auth()` itself:
  // before the challenge lands it throws "can't perform auth, no challenge was
  // received", which is a retry, not a failure.
  const isMissingChallenge = (err: unknown): boolean =>
    err instanceof Error && err.message.includes('no challenge');

  const authenticateRelay = async (url: string): Promise<void> => {
    const relay = await pool.ensureRelay(url);
    const deadline = Date.now() + AUTH_WAIT_MS;
    for (;;) {
      try {
        await relay.auth(onauth);
        return;
      } catch (err) {
        if (!isMissingChallenge(err)) throw err;
        // Still no challenge by the deadline: an open relay (AUTH never
        // offered) or one too slow. Proceed unauthenticated rather than stall
        // the broker — a gated relay then refuses, and the caller logs it.
        if (Date.now() >= deadline) return;
        await new Promise((resolve) => setTimeout(resolve, AUTH_POLL_MS));
      }
    }
  };

  const ensureAuthed = async (): Promise<void> => {
    const results = await Promise.allSettled(relays.map(authenticateRelay));
    const failures = collectRejections(results, relays);
    if (failures.length > 0) logger.warn('Relay AUTH failed', { failures });
  };

  // No conversation-key cache under NIP-04: `nip04.encrypt`/`decrypt` take the
  // secret key and the peer pubkey and do the ECDH internally, with no API for
  // a precomputed key. That is one ECDH per message rather than one per peer —
  // paid deliberately rather than worked around, since the alternative is
  // assembling the cipher here by hand.

  // Publish NIP-09 kind-5 deletions for `ids`, chunked one event per batch.
  const deleteEventIds = async (ids: string[]): Promise<void> => {
    for (let i = 0; i < ids.length; i += MAX_DELETE_REFS) {
      const batch = ids.slice(i, i + MAX_DELETE_REFS);
      const event = finalizeEvent(
        {
          kind: DELETION_KIND,
          created_at: nowSeconds(),
          tags: [['k', String(REGBY_KIND)], ...batch.map((id) => ['e', id]), CLIENT_TAG],
          content: 'regby expired',
        },
        secretKey,
      );
      await ensureAuthed();
      const results = await Promise.allSettled(pool.publish(relays, event, { onauth }));
      const rejections = collectRejections(results, relays);
      logger.debug('Published deletion', {
        count: batch.length,
        accepted: results.filter((r) => r.status === 'fulfilled').length,
        ...(rejections.length > 0 ? { rejections } : {}),
      });
    }
  };

  return {
    subscribe(onEvent) {
      // A single long-lived REQ goes deaf when a relay drops the idle
      // connection — nostr-tools won't re-establish it. So we re-subscribe on a
      // timer (which re-opens any dropped relay socket). The new REQ uses an
      // overlapping `since` so no event falls in the gap; re-delivered events
      // are filtered by the broker's seen-id set, so the overlap can't
      // double-mint. Open the replacement before closing the old one.
      const RESUB_INTERVAL_MS = 120_000;
      const OVERLAP_SECONDS = Math.floor(RESUB_INTERVAL_MS / 1000) + 15;

      const openSub = (since: number, initial: boolean): { close: () => void } => {
        const filter: Filter = {
          kinds: [REGBY_KIND],
          '#p': [publicKey],
          '#i': [...INBOUND_INTENTS],
          since,
        };
        logger[initial ? 'info' : 'debug']('Subscribing', { relays, since });
        return pool.subscribeMany(relays, filter, {
          onauth,
          onevent: onEvent,
          oneose: () => logger.debug('Relays reached end of stored events'),
        });
      };

      let current: { close: () => void } | null = null;
      let closed = false;

      // `since` is stamped BEFORE the AUTH wait so an event that arrives while
      // we are authenticating is still delivered as a stored event.
      const startedAt = nowSeconds();
      void ensureAuthed().then(() => {
        if (closed) return;
        current = openSub(startedAt, true);
      });

      const timer = setInterval(() => {
        void ensureAuthed().then(() => {
          if (closed) return;
          const next = openSub(nowSeconds() - OVERLAP_SECONDS, false);
          current?.close();
          current = next;
        });
      }, RESUB_INTERVAL_MS);
      timer.unref?.();

      return {
        close: () => {
          closed = true;
          clearInterval(timer);
          current?.close();
        },
      };
    },

    decrypt(senderPubkey, content) {
      // Keyed by the event's author, which the pool has already verified the
      // signature of. A decrypt that succeeds says the ciphertext was written
      // by someone holding the ECDH secret; it is the signature, not this, that
      // says who — see this module's note.
      return nip04.decrypt(secretKey, senderPubkey, content);
    },

    async reply(target, intent, content) {
      // Raw outbound content before encryption (a code/URI value or an error
      // reason — same intent either way). Debug only.
      logger.debug('Outbound plaintext', { intent, to: target.recipientPubkey.slice(0, 12), content });
      const ciphertext = nip04.encrypt(secretKey, target.recipientPubkey, content);
      const now = nowSeconds();
      const expiresAt = now + eventExpirySeconds;
      const event = finalizeEvent(
        {
          kind: REGBY_KIND,
          created_at: now,
          tags: [
            ['p', target.recipientPubkey],
            ['e', target.requestEventId],
            [INTENT_TAG, intent],
            ['expiration', String(expiresAt)],
            CLIENT_TAG,
          ],
          content: ciphertext,
        },
        secretKey,
      );
      // Track for active NIP-09 deletion once the advisory expiry lapses.
      deletions.add(event.id, expiresAt);
      // Same ordering rule as the subscription: a write on these relays is
      // AUTH-gated too, and `publish` neither waits for AUTH nor retries after
      // an `auth-required` OK:false.
      await ensureAuthed();
      const results = await Promise.allSettled(pool.publish(relays, event, { onauth }));
      const accepted = results.filter((r) => r.status === 'fulfilled').length;
      const rejections = collectRejections(results, relays);
      logger.debug('Published reply', {
        intent,
        to: target.recipientPubkey.slice(0, 12),
        accepted,
        attempted: relays.length,
        ...(rejections.length > 0 ? { rejections } : {}),
      });
      if (accepted === 0) {
        // Carry the per-relay reason: a bounced reply is otherwise a silent
        // dead-end for the customer, with no clue whether a relay guard
        // (kind/size/expiry/AUTH/write policy) or a dead socket dropped it.
        logger.warn('Reply accepted by no relay', { intent, rejections });
      }
    },

    async purgeExpired() {
      const due = deletions.takeDue(nowSeconds());
      if (due.length > 0) await deleteEventIds(due);
    },

    close() {
      pool.close(relays);
    },
  };
}
