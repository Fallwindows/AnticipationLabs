import type { FactSource, MemoryFact, Sensitivity } from '../domain/types.js';
import type { Clock } from '../util/clock.js';
import type { IdSource } from '../util/ids.js';
import type { EventBus } from '../util/events.js';
import { MemoryFactRepo } from '../persistence/repos.js';

export interface FactWrite {
  subject: string;
  predicate: string;
  value: string;
  source: FactSource;
  confidence: number;
  sensitivity?: Sensitivity;
  /** absolute expiry, e.g. hotel checkout for the room number (I12) */
  expiresAt?: string;
  /** if set, this fact supersedes the given fact id (correction, later statement — I2) */
  supersedes?: string;
}

export interface FactQuery {
  subject?: string;
  predicate?: string;
  /** include facts that are superseded or expired (inspector wants the full chain) */
  includeInactive?: boolean;
}

/**
 * Memory store (§5.2, I12). Every fact carries source, confidence, sensitivity and an
 * optional TTL. Facts are never deleted — they are superseded (keeping the chain
 * inspectable) or they expire. `promptView` is the ONLY surface prompt assembly may
 * read: it strips high-sensitivity facts and vault references entirely.
 */
export class MemoryStore {
  constructor(
    private repo: MemoryFactRepo,
    private clock: Clock,
    private ids: IdSource,
    private events: EventBus,
  ) {}

  add(write: FactWrite): MemoryFact {
    if (write.sensitivity === 'vault-ref' && !write.value.startsWith('vault:')) {
      throw new Error('vault-ref facts must store a vault pointer, never a raw value');
    }
    // Re-interpreting a whole episode re-emits its facts (I2); an identical active
    // fact is returned rather than duplicated.
    const existing = this.query({ subject: write.subject, predicate: write.predicate }).find(
      (f) => f.value === write.value,
    );
    if (existing && !write.supersedes) return existing;
    const fact: MemoryFact = {
      id: this.ids.next('fact'),
      subject: write.subject,
      predicate: write.predicate,
      value: write.value,
      source: write.source,
      confidence: write.confidence,
      sensitivity: write.sensitivity ?? 'normal',
      // normalized to UTC so expiry string comparisons are timezone-proof
      expiresAt: write.expiresAt ? new Date(write.expiresAt).toISOString() : undefined,
      createdAt: this.clock.now().toISOString(),
    };
    this.repo.save(fact);
    if (write.supersedes) {
      const prior = this.repo.get(write.supersedes);
      if (prior && !prior.supersededBy) {
        this.repo.save({ ...prior, supersededBy: fact.id });
        this.events.emit({
          type: 'memory.fact.superseded',
          factId: prior.id,
          supersededBy: fact.id,
        });
      }
    }
    this.events.emit({ type: 'memory.fact.added', factId: fact.id });
    return fact;
  }

  /**
   * Convenience for corrections: ONE new fact supersedes every current active fact
   * with the same subject+predicate (the cracked POT, not the plant; "Fridays after
   * two", not Tuesdays — I2).
   */
  correct(write: FactWrite): MemoryFact {
    const existing = this.query({ subject: write.subject, predicate: write.predicate });
    const first = existing[0];
    if (!first) {
      return this.add(write);
    }
    const fact = this.add({ ...write, supersedes: first.id });
    for (const prior of existing.slice(1)) {
      const row = this.repo.get(prior.id);
      if (row && !row.supersededBy) {
        this.repo.save({ ...row, supersededBy: fact.id });
        this.events.emit({ type: 'memory.fact.superseded', factId: row.id, supersededBy: fact.id });
      }
    }
    return fact;
  }

  get(id: string): MemoryFact | undefined {
    return this.repo.get(id);
  }

  private isActive(f: MemoryFact, nowIso: string): boolean {
    if (f.supersededBy) return false;
    if (f.expiresAt && f.expiresAt <= nowIso) return false;
    return true;
  }

  query(q: FactQuery = {}): MemoryFact[] {
    const nowIso = this.clock.now().toISOString();
    let facts = q.subject ? this.repo.bySubject(q.subject) : this.repo.all();
    if (q.predicate) facts = facts.filter((f) => f.predicate === q.predicate);
    if (!q.includeInactive) facts = facts.filter((f) => this.isActive(f, nowIso));
    return facts;
  }

  /** Single active value for subject+predicate (highest confidence wins ties). */
  lookup(subject: string, predicate: string): MemoryFact | undefined {
    const facts = this.query({ subject, predicate });
    return facts.sort((a, b) => b.confidence - a.confidence)[0];
  }

  /**
   * The redaction view (§5.2): the only memory surface prompt assembly may use.
   * Excludes superseded and expired facts, and anything 'high' or 'vault-ref' —
   * vault values can never leak into a model prompt because they were never here
   * to begin with, and even the pointers are stripped (I12).
   */
  promptView(q: FactQuery = {}): MemoryFact[] {
    return this.query(q).filter(
      (f) => f.sensitivity !== 'high' && f.sensitivity !== 'vault-ref',
    );
  }

  /** Render the prompt view as lines for prompt assembly. */
  promptLines(q: FactQuery = {}): string[] {
    return this.promptView(q).map(
      (f) => `${f.subject} ${f.predicate} ${f.value} (confidence ${f.confidence.toFixed(2)})`,
    );
  }

  /** Full chain for the inspector panel, including superseded/expired facts. */
  inspect(): MemoryFact[] {
    return this.query({ includeInactive: true });
  }
}
