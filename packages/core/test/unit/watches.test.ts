import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApproved, makeHarness } from '../helpers/harness.js';
import { HOUR, MINUTE, DAY } from '../../src/util/clock.js';

/**
 * Watch tests (§12, I8): controllable clock; follow-up windows (max one per window),
 * timeouts that notify but never close, retargeting when the world changes, and
 * close-only-on-ground-truth (I4). Plus restart survival (§5.9).
 */
describe('Watches (I8)', () => {
  async function watchedInvoice(h: ReturnType<typeof makeHarness>) {
    h.world.invoices.push({
      invoiceNumber: '1047',
      counterparty: 'Dana',
      amount: 1800,
      currency: 'CAD',
      dueDate: '2026-07-01',
      status: 'open',
    });
    const o = makeApproved(h);
    await h.core.executeAndVerify(o.id);
    const watch = h.core.startWatch({
      outcomeId: o.id,
      kind: 'ledger',
      description: 'invoice 1047 payment',
      closeCondition: {
        kind: 'ledger-payment-posted',
        params: { invoiceNumber: '1047', amount: 1800 },
        description: 'a matching ledger payment posts',
      },
      followUpAction: 'friendly-reminder',
    });
    return { o, watch };
  }

  it('closes the outcome ONLY when the ground-truth close condition is met', async () => {
    const h = makeHarness();
    const { o, watch } = await watchedInvoice(h);
    expect(h.core.engine.get(o.id).state).toBe('Watching');

    // Poll with nothing posted: stays open.
    h.clock.advance(6 * HOUR + MINUTE);
    await h.core.watches.tick();
    expect(h.core.engine.get(o.id).state).toBe('Watching');
    expect(h.core.watches.get(watch.id)!.state).toBe('active');

    // An email receipt is NOT a payment; only the ledger row closes it (I4).
    h.world.payments.push({
      invoiceNumber: '1047',
      amount: 1800,
      postedAt: h.clock.now().toISOString(),
      method: 'eft',
    });
    h.clock.advance(6 * HOUR + MINUTE);
    await h.core.watches.tick();
    expect(h.core.watches.get(watch.id)!.state).toBe('satisfied');
    const closed = h.core.engine.get(o.id);
    expect(closed.state).toBe('Closed');
    expect(closed.closure!.kind).toBe('ground-truth');
    expect((closed.closure!.evidence.payment as { amount: number }).amount).toBe(1800);
  });

  it('a partial payment does not satisfy the close condition', async () => {
    const h = makeHarness();
    const { o } = await watchedInvoice(h);
    h.world.payments.push({
      invoiceNumber: '1047',
      amount: 900,
      postedAt: h.clock.now().toISOString(),
      method: 'eft',
    });
    h.clock.advance(7 * HOUR);
    await h.core.watches.tick();
    expect(h.core.engine.get(o.id).state).toBe('Watching');
  });

  it('sends at most ONE follow-up per policy window', async () => {
    const h = makeHarness();
    const { watch } = await watchedInvoice(h);
    let followUps = 0;
    h.core.watches.registerFollowUp('ledger-payment-posted', async () => {
      followUps += 1;
    });

    // Six polls inside one 1-day window -> exactly one follow-up.
    for (let i = 0; i < 6; i++) {
      h.clock.advance(3 * HOUR);
      await h.core.watches.tick();
    }
    expect(followUps).toBe(1);

    // Next window opens -> exactly one more.
    h.clock.advance(DAY);
    await h.core.watches.tick();
    expect(followUps).toBe(2);
    expect(h.core.watches.get(watch.id)!.followUpsSentInWindow).toBe(1);
  });

  it('timeout notifies and marks the watch, but NEVER closes the outcome (I4)', async () => {
    const h = makeHarness();
    const { o, watch } = await watchedInvoice(h);
    h.clock.advance(15 * DAY);
    await h.core.watches.tick();
    expect(h.core.watches.get(watch.id)!.state).toBe('timed-out');
    // outcome still open:
    expect(h.core.engine.get(o.id).state).toBe('Watching');
    const notifications = h.core.events
      .history()
      .filter((e) => e.type === 'notification');
    expect(notifications.length).toBeGreaterThanOrEqual(1);
  });

  it('retargets when the world changes: "scheduled Friday" -> stay silent until Monday', async () => {
    const h = makeHarness({ start: '2026-07-16T09:00:00.000Z' }); // a Thursday
    const { watch } = await watchedInvoice(h);
    let followUps = 0;
    h.core.watches.registerFollowUp('ledger-payment-posted', async () => {
      followUps += 1;
    });

    // Dana says payment is scheduled Friday -> move the poll to Monday, reset budget.
    const monday = '2026-07-20T09:00:00.000Z';
    h.core.watches.retarget(watch.id, {
      nextPollAt: monday,
      reason: 'Dana confirmed payment scheduled Friday',
      resetFollowUpWindow: true,
    });

    // All weekend: no polls, no follow-ups — silence.
    h.clock.set('2026-07-18T12:00:00.000Z');
    await h.core.watches.tick();
    h.clock.set('2026-07-19T12:00:00.000Z');
    await h.core.watches.tick();
    expect(followUps).toBe(0);
    expect(h.core.watches.get(watch.id)!.lastPolledAt).toBeUndefined();

    // Monday: poll resumes.
    h.clock.set('2026-07-20T09:30:00.000Z');
    await h.core.watches.tick();
    expect(h.core.watches.get(watch.id)!.lastPolledAt).toBeTruthy();
  });

  it('watches survive a core restart (durable scheduler, §5.9)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anticipy-'));
    const dbPath = join(dir, 'core.sqlite3');
    try {
      const h1 = makeHarness({ dbPath });
      const { o, watch } = await watchedInvoice(h1);
      h1.core.close();

      // "restart": a fresh core over the same database
      const h2 = makeHarness({ dbPath });
      h2.clock.set('2026-07-16T09:00:00.000Z');
      h2.world.invoices.push({
        invoiceNumber: '1047',
        counterparty: 'Dana',
        amount: 1800,
        currency: 'CAD',
        dueDate: '2026-07-01',
        status: 'open',
      });
      h2.world.payments.push({
        invoiceNumber: '1047',
        amount: 1800,
        postedAt: h2.clock.now().toISOString(),
        method: 'eft',
      });
      expect(h2.core.watches.get(watch.id)!.state).toBe('active');
      h2.clock.advance(7 * HOUR);
      await h2.core.watches.tick();
      expect(h2.core.watches.get(watch.id)!.state).toBe('satisfied');
      expect(h2.core.engine.get(o.id).state).toBe('Closed');
      h2.core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancelling an outcome tears down its watches immediately (§9)', async () => {
    const h = makeHarness();
    const { o, watch } = await watchedInvoice(h);
    h.core.cancelOutcome(o.id, 'never mind');
    expect(h.core.engine.get(o.id).state).toBe('Cancelled');
    expect(h.core.watches.get(watch.id)!.state).toBe('cancelled');
  });
});
