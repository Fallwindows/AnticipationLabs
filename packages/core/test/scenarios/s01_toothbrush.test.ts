import { describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from '../helpers/harness.js';
import { MINUTE, DAY } from '../../src/util/clock.js';

/**
 * Scenario 1 (§10.1) — Forgotten toothbrush (Montreal).
 *
 * "We'll have to stop at London Drugs" is a signal to interpret, not a shopping
 * trigger (I1). Room 814 is present via reservation evidence and carries a checkout
 * TTL (I12). One approval = one disclosed call (I5/I11) recording who was spoken to
 * and the promised ETA; a 20-minute follow-up watch; "got it" closes on confirmation;
 * "never mind" cancels everything.
 */

const CHECKOUT = '2026-07-19T11:00:00.000Z';

function seed(h: Harness): void {
  h.world.hotels.push({
    name: 'Hôtel Le Germain Montréal',
    phone: '+1-514-849-2050',
    amenities: {
      'dental kit': 'complimentary dental kits, delivered to rooms on request',
    },
  });
  // Room number arrives as reservation evidence and expires at checkout (I12).
  h.core.memory.add({
    subject: 'Omar',
    predicate: 'hotel-room',
    value: '814',
    source: { kind: 'evidence', ref: 'gmail-reservation-le-germain' },
    confidence: 0.98,
    expiresAt: CHECKOUT,
  });
  h.core.memory.add({
    subject: 'Elias',
    predicate: 'relationship',
    value: "Omar's grandfather, travelling with Omar",
    source: { kind: 'seed', ref: 'profile' },
    confidence: 0.95,
  });
}

function enqueueInterpretation(h: Harness): void {
  h.llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'toothbrush-elias',
        title: 'Elias needs a toothbrush tonight',
        interpretedGoal:
          'Elias needs a toothbrush at the hotel without a special store trip; "London Drugs" was surface phrasing, not a command',
        owner: 'Omar',
        beneficiary: 'Elias',
        classification: 'commitment',
        confidence: 0.86,
        constraints: [{ kind: 'preference', description: 'would rather not make a special trip' }],
        preparation: {
          kind: 'hotel-amenity-call',
          params: { hotel: 'Le Germain', item: 'dental kit', room: '814' },
        },
      },
    ],
    facts: [],
  });
}

async function driveToApprovalCard(h: Harness) {
  const episode = h.core.startEpisode({
    participants: ['Omar', 'Elias'],
    evidence: [
      {
        kind: 'gmail-reservation',
        ref: 'gmail-reservation-le-germain',
        data: { hotel: 'Hôtel Le Germain Montréal', room: '814', checkout: CHECKOUT },
      },
    ],
  });
  h.core.addUtterance(episode.id, {
    speaker: 'Omar',
    text: "Ugh, Elias forgot his toothbrush. We'll have to stop at London Drugs.",
    channel: 'car-voice',
  });
  enqueueInterpretation(h);
  const report = await h.core.interpretEpisode(episode.id);
  const outcome = report.created[0]!;
  const prep = await h.core.prepareOutcome(outcome.id);
  if (prep.kind !== 'action') throw new Error('expected action preparation');
  h.core.presentApproval(outcome.id, prep.summary, 'one disclosed call to the front desk');
  return { outcome, prep };
}

