import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { AgentCore } from '../app/agentCore.js';
import type { ChatPipeline } from './chatPipeline.js';
import type { StateSnapshot, WireEvent } from './protocol.js';
import type { Notification } from '../util/events.js';
import type { ActionSignature } from '../domain/types.js';

/**
 * Local API server (§3, §9). Binds to 127.0.0.1 — but localhost binding alone does
 * not protect against the user's own browser as a confused deputy, so the browser
 * attack surface is closed structurally:
 *
 *  - The shell is served SAME-ORIGIN from this server (staticDir), so production
 *    needs no CORS at all. No Access-Control-Allow-* headers are emitted unless an
 *    explicit dev origin is configured (ANTICIPY_DEV_ORIGIN, for `vite dev`).
 *    Without ACAO, a malicious web page cannot read any response.
 *  - Mutating routes require Content-Type: application/json, which forces a CORS
 *    preflight for cross-origin callers — and the preflight fails without ACAO.
 *  - The Host header must be a loopback host (DNS-rebinding defense).
 *  - WebSocket upgrades are refused for cross-origin pages (Origin check).
 */
export interface CoreServerOptions {
  /** directory of the built shell (served same-origin at /) */
  staticDir?: string;
  /** exact origin allowed for CORS + WS during development (e.g. http://localhost:5173) */
  devOrigin?: string;
}

const MAX_NOTIFICATIONS = 200;

const signatureSchema: z.ZodType<ActionSignature> = z.object({
  actionType: z.string().min(1),
  target: z.string().min(1),
  params: z.record(z.unknown()),
  pageVersionHash: z.string(),
  disclosures: z.array(z.string()),
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

export class CoreServer {
  private http: Server;
  private wss: WebSocketServer;
  private notifications: Notification[] = [];

  constructor(
    private core: AgentCore,
    private pipeline: ChatPipeline,
    private port: number,
    private options: CoreServerOptions = {},
  ) {
    this.http = createServer((req, res) => {
      this.route(req, res).catch((err) => {
        this.json(req, res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
    });
    this.wss = new WebSocketServer({ noServer: true });

    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/ws' || !this.hostAllowed(req) || !this.originAllowed(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.core.events.on((event) => {
      if (event.type === 'notification') {
        this.notifications.push(event.notification);
        if (this.notifications.length > MAX_NOTIFICATIONS) {
          this.notifications.splice(0, this.notifications.length - MAX_NOTIFICATIONS);
        }
      }
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

  private hostAllowed(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? '').split(':')[0];
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  }

  /** No Origin (same-origin nav, curl, Electron main) is fine; else exact allowlist. */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    const self = `http://127.0.0.1:${this.port}`;
    const selfLocalhost = `http://localhost:${this.port}`;
    return (
      origin === self || origin === selfLocalhost || origin === this.options.devOrigin
    );
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
      // High-sensitivity values are stored-but-never-exposed (I12): the inspector
      // shows their existence, never their content. Vault refs stay pointers.
      facts: this.core.memory.inspect().map((f) =>
        f.sensitivity === 'high' ? { ...f, value: '•••••• (high sensitivity — redacted)' } : f,
      ),
      audit: this.core.audit.all(),
      chat: this.core.chatRepo.all(),
      disambiguations: this.core.resolver.pendingDisambiguations(),
      approvals: this.core.approvals.all(),
      vault: this.core.vault.list().map((v) => ({ ...v, redacted: true as const })),
      notifications: this.notifications,
    };
  }

  private json(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // CORS headers ONLY for the configured dev origin — production is same-origin.
    const origin = req.headers.origin;
    if (origin && this.options.devOrigin && origin === this.options.devOrigin) {
      headers['access-control-allow-origin'] = this.options.devOrigin;
      headers['access-control-allow-headers'] = 'content-type';
      headers['access-control-allow-methods'] = 'GET,POST,OPTIONS';
      headers['vary'] = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  private serveStatic(res: ServerResponse, pathname: string): boolean {
    const dir = this.options.staticDir;
    if (!dir) return false;
    const root = resolve(dir);
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const full = normalize(join(root, rel));
    if (!full.startsWith(root)) return false; // path traversal
    if (!existsSync(full) || !statSync(full).isFile()) {
      if (pathname !== '/' && !extname(full)) return false;
      return false;
    }
    res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
    res.end(readFileSync(full));
    return true;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.hostAllowed(req)) {
      this.json(req, res, 403, { error: 'forbidden host' });
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      // Preflight succeeds only for the configured dev origin (json() gates headers).
      this.json(req, res, this.originAllowed(req) ? 204 : 403, {});
      return;
    }

    if (req.method === 'GET') {
      if (path === '/api/health') {
        this.json(req, res, 200, { ok: true });
        return;
      }
      if (path === '/api/state') {
        if (!this.originAllowed(req)) {
          this.json(req, res, 403, { error: 'forbidden origin' });
          return;
        }
        this.json(req, res, 200, this.snapshot());
        return;
      }
      if (!path.startsWith('/api/') && this.serveStatic(res, path)) return;
    }

    if (req.method === 'POST') {
      if (!this.originAllowed(req)) {
        this.json(req, res, 403, { error: 'forbidden origin' });
        return;
      }
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        // Forces cross-origin callers into a CORS preflight they cannot pass.
        this.json(req, res, 415, { error: 'content-type must be application/json' });
        return;
      }

      if (path === '/api/chat') {
        const { text } = await this.body(req);
        await this.pipeline.onUserMessage(String(text ?? ''));
        this.json(req, res, 200, { ok: true });
        return;
      }

      const outcomeAction = path.match(/^\/api\/outcomes\/([^/]+)\/(approve|edit|cancel)$/);
      if (outcomeAction) {
        const [, id, action] = outcomeAction;
        const body = await this.body(req);
        if (action === 'approve') {
          await this.pipeline.onApprove(id!, String(body.approvedBy ?? 'user'));
          this.json(req, res, 200, { ok: true });
          return;
        }
        if (action === 'edit') {
          const parsed = signatureSchema.safeParse(body.signature);
          if (!parsed.success) {
            this.json(req, res, 400, { error: `invalid signature: ${parsed.error.message}` });
            return;
          }
          const outcome = this.core.editAction(id!, parsed.data, String(body.editedBy ?? 'user'));
          this.json(req, res, 200, { ok: true, signatureHash: outcome.preparedSignatureHash });
          return;
        }
        this.core.cancelOutcome(id!, String(body.reason ?? 'user cancelled'));
        this.json(req, res, 200, { ok: true });
        return;
      }

      const disambiguation = path.match(/^\/api\/disambiguations\/([^/]+)\/answer$/);
      if (disambiguation) {
        const body = await this.body(req);
        const resolution = this.core.resolver.answerDisambiguation(
          disambiguation[1]!,
          String(body.entityId ?? ''),
        );
        this.json(req, res, 200, { ok: true, entityId: resolution.entity.id });
        return;
      }
    }

    this.json(req, res, 404, { error: `no route for ${req.method} ${path}` });
  }
}
