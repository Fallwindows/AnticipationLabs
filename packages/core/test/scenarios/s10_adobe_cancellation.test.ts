import { describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from '../helpers/harness.js';
import { IllegalTransitionError } from '../../src/engine/outcomeEngine.js';

/**
 * Scenario 10 (§10.10) — Adobe cancellation reversed by later transcript.
 *
 * "I should cancel Adobe" does not become a cancellation; the full episode reassigns
 * it to research the consequences (I2): renewal date, owner, $109.98 termination fee,
 * team library usage, cancel-at-term option. Options are presented; on exact approval
 * of ONE option the cancellation is submitted once, the verifier reads the effective
 * date + confirmation reference from the billing account (I6), and a watch covers the
 * final billing period for rogue charges — closing only on clean ground truth (I4).
 */

const SUB_ID = 'sub-adobe-cc';
const RENEWAL = '2026-09-16'; // ~2 months out from the 2026-07-16 test clock

function seed(h: Harness): void {
  h.world.subscriptions.push({
    subscriptionId: SUB_ID,
    product: 'Adobe Creative Cloud',
    owner: 'Omar',
    renewalDate: RENEWAL,
    monthlyAmount: 54.99,
    earlyTerminationFee: 109.98,
    teamLibraryUsers: 3,
    status: 'active',
  });
}

async function driveThroughSupersession(h: Harness) {
  const episode = h.core.startEpisode({
    participants: ['Omar'],
    evidence: [{ kind: 'billing-subscription', ref: SUB_ID, data: { product: 'Adobe Creative Cloud' } }],
  });

  // Utterance 1: a frustrated "cancel Adobe" — read as a commitment, but low-ish confidence.
  h.core.addUtterance(episode.id, {
    speaker: 'Omar',
    text: 'Ugh, I should just cancel Adobe.',
    channel: 'chat',
  });
  h.llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'cancel-adobe',
        title: 'Cancel Adobe Creative Cloud',
        interpretedGoal: 'cancel the Adobe subscription — first read of a frustrated remark',
        owner: 'Omar',
        classification: 'commitment',
        confidence: 0.55,
        preparation: {
          kind: 'billing-cancel',
          params: { subscriptionId: SUB_ID, mode: 'immediate' },
        },
      },
    ],
    facts: [],
  });
  const first = await h.core.interpretEpisode(episode.id);
  const cancelOutcome = first.created[0]!;

  // Utterance 2, later in the same transcript: the full episode reassigns it (I2).
  h.core.addUtterance(episode.id, {
    speaker: 'Omar',
    text: 'Actually the team still uses the library — first find out what cancelling would actually cost us.',
    channel: 'chat',
  });
  h.llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'research-adobe',
        title: 'Research the consequences of cancelling Adobe',
        interpretedGoal:
          'research what cancelling Adobe Creative Cloud would actually cost: renewal date, owner, early-termination fee, team library usage, cancel-at-term option — then present options',
        owner: 'Omar',
        classification: 'commitment',
        confidence: 0.92,
        supersedesKey: 'cancel-adobe',
        constraints: [
          {
            kind: 'scope',
            description:
              'research + present options; cancellation only on explicit approval of a specific option',
          },
        ],
        preparation: { kind: 'billing-research', params: { subscriptionId: SUB_ID } },
      },
    ],
    facts: [],
  });
  const second = await h.core.interpretEpisode(episode.id);
  const researchOutcome = second.created[0]!;
  return { cancelOutcome, researchOutcome };
}

/** Options presented, Omar picks cancel-at-term, exact approval, one submit, verified. */
async function driveToVerified(h: Harness) {
  const { cancelOutcome, researchOutcome } = await driveThroughSupersession(h);

  // Present options (read-only), then Omar picks cancel-at-term.
  const options = await h.core.prepareOutcome(researchOutcome.id);
  if (options.kind !== 'options') throw new Error('expected options');
  const prep = await h.core.prepareOutcome(researchOutcome.id, 'billing-cancel', {
    subscriptionId: SUB_ID,
    mode: 'at-term',
  });
  if (prep.kind !== 'action') throw new Error('expected action');
  h.core.presentApproval(researchOutcome.id, prep.summary, 'one at-term cancellation of Adobe CC');
  h.core.approve(researchOutcome.id, 'Omar', 'cancel Adobe at term only — no fee');

  const verify = await h.core.executeAndVerify(researchOutcome.id);
  if (verify.status !== 'verified') throw new Error('verification failed');
  return { cancelOutcome, researchOutcome, prep, verify };
}

