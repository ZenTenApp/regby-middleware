import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Event } from 'nostr-tools';
import { ReGBYBroker } from './server.ts';
import { CodeStore } from './store.ts';
import type { Config } from './config.ts';
import type { ReGBYTransport, ReplyOptions, ReplyTarget } from './nostr.ts';
import type { AuditEntry, AuditSink } from './audit-sender.ts';
import { CODE_TAG, FROM_TAG, TO_TAG, type OutboundIntent } from './protocol.ts';

const BROKER = 'f'.repeat(64);
const MERCHANT = 'a'.repeat(64);
const CUSTOMER = 'c'.repeat(64);
const SECOND_CUSTOMER = 'd'.repeat(64);
const INVOICE =
  'defito://base/0xabc&amount=USDT:1&order_id=9f2c14ab7e5d4083b6a1cc90de3f7721' +
  '&valid_until=1795219200&nostr=npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef';

interface SentReply {
  target: ReplyTarget;
  intent: OutboundIntent;
  content: string;
  extraTags: readonly string[][];
  /** Only when the broker set it; otherwise the transport stamps publish time. */
  createdAt?: number;
}

/** Content arrives as plaintext: `decrypt` is the identity, so tests speak the protocol directly. */
class FakeTransport implements ReGBYTransport {
  readonly sent: SentReply[] = [];
  /** Who the broker decrypted content from, in order. */
  readonly decryptedFrom: string[] = [];
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
    { extraTags = [], createdAt }: ReplyOptions = {},
  ): Promise<boolean> {
    this.sent.push({ target, intent, content, extraTags, ...(createdAt === undefined ? {} : { createdAt }) });
    return this.deliveredTo.get(target.recipientPubkey) ?? true;
  }

  decrypt(sender: string, content: string): string {
    this.decryptedFrom.push(sender);
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

  /** A customer's redeem (event 3) as the protocol sends it: empty content, code in its tag. */
  redeem(id: string, pubkey: string, code: string): Promise<void> {
    return this.inbound(id, pubkey, 'request_regby_content', '', [[CODE_TAG, code]]);
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

/**
 * The store's clock: real now, plus an offset a test may move. The merchant's
 * `created_at` (real now) anchors each code, so a fixed clock still mints.
 */
function storeClock(): { now: () => number; at: number; advance: (s: number) => void } {
  const at = Math.floor(Date.now() / 1000);
  let offset = 0;
  return { now: () => at + offset, at, advance: (s) => (offset += s) };
}

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

/**
 * Mint as the merchant (event 1) and return the issued code. Event 2 carries
 * the merchant's own content back; the code is only in its tag.
 */
async function mint(transport: FakeTransport, content = INVOICE): Promise<string> {
  await transport.inbound('1', MERCHANT, 'request_regby_code', content);
  const reply = transport.sent.at(-1);
  assert.equal(reply?.intent, 'regby_code', 'no code issued');
  assert.equal(reply.content, content);
  const code = reply.extraTags.find((t) => t[0] === CODE_TAG)?.[1];
  assert.ok(code && /^\d{8}$/.test(code), 'no code tag');
  assert.deepEqual(reply.extraTags, [[CODE_TAG, code]]);
  return code;
}

test('a redeem names the merchant to the customer and notifies the merchant with the content', async () => {
  const clock = storeClock();
  await withBroker(async (transport, audit) => {
    const code = await mint(transport);
    await transport.redeem('3', CUSTOMER, code);

    const [, toCustomer, toMerchant] = transport.sent;
    // Event 4: the invoice, tagged with who it is from, dated when the store
    // counted the customer.
    assert.deepEqual(toCustomer, {
      target: { recipientPubkey: CUSTOMER, requestEventId: '3'.repeat(64) },
      intent: 'regby_content',
      content: INVOICE,
      extraTags: [[CODE_TAG, code], [FROM_TAG, MERCHANT]],
      createdAt: clock.at,
    });
    // Event 5: the same invoice to the merchant, on their own request's
    // thread, dated a second after event 4 so every client lists it after.
    assert.deepEqual(toMerchant, {
      target: { recipientPubkey: MERCHANT, requestEventId: '1'.repeat(64) },
      intent: 'regby_content_delivered',
      content: INVOICE,
      extraTags: [[CODE_TAG, code], [TO_TAG, CUSTOMER]],
      createdAt: clock.at + 1,
    });
    assert.deepEqual(
      audit.entries.map((e) => [e.event, e.pubkey, e.content, e.delivered]),
      [
        ['code_issued', MERCHANT, INVOICE, true],
        ['redeem', CUSTOMER, INVOICE, true],
        ['merchant_notified', MERCHANT, INVOICE, true],
      ],
    );
  }, clock.now);
});

test('a redeem is read from its code tag alone and never decrypted', async () => {
  await withBroker(async (transport) => {
    // A stray tag on the mint changes nothing: the real code is issued and tagged.
    await transport.inbound('1', MERCHANT, 'request_regby_code', INVOICE, [[CODE_TAG, '00000000']]);
    const code = transport.sent.at(-1)?.extraTags.find((t) => t[0] === CODE_TAG)?.[1];
    assert.ok(code && code !== '00000000' && /^\d{8}$/.test(code), 'no code issued');
    // The code in content with no tag, as old app builds sent it: dropped, no reply.
    await transport.inbound('2', CUSTOMER, 'request_regby_content', code);
    assert.equal(transport.sent.length, 1);
    // The tag is what counts; whatever the content holds is ignored.
    await transport.inbound('3', CUSTOMER, 'request_regby_content', '12345678', [[CODE_TAG, code]]);
    const reply = transport.sent.find((s) => s.intent === 'regby_content');
    assert.equal(reply?.content, INVOICE);
    assert.deepEqual(reply?.extraTags, [[CODE_TAG, code], [FROM_TAG, MERCHANT]]);
    assert.deepEqual(transport.decryptedFrom, [MERCHANT]);
  });
});

test('the merchant is notified even when the customer\'s reply reached no relay', async () => {
  await withBroker(async (transport, audit) => {
    const code = await mint(transport);
    transport.deliveredTo.set(CUSTOMER, false);
    await transport.redeem('3', CUSTOMER, code);
    assert.deepEqual(
      transport.sent.map((r) => r.intent),
      ['regby_code', 'regby_content', 'regby_content_delivered'],
    );
    const redeem = audit.entries.find((e) => e.event === 'redeem');
    assert.equal(redeem?.delivered, false);
  });
});

test('a second customer inside the minute is refused as already redeemed, and the merchant gets a conflict', async () => {
  const clock = storeClock();
  await withBroker(async (transport, audit) => {
    const code = await mint(transport);
    await transport.redeem('3', CUSTOMER, code);
    await transport.redeem('4', SECOND_CUSTOMER, code); // same second
    // The refused customer gets a plain failure; only the merchant is warned.
    const refusal = transport.sent.find((r) => r.target.recipientPubkey === SECOND_CUSTOMER);
    assert.deepEqual(refusal, {
      target: { recipientPubkey: SECOND_CUSTOMER, requestEventId: '4'.repeat(64) },
      intent: 'regby_code_already_redeemed',
      content: '',
      extraTags: [[CODE_TAG, code]],
      createdAt: clock.at,
    });
    // The winner's notice echoes the content and names them; the conflict is
    // bare. Each is dated past its customer's reply, in arrival order.
    const notices = transport.sent.filter((r) => r.target.recipientPubkey === MERCHANT && r.intent !== 'regby_code');
    assert.deepEqual(
      notices.map((r) => [r.intent, r.target.requestEventId, r.content, r.extraTags, r.createdAt]),
      [
        ['regby_content_delivered', '1'.repeat(64), INVOICE, [[CODE_TAG, code], [TO_TAG, CUSTOMER]], clock.at + 1],
        ['regby_conflict', '1'.repeat(64), '', [[CODE_TAG, code]], clock.at + 2],
      ],
    );
    // Only the merchant's own text is recorded as content.
    assert.deepEqual(
      audit.entries.map((e) => [e.event, e.pubkey, e.reason, e.content]),
      [
        ['code_issued', MERCHANT, undefined, INVOICE],
        ['redeem', CUSTOMER, undefined, INVOICE],
        ['merchant_notified', MERCHANT, undefined, INVOICE],
        ['redeem_refused', SECOND_CUSTOMER, 'redeemed', undefined],
        ['merchant_notified', MERCHANT, 'conflict', undefined],
      ],
    );
  }, clock.now);
});

test('the winner asking again is served again; a refused customer is refused again; no second notices', async () => {
  await withBroker(async (transport, audit) => {
    const code = await mint(transport);
    await transport.redeem('3', CUSTOMER, code);
    await transport.redeem('4', SECOND_CUSTOMER, code);
    await transport.redeem('5', CUSTOMER, code); // the winner again
    await transport.redeem('6', SECOND_CUSTOMER, code); // the refused one again
    const answer = (id: string) => transport.sent.find((r) => r.target.requestEventId === id.repeat(64));
    assert.deepEqual(answer('5'), {
      target: { recipientPubkey: CUSTOMER, requestEventId: '5'.repeat(64) },
      intent: 'regby_content',
      content: INVOICE,
      extraTags: [[CODE_TAG, code], [FROM_TAG, MERCHANT]],
    });
    assert.equal(answer('6')?.intent, 'regby_code_already_redeemed');
    assert.deepEqual(
      transport.sent.filter((r) => r.target.recipientPubkey === MERCHANT && r.intent !== 'regby_code').map((r) => r.intent),
      ['regby_content_delivered', 'regby_conflict'],
    );
    const redeems = audit.entries.filter((e) => e.event === 'redeem');
    assert.deepEqual(
      redeems.map((e) => [e.requestEvent, e.reason]),
      [
        ['3'.repeat(64), undefined],
        ['5'.repeat(64), 'repeat'],
      ],
    );
  });
});

test('the winner asking again past the minute is refused as expired', async () => {
  const clock = storeClock();
  await withBroker(async (transport) => {
    const code = await mint(transport);
    await transport.redeem('3', CUSTOMER, code);
    clock.advance(CONFIG.codeTtlSeconds + CONFIG.clockSkewSeconds);
    await transport.redeem('4', CUSTOMER, code);
    assert.equal(transport.sent.at(-1)?.intent, 'regby_code_expired');
  }, clock.now);
});

test('a customer past the minute is refused and the merchant hears nothing', async () => {
  const clock = storeClock();
  await withBroker(async (transport) => {
    const code = await mint(transport);
    await transport.redeem('3', CUSTOMER, code);
    clock.advance(CONFIG.codeTtlSeconds + CONFIG.clockSkewSeconds);
    await transport.redeem('4', SECOND_CUSTOMER, code);
    assert.equal(transport.sent.at(-1)?.intent, 'regby_code_expired');
    assert.equal(transport.sent.filter((r) => r.intent === 'regby_content_delivered').length, 1);
  }, clock.now);
});

test('empty content runs the same five events, pairing the peers', async () => {
  await withBroker(async (transport, audit) => {
    const code = await mint(transport, '');
    await transport.redeem('3', CUSTOMER, code);
    assert.deepEqual(
      transport.sent.map((r) => [r.intent, r.content, r.extraTags]),
      [
        ['regby_code', '', [[CODE_TAG, code]]],
        ['regby_content', '', [[CODE_TAG, code], [FROM_TAG, MERCHANT]]],
        ['regby_content_delivered', '', [[CODE_TAG, code], [TO_TAG, CUSTOMER]]],
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
    await transport.redeem('3', CUSTOMER, '12345678');
    assert.deepEqual(
      transport.sent.map((r) => [r.intent, r.content, r.extraTags]),
      [['regby_code_not_found', '', [[CODE_TAG, '12345678']]]],
    );
  });
});

test('a locked code is refused with empty content and counts as a guess', async () => {
  // The store's clock only: the merchant's `created_at` (real now) anchors the
  // code, and moving the store past the answer window makes it locked. The
  // skew covers a real second ticking over between the clock and the mint.
  const clock = storeClock();
  await withBroker(async (transport, audit) => {
    const code = await mint(transport);
    clock.advance(CONFIG.codeRetainSeconds + CONFIG.clockSkewSeconds);
    for (let i = 0; i <= CONFIG.redeemFailMax; i++) {
      await transport.redeem(`l${i}`, CUSTOMER, code);
    }
    const refusals = transport.sent.slice(1);
    assert.equal(refusals.length, CONFIG.redeemFailMax);
    for (const r of refusals) assert.deepEqual([r.intent, r.content, r.extraTags], ['regby_code_locked', '', [[CODE_TAG, code]]]);
    assert.equal(audit.entries.at(-1)?.event, 'blacklisted');
  }, clock.now);
});
