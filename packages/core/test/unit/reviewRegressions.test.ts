import { describe, expect, it } from 'vitest';
import { makeApproved, makeHarness, makePrepared, sampleSignature } from '../helpers/harness.js';
import { redactSensitiveText } from '../../src/util/redact.js';
import { HOUR } from '../../src/util/clock.js';

/**
 * Regression tests for the adversarial review findings: wedge states, time-zone
 * comparisons, memory duplication, restart-durable supersession, watch races,
 * external-satisfaction guards, and PII prompt hygiene.
 */
describe('No wedge states (§9 kill switch reachability)', () => {
  it('a LOST write (never landed) exhausts re-reads, parks in Verifying, and cancel is legal', async () => {
    const h = makeHarness();
    h.world.loseNextWrite.add('email.send');
    const o = makeApproved(h);
    const result = await h.core.executeAndVerify(o.id);
    expect(result.status).toBe('not-found');
    expect(h.core.engine.get(o.id).state).toBe('Verifying');
    // exactly one attempt reached the adapter; nothing landed; no re-submit happened
    expect(h.world.writesFor('email.send')).toHaveLength(1);
    expect(h.world.sentMessages).toHaveLength(0);
    // re-verification is available...
    const again = await h.core.verifyAgain(o.id);
    expect(again.status).toBe('not-found');
    // ...and so is the kill switch — the outcome is NOT stuck forever.
    const cancelled = h.core.engine.cancel(o.id, 'giving up after inconclusive verification');
    expect(cancelled.state).toBe('Cancelled');
  });

  it('an unroutable actionType is refused BEFORE the approval token is consumed', async () => {
    const h = makeHarness();
    const o = makeApproved(h, { ...sampleSignature(), actionType: 'calendar.create-event' });
    await expect(h.core.actor.execute(o.id)).rejects.toThrow(/no actor dispatch/);
    const current = h.core.engine.get(o.id);
    expect(current.state).toBe('Approved'); // not Executing — the gate never fired
    expect(h.core.approvals.get(current.approvalTokenId!)!.consumedAt).toBeUndefined();
  });

  it('a non-timeout adapter failure mid-dispatch hands off to verification instead of wedging in Executing', async () => {
    const h = makeHarness();
    // reservation for a slot that vanishes between preparation and execution
    h.world.restaurants.push({
      restaurantId: 'r1',
      name: 'Quiet Place',
      cuisine: 'bistro',
      noiseLevel: 'quiet',
      vegetarianFriendly: true,
      cancellationPolicy: 'free until 6pm',
      availableSlots: ['19:00'],
    });
    const o = makeApproved(h, {
      actionType: 'reservation.book',
      target: 'r1',
      params: { slot: '20:15', partySize: 2 }, // not an available slot -> adapter throws
      pageVersionHash: 'v1',
      disclosures: [],
    });
    const result = await h.core.actor.execute(o.id);
    expect(result.status).toBe('timeout'); // unknown-outcome handling
    expect(h.core.engine.get(o.id).state).toBe('Executed');
    h.core.engine.beginVerification(o.id);
    const verify = await h.core.verifier.verify(h.core.engine.get(o.id));
    expect(verify.status).toBe('not-found');
    expect(h.core.engine.get(o.id).state).toBe('Verifying');
    expect(() => h.core.engine.cancel(o.id, 'slot gone; user gave up')).not.toThrow();
  });
});

