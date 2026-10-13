/** Test fixture: an on-contract audit record, shared by the sender and sink tests. */
import type { AuditRecord } from './audit.ts';

const HEX = 'a'.repeat(64);

export function auditRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: '0b6d1c7e-3f7a-4c5e-9a3b-2d1e0f9c8b7a',
    ts: 1_700_000_000,
    event: 'code_issued',
    pubkey: HEX,
    requestEvent: HEX,
    code: '12345678',
    content: 'defito://base/0xabc',
    reason: null,
    delivered: true,
    ...overrides,
  };
}
