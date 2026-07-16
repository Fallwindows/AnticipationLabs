import { describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from '../helpers/harness.js';
import { HOUR, DAY } from '../../src/util/clock.js';

/**
 * Scenario 2 (§10.2) — Ambiguous Amazon return.
 *
 * Two order lines (bamboo plant, ceramic pot). The correction supersedes the first
 * guess — the POT, not the plant (I2). Preparation reaches the final screen: deadline,
 * $34.20 to the original Visa, Whole Foods free drop-off, reason "arrived damaged".
 * Approval binds item+reason+refund+method+page (I5). On post-submit timeout the
 * existing return ID is found — never re-clicked (I7). QR retrieved; watch spans
 * drop-off and refund; the plant is explicitly NOT returned; closes only when the
 * refund posts (I4).
 */

function seed(h: Harness): void {
  h.world.orderLines.push(
    {
      orderId: 'amz-7719',
      lineId: 'line-plant',
      item: 'Bamboo plant (live)',
      price: 24.99,
      currency: 'CAD',
      deliveredAt: '2026-07-14T15:00:00.000Z',
      returnDeadline: '2026-08-13',
    },
    {
      orderId: 'amz-7719',
      lineId: 'line-pot',
      item: 'Ceramic planter pot, 8"',
      price: 34.2,
      currency: 'CAD',
      deliveredAt: '2026-07-14T15:00:00.000Z',
      returnDeadline: '2026-08-13',
    },
  );
  h.world.returnOptions.set('amz-7719/line-pot', {
    lineId: 'line-pot',
    methods: [
      { method: 'whole-foods-dropoff', fee: 0, description: 'Whole Foods drop-off (free, no box needed)' },
      { method: 'ups-pickup', fee: 7.99, description: 'UPS pickup' },
    ],
    refundDestination: 'Visa ••4242 (original payment method)',
    windowEndsAt: '2026-08-13',
    pageVersionHash: 'returns-page-2026-07-16-v3',
  });
  h.world.returnOptions.set('amz-7719/line-plant', {
    lineId: 'line-plant',
    methods: [{ method: 'ups-pickup', fee: 7.99, description: 'UPS pickup' }],
    refundDestination: 'Visa ••4242 (original payment method)',
    windowEndsAt: '2026-08-13',
    pageVersionHash: 'returns-page-2026-07-16-v3',
  });
}

async function driveThroughCorrection(h: Harness) {
  const episode = h.core.startEpisode({
    participants: ['Omar'],
    evidence: [{ kind: 'amazon-order', ref: 'amz-7719', data: { lines: 2 } }],
  });

  // First guess: the plant.
  h.core.addUtterance(episode.id, {
    speaker: 'Omar',
    text: 'That Amazon order came cracked — start a return for the plant, I guess.',
    channel: 'chat',
  });
  h.llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'return-plant',
        title: 'Return the bamboo plant',
        interpretedGoal: 'return the damaged item from order amz-7719 — first guess: the plant',
        owner: 'Omar',
        classification: 'commitment',
        confidence: 0.7,
        preparation: {
          kind: 'commerce-return',
          params: { orderId: 'amz-7719', lineId: 'line-plant', reason: 'arrived damaged' },
        },
      },
    ],
    facts: [],
  });
  const first = await h.core.interpretEpisode(episode.id);
  const plantOutcome = first.created[0]!;

  // Correction, later in the same episode: the POT cracked, not the plant (I2).
  h.core.addUtterance(episode.id, {
    speaker: 'Omar',
    text: 'Actually wait — the plant is fine. It was the ceramic POT that arrived cracked. Return that.',
    channel: 'chat',
  });
  h.llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'return-pot',
        title: 'Return the ceramic pot',
        interpretedGoal:
          'return the cracked ceramic pot from order amz-7719; the plant is explicitly NOT returned',
        owner: 'Omar',
        classification: 'commitment',
        confidence: 0.95,
        supersedesKey: 'return-plant',
        constraints: [{ kind: 'exclusion', description: 'do not return the bamboo plant' }],
        preparation: {
          kind: 'commerce-return',
          params: { orderId: 'amz-7719', lineId: 'line-pot', reason: 'arrived damaged' },
        },
      },
    ],
    facts: [],
  });
  const second = await h.core.interpretEpisode(episode.id);
  const potOutcome = second.created[0]!;
  return { plantOutcome, potOutcome };
}

