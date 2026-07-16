import type { Db } from './db.js';
import type {
  ApprovalToken,
  AuditEntry,
  DisambiguationRequest,
  Entity,
  Episode,
  MemoryFact,
  Outcome,
  Watch,
} from '../domain/types.js';
import type { ChatMessage } from '../util/events.js';
import { canonicalJson } from '../util/canonical.js';

/**
 * Thin typed repositories over SQLite. Documents round-trip as canonical JSON;
 * queryable columns are kept in sync on every write.
 */

export class OutcomeRepo {
  constructor(private db: Db) {}

  save(o: Outcome): void {
    this.db
      .prepare(
        `INSERT INTO outcomes (id, state, owner, updated_at, doc) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state=excluded.state, owner=excluded.owner,
           updated_at=excluded.updated_at, doc=excluded.doc`,
      )
      .run(o.id, o.state, o.owner, o.updatedAt, canonicalJson(o));
  }

  get(id: string): Outcome | undefined {
    const row = this.db.prepare('SELECT doc FROM outcomes WHERE id = ?').get(id) as
      | { doc: string }
      | undefined;
    return row ? (JSON.parse(row.doc) as Outcome) : undefined;
  }

  all(): Outcome[] {
    const rows = this.db.prepare('SELECT doc FROM outcomes ORDER BY rowid').all() as {
      doc: string;
    }[];
    return rows.map((r) => JSON.parse(r.doc) as Outcome);
  }

  byState(state: string): Outcome[] {
    const rows = this.db
      .prepare('SELECT doc FROM outcomes WHERE state = ? ORDER BY rowid')
      .all(state) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as Outcome);
  }
}

export class EpisodeRepo {
  constructor(private db: Db) {}

  save(e: Episode): void {
    this.db
      .prepare(
        `INSERT INTO episodes (id, ingested_at, doc) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ingested_at=excluded.ingested_at, doc=excluded.doc`,
      )
      .run(e.id, e.ingestedAt, canonicalJson(e));
  }

  get(id: string): Episode | undefined {
    const row = this.db.prepare('SELECT doc FROM episodes WHERE id = ?').get(id) as
      | { doc: string }
      | undefined;
    return row ? (JSON.parse(row.doc) as Episode) : undefined;
  }
}

export class MemoryFactRepo {
  constructor(private db: Db) {}

  save(f: MemoryFact): void {
    this.db
      .prepare(
        `INSERT INTO memory_facts (id, subject, predicate, sensitivity, expires_at, superseded_by, created_at, doc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET subject=excluded.subject, predicate=excluded.predicate,
           sensitivity=excluded.sensitivity, expires_at=excluded.expires_at,
           superseded_by=excluded.superseded_by, created_at=excluded.created_at, doc=excluded.doc`,
      )
      .run(
        f.id,
        f.subject,
        f.predicate,
        f.sensitivity,
        f.expiresAt ?? null,
        f.supersededBy ?? null,
        f.createdAt,
        canonicalJson(f),
      );
  }

  get(id: string): MemoryFact | undefined {
    const row = this.db.prepare('SELECT doc FROM memory_facts WHERE id = ?').get(id) as
      | { doc: string }
      | undefined;
    return row ? (JSON.parse(row.doc) as MemoryFact) : undefined;
  }

  all(): MemoryFact[] {
    const rows = this.db.prepare('SELECT doc FROM memory_facts ORDER BY rowid').all() as {
      doc: string;
    }[];
    return rows.map((r) => JSON.parse(r.doc) as MemoryFact);
  }

  bySubject(subject: string): MemoryFact[] {
    const rows = this.db
      .prepare('SELECT doc FROM memory_facts WHERE subject = ? ORDER BY rowid')
      .all(subject) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as MemoryFact);
  }
}

export class EntityRepo {
  constructor(private db: Db) {}

  save(e: Entity): void {
    this.db
      .prepare(
        `INSERT INTO entities (id, type, doc) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET type=excluded.type, doc=excluded.doc`,
      )
      .run(e.id, e.type, canonicalJson(e));
  }

  get(id: string): Entity | undefined {
    const row = this.db.prepare('SELECT doc FROM entities WHERE id = ?').get(id) as
      | { doc: string }
      | undefined;
    return row ? (JSON.parse(row.doc) as Entity) : undefined;
  }

