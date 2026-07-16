/**
 * Typed event bus. The core emits every state change here; the local server relays
 * events to the shell over WebSocket so the inspector panels update live (§7), and
 * tests subscribe to observe behavior without polling.
 */
export type CoreEvent =
  | { type: 'outcome.changed'; outcomeId: string; from?: string; to: string; reason?: string }
  | { type: 'outcome.created'; outcomeId: string }
  | { type: 'memory.fact.added'; factId: string }
  | { type: 'memory.fact.superseded'; factId: string; supersededBy: string }
  | { type: 'watch.created'; watchId: string; outcomeId: string }
  | { type: 'watch.updated'; watchId: string; outcomeId: string }
  | { type: 'audit.appended'; entryId: string; outcomeId?: string }
  | { type: 'approval.requested'; outcomeId: string; signatureHash: string }
  | { type: 'approval.invalidated'; outcomeId: string; tokenId: string; reason: string }
  | { type: 'disambiguation.requested'; requestId: string; question: string }
  | { type: 'chat.message'; message: ChatMessage }
  | { type: 'notification'; notification: Notification };

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

export type CoreEventListener = (event: CoreEvent) => void;

export class EventBus {
  private listeners = new Set<CoreEventListener>();
  private log: CoreEvent[] = [];

  emit(event: CoreEvent): void {
    this.log.push(event);
    for (const l of this.listeners) l(event);
  }

  on(listener: CoreEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test helper: every event emitted since construction, in order. */
  history(): readonly CoreEvent[] {
    return this.log;
  }
}
