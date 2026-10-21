import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Event } from 'nostr-tools';
import { ReGBYBroker } from './server.ts';
import { CodeStore } from './store.ts';
import type { Config } from './config.ts';
import type { ReGBYTransport, ReplyTarget } from './nostr.ts';
import type { AuditEntry, AuditSink } from './audit-sender.ts';
import { CODE_TAG, FROM_TAG, TO_TAG, type OutboundIntent } from './protocol.ts';

const BROKER = 'f'.repeat(64);
const MERCHANT = 'a'.repeat(64);
const CUSTOMER = 'c'.repeat(64);
const INVOICE =
  'defito://base/0xabc&amount=USDT:1&order_id=9f2c14ab7e5d4083b6a1cc90de3f7721' +
  '&valid_until=1795219200&nostr=npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef';

interface SentReply {
  target: ReplyTarget;
  intent: OutboundIntent;
  content: string;
  extraTags: readonly string[][];
}

/** Content arrives as plaintext: `decrypt` is the identity, so tests speak the protocol directly. */
class FakeTransport implements ReGBYTransport {
  readonly sent: SentReply[] = [];
  /** Per-recipient delivery outcome; unlisted recipients succeed. */
  readonly deliveredTo = new Map<string, boolean>();
  private onEvent: ((event: Event) => void) | null = null;

  subscribe(onEvent: (event: Event) => void): { close: () => void } {
    this.onEvent = onEvent;
    return { close: () => {} };
  }

  async reply(
    target: ReplyTarget,
    intent: OutboundIntent,
    content: string,
    extraTags: readonly string[][] = [],
  ): Promise<boolean> {
    this.sent.push({ target, intent, content, extraTags });
    return this.deliveredTo.get(target.recipientPubkey) ?? true;
  }

  decrypt(_sender: string, content: string): string {
    return content;
  }

  async purgeExpired(): Promise<void> {}

  close(): void {}

  /** Deliver an inbound event and let the broker finish handling it. */
  async inbound(
    id: string,
    pubkey: string,
    intent: string,
    content: string,
    extraTags: readonly string[][] = [],
  ): Promise<void> {
    assert.ok(this.onEvent, 'broker not started');
    this.onEvent({
      id: id.repeat(64).slice(0, 64),
      pubkey,
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['p', BROKER],
        ['i', intent],
        ...extraTags,
      ],
      content,
      sig: '',
    });
    // Every await in the broker resolves through this fake's promises, which
    // are all microtasks; one macrotask tick drains them.
    await new Promise((r) => setImmediate(r));
  }
}

class MemoryAudit implements AuditSink {
  readonly entries: AuditEntry[] = [];
  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }
  async close(): Promise<void> {}
}

/** Only the limits and timings matter: transport, store and audit are injected. */
const CONFIG: Config = {
  secretKey: new Uint8Array(32),
  publicKey: BROKER,
  relays: [],
  codeTtlSeconds: 60,
  codeRetainSeconds: 3600,
  dbPath: ':memory:',
  eventExpirySeconds: 259_140,
  clockSkewSeconds: 30,
  rateMax: 100,
  rateWindowSeconds: 60,
  redeemRateMax: 100,
  redeemRateWindowSeconds: 60,
  mintRateMax: 100,
  mintRateWindowSeconds: 60,
  redeemFailMax: 10,
  storeMax: 1000,
  blacklistSeconds: 86_400,
  audit: null,
  logLevel: 'error',
};

async function withBroker(
  fn: (transport: FakeTransport, audit: MemoryAudit) => Promise<void>,
  clock?: () => number,
): Promise<void> {
  const transport = new FakeTransport();
  const audit = new MemoryAudit();
  const store = new CodeStore(
    CONFIG.codeTtlSeconds,
    CONFIG.codeRetainSeconds,
    CONFIG.storeMax,
    ':memory:',
    clock,
  );
  const broker = new ReGBYBroker(CONFIG, { transport, store, auditSink: audit });
  broker.start();
  try {
    await fn(transport, audit);
  } finally {
    await broker.stop();
  }
}

/** Mint as the merchant (event 1), returning the issued code (event 2). */
async function mint(transport: FakeTransport, content = INVOICE): Promise<string> {
  await transport.inbound('1', MERCHANT, 'request_regby_code', content);
  const reply = transport.sent.at(-1);
  assert.ok(reply && /^\d{8}$/.test(reply.content), 'no code issued');
  return reply.content;
}