  all(): Entity[] {
    const rows = this.db.prepare('SELECT doc FROM entities ORDER BY rowid').all() as {
      doc: string;
    }[];
    return rows.map((r) => JSON.parse(r.doc) as Entity);
  }
}

export class ApprovalTokenRepo {
  constructor(private db: Db) {}

  save(t: ApprovalToken): void {
    this.db
      .prepare(
        `INSERT INTO approval_tokens (id, outcome_id, signature_hash, consumed_at, invalidated_at, doc)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET outcome_id=excluded.outcome_id,
           signature_hash=excluded.signature_hash, consumed_at=excluded.consumed_at,
           invalidated_at=excluded.invalidated_at, doc=excluded.doc`,
      )
      .run(
        t.id,
        t.outcomeId,
        t.signatureHash,
        t.consumedAt ?? null,
        t.invalidatedAt ?? null,
        canonicalJson(t),
      );
  }

  get(id: string): ApprovalToken | undefined {
    const row = this.db.prepare('SELECT doc FROM approval_tokens WHERE id = ?').get(id) as
      | { doc: string }
      | undefined;
    return row ? (JSON.parse(row.doc) as ApprovalToken) : undefined;
  }

  byOutcome(outcomeId: string): ApprovalToken[] {
    const rows = this.db
      .prepare('SELECT doc FROM approval_tokens WHERE outcome_id = ? ORDER BY rowid')
      .all(outcomeId) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as ApprovalToken);
  }

  all(): ApprovalToken[] {
    const rows = this.db.prepare('SELECT doc FROM approval_tokens ORDER BY rowid').all() as {
      doc: string;
    }[];
    return rows.map((r) => JSON.parse(r.doc) as ApprovalToken);
  }
}

export class WatchRepo {
  constructor(private db: Db) {}

  save(w: Watch): void {
    this.db
      .prepare(
        `INSERT INTO watches (id, outcome_id, state, next_poll_at, doc) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET outcome_id=excluded.outcome_id, state=excluded.state,
           next_poll_at=excluded.next_poll_at, doc=excluded.doc`,
      )
      .run(w.id, w.outcomeId, w.state, w.nextPollAt, canonicalJson(w));
  }

  get(id: string): Watch | undefined {
    const row = this.db.prepare('SELECT doc FROM watches WHERE id = ?').get(id) as
      | { doc: string }
      | undefined;
    return row ? (JSON.parse(row.doc) as Watch) : undefined;
  }

  all(): Watch[] {
    const rows = this.db.prepare('SELECT doc FROM watches ORDER BY rowid').all() as {
      doc: string;
    }[];
    return rows.map((r) => JSON.parse(r.doc) as Watch);
  }

  due(nowIso: string): Watch[] {
    const rows = this.db
      .prepare(
        `SELECT doc FROM watches WHERE state = 'active' AND next_poll_at <= ? ORDER BY next_poll_at`,
      )
      .all(nowIso) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as Watch);
  }

  /** Active watches whose timeout has passed — loads only active rows, not all history. */
  activeTimedOut(nowIso: string): Watch[] {
    const rows = this.db
      .prepare(`SELECT doc FROM watches WHERE state = 'active' ORDER BY rowid`)
      .all() as { doc: string }[];
    return rows
      .map((r) => JSON.parse(r.doc) as Watch)
      .filter((w) => w.timeoutAt !== undefined && w.timeoutAt <= nowIso);
  }
}

export class DisambiguationRepo {
  constructor(private db: Db) {}

  save(d: DisambiguationRequest): void {
    this.db
      .prepare(
        `INSERT INTO disambiguations (id, resolved_entity_id, doc) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET resolved_entity_id=excluded.resolved_entity_id, doc=excluded.doc`,
      )
      .run(d.id, d.resolvedEntityId ?? null, canonicalJson(d));
  }

  get(id: string): DisambiguationRequest | undefined {
    const row = this.db.prepare('SELECT doc FROM disambiguations WHERE id = ?').get(id) as
      | { doc: string }
      | undefined;
    return row ? (JSON.parse(row.doc) as DisambiguationRequest) : undefined;
  }

