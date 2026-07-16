import type {
  ActionSignature,
  ApprovalToken,
  AuditEntry,
  DisambiguationRequest,
  MemoryFact,
  Outcome,
  Watch,
} from '../domain/types.js';
import type { ChatMessage, CoreEvent, Notification } from '../util/events.js';

/**
 * Wire protocol between the agent core service and the desktop shell (§3, §7).
 * REST for commands + snapshot, WebSocket for the live event stream that keeps the
 * chat surface and the four inspector panels in sync.
 *
 * Endpoints:
 *   GET  /api/health                        -> { ok: true }
 *   GET  /api/state                         -> StateSnapshot
 *   POST /api/chat                          -> { text } (user message)
 *   POST /api/outcomes/:id/approve          -> { approvedBy }
 *   POST /api/outcomes/:id/edit             -> { signature: ActionSignature, editedBy }
 *   POST /api/outcomes/:id/cancel           -> { reason }
 *   POST /api/disambiguations/:id/answer    -> { entityId }
 *   WS   /ws                                -> stream of WireEvent
 */

export interface VaultItemView {
  id: string;
  label: string;
  createdAt: string;
  /** values are never sent to the shell; the panel shows redaction + access log */
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

export type WireEvent =
  | { kind: 'core-event'; event: CoreEvent }
  | { kind: 'snapshot'; snapshot: StateSnapshot };

export interface ApproveRequest {
  approvedBy: string;
}

export interface EditRequest {
  signature: ActionSignature;
  editedBy: string;
}

export interface CancelRequest {
  reason: string;
}

export interface ChatRequest {
  text: string;
}

export interface AnswerDisambiguationRequest {
  entityId: string;
}

export const DEFAULT_PORT = 4271;
