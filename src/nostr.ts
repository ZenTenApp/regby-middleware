/**
 * Nostr transport: relay pool, NIP-44 encrypt/decrypt, and plink event
 * build/publish. The middleman secret key never leaves this module's closure.
 */
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { finalizeEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import type { Event, Filter } from 'nostr-tools';
import WebSocket from 'ws';
import { PLINK_KIND, INTENT_TAG, INBOUND_INTENTS, type OutboundIntent } from './protocol.ts';
import { DeletionQueue } from './deletion-queue.ts';
import { BoundedMap } from './bounded-map.ts';
import { nowSeconds } from './time.ts';
import { logger } from './logger.ts';

/** NIP-09 deletion request kind. */
const DELETION_KIND = 5;

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

export interface PlinkTransport {
  /** Subscribe to inbound plink events addressed to the middleman. */
  subscribe(onEvent: (event: Event) => void): { close: () => void };
  /** Encrypt + sign + publish a raw-content reply of `intent` to a target. */
  reply(target: ReplyTarget, intent: OutboundIntent, content: string): Promise<void>;
  /** Decrypt an inbound event's content with the sender's conversation key. */
  decrypt(senderPubkey: string, content: string): string;
  /** Publish NIP-09 deletions for our reply events whose expiry has passed. */
  purgeExpired(): Promise<void>;
  close(): void;
}

export function createTransport(
  secretKey: Uint8Array,
  publicKey: string,
  relays: string[],
  eventExpirySeconds: number,
): PlinkTransport {
  const pool = new SimplePool();
  const deletions = new DeletionQueue();

  // Per-peer NIP-44 conversation key — symmetric, so the same key decrypts the
  // inbound event and encrypts the reply. Deriving it is an ECDH op, so cache
  // per peer; the BoundedMap caps the cache so a flood of distinct senders can't
  // grow it without limit.
  const KEY_CACHE_MAX = 10_000;
  const keyCache = new BoundedMap<string, Uint8Array>(KEY_CACHE_MAX);
  const conversationKey = (peerPubkey: string): Uint8Array => {
    const cached = keyCache.get(peerPubkey);
    if (cached) return cached;
    const key = nip44.getConversationKey(secretKey, peerPubkey);
    keyCache.set(peerPubkey, key);
    return key;
  };

  // Publish NIP-09 kind-5 deletions for `ids`, chunked one event per batch.
  const deleteEventIds = async (ids: string[]): Promise<void> => {
    for (let i = 0; i < ids.length; i += MAX_DELETE_REFS) {
      const batch = ids.slice(i, i + MAX_DELETE_REFS);
      const event = finalizeEvent(
        {
          kind: DELETION_KIND,
          created_at: nowSeconds(),
          tags: [['k', String(PLINK_KIND)], ...batch.map((id) => ['e', id])],
          content: 'plink expired',
        },
        secretKey,
      );
      await Promise.allSettled(pool.publish(relays, event));
      logger.debug('Published deletion', { count: batch.length });
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
          kinds: [PLINK_KIND],
          '#p': [publicKey],
          '#i': [...INBOUND_INTENTS],
          since,
        };
        logger[initial ? 'info' : 'debug']('Subscribing', { relays, since });
        return pool.subscribeMany(relays, filter, {
          onevent: onEvent,
          oneose: () => logger.debug('Relays reached end of stored events'),
        });
      };

      let current = openSub(nowSeconds(), true);
      const timer = setInterval(() => {
        const next = openSub(nowSeconds() - OVERLAP_SECONDS, false);
        current.close();
        current = next;
      }, RESUB_INTERVAL_MS);
      timer.unref?.();

      return {
        close: () => {
          clearInterval(timer);
          current.close();
        },
      };
    },

    decrypt(senderPubkey, content) {
      return nip44.decrypt(content, conversationKey(senderPubkey));
    },

    async reply(target, intent, content) {
      // Raw outbound content before encryption (a code/URI value or an error
      // reason — same intent either way). Debug only.
      logger.debug('Outbound plaintext', { intent, to: target.recipientPubkey.slice(0, 12), content });
      const ciphertext = nip44.encrypt(content, conversationKey(target.recipientPubkey));
      const now = nowSeconds();
      const expiresAt = now + eventExpirySeconds;
      const event = finalizeEvent(
        {
          kind: PLINK_KIND,
          created_at: now,
          tags: [
            ['p', target.recipientPubkey],
            ['e', target.requestEventId],
            [INTENT_TAG, intent],
            ['expiration', String(expiresAt)],
          ],
          content: ciphertext,
        },
        secretKey,
      );
      // Track for active NIP-09 deletion once the advisory expiry lapses.
      deletions.add(event.id, expiresAt);
      const results = await Promise.allSettled(pool.publish(relays, event));
      const accepted = results.filter((r) => r.status === 'fulfilled').length;
      logger.debug('Published reply', {
        intent,
        to: target.recipientPubkey.slice(0, 12),
        accepted,
        attempted: relays.length,
      });
      if (accepted === 0) {
        logger.warn('Reply accepted by no relay', { intent });
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