  all(): DisambiguationRequest[] {
    const rows = this.db.prepare('SELECT doc FROM disambiguations ORDER BY rowid').all() as {
      doc: string;
    }[];
    return rows.map((r) => JSON.parse(r.doc) as DisambiguationRequest);
  }
}

export class ChatRepo {
  constructor(private db: Db) {}

  save(m: ChatMessage): void {
    this.db
      .prepare(
        `INSERT INTO chat_messages (id, at, doc) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET at=excluded.at, doc=excluded.doc`,
      )
      .run(m.id, m.at, canonicalJson(m));
  }

  all(): ChatMessage[] {
    const rows = this.db.prepare('SELECT doc FROM chat_messages ORDER BY rowid').all() as {
      doc: string;
    }[];
    return rows.map((r) => JSON.parse(r.doc) as ChatMessage);
  }
}

export class IdempotencyRepo {
  constructor(private db: Db) {}

  /** Returns false if the key was already recorded (i.e. an attempt already happened). */
  recordAttempt(key: string, outcomeId: string, actionType: string, atIso: string): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO idempotency_records (key, outcome_id, action_type, attempted_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`,
      )
      .run(key, outcomeId, actionType, atIso);
    return res.changes === 1;
  }

  recordResult(key: string, result: string): void {
    this.db
      .prepare('UPDATE idempotency_records SET result = ? WHERE key = ?')
      .run(result, key);
  }

  get(key: string):
    | { key: string; outcomeId: string; actionType: string; attemptedAt: string; result: string | null }
    | undefined {
    const row = this.db
      .prepare(
        'SELECT key, outcome_id, action_type, attempted_at, result FROM idempotency_records WHERE key = ?',
      )
      .get(key) as
      | { key: string; outcome_id: string; action_type: string; attempted_at: string; result: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      key: row.key,
      outcomeId: row.outcome_id,
      actionType: row.action_type,
      attemptedAt: row.attempted_at,
      result: row.result,
    };
  }
}

export interface AuditRow {
  entry: Omit<AuditEntry, 'seq'>;
}

export class AuditRepo {
  constructor(private db: Db) {}

  lastHash(): string {
    const row = this.db
      .prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1')
      .get() as { hash: string } | undefined;
    return row?.hash ?? 'genesis';
  }

  append(entry: Omit<AuditEntry, 'seq'>): AuditEntry {
    const res = this.db
      .prepare(
        `INSERT INTO audit_log (id, outcome_id, actor, action, target, disclosure, spoke_to,
           promised_eta, result, timestamp, signature_hash, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.outcomeId ?? null,
        entry.actor,
        entry.action,
        entry.target ?? null,
        entry.disclosure ?? null,
        entry.spokeTo ?? null,
        entry.promisedETA ?? null,
        entry.result,
        entry.timestamp,
        entry.signatureHash ?? null,
        entry.prevHash,
        entry.hash,
      );
    return { ...entry, seq: Number(res.lastInsertRowid) };
  }

  private rowToEntry(r: AuditDbRow): AuditEntry {
    return {
      seq: r.seq,
      id: r.id,
      outcomeId: r.outcome_id ?? undefined,
      actor: r.actor,
      action: r.action,
      target: r.target ?? undefined,
      disclosure: r.disclosure ?? undefined,
      spokeTo: r.spoke_to ?? undefined,
      promisedETA: r.promised_eta ?? undefined,
      result: r.result,
      timestamp: r.timestamp,
      signatureHash: r.signature_hash ?? undefined,
      prevHash: r.prev_hash,
      hash: r.hash,
    };
  }

  all(): AuditEntry[] {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY seq').all() as AuditDbRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  byOutcome(outcomeId: string): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_log WHERE outcome_id = ? ORDER BY seq')
      .all(outcomeId) as AuditDbRow[];
    return rows.map((r) => this.rowToEntry(r));
  }
}

interface AuditDbRow {
  seq: number;
  id: string;
  outcome_id: string | null;
  actor: string;
  action: string;
  target: string | null;
  disclosure: string | null;
  spoke_to: string | null;
  promised_eta: string | null;
  result: string;
  timestamp: string;
  signature_hash: string | null;
  prev_hash: string;
  hash: string;
}
