import type {
  ActionSignature,
  ClosureRecord,
  Outcome,
  OutcomeConstraint,
  OutcomeState,
  VerificationRecord,
} from '../domain/types.js';
import { LEGAL_TRANSITIONS, PRE_EXECUTION_STATES, TERMINAL_STATES } from '../domain/types.js';
import type { Clock } from '../util/clock.js';
import type { IdSource } from '../util/ids.js';
import type { EventBus } from '../util/events.js';
import { OutcomeRepo } from '../persistence/repos.js';
import { ApprovalService, signatureHash } from '../approval/approvals.js';
import { AuditLog } from '../audit/auditLog.js';

export class IllegalTransitionError extends Error {
  constructor(
    public outcomeId: string,
    public from: OutcomeState,
    public to: OutcomeState,
    detail?: string,
  ) {
    super(
      `Illegal transition ${from} -> ${to} for outcome ${outcomeId}${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'IllegalTransitionError';
  }
}

export class ApprovalGateError extends Error {
  constructor(
    public outcomeId: string,
    public reason: string,
  ) {
    super(`Approval gate refused execution for outcome ${outcomeId}: ${reason}`);
    this.name = 'ApprovalGateError';
  }
}

/**
 * The Outcome state machine (§4.1, §5.4). Owns every transition and enforces the
 * invariants at the boundaries:
 *
 *  - no `Executing` without consuming a matching, live ApprovalToken (I5);
 *  - no `Closed` without a ClosureRecord — ground truth or action-was-outcome (I4);
 *  - `Verified` requires a VerificationRecord from a read-only source (I6);
 *  - supersession only from pre-execution states (I2, §5.4);
 *  - any edit to the prepared action invalidates outstanding approvals (I5).
 *
 * This is an explicit, tested state machine — all writes to Outcome.state go through
 * `transition()`, which checks the LEGAL_TRANSITIONS table.
 */
export class OutcomeEngine {
  constructor(
    private repo: OutcomeRepo,
    private approvals: ApprovalService,
    private audit: AuditLog,
    private clock: Clock,
    private ids: IdSource,
    private events: EventBus,
  ) {}

  create(args: {
    title: string;
    owner: string;
    beneficiary?: string;
    originEpisodeId: string;
    interpretedGoal: string;
    originClassification: Outcome['originClassification'];
    constraints?: OutcomeConstraint[];
  }): Outcome {
    const now = this.clock.now().toISOString();
    const outcome: Outcome = {
      id: this.ids.next('out'),
      title: args.title,
      state: 'Discovered',
      owner: args.owner,
      beneficiary: args.beneficiary,
      originEpisodeId: args.originEpisodeId,
      interpretedGoal: args.interpretedGoal,
      originClassification: args.originClassification,
      constraints: args.constraints ?? [],
      watchIds: [],
      history: [{ from: null, to: 'Discovered', at: now, reason: 'signal detected in episode' }],
      createdAt: now,
      updatedAt: now,
    };
    this.repo.save(outcome);
    this.events.emit({ type: 'outcome.created', outcomeId: outcome.id });
    this.events.emit({ type: 'outcome.changed', outcomeId: outcome.id, to: 'Discovered' });
    return outcome;
  }

  get(id: string): Outcome {
    const o = this.repo.get(id);
    if (!o) throw new Error(`Unknown outcome ${id}`);
    return o;
  }

  all(): Outcome[] {
    return this.repo.all();
  }

  /** The single write path for state. Everything else in this class goes through here. */
  private transition(
    id: string,
    to: OutcomeState,
    patch: Partial<Outcome>,
    reason?: string,
    evidence?: unknown,
  ): Outcome {
    const o = this.get(id);
    const legal = LEGAL_TRANSITIONS[o.state];
    if (!legal.includes(to)) {
      throw new IllegalTransitionError(id, o.state, to, reason);
    }
    const now = this.clock.now().toISOString();
    const next: Outcome = {
      ...o,
      ...patch,
      state: to,
      updatedAt: now,
      history: [...o.history, { from: o.state, to, at: now, reason, evidence }],
    };
    this.repo.save(next);
    this.events.emit({ type: 'outcome.changed', outcomeId: id, from: o.state, to, reason });
    return next;
  }

  // -- Interpretation ---------------------------------------------------------

  beginInterpretation(id: string): Outcome {
    return this.transition(id, 'Interpreting', {});
  }

  /** Discussion / emotion / not-actionable-yet (I3). */
  markDormant(id: string, reason: string): Outcome {
    return this.transition(id, 'Dormant', { dormantReason: reason }, reason);
  }

  /** New evidence wakes a dormant outcome. */
  reopenFromDormant(id: string, reason: string): Outcome {
    return this.transition(id, 'Interpreting', { dormantReason: undefined }, reason);
  }

  /**
   * Preparation finished: the outcome has been taken to its final consequential
   * screen without committing (§5.5) and the exact ActionSignature exists.
   */
  markPrepared(id: string, action: ActionSignature, reason?: string): Outcome {
    return this.transition(
      id,
      'Prepared',
      { preparedAction: action, preparedSignatureHash: signatureHash(action) },
      reason ?? 'prepared to final consequential screen',
    );
  }

  /** Re-interpretation of an already-prepared outcome (new evidence arrived). */
  reinterpret(id: string, reason: string): Outcome {
    const o = this.get(id);
    if (o.approvalTokenId) {
      this.approvals.invalidateForOutcome(id, `reinterpretation: ${reason}`);
    }
    return this.transition(id, 'Interpreting', { approvalTokenId: undefined }, reason);
  }

  // -- Approval ---------------------------------------------------------------

  requestApproval(id: string): Outcome {
    const o = this.get(id);
    if (!o.preparedAction) {
      throw new IllegalTransitionError(id, o.state, 'AwaitingApproval', 'no prepared action');
    }
    const next = this.transition(id, 'AwaitingApproval', {}, 'approval card presented');
    this.events.emit({
      type: 'approval.requested',
      outcomeId: id,
      signatureHash: o.preparedSignatureHash!,
    });
    return next;
  }

  /**
   * Any edit to the prepared action while awaiting/holding approval rebuilds the
   * signature and invalidates every outstanding token (I5). State returns to
   * AwaitingApproval (from Approved) or stays there.
   */
  editPreparedAction(id: string, action: ActionSignature, editedBy: string): Outcome {
    const o = this.get(id);
    if (o.state !== 'AwaitingApproval' && o.state !== 'Approved' && o.state !== 'Prepared') {
      throw new IllegalTransitionError(id, o.state, o.state, 'cannot edit action in this state');
    }
    this.approvals.invalidateForOutcome(id, `signature edited by ${editedBy}`);
    const newHash = signatureHash(action);
    const now = this.clock.now().toISOString();
    if (o.state === 'Approved') {
      return this.transition(
        id,
        'AwaitingApproval',
        { preparedAction: action, preparedSignatureHash: newHash, approvalTokenId: undefined },
        'edit invalidated prior approval',
      );
    }
    // Prepared / AwaitingApproval: same state, new signature — record without a state edge.
    const next: Outcome = {
      ...o,
      preparedAction: action,
      preparedSignatureHash: newHash,
      approvalTokenId: undefined,
      updatedAt: now,
      history: [
        ...o.history,
        { from: o.state, to: o.state, at: now, reason: 'signature edited; approvals invalidated' },
      ],
    };
    this.repo.save(next);
    this.events.emit({
      type: 'outcome.changed',
      outcomeId: id,
      from: o.state,
      to: o.state,
      reason: 'signature edited',
    });
    if (next.state === 'AwaitingApproval') {
      this.events.emit({ type: 'approval.requested', outcomeId: id, signatureHash: newHash });
    }
    return next;
  }

  /**
   * A human "yes" on the exact signature currently prepared. Issues the single-use
   * token and moves to Approved. The token is NOT consumed here — consumption happens
   * at the execution gate, so drift between approval and execution is still caught.
   */
  approve(id: string, approvedBy: string, scopeDescription: string, expiresAt?: string): Outcome {
    const o = this.get(id);
    if (o.state !== 'AwaitingApproval') {
      throw new IllegalTransitionError(id, o.state, 'Approved', 'not awaiting approval');
    }
    if (!o.preparedAction) {
      throw new ApprovalGateError(id, 'no prepared action to approve');
    }
    const token = this.approvals.issue({
      outcomeId: id,
      signature: o.preparedAction,
      issuedBy: approvedBy,
      scope: { description: scopeDescription, expiresAt },
    });
    return this.transition(
      id,
      'Approved',
      { approvalTokenId: token.id },
      `approved by ${approvedBy}`,
      { tokenId: token.id, signatureHash: token.signatureHash },
    );
  }

  // -- Execution gate (I5) ------------------------------------------------------

  /**
   * Approved -> Executing. THE gate: consumes the single-use token after verifying it
   * still binds to the exact current signature. Records the idempotency key (I7).
   */
  startExecution(id: string, idempotencyKey: string): Outcome {
    const o = this.get(id);
    if (o.state !== 'Approved') {
      throw new IllegalTransitionError(id, o.state, 'Executing', 'not approved');
    }
    if (!o.preparedAction || !o.approvalTokenId) {
      throw new ApprovalGateError(id, 'missing prepared action or approval token');
    }
    const res = this.approvals.consume(o.approvalTokenId, o.preparedAction);
    if (!res.ok) {
      throw new ApprovalGateError(id, `token check failed: ${res.reason}`);
    }
    return this.transition(
      id,
      'Executing',
      { idempotencyKey },
      'approval token consumed; execution started',
      { tokenId: o.approvalTokenId, idempotencyKey },
    );
  }

  /** Actor reports the side effect was ATTEMPTED (not that it worked — I6). */
  markExecuted(id: string, actorReport: string): Outcome {
    return this.transition(id, 'Executed', {}, `actor report (unverified): ${actorReport}`);
  }

  // -- Verification (I6/I7) -----------------------------------------------------

  beginVerification(id: string): Outcome {
    return this.transition(id, 'Verifying', {}, 'independent read-only verification');
  }

  /**
   * Verifying -> Executing: idempotent recovery. Only legal way back into Executing;
   * the actor must RE-READ for an existing result, never re-submit (I7).
   */
  recoverForReread(id: string, reason: string): Outcome {
    return this.transition(id, 'Executing', {}, `idempotent recovery (re-read only): ${reason}`);
  }

  /** Ground truth read independently confirms the action (I6). */
  markVerified(id: string, verification: VerificationRecord): Outcome {
    if (verification.source.startsWith('actor')) {
      throw new ApprovalGateError(id, 'verification evidence must come from a read-only source, not an actor');
    }
    return this.transition(id, 'Verified', { verification }, 'ground truth confirmed', verification);
  }

  // -- Outcome resolution (I4/I8) -------------------------------------------------

  startWatching(id: string, watchId: string, reason: string): Outcome {
    const o = this.get(id);
    return this.transition(id, 'Watching', { watchIds: [...o.watchIds, watchId] }, reason);
  }

  attachWatch(id: string, watchId: string): Outcome {
    const o = this.get(id);
    const now = this.clock.now().toISOString();
    const next = { ...o, watchIds: [...o.watchIds, watchId], updatedAt: now };
    this.repo.save(next);
    return next;
  }

  /**
   * Closing requires evidence: either the watch's close condition (ground truth) or
   * the I4-boundary case where the verified action WAS the promised outcome.
   */
  close(id: string, closure: Omit<ClosureRecord, 'closedAt'>): Outcome {
    const o = this.get(id);
    if (o.state === 'Watching' && closure.kind !== 'ground-truth') {
      throw new IllegalTransitionError(
        id,
        o.state,
        'Closed',
        'a watching outcome closes only on ground truth',
      );
    }
    if (o.state === 'Verified' && closure.kind === 'action-was-outcome' && !o.verification) {
      throw new IllegalTransitionError(id, o.state, 'Closed', 'no verification record');
    }
    const record: ClosureRecord = { ...closure, closedAt: this.clock.now().toISOString() };
    return this.transition(id, 'Closed', { closure: record }, `closed: ${closure.kind}`, record.evidence);
  }

  // -- Supersession & cancellation (I2, §9) ---------------------------------------

  /** A later statement changed the assignment. Pre-execution states only (§5.4). */
  supersede(id: string, reason: string, supersededBy?: string): Outcome {
    const o = this.get(id);
    if (!PRE_EXECUTION_STATES.includes(o.state)) {
      throw new IllegalTransitionError(id, o.state, 'Superseded', 'side effect already in flight');
    }
    this.approvals.invalidateForOutcome(id, `superseded: ${reason}`);
    return this.transition(id, 'Superseded', { supersededBy, approvalTokenId: undefined }, reason);
  }

  /** Explicit human cancel ("never mind"). Tears down approvals; caller tears down watches. */
  cancel(id: string, reason: string): Outcome {
    const o = this.get(id);
    if (TERMINAL_STATES.includes(o.state)) {
      throw new IllegalTransitionError(id, o.state, 'Cancelled', 'already terminal');
    }
    this.approvals.invalidateForOutcome(id, `cancelled: ${reason}`);
    const next = this.transition(id, 'Cancelled', { cancelReason: reason, approvalTokenId: undefined }, reason);
    this.audit.append({
      outcomeId: id,
      actor: 'engine',
      action: 'outcome.cancelled',
      result: reason,
    });
    return next;
  }
}
