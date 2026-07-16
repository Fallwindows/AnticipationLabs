import type { AuditEntry } from '../domain/types.js';
import type { Clock } from '../util/clock.js';
import type { IdSource } from '../util/ids.js';
import type { EventBus } from '../util/events.js';
import { AuditRepo } from '../persistence/repos.js';
import { canonicalJson, sha256Hex } from '../util/canonical.js';

export interface AuditWrite {
  outcomeId?: string;
  actor: string;
  action: string;
  target?: string;
  disclosure?: string;
  spokeTo?: string;
  promisedETA?: string;
  result: string;
  signatureHash?: string;
}

/**
 * Append-only audit log (I11). Rows are hash-chained (each row's hash covers the
 * previous row's hash), and the underlying table has triggers that abort UPDATE and
 * DELETE — immutability is a database property, not a convention.
 */
export class AuditLog {
  constructor(
    private repo: AuditRepo,
    private clock: Clock,
    private ids: IdSource,
    private events: EventBus,
  ) {}

  append(write: AuditWrite): AuditEntry {
    const prevHash = this.repo.lastHash();
    const body = {
      id: this.ids.next('audit'),
      ...write,
      timestamp: this.clock.now().toISOString(),
      prevHash,
    };
    const hash = sha256Hex(prevHash + canonicalJson({ ...body, hash: undefined }));
    const entry = this.repo.append({ ...body, hash });
    this.events.emit({ type: 'audit.appended', entryId: entry.id, outcomeId: entry.outcomeId });
    return entry;
  }

  all(): AuditEntry[] {
    return this.repo.all();
  }

  byOutcome(outcomeId: string): AuditEntry[] {
    return this.repo.byOutcome(outcomeId);
  }

  /** Verifies the hash chain end-to-end; returns the first broken seq or null. */
  verifyChain(): number | null {
    let prev = 'genesis';
    for (const e of this.repo.all()) {
      const expected = sha256Hex(
        prev +
          canonicalJson({
            id: e.id,
            outcomeId: e.outcomeId,
            actor: e.actor,
            action: e.action,
            target: e.target,
            disclosure: e.disclosure,
            spokeTo: e.spokeTo,
            promisedETA: e.promisedETA,
            result: e.result,
            signatureHash: e.signatureHash,
            timestamp: e.timestamp,
            prevHash: e.prevHash,
            hash: undefined,
          }),
      );
      if (e.prevHash !== prev || e.hash !== expected) return e.seq;
      prev = e.hash;
    }
    return null;
  }
}
