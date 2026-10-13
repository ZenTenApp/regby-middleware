import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_BATCH_MAX, parseAuditBatch, type AuditRecord } from './audit.ts';
import { auditRecord } from './audit.fixture.ts';
import { MAX_CONTENT_LENGTH } from './protocol.ts';

test('a well-formed batch parses to its records', () => {
  const records = [auditRecord(), auditRecord({ event: 'blacklisted', delivered: null })];
  assert.deepEqual(parseAuditBatch({ records }), records);
});

test('anything off-contract fails the whole batch', () => {
  const { content: _content, ...missing } = auditRecord();
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
    { records: [auditRecord({ content: 'x'.repeat(MAX_CONTENT_LENGTH + 1) })] },
    { records: [auditRecord({ ts: -1 })] },
    { records: [auditRecord({ delivered: 'yes' as unknown as boolean })] },
    { records: [auditRecord(), 'not a record'] },
  ]) {
    assert.equal(parseAuditBatch(bad), null, JSON.stringify(bad)?.slice(0, 80));
  }
});

test('a batch in the pre-content shape is mapped, not rejected, so a deploy loses nothing', () => {
  const { content, reason, ...rest } = auditRecord({ event: 'redeem_refused', reason: 'expired', content: null });
  const legacy = { ...rest, uri: content, detail: reason, validUntil: null, payloadHmac: null, payloadLength: null };
  const refused = { ...rest, event: 'invalid_request', uri: null, detail: 'malformed', validUntil: null, payloadHmac: 'b'.repeat(64), payloadLength: 42 };
  assert.deepEqual(parseAuditBatch({ records: [legacy, refused] }), [
    { ...rest, content: null, reason: 'expired' },
    { ...rest, event: 'invalid_request', content: null, reason: 'malformed' },
  ]);
  // Still validated after mapping: a legacy record with a bad field fails the batch.
  assert.equal(parseAuditBatch({ records: [{ ...legacy, pubkey: 'nope' }] }), null);
});