describe('Scenario 2 — ambiguous Amazon return', () => {
  it('the correction supersedes the first guess: pot, not plant (I2)', async () => {
    const h = makeHarness();
    seed(h);
    const { plantOutcome, potOutcome } = await driveThroughCorrection(h);
    expect(h.core.engine.get(plantOutcome.id).state).toBe('Superseded');
    expect(h.core.engine.get(plantOutcome.id).supersededBy).toBe(potOutcome.id);
    expect(h.core.engine.get(potOutcome.id).state).toBe('Interpreting');
  });

  it('prepares to the final screen and binds approval to item+reason+refund+method+page (I5)', async () => {
    const h = makeHarness();
    seed(h);
    const { potOutcome } = await driveThroughCorrection(h);

    const prep = await h.core.prepareOutcome(potOutcome.id);
    if (prep.kind !== 'action') throw new Error('expected action');
    // The final consequential screen, exactly:
    expect(prep.signature.actionType).toBe('commerce.submit-return');
    expect(prep.signature.target).toBe('amz-7719');
    expect(prep.signature.params.item).toBe('Ceramic planter pot, 8"');
    expect(prep.signature.params.reason).toBe('arrived damaged');
    expect(prep.signature.params.refundAmount).toBe(34.2);
    expect(prep.signature.params.refundDestination).toBe('Visa ••4242 (original payment method)');
    expect(prep.signature.params.method).toBe('whole-foods-dropoff');
    expect(prep.signature.pageVersionHash).toBe('returns-page-2026-07-16-v3');
    expect(prep.summary).toContain('34.20');
    expect(prep.summary).toContain('2026-08-13');
    // Read-only so far: nothing submitted (§5.5).
    expect(h.world.writeCalls).toHaveLength(0);

    // Approval binds the exact signature; a drifted signature is refused.
    h.core.presentApproval(potOutcome.id, prep.summary, 'one return submission');
    const approved = h.core.approve(potOutcome.id, 'Omar', 'submit this return');
    const drifted = {
      ...prep.signature,
      params: { ...prep.signature.params, refundDestination: 'gift card balance' },
    };
    const check = h.core.approvals.check(approved.approvalTokenId!, drifted);
    expect(check.ok).toBe(false);
  });

  it('post-submit timeout finds the existing return ID and never re-clicks (I7); QR retrieved; closes only when the refund posts (I4)', async () => {
    const h = makeHarness();
    seed(h);
    const { plantOutcome, potOutcome } = await driveThroughCorrection(h);
    const prep = await h.core.prepareOutcome(potOutcome.id);
    if (prep.kind !== 'action') throw new Error('expected action');
    h.core.presentApproval(potOutcome.id, prep.summary, 'one return submission');
    h.core.approve(potOutcome.id, 'Omar', 'submit this return');

    // The submit lands but the confirmation times out (the I7 trap).
    h.world.failNextWriteWithTimeout.add('commerce.submit-return');
    const verify = await h.core.executeAndVerify(potOutcome.id);
    expect(verify.status).toBe('verified');
    if (verify.status !== 'verified') throw new Error('unreachable');

    // Exactly one submission ever reached Amazon; the existing return was found by re-read.
    expect(h.world.writesFor('commerce.submit-return')).toHaveLength(1);
    expect(h.world.returns).toHaveLength(1);
    const returnId = String(verify.record.evidence.returnId);
    expect(returnId).toBe(h.world.returns[0]!.returnId);
    // QR code retrieved for the drop-off.
    expect(verify.record.evidence.qrCodeRef).toBeTruthy();

    // Watch: drop-off then refund; closes ONLY when the refund posts to the Visa (I4).
    h.core.startWatch({
      outcomeId: potOutcome.id,
      kind: 'refund',
      description: 'refund $34.20 to Visa ••4242',
      closeCondition: {
        kind: 'refund-posted',
        params: {
          returnId,
          amount: 34.2,
          destination: 'Visa ••4242 (original payment method)',
        },
        description: 'refund posts to the original payment method',
      },
    });
    expect(h.core.engine.get(potOutcome.id).state).toBe('Watching');

    // Drop-off happens — still not closed: a QR scan is not a refund (I4).
    h.world.returns[0]!.status = 'dropped-off';
    h.clock.advance(13 * HOUR);
    await h.core.watches.tick();
    expect(h.core.engine.get(potOutcome.id).state).toBe('Watching');

    // Amazon receives it — still not closed.
    h.world.returns[0]!.status = 'received';
    h.clock.advance(13 * HOUR);
    await h.core.watches.tick();
    expect(h.core.engine.get(potOutcome.id).state).toBe('Watching');

    // The refund posts to the ORIGINAL Visa — now it closes.
    h.world.returns[0]!.status = 'refunded';
    h.world.refunds.push({
      returnId,
      amount: 34.2,
      destination: 'Visa ••4242 (original payment method)',
      postedAt: h.clock.now().toISOString(),
    });
    h.clock.advance(13 * HOUR);
    await h.core.watches.tick();
    const closed = h.core.engine.get(potOutcome.id);
    expect(closed.state).toBe('Closed');
    expect(closed.closure!.kind).toBe('ground-truth');

    // The plant was never returned (explicitly excluded).
    expect(h.core.engine.get(plantOutcome.id).state).toBe('Superseded');
    expect(h.world.returns.every((r) => r.lineId === 'line-pot')).toBe(true);
    expect(
      h.core.engine.get(potOutcome.id).constraints.some((c) => c.description.includes('plant')),
    ).toBe(true);
  });

  it('a wrong-destination refund does not close the outcome (I4)', async () => {
    const h = makeHarness();
    seed(h);
    const { potOutcome } = await driveThroughCorrection(h);
    const prep = await h.core.prepareOutcome(potOutcome.id);
    if (prep.kind !== 'action') throw new Error('expected action');
    h.core.presentApproval(potOutcome.id, prep.summary, 'one return submission');
    h.core.approve(potOutcome.id, 'Omar', 'submit this return');
    const verify = await h.core.executeAndVerify(potOutcome.id);
    if (verify.status !== 'verified') throw new Error('verification failed');
    const returnId = String(verify.record.evidence.returnId);
    h.core.startWatch({
      outcomeId: potOutcome.id,
      kind: 'refund',
      description: 'refund watch',
      closeCondition: {
        kind: 'refund-posted',
        params: { returnId, amount: 34.2, destination: 'Visa ••4242 (original payment method)' },
        description: 'refund posts to the original payment method',
      },
    });
    // Refund lands as a gift-card credit instead — NOT the approved destination.
    h.world.refunds.push({
      returnId,
      amount: 34.2,
      destination: 'gift card balance',
      postedAt: h.clock.now().toISOString(),
    });
    h.clock.advance(DAY);
    await h.core.watches.tick();
    expect(h.core.engine.get(potOutcome.id).state).toBe('Watching');
  });
});
