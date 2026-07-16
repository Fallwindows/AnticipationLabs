import { describe, expect, it } from 'vitest';
import { makeHarness } from '../helpers/harness.js';
import { DAY } from '../../src/util/clock.js';

/**
 * Memory + vault tests (§12, I12): provenance, TTL expiry, redaction view, and the
 * vault property that raw values never reach memory or a model prompt.
 */
describe('Memory: provenance, TTL, redaction (I12)', () => {
  it('facts expire on TTL: room 814 stops being context after checkout', () => {
    const h = makeHarness();
    const checkout = new Date(h.clock.now().getTime() + 2 * DAY).toISOString();
    h.core.memory.add({
      subject: 'Omar',
      predicate: 'hotel-room',
      value: 'room 814 at Le Germain',
      source: { kind: 'evidence', ref: 'gmail-reservation-1' },
      confidence: 0.98,
      expiresAt: checkout,
    });
    expect(h.core.memory.lookup('Omar', 'hotel-room')!.value).toContain('814');
    h.clock.advanceDays(3);
    expect(h.core.memory.lookup('Omar', 'hotel-room')).toBeUndefined();
    // but the fact still exists for the inspector (never deleted)
    expect(h.core.memory.inspect().some((f) => f.value.includes('814'))).toBe(true);
  });

  it('every fact carries source and confidence', () => {
    const h = makeHarness();
    const f = h.core.memory.add({
      subject: 'Daniel',
      predicate: 'diet',
      value: 'vegetarian',
      source: { kind: 'utterance', ref: 'ep-dinner', assertedBy: 'Omar' },
      confidence: 0.9,
    });
    expect(f.source.kind).toBe('utterance');
    expect(f.source.assertedBy).toBe('Omar');
    expect(f.confidence).toBe(0.9);
  });

  it('the prompt view strips high-sensitivity facts and vault refs', () => {
    const h = makeHarness();
    h.core.memory.add({
      subject: 'Omar',
      predicate: 'likes',
      value: 'quiet restaurants',
      source: { kind: 'seed', ref: 's' },
      confidence: 0.8,
    });
    h.core.memory.add({
      subject: 'Omar',
      predicate: 'health-note',
      value: 'something private',
      source: { kind: 'seed', ref: 's' },
      confidence: 0.9,
      sensitivity: 'high',
    });
    const vaultId = h.core.vault.put('sister passport number', 'AB1234567', 'test');
    h.core.memory.add({
      subject: 'sister',
      predicate: 'passport',
      value: `vault:${vaultId}`,
      source: { kind: 'utterance', ref: 'ep-passport' },
      confidence: 1,
      sensitivity: 'vault-ref',
    });

    const prompt = h.core.memory.promptLines().join('\n');
    expect(prompt).toContain('quiet restaurants');
    expect(prompt).not.toContain('something private');
    expect(prompt).not.toContain('AB1234567');
    expect(prompt).not.toContain('vault:');
    // full store still has all three for the inspector
    expect(h.core.memory.inspect()).toHaveLength(3);
  });

  it('refuses to store a raw value as a vault-ref fact', () => {
    const h = makeHarness();
    expect(() =>
      h.core.memory.add({
        subject: 'sister',
        predicate: 'passport',
        value: 'AB1234567',
        source: { kind: 'utterance', ref: 'ep' },
        confidence: 1,
        sensitivity: 'vault-ref',
      }),
    ).toThrow(/vault pointer/);
  });
});

describe('Vault (§5.11, I12)', () => {
  it('round-trips a secret, encrypted at rest', () => {
    const h = makeHarness();
    const id = h.core.vault.put('passport', 'AB1234567', 'test');
    // raw DB bytes never contain the plaintext
    const rows = h.core.db.prepare('SELECT ciphertext FROM vault_items').all() as {
      ciphertext: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.ciphertext, 'base64').toString('utf8')).not.toContain('AB1234567');
    expect(h.core.vault.reveal(id, 'user-takeover', 'test')).toBe('AB1234567');
  });

  it('secret substitution happens at the adapter boundary and is audited', () => {
    const h = makeHarness();
    const id = h.core.vault.put('passport', 'AB1234567', 'test');
    const substituted = h.core.vault.substituteParams(
      { formField: `passport number {{vault:${id}}}` },
      'actor:test',
    );
    expect(substituted.formField).toBe('passport number AB1234567');
    const accesses = h.core.audit.all().filter((e) => e.action === 'vault.reveal');
    expect(accesses).toHaveLength(1);
    expect(accesses[0]!.result).toContain('secret-substitution');
    expect(accesses[0]!.result).not.toContain('AB1234567');
  });

  it('the inspector list shows labels only — never values', () => {
    const h = makeHarness();
    h.core.vault.put('passport', 'AB1234567', 'test');
    const list = h.core.vault.list();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('AB1234567');
  });

  it('vault values never reach a model prompt even when memory is prompt-assembled', async () => {
    const h = makeHarness();
    const id = h.core.vault.put('passport', 'AB1234567', 'test');
    h.core.memory.add({
      subject: 'sister',
      predicate: 'passport',
      value: `vault:${id}`,
      source: { kind: 'utterance', ref: 'ep' },
      confidence: 1,
      sensitivity: 'vault-ref',
    });
    const episode = h.core.startEpisode({ participants: ['Omar'] });
    h.core.addUtterance(episode.id, { speaker: 'Omar', text: 'book the appointment', channel: 'chat' });
    h.llm.enqueue('interpret-episode', { outcomes: [], facts: [] });
    await h.core.interpretEpisode(episode.id);
    // Inspect EVERYTHING the fixture "model" was shown:
    for (const req of h.llm.seen) {
      expect(req.prompt).not.toContain('AB1234567');
      expect(req.prompt).not.toContain('vault:');
      expect(req.system ?? '').not.toContain('AB1234567');
    }
  });
});
