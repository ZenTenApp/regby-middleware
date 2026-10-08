/**
 * Append-only audit trail of every request the broker ANSWERED: mints, redeems,
 * refusals, blacklistings and replies no relay took. It lives as an `events`
 * table inside the same daily SQLite file as the codes, so it rotates with
 * them, and unlike the `codes` table nothing ever deletes or rewrites a row -
 * the daily files are the permanent history.
 *
 * It deliberately keeps the FULL invoice and FULL pubkeys, so merchant and
 * customer activity can be reconstructed across days. That is the opposite
 * trade from the `codes` table, which wipes an invoice once served: the code
 * table governs what can be redeemed, this one is the record of what was.
 *
 * Not recorded: events dropped before any work (blacklisted sender, rate
 * limited, undecryptable, unusable content). Those are attacker-controlled
 * volume, and logging them would turn the audit trail into a disk-filling
 * vector.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { validUntilOf } from './protocol.ts';

export type AuditEvent =
  | 'mint'
  | 'mint_busy'
  | 'redeem'
  | 'redeem_expired'
  | 'redeem_not_found'
  | 'invalid_request'
  | 'blacklisted'
  | 'reply_dropped';

export interface AuditEntry {
  event: AuditEvent;
  /** Full hex pubkey of the sender the event concerns. */
  pubkey: string;
  /** Id of the inbound Nostr event this row answers. */
  requestEvent: string;
  code?: string | undefined;
  /** Full invoice payload (mint, refused request, redeem). */
  uri?: string | undefined;
  /** Reason or extra context, e.g. `malformed`, `guessing`, a reply intent. */
  detail?: string | undefined;
}

export class AuditLog {
  private readonly insertStmt: StatementSync;

  constructor(
    db: DatabaseSync,
    private readonly now: () => number,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,
        event         TEXT NOT NULL,
        pubkey        TEXT NOT NULL,
        request_event TEXT NOT NULL,
        code          TEXT,
        uri           TEXT,
        valid_until   INTEGER,
        detail        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_code ON events(code);
      CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey);
    `);
    this.insertStmt = db.prepare(
      'INSERT INTO events (ts, event, pubkey, request_event, code, uri, valid_until, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
  }

  record(entry: AuditEntry): void {
    this.insertStmt.run(
      this.now(),
      entry.event,
      entry.pubkey,
      entry.requestEvent,
      entry.code ?? null,
      entry.uri ?? null,
      entry.uri === undefined ? null : validUntilOf(entry.uri),
      entry.detail ?? null,
    );
  }
}
