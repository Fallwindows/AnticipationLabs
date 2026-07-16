import { createHash } from 'node:crypto';

/**
 * Canonical JSON: recursively key-sorted, no whitespace, undefined values dropped.
 * ActionSignature hashes (I5) and audit hash-chaining (I11) are computed over this
 * form so a hash is a property of the *content*, not of serialization order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k] = sortValue(v);
  return out;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
