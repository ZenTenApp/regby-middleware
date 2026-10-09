import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AUDIT_BATCH_MAX, parseAuditBatch, redactPayload, type AuditRecord } from './audit.ts';
import { auditRecord } from './audit.fixture.ts';
import { MAX_STORED_LENGTH } from './protocol.ts';

test('a well-formed batch parses to its records', () => {
  const records = [auditRecord(), auditRecord({ event: 'blacklisted', delivered: null })];
  assert.deepEqual(parseAuditBatch({ records }), records);
});

test('anything off-contract fails the whole batch', () => {
  const { uri: _uri, ...missing } = auditRecord();
  for (const bad of [
    null,
    [],
    { records: [] },
    { records: Array.from({ length: AUDIT_BATCH_MAX + 1 }, () => auditRecord()) },
    { records: [missing] },
    { records: [{ ...auditRecord(), extra: 1 }] },
    { records: [auditRecord({ event: 'drop_table' as AuditRecord['event'] })] },
    { records: [auditRecord({ pubkey: 'A'.repeat(64) })] },
    { records: [auditRecord({ code: '1234' })] },
    { records: [auditRecord({ uri: 'x'.repeat(MAX_STORED_LENGTH + 1) })] },
    { records: [auditRecord({ ts: -1 })] },
    { records: [auditRecord({ delivered: 'yes' as unknown as boolean })] },
    { records: [auditRecord(), 'not a record'] },
  ]) {
    assert.equal(parseAuditBatch(bad), null, JSON.stringify(bad)?.slice(0, 80));
  }
});

test('a refused payload is reduced to a keyed hash and its length', () => {
  const payload = 'defito://base/0xabc&amount=USDT:5';
  const key = 'k'.repeat(32);
  assert.deepEqual(redactPayload(payload, key), {
    payloadHmac: createHmac('sha256', key).update(payload).digest('hex'),
    payloadLength: payload.length,
  });
  // Without the key, the same payload hashes to something else entirely.
  assert.notEqual(redactPayload(payload, 'x'.repeat(32)).payloadHmac, redactPayload(payload, key).payloadHmac);
});
