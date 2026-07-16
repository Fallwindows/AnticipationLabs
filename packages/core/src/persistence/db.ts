import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

/**
 * Local embedded persistence (DECISIONS D-003). The agent core is the source of truth
 * and must survive UI restarts (§3), so everything durable lives here: outcomes,
 * episodes, memory facts, approval tokens, watches, chat, disambiguations, and the
 * append-only audit log. Tests open ':memory:'; restart-survival tests reopen a file.
 *
 * Documents are stored as canonical JSON with the columns that need indexing/querying
 * extracted. The audit table is INSERT-only: no code path updates or deletes rows, and
 * triggers enforce it at the database layer (I11).
 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outcomes (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      owner TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      doc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outcomes_state ON outcomes(state);

    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      ingested_at TEXT NOT NULL,
      doc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_facts (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      expires_at TEXT,
      superseded_by TEXT,
      created_at TEXT NOT NULL,
      doc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_facts_subject ON memory_facts(subject);
    CREATE INDEX IF NOT EXISTS idx_facts_subject_predicate ON memory_facts(subject, predicate);

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      doc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_tokens (
      id TEXT PRIMARY KEY,
      outcome_id TEXT NOT NULL,
      signature_hash TEXT NOT NULL,
      consumed_at TEXT,
      invalidated_at TEXT,
      doc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tokens_outcome ON approval_tokens(outcome_id);

    CREATE TABLE IF NOT EXISTS watches (
      id TEXT PRIMARY KEY,
      outcome_id TEXT NOT NULL,
      state TEXT NOT NULL,
      next_poll_at TEXT NOT NULL,
      doc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watches_due ON watches(state, next_poll_at);

    CREATE TABLE IF NOT EXISTS disambiguations (
      id TEXT PRIMARY KEY,
      resolved_entity_id TEXT,
      doc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      doc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vault_items (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      ciphertext TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      outcome_id TEXT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      disclosure TEXT,
      spoke_to TEXT,
      promised_eta TEXT,
      result TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      signature_hash TEXT,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_outcome ON audit_log(outcome_id);

    CREATE TRIGGER IF NOT EXISTS audit_no_update
      BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS audit_no_delete
      BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

    CREATE TABLE IF NOT EXISTS idempotency_records (
      key TEXT PRIMARY KEY,
      outcome_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      attempted_at TEXT NOT NULL,
      result TEXT
    );
  `);
}
