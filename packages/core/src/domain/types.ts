/**
 * Core domain model (brief §4). These are first-class persisted types; the semantics
 * here are load-bearing — every invariant in brief §2 is enforced against these shapes.
 */

// ---------------------------------------------------------------------------
// Outcome (§4.1) — the central object
// ---------------------------------------------------------------------------

export type OutcomeState =
  | 'Discovered'
  | 'Interpreting'
  | 'Dormant'
  | 'Prepared'
  | 'AwaitingApproval'
  | 'Approved'
  | 'Executing'
  | 'Executed'
  | 'Verifying'
  | 'Verified'
  | 'Watching'
  | 'Closed'
  | 'Cancelled'
  | 'Superseded';

export const TERMINAL_STATES: readonly OutcomeState[] = ['Closed', 'Cancelled', 'Superseded'];

/**
 * States from which supersession may fire (§5.4: "any pre-execution state", I2).
 * Once a side effect is in flight (Executing and beyond) the world may already have
 * changed, so supersession no longer applies — the verifier must establish ground
 * truth first.
 */
export const PRE_EXECUTION_STATES: readonly OutcomeState[] = [
  'Discovered',
  'Interpreting',
  'Dormant',
  'Prepared',
  'AwaitingApproval',
  'Approved',
];

/**
 * The explicit legal-edge table (§4.1 state diagram). The OutcomeEngine refuses any
 * transition not listed here; tests assert the refusals (§12 "forbid illegal edges").
 *
 * Cancellation (the kill switch, §9) is available from every pre-execution state,
 * from Watching, and — as a last-resort human abandon — from Verifying (the audit
 * trail records that a side effect may exist; verification was inconclusive). It is
 * deliberately NOT available during Executing/Executed: the side effect is in flight
 * and the machine must reach the verification stage first, so "cancelled" never
 * misrepresents the world (I4/I6).
 */
export const LEGAL_TRANSITIONS: Readonly<Record<OutcomeState, readonly OutcomeState[]>> = {
  Discovered: ['Interpreting', 'Superseded', 'Cancelled'],
  Interpreting: ['Dormant', 'Prepared', 'Superseded', 'Cancelled'],
  Dormant: ['Interpreting', 'Superseded', 'Cancelled'],
  Prepared: ['AwaitingApproval', 'Interpreting', 'Superseded', 'Cancelled'],
  AwaitingApproval: ['Approved', 'Superseded', 'Cancelled'],
  Approved: ['Executing', 'AwaitingApproval', 'Superseded', 'Cancelled'],
  Executing: ['Executed'],
  Executed: ['Verifying'],
  Verifying: ['Executing', 'Verified', 'Cancelled'],
  Verified: ['Watching', 'Closed'],
  Watching: ['Closed', 'Cancelled'],
  Closed: [],
  Cancelled: [],
  Superseded: [],
};

export interface OutcomeTransition {
  from: OutcomeState | null;
  to: OutcomeState;
  at: string;
  reason?: string;
  /** e.g. verifier evidence, close-condition evidence, approval token id */
  evidence?: unknown;
}

export interface OutcomeConstraint {
  kind: 'exclusion' | 'buffer' | 'authority-limit' | 'preference' | 'deadline' | 'scope';
  description: string;
  /** machine-checkable payload, e.g. { field: 'cc', forbidden: 'ceo@...' } */
  params?: Record<string, unknown>;
}

export interface VerificationRecord {
  verifiedAt: string;
  /** which read-only source produced the evidence (never the actor, I6) */
  source: string;
  evidence: Record<string, unknown>;
}

export interface ClosureRecord {
  closedAt: string;
  /**
   * 'ground-truth'        — a watch close-condition was met (payment posted, refund landed)
   * 'action-was-outcome'  — the verified action itself was the promised outcome (I4 boundary,
   *                         e.g. scenario 4: the promise was to *send*)
   */
  kind: 'ground-truth' | 'action-was-outcome';
  evidence: Record<string, unknown>;
}