function startFinalPeriodWatch(h: Harness, outcomeId: string, withFollowUp = false) {
  return h.core.startWatch({
    outcomeId,
    kind: 'billing',
    description: 'final billing period of Adobe CC shows no rogue charge',
    closeCondition: {
      kind: 'no-rogue-charge',
      params: {
        subscriptionId: SUB_ID,
        since: h.clock.now().toISOString(),
        periodEnd: RENEWAL,
        allowedFinalAmount: 54.99,
      },
      description: 'only the regular $54.99 charge until the renewal date, then clean',
    },
    ...(withFollowUp ? { followUpAction: 'flag-rogue-charge' } : {}),
  });
}

describe('Scenario 10 — Adobe cancellation reversed by later transcript', () => {
  it('"I should cancel Adobe" never becomes a cancellation: the full episode reassigns it to research (I2)', async () => {
    const h = makeHarness();
    seed(h);
    const { cancelOutcome, researchOutcome } = await driveThroughSupersession(h);

    const superseded = h.core.engine.get(cancelOutcome.id);
    expect(superseded.state).toBe('Superseded');
    expect(superseded.supersededBy).toBe(researchOutcome.id);
    // The low-confidence guess parked as Dormant and was superseded from there —
    // it never travelled toward execution.
    expect(superseded.history.map((t) => t.to)).toEqual([
      'Discovered',
      'Interpreting',
      'Dormant',
      'Superseded',
    ]);

    const research = h.core.engine.get(researchOutcome.id);
    expect(research.state).toBe('Interpreting');
    expect(research.constraints.some((c) => c.kind === 'scope' && c.description.includes('explicit approval'))).toBe(
      true,
    );

    // NO billing.cancel write occurred — nothing was cancelled (I2).
    expect(h.world.writesFor('billing.cancel')).toHaveLength(0);
    expect(h.world.writeCalls).toHaveLength(0);
    expect(h.world.subscriptions[0]!.status).toBe('active');
  });

  it('billing-research presents three options with the full consequence picture — still read-only', async () => {
    const h = makeHarness();
    seed(h);
    const { researchOutcome } = await driveThroughSupersession(h);

    const prep = await h.core.prepareOutcome(researchOutcome.id);
    if (prep.kind !== 'options') throw new Error('expected options');
    expect(prep.options).toHaveLength(3);
    expect(prep.options.map((o) => o.optionId)).toEqual(['at-term', 'immediate', 'keep']);

    const atTerm = prep.options.find((o) => o.optionId === 'at-term')!;
    expect(atTerm.label).toContain(RENEWAL);
    expect(atTerm.label).toContain('no early-termination fee');
    const immediate = prep.options.find((o) => o.optionId === 'immediate')!;
    expect(immediate.label).toContain('109.98');

    // The summary carries renewal date, owner, termination fee and team library usage.
    expect(prep.summary).toContain(RENEWAL);
    expect(prep.summary).toContain('owner Omar');
    expect(prep.summary).toContain('109.98');
    expect(prep.summary).toContain('team library used by 3 people');

    // Research is preparation, not action: no writes, and the outcome waits for the human.
    expect(h.world.writeCalls).toHaveLength(0);
    expect(h.core.engine.get(researchOutcome.id).state).toBe('Interpreting');
  });

  it('approval binds the exact mode; one submit; verifier reads effective date + confirmation ref (I5/I6)', async () => {
    const h = makeHarness();
    seed(h);
    const { researchOutcome } = await driveThroughSupersession(h);
    await h.core.prepareOutcome(researchOutcome.id); // options presented

    // Omar picks cancel-at-term.
    const prep = await h.core.prepareOutcome(researchOutcome.id, 'billing-cancel', {
      subscriptionId: SUB_ID,
      mode: 'at-term',
    });
    if (prep.kind !== 'action') throw new Error('expected action');
    expect(prep.signature.actionType).toBe('billing.cancel');
    expect(prep.signature.target).toBe(SUB_ID);
    expect(prep.signature.params.mode).toBe('at-term');
    expect(prep.signature.params.earlyTerminationFee).toBe(0);
    expect(prep.signature.params.renewalDate).toBe(RENEWAL);

    // approve() is only legal from AwaitingApproval — presentApproval must come first.
    expect(() => h.core.approve(researchOutcome.id, 'Omar', 'cancel at term')).toThrow(
      IllegalTransitionError,
    );

    h.core.presentApproval(researchOutcome.id, prep.summary, 'one at-term cancellation of Adobe CC');
    const approved = h.core.approve(researchOutcome.id, 'Omar', 'cancel Adobe at term only — no fee');

    // The approval binds the exact mode: a mutated "immediate" signature is refused.
    const mutated = {
      ...prep.signature,
      params: { ...prep.signature.params, mode: 'immediate', earlyTerminationFee: 109.98 },
    };
    expect(h.core.approvals.check(approved.approvalTokenId!, mutated).ok).toBe(false);

    // Submit once; the read-only verifier establishes the effective date (I6).
    const verify = await h.core.executeAndVerify(researchOutcome.id);
    expect(verify.status).toBe('verified');
    if (verify.status !== 'verified') throw new Error('unreachable');
    expect(verify.record.source).toBe('read:billing-account');
    expect(verify.record.evidence.effectiveDate).toBe(RENEWAL);
    expect(verify.record.evidence.confirmationRef).toBeTruthy();
    expect(verify.record.evidence.confirmationRef).toBe(
      h.world.subscriptions[0]!.cancellation!.confirmationRef,
    );

    // Exactly one billing.cancel write; the account really is cancel-at-term.
    expect(h.world.writesFor('billing.cancel')).toHaveLength(1);
    expect(h.world.subscriptions[0]!.status).toBe('cancel-at-term');
  });

  it('clean final period: the regular $54.99 charge is allowed; closes ground-truth only past the period end (I4)', async () => {
    const h = makeHarness();
    seed(h);
    const { researchOutcome } = await driveToVerified(h);

    const watch = startFinalPeriodWatch(h, researchOutcome.id);
    expect(h.core.engine.get(researchOutcome.id).state).toBe('Watching');

    // A Watching outcome closes ONLY via ground truth — action-was-outcome is refused.
    expect(() => h.core.closeAsActionWasOutcome(researchOutcome.id, { note: 'shortcut' })).toThrow(
      IllegalTransitionError,
    );

    // The regular monthly charge posts mid-period — allowed, so still Watching.
    h.clock.advanceDays(15);
    h.world.charges.push({
      subscriptionId: SUB_ID,
      amount: 54.99,
      chargedAt: h.clock.now().toISOString(),
      description: 'Adobe Creative Cloud monthly',
    });
    await h.core.watches.tick();
    expect(h.core.engine.get(researchOutcome.id).state).toBe('Watching');

    // Still inside the period a month later: still Watching (time has not run out).
    h.clock.advanceDays(30);
    await h.core.watches.tick();
    expect(h.core.engine.get(researchOutcome.id).state).toBe('Watching');

    // The clock passes the period end with no rogue charge -> closes on ground truth.
    h.clock.set('2026-09-17T09:00:00.000Z');
    await h.core.watches.tick();
    const closed = h.core.engine.get(researchOutcome.id);
    expect(closed.state).toBe('Closed');
    expect(closed.closure!.kind).toBe('ground-truth');
    expect(closed.closure!.evidence.finalPeriodClean).toBe(true);
    expect(h.core.watches.get(watch.id)!.state).toBe('satisfied');

    // Exactly one cancellation ever submitted, and the exact transition path:
    expect(h.world.writesFor('billing.cancel')).toHaveLength(1);
    expect(closed.history.map((t) => t.to)).toEqual([
      'Discovered',
      'Interpreting',
      'Prepared',
      'AwaitingApproval',
      'Approved',
      'Executing',
      'Executed',
      'Verifying',
      'Verified',
      'Watching',
      'Closed',
    ]);
  });

  it('a rogue $89.99 charge blocks closure: follow-up wanted, still Watching even past the period end (I4/I8)', async () => {
    const h = makeHarness();
    seed(h);
    const { researchOutcome } = await driveToVerified(h);

    const followUps: string[] = [];
    h.core.watches.registerFollowUp('no-rogue-charge', async (w) => {
      followUps.push(w.id);
    });
    const watch = startFinalPeriodWatch(h, researchOutcome.id, true);
    expect(h.core.engine.get(researchOutcome.id).state).toBe('Watching');

    // A ROGUE charge posts during the final period.
    h.clock.advanceDays(10);
    h.world.charges.push({
      subscriptionId: SUB_ID,
      amount: 89.99,
      chargedAt: h.clock.now().toISOString(),
      description: 'Adobe Stock add-on (never ordered)',
    });
    await h.core.watches.tick();

    // Not closed — and the evaluator wanted a follow-up (exactly one this window, I8).
    expect(h.core.engine.get(researchOutcome.id).state).toBe('Watching');
    expect(followUps).toHaveLength(1);

    h.clock.advanceDays(1);
    await h.core.watches.tick();
    expect(followUps).toHaveLength(1); // follow-up budget: one per window

    // Even past the period end, a rogue charge means NO clean-period closure (I4).
    h.clock.set('2026-09-17T09:00:00.000Z');
    await h.core.watches.tick();
    const still = h.core.engine.get(researchOutcome.id);
    expect(still.state).toBe('Watching');
    expect(still.closure).toBeUndefined();
    expect(h.core.watches.get(watch.id)!.state).toBe('active');
  });
});