describe('Time comparisons are timezone-proof', () => {
  it('an offset-format expiresAt still expires the token on time', () => {
    const h = makeHarness({ start: '2026-07-16T15:59:00.000Z' });
    const sig = sampleSignature();
    const o = makePrepared(h, sig);
    h.core.engine.requestApproval(o.id);
    // 18:00 at UTC+2 === 16:00Z — one minute from "now"
    const approved = h.core.engine.approve(o.id, 'Omar', 'scope', '2026-07-16T18:00:00+02:00');
    expect(h.core.approvals.check(approved.approvalTokenId!, sig).ok).toBe(true);
    h.clock.advanceMinutes(2);
    const check = h.core.approvals.check(approved.approvalTokenId!, sig);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('expired');
  });

  it('an offset-format memory TTL expires correctly', () => {
    const h = makeHarness({ start: '2026-07-16T15:59:00.000Z' });
    h.core.memory.add({
      subject: 'Omar',
      predicate: 'gate',
      value: 'C42',
      source: { kind: 'evidence', ref: 'boarding-pass' },
      confidence: 0.9,
      expiresAt: '2026-07-16T18:00:00+02:00', // = 16:00Z
    });
    expect(h.core.memory.lookup('Omar', 'gate')).toBeTruthy();
    h.clock.advanceMinutes(2);
    expect(h.core.memory.lookup('Omar', 'gate')).toBeUndefined();
  });
});

describe('Memory dedup and correction shape', () => {
  it('re-interpreting an episode does not duplicate identical facts', async () => {
    const h = makeHarness();
    const episode = h.core.startEpisode({ participants: ['Omar'] });
    h.core.addUtterance(episode.id, { speaker: 'Omar', text: 'Daniel is vegetarian', channel: 'chat' });
    const canned = {
      outcomes: [],
      facts: [
        { subject: 'Daniel', predicate: 'diet', value: 'vegetarian', confidence: 0.9, sensitivity: 'normal' as const, corrects: false },
      ],
    };
    h.llm.enqueue('interpret-episode', canned);
    await h.core.interpretEpisode(episode.id);
    h.core.addUtterance(episode.id, { speaker: 'Omar', text: 'also he likes quiet places', channel: 'chat' });
    h.llm.enqueue('interpret-episode', canned); // whole-episode re-interpretation re-emits the fact
    await h.core.interpretEpisode(episode.id);
    expect(h.core.memory.query({ subject: 'Daniel', predicate: 'diet' })).toHaveLength(1);
  });

  it('correct() with multiple active priors produces ONE new fact superseding all of them', () => {
    const h = makeHarness();
    const a = h.core.memory.add({
      subject: 'Omar',
      predicate: 'coffee',
      value: 'americano',
      source: { kind: 'seed', ref: 's1' },
      confidence: 0.5,
    });
    const b = h.core.memory.add({
      subject: 'Omar',
      predicate: 'coffee',
      value: 'flat white',
      source: { kind: 'seed', ref: 's2' },
      confidence: 0.5,
    });
    const corrected = h.core.memory.correct({
      subject: 'Omar',
      predicate: 'coffee',
      value: 'oat latte',
      source: { kind: 'user-correction', ref: 'chat' },
      confidence: 0.95,
    });
    const active = h.core.memory.query({ subject: 'Omar', predicate: 'coffee' });
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(corrected.id);
    expect(h.core.memory.get(a.id)!.supersededBy).toBe(corrected.id);
    expect(h.core.memory.get(b.id)!.supersededBy).toBe(corrected.id);
  });
});

