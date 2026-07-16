/**
 * Wire-protocol types mirrored from @anticipy/core (packages/core/src/server/protocol.ts
 * and packages/core/src/domain/types.ts). The shell talks JSON over HTTP/WS, so these
 * are structural mirrors — kept in one file so drift against the core is easy to audit.
 */

// ---------------------------------------------------------------------------
// Outcome
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

export interface OutcomeTransition {
  from: OutcomeState | null;
  to: OutcomeState;
  at: string;
  reason?: string;
  evidence?: unknown;
}

export interface OutcomeConstraint {
  kind: 'exclusion' | 'buffer' | 'authority-limit' | 'preference' | 'deadline' | 'scope';
  description: string;
  params?: Record<string, unknown>;
}

export interface VerificationRecord {
  verifiedAt: string;
  source: string;
  evidence: Record<string, unknown>;
}

export interface ClosureRecord {
  closedAt: string;
  kind: 'ground-truth' | 'action-was-outcome';
  evidence: Record<string, unknown>;
}

export interface ActionSignature {
  actionType: string;
  target: string;
  params: Record<string, unknown>;
  pageVersionHash: string;
  disclosures: string[];
}

export interface ApprovalScope {
  description: string;
  maxUses: 1;
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

export interface Outcome {
  id: string;
  title: string;
  state: OutcomeState;
  owner: string;
  beneficiary?: string;
  originEpisodeId: string;
  interpretedGoal: string;
  originClassification: 'commitment' | 'discussion' | 'emotion' | 'signal';
  constraints: OutcomeConstraint[];
  preparationHint?: { kind: string; params: Record<string, unknown> };
  preparedAction?: ActionSignature;
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
// MemoryFact
// ---------------------------------------------------------------------------

export type Sensitivity = 'low' | 'normal' | 'high' | 'vault-ref';

export interface FactSource {
  kind: 'utterance' | 'evidence' | 'inference' | 'integration' | 'user-correction' | 'seed';
  ref: string;
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
  expiresAt?: string;
  createdAt: string;
  supersededBy?: string;
}

// ---------------------------------------------------------------------------
// Watch
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
  description: string;
  pollPolicy: { intervalMs: number };
  followUpPolicy: { windowMs: number; action: string } | null;
  timeoutAt?: string;
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
// AuditEntry
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  seq: number;
  outcomeId?: string;
  actor: string;
  action: string;
  target?: string;
  disclosure?: string;
  spokeTo?: string;
  promisedETA?: string;
  result: string;
  timestamp: string;
  signatureHash?: string;
  prevHash: string;
  hash: string;
}

// ---------------------------------------------------------------------------
// Disambiguation
// ---------------------------------------------------------------------------

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
// Chat & notifications
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: string;
  role: 'user' | 'anticipy' | 'system';
  text: string;
  at: string;
  outcomeId?: string;
  kind?: 'text' | 'approval-card' | 'disambiguation' | 'options' | 'notification';
  payload?: unknown;
}

export interface Notification {
  id: string;
  channel: 'quiet-card' | 'chat' | 'priority-push' | 'call';
  urgency: 'low' | 'normal' | 'high' | 'critical';
  title: string;
  body: string;
  outcomeId?: string;
  at: string;
}

// ---------------------------------------------------------------------------
// Snapshot + wire events
// ---------------------------------------------------------------------------

export interface VaultItemView {
  id: string;
  label: string;
  createdAt: string;
  redacted: true;
}

export interface StateSnapshot {
  outcomes: Outcome[];
  watches: Watch[];
  facts: MemoryFact[];
  audit: AuditEntry[];
  chat: ChatMessage[];
  disambiguations: DisambiguationRequest[];
  approvals: ApprovalToken[];
  vault: VaultItemView[];
  notifications: Notification[];
}

export type CoreEvent = { type: string } & Record<string, unknown>;

export type WireEvent =
  | { kind: 'core-event'; event: CoreEvent }
  | { kind: 'snapshot'; snapshot: StateSnapshot };

// Payload the core attaches to kind:'approval-card' chat messages.
export interface ApprovalCardPayload {
  signature?: ActionSignature;
  signatureHash?: string;
  scopeDescription?: string;
}

// Payload the core attaches to kind:'options' chat messages.
export interface OptionItem {
  optionId: string;
  label: string;
  detail?: Record<string, unknown>;
}

export const EMPTY_SNAPSHOT: StateSnapshot = {
  outcomes: [],
  watches: [],
  facts: [],
  audit: [],
  chat: [],
  disambiguations: [],
  approvals: [],
  vault: [],
  notifications: [],
};
