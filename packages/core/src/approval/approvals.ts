import type { ActionSignature, ApprovalScope, ApprovalToken } from '../domain/types.js';
import type { Clock } from '../util/clock.js';
import type { IdSource } from '../util/ids.js';
import type { EventBus } from '../util/events.js';
import { ApprovalTokenRepo } from '../persistence/repos.js';
import { hashCanonical } from '../util/canonical.js';

/**
 * Authorization & approval binding (§5.6, I5).
 *
 * An approval is a token bound to the SHA-256 of the canonical ActionSignature —
 * recipient, item, reason, amount, destination, method, page version, disclosures.
 * Single-use. Any edit to the signature produces a different hash, so the token no
 * longer authorizes anything; `invalidateForOutcome` is also called eagerly on edit
 * so the UI can show the invalidation (§7).
 */
export function signatureHash(sig: ActionSignature): string {
  // The WHOLE signature object is the signed surface: any field ever added to
  // ActionSignature automatically participates in the hash, so it can never be
  // silently excluded from "any edit invalidates" (I5).
  return hashCanonical(sig);
}

export type TokenCheck =
  | { ok: true; token: ApprovalToken }
  | { ok: false; reason: 'not-found' | 'signature-mismatch' | 'consumed' | 'invalidated' | 'expired' };

export class ApprovalService {
  constructor(
    private repo: ApprovalTokenRepo,
    private clock: Clock,
    private ids: IdSource,
    private events: EventBus,
  ) {}

  issue(args: {
    outcomeId: string;
    signature: ActionSignature;
    issuedBy: string;
    scope: Omit<ApprovalScope, 'maxUses'>;
  }): ApprovalToken {
    // A fresh approval supersedes any live token for the same outcome (one live
    // approval per outcome keeps "one approval = one action" auditable).
    for (const prior of this.repo.byOutcome(args.outcomeId)) {
      if (!prior.consumedAt && !prior.invalidatedAt) {
        this.invalidate(prior.id, 'replaced-by-new-approval');
      }
    }
    const token: ApprovalToken = {
      id: this.ids.next('apr'),
      outcomeId: args.outcomeId,
      signatureHash: signatureHash(args.signature),
      scope: {
        ...args.scope,
        maxUses: 1,
        // normalize to UTC so expiry comparisons are timezone-proof
        expiresAt: args.scope.expiresAt
          ? new Date(args.scope.expiresAt).toISOString()
          : undefined,
      },
      issuedAt: this.clock.now().toISOString(),
      issuedBy: args.issuedBy,
    };
    this.repo.save(token);
    return token;
  }

  /**
   * Validates that `tokenId` authorizes exactly `signature`, right now. Does not
   * consume. Every failure mode is explicit so tests can assert the reason.
   */
  check(tokenId: string, signature: ActionSignature): TokenCheck {
    const token = this.repo.get(tokenId);
    if (!token) return { ok: false, reason: 'not-found' };
    if (token.invalidatedAt) return { ok: false, reason: 'invalidated' };
    if (token.consumedAt) return { ok: false, reason: 'consumed' };
    if (
      token.scope.expiresAt &&
      new Date(token.scope.expiresAt).getTime() <= this.clock.now().getTime()
    ) {
      return { ok: false, reason: 'expired' };
    }
    if (token.signatureHash !== signatureHash(signature)) {
      return { ok: false, reason: 'signature-mismatch' };
    }
    return { ok: true, token };
  }

  /** Single-use: consuming is what permits exactly one execution (I5). */
  consume(tokenId: string, signature: ActionSignature): TokenCheck {
    const res = this.check(tokenId, signature);
    if (!res.ok) return res;
    const consumed = { ...res.token, consumedAt: this.clock.now().toISOString() };
    this.repo.save(consumed);
    return { ok: true, token: consumed };
  }

  invalidate(tokenId: string, reason: string): void {
    const token = this.repo.get(tokenId);
    if (!token || token.invalidatedAt) return;
    this.repo.save({
      ...token,
      invalidatedAt: this.clock.now().toISOString(),
      invalidationReason: reason,
    });
    this.events.emit({
      type: 'approval.invalidated',
      outcomeId: token.outcomeId,
      tokenId,
      reason,
    });
  }

  /** Invalidate every live token for an outcome (used on edit/supersession/cancel). */
  invalidateForOutcome(outcomeId: string, reason: string): void {
    for (const token of this.repo.byOutcome(outcomeId)) {
      if (!token.consumedAt && !token.invalidatedAt) this.invalidate(token.id, reason);
    }
  }

  get(tokenId: string): ApprovalToken | undefined {
    return this.repo.get(tokenId);
  }

  byOutcome(outcomeId: string): ApprovalToken[] {
    return this.repo.byOutcome(outcomeId);
  }

  all(): ApprovalToken[] {
    return this.repo.all();
  }
}