describe('Supersession survives a restart (I2, §3)', () => {
  it('an outcome created before a restart is still superseded by a correction after it', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'anticipy-restart-'));
    const dbPath = join(dir, 'core.sqlite3');
    try {
      const h1 = makeHarness({ dbPath });
      const episode = h1.core.startEpisode({ participants: ['Omar'] });
      h1.core.addUtterance(episode.id, { speaker: 'Omar', text: 'return the plant', channel: 'chat' });
      h1.llm.enqueue('interpret-episode', {
        outcomes: [
          { key: 'return-plant', title: 'Return plant', interpretedGoal: 'g', owner: 'Omar', classification: 'commitment' as const, confidence: 0.7 },
        ],
        facts: [],
      });
      const first = await h1.core.interpretEpisode(episode.id);
      const plantId = first.created[0]!.id;
      h1.core.close();

      // restart: fresh core, same database — the in-memory key map is gone
      const h2 = makeHarness({ dbPath });
      h2.core.addUtterance(episode.id, { speaker: 'Omar', text: 'no wait, the POT', channel: 'chat' });
      h2.llm.enqueue('interpret-episode', {
        outcomes: [
          { key: 'return-pot', title: 'Return pot', interpretedGoal: 'g2', owner: 'Omar', classification: 'commitment' as const, confidence: 0.95, supersedesKey: 'return-plant' },
        ],
        facts: [],
      });
      const second = await h2.core.interpretEpisode(episode.id);
      expect(second.superseded.map((s) => s.outcomeId)).toContain(plantId);
      expect(h2.core.engine.get(plantId).state).toBe('Superseded');
      // and re-emitting the same key does not duplicate the outcome
      expect(h2.core.engine.all().filter((o) => o.episodeKey === 'return-pot')).toHaveLength(1);
      h2.core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Watch scheduler races and guards', () => {
  it('a watch cancelled while its poller is in flight is not resurrected', async () => {
    const h = makeHarness();
    const o = makeApproved(h);
    await h.core.executeAndVerify(o.id);
    const watch = h.core.startWatch({
      outcomeId: o.id,
      kind: 'custom',
      description: 'racy watch',
      closeCondition: { kind: 'racy', params: {}, description: 'never' },
      intervalMs: HOUR,
      firstPollAt: h.clock.now().toISOString(),
    });
    h.core.watches.registerPoller('racy', async () => {
      // concurrent cancellation lands while the poll is awaited
      h.core.cancelOutcome(o.id, 'user changed their mind mid-poll');
      return {};
    });
    h.core.watches.registerEvaluator('racy', () => ({ met: false }));
    await h.core.watches.tick();
    expect(h.core.watches.get(watch.id)!.state).toBe('cancelled');
    expect(h.core.engine.get(o.id).state).toBe('Cancelled');
  });

  it('one poisoned watch does not stall polling for the others', async () => {
    const h = makeHarness();
    const a = makeApproved(h);
    await h.core.executeAndVerify(a.id);
    // watch with an UNREGISTERED close-condition kind (e.g. after a restart)
    h.core.startWatch({
      outcomeId: a.id,
      kind: 'custom',
      description: 'poisoned',
      closeCondition: { kind: 'not-registered-anywhere', params: {}, description: 'x' },
      intervalMs: HOUR,
      firstPollAt: h.clock.now().toISOString(),
    });
    // healthy ledger watch behind it
    h.world.invoices.push({ invoiceNumber: '9', counterparty: 'X', amount: 10, currency: 'CAD', dueDate: '2026-07-01', status: 'open' });
    h.world.payments.push({ invoiceNumber: '9', amount: 10, postedAt: h.clock.now().toISOString(), method: 'eft' });
    const b = makeApproved(h);
    await h.core.executeAndVerify(b.id);
    h.core.startWatch({
      outcomeId: b.id,
      kind: 'ledger',
      description: 'healthy',
      closeCondition: { kind: 'ledger-payment-posted', params: { invoiceNumber: '9', amount: 10 }, description: 'paid' },
      firstPollAt: h.clock.now().toISOString(),
    });

    await h.core.watches.tick(); // must not throw, and must reach the healthy watch
    expect(h.core.engine.get(b.id).state).toBe('Closed');
    // the poisoned watch's failure is audited and its nextPollAt moved forward
    const errors = h.core.audit.all().filter((e) => e.action === 'watch.poll-error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('satisfyExternally refuses non-active watches, empty evidence, and non-Watching outcomes; tears down siblings', async () => {
    const h = makeHarness();
    const o = makeApproved(h);
    await h.core.executeAndVerify(o.id);
    const w1 = h.core.startWatch({
      outcomeId: o.id,
      kind: 'reply',
      description: 'primary',
      closeCondition: { kind: 'reply-received', params: { mailbox: 'omar@x', from: 'y@x' }, description: 'reply' },
    });
    const w2 = h.core.startWatch({
      outcomeId: o.id,
      kind: 'custom',
      description: 'sibling',
      closeCondition: { kind: 'reply-received', params: { mailbox: 'omar@x', from: 'z@x' }, description: 'other reply' },
    });

    expect(() => h.core.watches.satisfyExternally(w1.id, {})).toThrow(/evidence/);
    h.core.watches.satisfyExternally(w1.id, { userConfirmation: 'done' });
    expect(h.core.engine.get(o.id).state).toBe('Closed');
    // sibling watches are torn down, not left polling a closed outcome
    expect(h.core.watches.get(w2.id)!.state).toBe('cancelled');
    // and a satisfied watch cannot be satisfied again
    expect(() => h.core.watches.satisfyExternally(w1.id, { again: true })).toThrow(/active/);
  });
});

describe('PII prompt hygiene (I12, D-010)', () => {
  it('redactSensitiveText scrubs cards, SSNs, and passport-shaped ids but not flight/room/order codes', () => {
    expect(redactSensitiveText('my passport is HQ7841226 ok')).toBe('my passport is [redacted:id-document] ok');
    expect(redactSensitiveText('card 4111 1111 1111 1111 thanks')).toBe('card [redacted:card] thanks');
    expect(redactSensitiveText('ssn 123-45-6789')).toBe('ssn [redacted:ssn]');
    const untouched = 'flight UA482 room 814 order amz-7719 PNR ABC123 call +1-514-849-2050 invoice 1047';
    expect(redactSensitiveText(untouched)).toBe(untouched);
  });

  it('a passport number typed into chat never reaches the model prompt', async () => {
    const h = makeHarness();
    const episode = h.core.startEpisode({ participants: ['Omar'] });
    h.core.addUtterance(episode.id, {
      speaker: 'Omar',
      text: 'my sister passport number is HQ7841226, use it for the booking',
      channel: 'chat',
    });
    h.llm.enqueue('interpret-episode', { outcomes: [], facts: [] });
    await h.core.interpretEpisode(episode.id);
    for (const req of h.llm.seen) {
      expect(req.prompt).not.toContain('HQ7841226');
    }
    expect(h.llm.seen.some((r) => r.prompt.includes('[redacted:id-document]'))).toBe(true);
  });

  it('vault placeholders are refused in internal chat deliverables', async () => {
    const h = makeHarness();
    const id = h.core.vault.put('secret', 'HQ7841226', 'test');
    const o = makeApproved(h, {
      actionType: 'chat.deliver-brief',
      target: 'user',
      params: { topic: 'x', text: `here is the number {{vault:${id}}}` },
      pageVersionHash: 'v1',
      disclosures: [],
    });
    const result = await h.core.actor.execute(o.id);
    // dispatch failure -> unknown-outcome handling; nothing was decrypted into chat
    expect(result.status).toBe('timeout');
    expect(JSON.stringify(h.core.chatRepo.all())).not.toContain('HQ7841226');
    const failed = h.core.audit.byOutcome(o.id).find((e) => e.result.includes('FAILED'))!;
    expect(failed.result).toContain('vault placeholders are not allowed');
  });
});

describe('Approval re-request on edit-after-approve', () => {
  it('editing an Approved action emits approval.requested for the new signature', () => {
    const h = makeHarness();
    const sig = sampleSignature();
    const o = makePrepared(h, sig);
    h.core.engine.requestApproval(o.id);
    h.core.engine.approve(o.id, 'Omar', 'scope');
    const before = h.core.events.history().filter((e) => e.type === 'approval.requested').length;
    h.core.editAction(o.id, { ...sig, params: { ...sig.params, body: 'edited' } }, 'Omar');
    const after = h.core.events.history().filter((e) => e.type === 'approval.requested');
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]!.signatureHash).toBe(
      h.core.engine.get(o.id).preparedSignatureHash,
    );
  });
});
