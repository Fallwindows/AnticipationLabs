import { describe, expect, it } from 'vitest';
import { makeApproved, makeHarness } from '../helpers/harness.js';
import type { ActionSignature } from '../../src/domain/types.js';

/**
 * Idempotency tests (§12, I7): simulate a post-submit timeout and assert the system
 * RE-READS for the existing result instead of re-submitting. It must never
 * double-submit.
 */
describe('Idempotency (I7)', () => {
  const returnSig: ActionSignature = {
    actionType: 'commerce.submit-return',
    target: 'order-114',
    params: {
      lineId: 'line-2',
      item: 'ceramic pot',
      reason: 'arrived damaged',
      method: 'whole-foods-dropoff',
      refundAmount: 34.2,
      refundDestination: 'Visa •• 4242',
    },
    pageVersionHash: 'returns-page-v7',
    disclosures: [],
  };

  function seedOrder(h: ReturnType<typeof makeHarness>): void {
    h.world.orderLines.push({
      orderId: 'order-114',
      lineId: 'line-2',
      item: 'ceramic pot',
      price: 34.2,
      currency: 'CAD',
      returnDeadline: '2026-07-30',
    });
  }

  it('post-submit timeout: the side effect landed, verification re-reads and finds it — no second submit', async () => {
    const h = makeHarness();
    seedOrder(h);
    // The classic trap: the adapter applies the side effect, then the confirmation
    // times out. The caller cannot know whether the write landed.
    h.world.failNextWriteWithTimeout.add('commerce.submit-return');

    const o = makeApproved(h, returnSig);
    const result = await h.core.executeAndVerify(o.id);

    expect(result.status).toBe('verified');
    if (result.status === 'verified') {
      expect(result.record.evidence.returnId).toBe('ret-001');
      expect(result.record.source).toBe('read:returns-page');
    }
    // exactly ONE submit ever reached the adapter
    expect(h.world.writesFor('commerce.submit-return')).toHaveLength(1);
    // and exactly one return exists
    expect(h.world.returns).toHaveLength(1);
    expect(h.core.engine.get(o.id).state).toBe('Verified');
  });

  it('the idempotency key is deterministic for outcome+signature', () => {
    const h = makeHarness();
    seedOrder(h);
    const o = makeApproved(h, returnSig);
    const k1 = h.core.actor.idempotencyKeyFor(h.core.engine.get(o.id));
    const k2 = h.core.actor.idempotencyKeyFor(h.core.engine.get(o.id));
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^idem_/);
  });

  it('recovery path re-reads through Verifying -> Executing -> Executed without touching the write port', async () => {
    const h = makeHarness();
    seedOrder(h);
    h.world.failNextWriteWithTimeout.add('commerce.submit-return');
    const o = makeApproved(h, returnSig);
    await h.core.executeAndVerify(o.id);

    const path = h.core.engine.get(o.id).history.map((t) => t.to);
    // one Executing only — the timeout recovery verified on the first read since the
    // fixture's side effect had landed
    expect(path.filter((s) => s === 'Executing')).toHaveLength(1);
    expect(h.world.writesFor('commerce.submit-return')).toHaveLength(1);
  });

  it('a well-behaved adapter dedupes on the idempotency key even if a submit is repeated at the port level', async () => {
    const h = makeHarness();
    seedOrder(h);
    const o = makeApproved(h, returnSig);
    await h.core.executeAndVerify(o.id);
    const key = h.core.engine.get(o.id).idempotencyKey!;
    // A rogue duplicate submit with the same key must not create a second return.
    const ports = h.world;
    expect(ports.returns).toHaveLength(1);
    const before = ports.returns.length;
    // simulate the duplicate at adapter level
    const { buildFixturePorts } = await import('../../src/integrations/fixtures/fixtureAdapters.js');
    const { write } = buildFixturePorts(h.world);
    await write.commerce.submitReturn(
      {
        orderId: 'order-114',
        lineId: 'line-2',
        reason: 'arrived damaged',
        method: 'whole-foods-dropoff',
        refundDestination: 'Visa •• 4242',
        pageVersionHash: 'returns-page-v7',
      },
      key,
    );
    expect(ports.returns.length).toBe(before);
  });
});