test('a redeem names the merchant to the customer and notifies the merchant', async () => {
  await withBroker(async (transport, audit) => {
    const code = await mint(transport);
    await transport.inbound('3', CUSTOMER, 'request_regby_content', code);

    const [, toCustomer, toMerchant] = transport.sent;
    // Event 4: the invoice, tagged with who it is from.
    assert.deepEqual(toCustomer, {
      target: { recipientPubkey: CUSTOMER, requestEventId: '3'.repeat(64) },
      intent: 'regby_content',
      content: INVOICE,
      extraTags: [[CODE_TAG, code], [FROM_TAG, MERCHANT]],
    });
    // Event 5: the code back to the merchant, on their own request's thread.
    assert.deepEqual(toMerchant, {
      target: { recipientPubkey: MERCHANT, requestEventId: '1'.repeat(64) },
      intent: 'regby_content_delivered',
      content: code,
      extraTags: [[CODE_TAG, code], [TO_TAG, CUSTOMER]],
    });
    assert.deepEqual(
      audit.entries.map((e) => [e.event, e.pubkey, e.delivered]),
      [
        ['code_issued', MERCHANT, true],
        ['redeem', CUSTOMER, true],
        ['merchant_notified', MERCHANT, true],
      ],
    );
  });
});

test('requests need no code tag, and one a client sends is ignored', async () => {
  await withBroker(async (transport) => {
    // A stray tag on the mint changes nothing: a code is still issued.
    await transport.inbound('1', MERCHANT, 'request_regby_code', INVOICE, [[CODE_TAG, '00000000']]);
    const code = transport.sent.at(-1)?.content;
    assert.ok(code && /^\d{8}$/.test(code), 'no code issued');
    // The redeem names the real code only in its content; a tag naming
    // another code must neither be redeemed nor block the real one.
    await transport.inbound('3', CUSTOMER, 'request_regby_content', code, [[CODE_TAG, '12345678']]);
    const reply = transport.sent.find((s) => s.intent === 'regby_content');
    assert.equal(reply?.content, INVOICE);
    assert.deepEqual(reply?.extraTags, [[CODE_TAG, code], [FROM_TAG, MERCHANT]]);
  });
});

test('the merchant is notified even when the customer\'s reply reached no relay', async () => {
  await withBroker(async (transport, audit) => {
    const code = await mint(transport);
    transport.deliveredTo.set(CUSTOMER, false);
    await transport.inbound('3', CUSTOMER, 'request_regby_content', code);
    assert.deepEqual(
      transport.sent.map((r) => r.intent),
      ['regby_code', 'regby_content', 'regby_content_delivered'],
    );
    const redeem = audit.entries.find((e) => e.event === 'redeem');
    assert.equal(redeem?.delivered, false);
  });
});

test('a refused redeem notifies no one and tags only the code', async () => {
  await withBroker(async (transport) => {
    const code = await mint(transport);
    await transport.inbound('3', CUSTOMER, 'request_regby_content', code);
    await transport.inbound('5', CUSTOMER, 'request_regby_content', code); // already redeemed
    const refusal = transport.sent.at(-1);
    assert.equal(refusal?.intent, 'regby_code_already_redeemed');
    assert.equal(refusal?.content, '');
    assert.deepEqual(refusal?.extraTags, [[CODE_TAG, code]]);
    assert.equal(transport.sent.filter((r) => r.intent === 'regby_content_delivered').length, 1);
  });
});

test('empty content runs the same five events, pairing the peers', async () => {
  await withBroker(async (transport, audit) => {
    const code = await mint(transport, '');
    await transport.inbound('3', CUSTOMER, 'request_regby_content', code);
    assert.deepEqual(
      transport.sent.map((r) => [r.intent, r.content, r.extraTags]),
      [
        ['regby_code', code, [[CODE_TAG, code]]],
        ['regby_content', '', [[CODE_TAG, code], [FROM_TAG, MERCHANT]]],
        ['regby_content_delivered', code, [[CODE_TAG, code], [TO_TAG, CUSTOMER]]],
      ],
    );
    assert.deepEqual(
      audit.entries.map((e) => e.event),
      ['code_issued', 'redeem', 'merchant_notified'],
    );
  });
});

test('an unknown code is refused as not found, with empty content', async () => {
  await withBroker(async (transport) => {
    await transport.inbound('3', CUSTOMER, 'request_regby_content', '12345678');
    assert.deepEqual(
      transport.sent.map((r) => [r.intent, r.content, r.extraTags]),
      [['regby_code_not_found', '', [[CODE_TAG, '12345678']]]],
    );
  });
});

test('a locked code is refused with empty content and counts as a guess', async () => {
  // The store's clock only: the merchant's `created_at` (real now) anchors the
  // code, and moving the store past the answer window makes it locked.
  let offset = 0;
  const clock = (): number => Math.floor(Date.now() / 1000) + offset;
  await withBroker(async (transport, audit) => {
    const code = await mint(transport);
    offset = CONFIG.codeRetainSeconds;
    for (let i = 0; i <= CONFIG.redeemFailMax; i++) {
      await transport.inbound(`l${i}`, CUSTOMER, 'request_regby_content', code);
    }
    const refusals = transport.sent.slice(1);
    assert.equal(refusals.length, CONFIG.redeemFailMax);
    for (const r of refusals) assert.deepEqual([r.intent, r.content, r.extraTags], ['regby_code_locked', '', [[CODE_TAG, code]]]);
    assert.equal(audit.entries.at(-1)?.event, 'blacklisted');
  }, clock);
});
