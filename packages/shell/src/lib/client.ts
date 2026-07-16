import {
  EMPTY_SNAPSHOT,
  type ActionSignature,
  type StateSnapshot,
  type WireEvent,
} from './types';

/**
 * Live connection to the local agent core (127.0.0.1:4271).
 *
 * Strategy (simple + correct):
 *  - WS /ws pushes an initial {kind:'snapshot'}; every subsequent {kind:'core-event'}
 *    triggers a refetch of GET /api/state so the shell never applies partial deltas.
 *  - Auto-reconnect with exponential backoff.
 *  - If the WS cannot connect, an initial GET /api/state still populates the UI.
 */

export const DEFAULT_PORT = 4271;

// Same-origin when the core serves the built shell (production/Electron); explicit
// localhost core only under the Vite dev server. Same-origin means the core emits
// no CORS headers at all in production.
const servedByCore =
  typeof window !== 'undefined' &&
  window.location.protocol.startsWith('http') &&
  window.location.port !== '5173';

export const HTTP_BASE = servedByCore ? '' : `http://127.0.0.1:${DEFAULT_PORT}`;
export const WS_URL = servedByCore
  ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
  : `ws://127.0.0.1:${DEFAULT_PORT}/ws`;

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export interface ClientState {
  snapshot: StateSnapshot;
  status: ConnectionStatus;
}

type Listener = (state: ClientState) => void;

export class CoreClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private state: ClientState = { snapshot: EMPTY_SNAPSHOT, status: 'connecting' };
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private refetchQueued = false;
  private stopped = false;

  start(): void {
    this.stopped = false;
    // Fallback snapshot in case the WS never comes up.
    void this.refetchState();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): ClientState {
    return this.state;
  }

  // -- commands ---------------------------------------------------------------

  sendChat(text: string): Promise<void> {
    return this.post('/api/chat', { text });
  }

  approve(outcomeId: string, approvedBy: string): Promise<void> {
    return this.post(`/api/outcomes/${encodeURIComponent(outcomeId)}/approve`, { approvedBy });
  }

  async edit(
    outcomeId: string,
    signature: ActionSignature,
    editedBy: string,
  ): Promise<{ signatureHash?: string }> {
    const res = await this.postRaw(`/api/outcomes/${encodeURIComponent(outcomeId)}/edit`, {
      signature,
      editedBy,
    });
    const body = (await res.json().catch(() => ({}))) as { signatureHash?: string };
    void this.refetchState();
    return body;
  }

  cancel(outcomeId: string, reason: string): Promise<void> {
    return this.post(`/api/outcomes/${encodeURIComponent(outcomeId)}/cancel`, { reason });
  }

  answerDisambiguation(requestId: string, entityId: string): Promise<void> {
    return this.post(`/api/disambiguations/${encodeURIComponent(requestId)}/answer`, { entityId });
  }

  // -- internals ----------------------------------------------------------------

  private async post(path: string, body: unknown): Promise<void> {
    await this.postRaw(path, body);
    // Even if the WS is down, keep the UI truthful after a command.
    void this.refetchState();
  }

  private async postRaw(path: string, body: unknown): Promise<Response> {
    const res = await fetch(`${HTTP_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(detail.error ?? `${res.status} on ${path}`);
    }
    return res;
  }

  private connect(): void {
    if (this.stopped) return;
    try {
      this.ws = new WebSocket(WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    const ws = this.ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.update({ status: 'connected' });
    };
    ws.onmessage = (msg: MessageEvent) => {
      let event: WireEvent;
      try {
        event = JSON.parse(String(msg.data)) as WireEvent;
      } catch {
        return;
      }
      if (event.kind === 'snapshot') {
        this.update({ snapshot: event.snapshot });
      } else if (event.kind === 'core-event') {
        this.queueRefetch();
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      ws.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.update({ status: 'reconnecting' });
    const delay = Math.min(500 * 2 ** this.reconnectAttempt, 8000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Coalesce bursts of core-events into a single GET /api/state. */
  private queueRefetch(): void {
    if (this.refetchQueued) return;
    this.refetchQueued = true;
    window.setTimeout(() => {
      this.refetchQueued = false;
      void this.refetchState();
    }, 40);
  }

  private async refetchState(): Promise<void> {
    try {
      const res = await fetch(`${HTTP_BASE}/api/state`);
      if (!res.ok) return;
      const snapshot = (await res.json()) as StateSnapshot;
      this.update({ snapshot });
    } catch {
      // core not reachable yet; the WS reconnect loop keeps trying
    }
  }

  private update(partial: Partial<ClientState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }
}

export const coreClient = new CoreClient();
