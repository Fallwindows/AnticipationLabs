import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Db } from '../persistence/db.js';
import type { Clock } from '../util/clock.js';
import type { IdSource } from '../util/ids.js';
import { AuditLog } from '../audit/auditLog.js';

/**
 * Sensitive data vault (§5.11, I12). Values are AES-256-GCM encrypted at rest and are
 * never placed in MemoryFacts, model prompts, or logs. Memory may hold only a
 * `vault:<id>` pointer; ActionSignature params may hold a `{{vault:<id>}}` placeholder
 * that is substituted at the adapter boundary — after the model, inside the actor.
 * Every access is written to the audit log.
 */

export interface KeyProvider {
  /** 32-byte data-encryption key. */
  getKey(): Buffer;
}

/** Dev/CI key provider: key file with 0600 permissions (DECISIONS D-003). */
export class FileKeyProvider implements KeyProvider {
  private key: Buffer | null = null;

  constructor(private path: string) {}

  getKey(): Buffer {
    if (this.key) return this.key;
    if (existsSync(this.path)) {
      this.key = Buffer.from(readFileSync(this.path, 'utf8').trim(), 'hex');
    } else {
      this.key = randomBytes(32);
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, this.key.toString('hex'), { mode: 0o600 });
    }
    if (this.key.length !== 32) throw new Error('vault key must be 32 bytes');
    return this.key;
  }
}

/** Deterministic key for tests only. */
export class StaticKeyProvider implements KeyProvider {
  constructor(private key: Buffer = Buffer.alloc(32, 7)) {}
  getKey(): Buffer {
    return this.key;
  }
}

export const VAULT_PLACEHOLDER = /\{\{vault:([a-zA-Z0-9_\-]+)\}\}/g;

export class VaultAccessError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'VaultAccessError';
  }
}

export class Vault {
  constructor(
    private db: Db,
    private keys: KeyProvider,
    private clock: Clock,
    private ids: IdSource,
    private audit: AuditLog,
  ) {}

  /** Store a secret; returns the vault id to reference it by. */
  put(label: string, value: string, storedBy: string): string {
    const id = this.ids.next('vault');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.getKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.db
      .prepare(
        'INSERT INTO vault_items (id, label, created_at, iv, auth_tag, ciphertext) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        label,
        this.clock.now().toISOString(),
        iv.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        ciphertext.toString('base64'),
      );
    this.audit.append({
      actor: 'vault',
      action: 'vault.put',
      target: id,
      result: `stored "${label}" by ${storedBy}`,
    });
    return id;
  }

  /**
   * Reveal is restricted to adapter-boundary purposes; the purpose string is audited.
   * Nothing in prompt assembly links against this method.
   */
  reveal(id: string, purpose: 'secret-substitution' | 'user-takeover', accessedBy: string): string {
    const row = this.db
      .prepare('SELECT label, iv, auth_tag, ciphertext FROM vault_items WHERE id = ?')
      .get(id) as { label: string; iv: string; auth_tag: string; ciphertext: string } | undefined;
    if (!row) throw new VaultAccessError(`vault item ${id} not found`);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.keys.getKey(),
      Buffer.from(row.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
    const value =
      decipher.update(Buffer.from(row.ciphertext, 'base64')).toString('utf8') +
      decipher.final('utf8');
    this.audit.append({
      actor: 'vault',
      action: 'vault.reveal',
      target: id,
      result: `revealed "${row.label}" for ${purpose} by ${accessedBy}`,
    });
    return value;
  }

  /** Inspector view: labels and access metadata only — never values. */
  list(): { id: string; label: string; createdAt: string }[] {
    const rows = this.db
      .prepare('SELECT id, label, created_at FROM vault_items ORDER BY rowid')
      .all() as { id: string; label: string; created_at: string }[];
    return rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at }));
  }

  /**
   * Secret substitution at the adapter boundary (§5.11): replaces {{vault:id}}
   * placeholders in a string. Called by actors AFTER approval-hash verification and
   * AFTER the model is out of the loop. The audit trail shows each reveal.
   */
  substitute(text: string, accessedBy: string): string {
    return text.replace(VAULT_PLACEHOLDER, (_m, id: string) =>
      this.reveal(id, 'secret-substitution', accessedBy),
    );
  }

  /** Deep-substitutes placeholders in params (for adapter payloads). */
  substituteParams(params: Record<string, unknown>, accessedBy: string): Record<string, unknown> {
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return this.substitute(v, accessedBy);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
      }
      return v;
    };
    return walk(params) as Record<string, unknown>;
  }
}
