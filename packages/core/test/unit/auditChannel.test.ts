import { describe, expect, it } from 'vitest';
import { makeApproved, makeHarness } from '../helpers/harness.js';

/**
 * Audit log (I11) and channel policy (I13) tests.
 */
describe('Audit log — append-only, hash-chained (I11)', () => {
  it('rows chain: each hash covers the previous', () => {
    const h = makeHarness();
    h.core.audit.append({ actor: 'test', action: 'a', result: 'r1' });
    h.core.audit.append({ actor: 'test', action: 'b', result: 'r2' });
    h.core.audit.append({ actor: 'test', action: 'c', result: 'r3' });
    expect(h.core.audit.verifyChain()).toBeNull();
    const all = h.core.audit.all();
    expect(all[0]!.prevHash).toBe('genesis');
    expect(all[1]!.prevHash).toBe(all[0]!.hash);
    expect(all[2]!.prevHash).toBe(all[1]!.hash);
  });

  it('the database refuses UPDATE and DELETE on audit rows', () => {
    const h = makeHarness();
    h.core.audit.append({ actor: 'test', action: 'a', result: 'r' });
    expect(() => h.core.db.prepare(`UPDATE audit_log SET result = 'tampered'`).run()).toThrow(
      /append-only/,
    );
    expect(() => h.core.db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
  });

  it('external contact records disclosure, who was spoken to, and the promised ETA (I11)', async () => {
    const h = makeHarness();
    h.world.hotels.push({
      name: 'Le Germain',
      phone: '+1-514-849-2050',
      amenities: { 'dental kit': 'complimentary' },
    });
    const o = makeApproved(h, {
      actionType: 'telephony.call',
      target: '+1-514-849-2050',
      params: { script: 'Please send a dental kit to room 814.' },
      pageVersionHash: 'v1',
      disclosures: ["This is Anticipy, Omar's assistant, calling on their behalf."],
    });
    await h.core.executeAndVerify(o.id);
    const call = h.core.audit.byOutcome(o.id).find((e) => e.action === 'telephony.call')!;
    expect(call.disclosure).toContain("Omar's assistant");
    expect(call.spokeTo).toBeTruthy();
    expect(call.promisedETA).toBeTruthy();
  });

  it('tampering (if triggers were bypassed) is detectable via the chain', () => {
    const h = makeHarness();
    h.core.audit.append({ actor: 'test', action: 'a', result: 'r1' });
    h.core.audit.append({ actor: 'test', action: 'b', result: 'r2' });
    // simulate an attacker with trigger-dropping powers
    h.core.db.exec('DROP TRIGGER audit_no_update');
    h.core.db.prepare(`UPDATE audit_log SET result = 'tampered' WHERE seq = 1`).run();
    expect(h.core.audit.verifyChain()).toBe(1);
  });
});

describe('Channel policy (I13)', () => {
  it('a delay that breaks a hard deadline escalates to a call', () => {
    const h = makeHarness({ start: '2026-07-16T21:00:00.000Z' });
    const urgency = h.core.channels.deriveUrgency({
      deadlineAt: '2026-07-17T09:00:00.000Z', // 9 a.m. keynote, 12h away
      breaksHardCommitment: true,
    });
    expect(urgency).toBe('critical');
    expect(h.core.channels.channelFor(urgency)).toBe('call');
  });

  it('routine nudges stay quiet', () => {
    const h = makeHarness();
    const urgency = h.core.channels.deriveUrgency({ baseImportance: 'low' });
    expect(urgency).toBe('low');
    expect(h.core.channels.channelFor(urgency)).toBe('quiet-card');
  });

  it('sensitive content avoids priority push', () => {
    const h = makeHarness();
    expect(h.core.channels.channelFor('high', true)).toBe('chat');
    expect(h.core.channels.channelFor('high', false)).toBe('priority-push');
  });

  it('the same fact is urgent only when a hard commitment is at stake', () => {
    const h = makeHarness({ start: '2026-07-16T21:00:00.000Z' });
    const casual = h.core.channels.deriveUrgency({
      deadlineAt: '2026-07-18T09:00:00.000Z',
      breaksHardCommitment: false,
    });
    expect(casual).not.toBe('critical');
  });
});

describe('Telephony compliance gate (D-005, §9)', () => {
  it('the telephony tier refuses calls when disabled', async () => {
    const h = makeHarness({ telephonyEnabled: false });
    h.world.hotels.push({ name: 'Le Germain', phone: '+1', amenities: {} });
    const o = makeApproved(h, {
      actionType: 'telephony.call',
      target: '+1',
      params: { script: 'hello' },
      pageVersionHash: 'v1',
      disclosures: ['assistant call'],
    });
    await expect(h.core.actor.execute(o.id)).rejects.toThrow(/disabled/);
  });

  it('calls without a disclosure are refused at the adapter (I11)', async () => {
    const h = makeHarness();
    const o = makeApproved(h, {
      actionType: 'telephony.call',
      target: '+1',
      params: { script: 'hello' },
      pageVersionHash: 'v1',
      disclosures: [],
    });
    await expect(h.core.actor.execute(o.id)).rejects.toThrow(/disclosure/);
  });
});