describe('Scenario 1 — forgotten toothbrush', () => {
  it('interprets the goal, not the keyword: no shopping action of any kind (I1)', async () => {
    const h = makeHarness({ start: '2026-07-17T21:40:00.000Z' });
    seed(h);
    const { outcome, prep } = await driveToApprovalCard(h);

    const current = h.core.engine.get(outcome.id);
    expect(current.state).toBe('AwaitingApproval');
    expect(current.interpretedGoal).toContain('toothbrush');
    // The prepared action is a call to the hotel — not a purchase, not a store page.
    if (prep.kind !== 'action') throw new Error('unreachable');
    expect(prep.signature.actionType).toBe('telephony.call');
    expect(prep.signature.target).toBe('+1-514-849-2050');
    expect(String(prep.signature.params.room)).toBe('814');
    expect(String(prep.signature.params.beneficiary)).toBe('Elias');
    // Nothing was bought or even attempted anywhere:
    expect(h.world.writeCalls).toHaveLength(0);
  });

  it('one approval = one disclosed call; audit records who was spoken to + ETA (I5/I11); 20-min watch; "got it" closes', async () => {
    const h = makeHarness({ start: '2026-07-17T21:40:00.000Z' });
    seed(h);
    const { outcome } = await driveToApprovalCard(h);

    // Omar: "Yes, please."
    h.core.approve(outcome.id, 'Omar', 'one disclosed call to Hôtel Le Germain front desk');
    const verify = await h.core.executeAndVerify(outcome.id);
    expect(verify.status).toBe('verified');

    // Exactly one call fired, disclosed as the assistant.
    const calls = h.world.writesFor('telephony.call');
    expect(calls).toHaveLength(1);
    expect(h.world.calls[0]!.disclosure).toContain("Omar's assistant");

    // The audit entry records disclosure, who was spoken to, and the promised ETA (I11).
    const auditCall = h.core.audit.byOutcome(outcome.id).find((e) => e.action === 'telephony.call')!;
    expect(auditCall.disclosure).toContain('assistant');
    expect(auditCall.spokeTo).toBe('front desk agent (fixture)');
    expect(auditCall.promisedETA).toBe('20 minutes');

    // 20-minute follow-up watch (D-007).
    h.core.startWatch({
      outcomeId: outcome.id,
      kind: 'delivery',
      description: 'dental kit to room 814',
      closeCondition: { kind: 'delivery-confirmed', params: {}, description: 'Omar confirms arrival' },
      followUpAction: 'nudge-front-desk',
      followUpWindowMs: 20 * MINUTE,
      firstPollAt: new Date(h.clock.now().getTime() + 20 * MINUTE).toISOString(),
    });
    expect(h.core.engine.get(outcome.id).state).toBe('Watching');

    // The kit doesn't arrive in 20 minutes: exactly one follow-up per window.
    let followUps = 0;
    h.core.watches.registerFollowUp('delivery-confirmed', async () => {
      followUps += 1;
    });
    h.clock.advanceMinutes(21);
    await h.core.watches.tick();
    h.clock.advanceMinutes(5);
    await h.core.watches.tick();
    expect(followUps).toBe(1);

    // A second call CANNOT happen on the same approval: the token is consumed.
    expect(h.world.writesFor('telephony.call')).toHaveLength(1);

    // "Got it, thanks" — human confirmation is ground truth; outcome closes.
    const watch = h.core.watches.all()[0]!;
    h.core.watches.satisfyExternally(watch.id, { userConfirmation: 'got it' });
    const closed = h.core.engine.get(outcome.id);
    expect(closed.state).toBe('Closed');
    expect(closed.closure!.kind).toBe('ground-truth');
  });

  it('"never mind, I found one" cancels everything immediately (§9)', async () => {
    const h = makeHarness({ start: '2026-07-17T21:40:00.000Z' });
    seed(h);
    const { outcome } = await driveToApprovalCard(h);
    h.core.approve(outcome.id, 'Omar', 'one call');

    h.core.cancelOutcome(outcome.id, 'never mind, found one in the car');
    expect(h.core.engine.get(outcome.id).state).toBe('Cancelled');
    // approval dead, no call ever fired
    expect(h.core.approvals.byOutcome(outcome.id).every((t) => t.invalidatedAt)).toBe(true);
    expect(h.world.writesFor('telephony.call')).toHaveLength(0);
  });

  it('the room number is TTL-bound context: gone after checkout, chain preserved (I12)', async () => {
    const h = makeHarness({ start: '2026-07-17T21:40:00.000Z' });
    seed(h);
    expect(h.core.memory.lookup('Omar', 'hotel-room')!.value).toBe('814');
    h.clock.advance(2 * DAY); // past checkout
    expect(h.core.memory.lookup('Omar', 'hotel-room')).toBeUndefined();
    expect(h.core.memory.inspect().some((f) => f.value === '814')).toBe(true);
  });
});
