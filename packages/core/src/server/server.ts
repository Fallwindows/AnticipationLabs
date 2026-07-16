import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentCore } from '../app/agentCore.js';
import type { ChatPipeline } from './chatPipeline.js';
import type { StateSnapshot, WireEvent } from './protocol.js';
import type { Notification } from '../util/events.js';

/**
 * Local API server (§3): REST commands + snapshot, WebSocket event stream. Binds to
 * 127.0.0.1 only — the core is a local service for the desktop shell, not a network
 * daemon.
 */
export class CoreServer {
  private http: Server;
  private wss: WebSocketServer;
  private notifications: Notification[] = [];

  constructor(
    private core: AgentCore,
    private pipeline: ChatPipeline,
    private port: number,
  ) {
    this.http = createServer((req, res) => {
      this.route(req, res).catch((err) => {
        this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
    });
    this.wss = new WebSocketServer({ server: this.http, path: '/ws' });

    this.core.events.on((event) => {
      if (event.type === 'notification') this.notifications.push(event.notification);
      this.broadcast({ kind: 'core-event', event });
    });

    this.wss.on('connection', (socket) => {
      socket.send(JSON.stringify({ kind: 'snapshot', snapshot: this.snapshot() } satisfies WireEvent));
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.http.listen(this.port, '127.0.0.1', resolve));
  }

  close(): void {
    for (const client of this.wss.clients) client.close();
    this.wss.close();
    this.http.close();
  }

  private broadcast(event: WireEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  snapshot(): StateSnapshot {
    return {
      outcomes: this.core.engine.all(),
      watches: this.core.watches.all(),
      facts: this.core.memory.inspect(),
      audit: this.core.audit.all(),
      chat: this.core.chatRepo.all(),
      disambiguations: this.core.resolver.pendingDisambiguations(),
      approvals: this.core.engine
        .all()
        .flatMap((o) => this.core.approvals.byOutcome(o.id)),
      vault: this.core.vault.list().map((v) => ({ ...v, redacted: true as const })),
      notifications: this.notifications,
    };
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const path = url.pathname;
    if (req.method === 'OPTIONS') {
      this.json(res, 204, {});
      return;
    }

    if (req.method === 'GET' && path === '/api/health') {
      this.json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && path === '/api/state') {
      this.json(res, 200, this.snapshot());
      return;
    }
    if (req.method === 'POST' && path === '/api/chat') {
      const { text } = await this.body(req);
      await this.pipeline.onUserMessage(String(text ?? ''));
      this.json(res, 200, { ok: true });
      return;
    }

    const outcomeAction = path.match(/^\/api\/outcomes\/([^/]+)\/(approve|edit|cancel)$/);
    if (req.method === 'POST' && outcomeAction) {
      const [, id, action] = outcomeAction;
      const body = await this.body(req);
      if (action === 'approve') {
        await this.pipeline.onApprove(id!, String(body.approvedBy ?? 'user'));
        this.json(res, 200, { ok: true });
        return;
      }
      if (action === 'edit') {
        const outcome = this.core.editAction(
          id!,
          body.signature as never,
          String(body.editedBy ?? 'user'),
        );
        this.json(res, 200, { ok: true, signatureHash: outcome.preparedSignatureHash });
        return;
      }
      this.core.cancelOutcome(id!, String(body.reason ?? 'user cancelled'));
      this.json(res, 200, { ok: true });
      return;
    }

    const disambiguation = path.match(/^\/api\/disambiguations\/([^/]+)\/answer$/);
    if (req.method === 'POST' && disambiguation) {
      const body = await this.body(req);
      const resolution = this.core.resolver.answerDisambiguation(
        disambiguation[1]!,
        String(body.entityId ?? ''),
      );
      this.json(res, 200, { ok: true, entityId: resolution.entity.id });
      return;
    }

    this.json(res, 404, { error: `no route for ${req.method} ${path}` });
  }
}