export interface Outcome {
  id: string;
  title: string;
  state: OutcomeState;
  /** whose outcome this is (who Anticipy answers to for it) */
  owner: string;
  /** who it is for, when different (e.g. Elias) */
  beneficiary?: string;
  originEpisodeId: string;
  interpretedGoal: string;
  /** classification of the originating utterances: discussion/emotion never authorize (I3) */
  originClassification: 'commitment' | 'discussion' | 'emotion' | 'signal';
  constraints: OutcomeConstraint[];
  /** stable interpreter key within the origin episode; drives cross-restart supersession (I2) */
  episodeKey?: string;
  /** interpreter's read-only research hint for the preparation service (never an action) */
  preparationHint?: { kind: string; params: Record<string, unknown> };
  preparedAction?: ActionSignature;
  /** hash of preparedAction, kept in lockstep with it at every engine write site */
  preparedSignatureHash?: string;
  approvalTokenId?: string;
  idempotencyKey?: string;
  verification?: VerificationRecord;
  closure?: ClosureRecord;
  watchIds: string[];
  history: OutcomeTransition[];
  supersededBy?: string;
  cancelReason?: string;
  dormantReason?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Episode & Utterance (§4.2)
// ---------------------------------------------------------------------------

export interface Utterance {
  speaker: string;
  text: string;
  at: string;
  channel: string;
}

export interface EvidenceRef {
  kind: string; // 'gmail-reservation' | 'amazon-order' | 'jira-ticket' | ...
  ref: string;
  data?: Record<string, unknown>;
}

export interface Episode {
  id: string;
  utterances: Utterance[];
  evidence: EvidenceRef[];
  participants: string[];
  ingestedAt: string;
}

// ---------------------------------------------------------------------------
// MemoryFact (§4.3)
// ---------------------------------------------------------------------------

/**
 * 'vault-ref' facts carry only a pointer into the vault (§5.11); the value never
 * appears in memory. 'high' facts are stored but excluded from the prompt view (I12).
 */
export type Sensitivity = 'low' | 'normal' | 'high' | 'vault-ref';

export interface FactSource {
  kind: 'utterance' | 'evidence' | 'inference' | 'integration' | 'user-correction' | 'seed';
  ref: string;
  /** who asserted it — authority checks (I10) need to know the mother said it, not the sister */
  assertedBy?: string;
}

export interface MemoryFact {
  id: string;
  subject: string;
  predicate: string;
  value: string;
  source: FactSource;
  confidence: number;
  sensitivity: Sensitivity;
  /** absolute expiry (ISO); after this the fact is no longer returned by queries (I12) */
  expiresAt?: string;
  createdAt: string;
  supersededBy?: string;
}

// ---------------------------------------------------------------------------
// Entity & Resolution (§4.4)
// ---------------------------------------------------------------------------

export type EntityType = 'person' | 'project' | 'org' | 'place' | 'product';

export interface Entity {
  id: string;
  type: EntityType;
  /** canonical name first */
  names: string[];
  aliases: string[];
  attributes: Record<string, string>;
}

export interface ResolutionEvidence {
  kind:
    | 'name-similarity'
    | 'relationship'
    | 'meeting-context'
    | 'thread-membership'
    | 'domain-vocabulary'
    | 'recency'
    | 'explicit-reference';
  description: string;
  weight: number;
}

export interface Resolution {
  entity: Entity;
  confidence: number;
  evidence: ResolutionEvidence[];
}

export interface DisambiguationRequest {
  id: string;
  mention: string;
  question: string;
  candidates: { entityId: string; label: string; confidence: number }[];
  outcomeId?: string;
  createdAt: string;
  resolvedEntityId?: string;
}

// ---------------------------------------------------------------------------
// ActionSignature & ApprovalToken (§4.5, I5)
// ---------------------------------------------------------------------------

/**
 * The canonical, hashable description of exactly what will happen. Params may contain
 * vault placeholders ("{{vault:<id>}}") — the hash binds to the placeholder; the raw
 * value is substituted at the adapter boundary, outside the model (§5.11).
 */
export interface ActionSignature {
  actionType: string; // 'email.send' | 'commerce.submit-return' | 'telephony.call' | ...
  target: string; // recipient address / order id / phone number / subscription id
  params: Record<string, unknown>; // item, reason, amount, refund destination, method, ...
  /** hash of the exact page/screen/version the action will be performed against */
  pageVersionHash: string;
  /** what will be disclosed to the counterparty (I11) — part of the signed surface */
  disclosures: string[];
}

export interface ApprovalScope {
  /** e.g. "one disclosed call to Hotel Le Germain front desk" */
  description: string;
  maxUses: 1; // single-use, by construction (I5)
  expiresAt?: string;
}

export interface ApprovalToken {
  id: string;
  outcomeId: string;
  signatureHash: string;
  scope: ApprovalScope;
  issuedAt: string;
  issuedBy: string;
  consumedAt?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

// ---------------------------------------------------------------------------
// Watch (§4.6, I8)
// ---------------------------------------------------------------------------

export type WatchKind =
  | 'ledger'
  | 'mailbox'
  | 'reply'
  | 'refund'
  | 'flight'
  | 'delivery'
  | 'dropoff'
  | 'billing'
  | 'custom';

export type WatchState = 'active' | 'satisfied' | 'timed-out' | 'cancelled';

export interface Watch {
  id: string;
  outcomeId: string;
  kind: WatchKind;
  /** free-text for the inspector panel */
  description: string;
  pollPolicy: { intervalMs: number };
  /** at most one follow-up per window (I8) */
  followUpPolicy: { windowMs: number; action: string } | null;
  /** absolute deadline; passing it emits a timeout notification, never a closure */
  timeoutAt?: string;
  /**
   * Evaluated by a registered evaluator for `kind` against polled ground truth.
   * Only a met close-condition (or explicit human cancel) closes the Outcome (I4).
   */
  closeCondition: { kind: string; params: Record<string, unknown>; description: string };
  state: WatchState;
  nextPollAt: string;
  windowStartedAt: string;
  followUpsSentInWindow: number;
  lastPolledAt?: string;
  lastPollResult?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// AuditEntry (§4.7, I11) — append-only
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  /** monotonically increasing; gaps would reveal tampering */
  seq: number;
  outcomeId?: string;
  /** which component acted (e.g. 'actor:email', 'verifier:ledger', 'vault') */
  actor: string;
  action: string;
  target?: string;
  /** what was disclosed to the counterparty on external contact (I11) */
  disclosure?: string;
  /** who was spoken to, for calls (I11) */
  spokeTo?: string;
  promisedETA?: string;
  result: string;
  timestamp: string;
  signatureHash?: string;
  /** hash chain: sha256(prevHash + canonical(entry-sans-hash)) */
  prevHash: string;
  hash: string;
}
