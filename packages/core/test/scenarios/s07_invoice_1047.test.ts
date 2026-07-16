import { describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from '../helpers/harness.js';
import { IllegalTransitionError } from '../../src/engine/outcomeEngine.js';
import { HOUR, MINUTE } from '../../src/util/clock.js';

/**
 * Scenario 7 (§10.7) — Overdue invoice #1047.
 *
 * Verify the ledger is still unpaid AND read the Dana thread BEFORE acting (I4/I6).
 * Respect Omar's "2 business days past a promised date" buffer, friendly tone, and
 * never copy the CEO (I10). Send the nudge once and verify Sent — but the send is NOT
 * the outcome, so the Outcome stays open under a ledger watch (I4). On "scheduled
 * Friday" the watch retargets to Monday and stays silent all weekend (I8). An email
 * receipt from Dana never closes it; only the matching ledger payment does (I4).
 */

const OMAR = 'omar@anticipationlabs.example';
const DANA = 'dana@vireodesign.example';
/** Dana's promised payment date — a Monday, already in the past. */
const PROMISED_DATE = '2026-07-13';
const BUFFER_FACT = 'wait 2 business days past a promised date';
const CEO_EXCLUSION = 'do not copy the CEO';
const MONDAY_9 = '2026-07-20T09:00:00.000Z';

const FRIENDLY_NUDGE =
  'Hi Dana,\n\nHope the week is treating you well! Just a friendly nudge on invoice ' +
  '#1047 ($1,800) — I know accounting planned to send it along. No rush if it is ' +
  'already in flight, and happy to resend the invoice if that helps.\n\nThanks so much,\nOmar';

function seed(h: Harness): void {
  // Invoice 1047: open, $1800.
  h.world.invoices.push({
    invoiceNumber: '1047',
    counterparty: 'Dana (Vireo Design)',
    amount: 1800,
    currency: 'CAD',
    dueDate: '2026-07-01',
    status: 'open',
  });
  // The Dana thread lives in OMAR's mailbox: she promised payment by a now-past date.
  h.world.deliverToMailbox(OMAR, {
    messageId: 'msg-dana-promise',
    from: DANA,
    to: OMAR,
    subject: 'Re: Invoice #1047',
    body: `So sorry for the delay — accounting will send payment by ${PROMISED_DATE}, promise!`,
    sentAt: '2026-07-09T14:00:00.000Z',
  });
  // Omar's standing preferences in memory: the nudge buffer and the CEO exclusion.
  h.core.memory.add({
    subject: 'omar',
    predicate: 'invoice-nudge-buffer',
    value: BUFFER_FACT,
    source: { kind: 'seed', ref: 'omar-preferences' },
    confidence: 0.95,
  });
  h.core.memory.add({
    subject: 'omar',
    predicate: 'invoice-nudge-exclusion',
    value: CEO_EXCLUSION,
    source: { kind: 'seed', ref: 'omar-preferences' },
    confidence: 0.95,
  });
}

/** Weekdays strictly after `fromDate`, counted through `now` (UTC). */
function businessDaysSince(fromDate: string, now: Date): number {
  let count = 0;
  const d = new Date(`${fromDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getTime() <= now.getTime()) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

/**
 * Custom preparer (test-registered): read the ledger AND the thread before acting;
 * refuse if already paid or inside Omar's business-day buffer; otherwise produce a
 * friendly, cc-empty email-send signature. Read ports only — nothing fires here.
 */
function registerInvoiceNudge(h: Harness): void {
  h.core.preparation.register('invoice-nudge', async ({ read, memory, llm, outcome, params }) => {
    const invoiceNumber = String(params.invoiceNumber);
    const from = String(params.from);
    const to = String(params.to);

    // Ground truth first (I4/I6): is the invoice actually still unpaid?
    const invoice = await read.ledger.getInvoice(invoiceNumber);
    if (!invoice) throw new Error(`invoice ${invoiceNumber} not found in ledger`);
    const payments = await read.ledger.listPayments(invoiceNumber);
    const posted = payments.reduce((sum, p) => sum + p.amount, 0);
    if (invoice.status !== 'open' || posted >= invoice.amount) {
      throw new Error(`refusing to nudge: invoice ${invoiceNumber} already paid`);
    }

    // Read the Dana thread before acting — the promised date lives there.
    const thread = await read.email.readMailbox(from);
    const promisedDate = thread
      .filter((m) => m.from === to)
      .map((m) => /(\d{4}-\d{2}-\d{2})/.exec(m.body)?.[1])
      .find((d): d is string => Boolean(d));
    if (!promisedDate) throw new Error('refusing to nudge: no promised date found in the thread');

    // Omar's buffer preference (memory fact), enforced against the test clock.
    const bufferFact = memory.lookup('omar', 'invoice-nudge-buffer');
    if (!bufferFact) throw new Error('no nudge-buffer preference in memory');
    const bufferDays = Number(/(\d+)\s+business day/.exec(bufferFact.value)![1]);
    const elapsed = businessDaysSince(promisedDate, h.clock.now());
    if (elapsed <= bufferDays) {
      throw new Error(
        `refusing to nudge: only ${elapsed} business day(s) past the promised date ` +
          `${promisedDate}; Omar's buffer is ${bufferDays} business days`,
      );
    }

    const body = await llm.complete({
      tag: 'draft-email',
      system: 'Draft a friendly nudge. Copy nobody. Honor every exclusion strictly.',
      prompt: [
        `Goal: ${outcome.interpretedGoal}`,
        `Hard constraints: ${outcome.constraints.map((c) => c.description).join('; ')}`,
        `Promised in thread: payment by ${promisedDate} (now ${elapsed} business days past)`,
      ].join('\n'),
    });

    return {
      kind: 'action',
      signature: {
        actionType: 'email.send',
        target: to,
        params: {
          from,
          to,
          cc: [], // never the CEO — never anyone (I10)
          subject: 'Friendly nudge: invoice #1047',
          body,
          attachments: [],
        },
        pageVersionHash: `ledger-${invoiceNumber}-open-v1`,
        disclosures: [],
      },
      summary: `Send a friendly nudge about invoice #${invoiceNumber} ($${invoice.amount}) to ${to}; nobody cc'd.`,
      research: {
        invoiceStatus: invoice.status,
        paymentsSeen: payments.length,
        promisedDate,
        elapsedBusinessDays: elapsed,
      },
    };
  });
}

async function driveToInterpreted(h: Harness) {
  const episode = h.core.startEpisode({
    participants: ['Omar'],
    evidence: [{ kind: 'ledger-invoice', ref: 'inv-1047', data: { amount: 1800, status: 'open' } }],
  });
  h.core.addUtterance(episode.id, {
    speaker: 'Omar',
    text:
      'Invoice 1047 to Dana is overdue. Nudge her — friendly, and do NOT copy the CEO. ' +
      'And respect my rule: wait two business days past whatever date she promised.',
    channel: 'chat',
  });
  h.llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'collect-1047',
        title: 'Get invoice #1047 paid',
        interpretedGoal:
          'invoice #1047 ($1800) is PAID — a friendly nudge to Dana is a step, not the outcome',
        owner: 'Omar',
        classification: 'commitment',
        confidence: 0.9,
        constraints: [
          { kind: 'exclusion', description: CEO_EXCLUSION, params: { field: 'cc' } },
          { kind: 'buffer', description: BUFFER_FACT },
          { kind: 'preference', description: 'friendly tone' },
        ],
        preparation: {
          kind: 'invoice-nudge',
          params: { invoiceNumber: '1047', from: OMAR, to: DANA },
        },
      },
    ],
    facts: [],
  });
  const report = await h.core.interpretEpisode(episode.id);
  return report.created[0]!;
}

describe('Scenario 7 — overdue invoice #1047', () => {
  it('reads the ledger BEFORE acting and refuses when the invoice is already paid (I4/I6)', async () => {
    const h = makeHarness(); // Thu 2026-07-16 — buffer would be satisfied
    seed(h);
    registerInvoiceNudge(h);
    // The ledger already shows a full payment — nudging would be wrong.
    h.world.payments.push({
      invoiceNumber: '1047',
      amount: 1800,
      postedAt: '2026-07-15T10:00:00.000Z',
      method: 'eft',
    });
    const outcome = await driveToInterpreted(h);

    await expect(h.core.prepareOutcome(outcome.id)).rejects.toThrow(/already paid/);
    // Refusal happened on the ledger read, before any drafting or side effect.
    expect(h.llm.seen.filter((r) => r.tag === 'draft-email')).toHaveLength(0);
    expect(h.world.writeCalls).toHaveLength(0);
    expect(h.core.engine.get(outcome.id).state).toBe('Interpreting');
  });

  it('unpaid: reads the Dana thread, drafts a friendly nudge with EMPTY cc — no CEO (I10)', async () => {
    const h = makeHarness(); // D+3 business days past the promise
    seed(h);
    registerInvoiceNudge(h);
    const outcome = await driveToInterpreted(h);

    h.llm.enqueue('draft-email', FRIENDLY_NUDGE);
    const prep = await h.core.prepareOutcome(outcome.id);
    if (prep.kind !== 'action') throw new Error('expected action');

    // The thread was actually read: the promised date came out of Dana's message.
    expect(prep.research!.promisedDate).toBe(PROMISED_DATE);
    expect(prep.research!.invoiceStatus).toBe('open');
    expect(prep.research!.elapsedBusinessDays).toBe(3);

    // The final consequential screen: one friendly email to Dana, cc EMPTY.
    expect(prep.signature.actionType).toBe('email.send');
    expect(prep.signature.target).toBe(DANA);
    expect(prep.signature.params.cc).toEqual([]);
    expect(prep.signature.params.body).toBe(FRIENDLY_NUDGE);
    expect(String(prep.signature.params.body)).toContain('friendly nudge');
    // The drafting prompt carried the CEO exclusion and the buffer to the model.
    const draftReq = h.llm.seen.find((r) => r.tag === 'draft-email')!;
    expect(draftReq.prompt).toContain(CEO_EXCLUSION);
    expect(draftReq.prompt).toContain(BUFFER_FACT);

    // Preparation is read-only: nothing sent yet (§5.5).
    expect(h.world.writeCalls).toHaveLength(0);
    expect(h.core.engine.get(outcome.id).state).toBe('Prepared');
  });

  it("respects Omar's buffer: refuses at D+1 business day, proceeds at D+3", async () => {
    // Tue 2026-07-14 = exactly 1 business day past the Monday promise.
    const h = makeHarness({ start: '2026-07-14T09:00:00.000Z' });
    seed(h);
    registerInvoiceNudge(h);
    const outcome = await driveToInterpreted(h);

    await expect(h.core.prepareOutcome(outcome.id)).rejects.toThrow(
      /only 1 business day\(s\) past the promised date/,
    );
    expect(h.world.writeCalls).toHaveLength(0);
    expect(h.core.engine.get(outcome.id).state).toBe('Interpreting');

    // Thu 2026-07-16 = 3 business days past the promise: the buffer is respected.
    h.clock.set('2026-07-16T09:00:00.000Z');
    h.llm.enqueue('draft-email', FRIENDLY_NUDGE);
    const prep = await h.core.prepareOutcome(outcome.id);
    if (prep.kind !== 'action') throw new Error('expected action');
    expect(prep.research!.elapsedBusinessDays).toBe(3);
    expect(h.core.engine.get(outcome.id).state).toBe('Prepared');
  });

  it('sends once & verifies Sent, but the outcome stays OPEN; only the matching ledger payment closes it (I4/I8)', async () => {
    const h = makeHarness(); // Thu 2026-07-16 09:00
    seed(h);
    registerInvoiceNudge(h);
    const outcome = await driveToInterpreted(h);
    h.llm.enqueue('draft-email', FRIENDLY_NUDGE);
    const prep = await h.core.prepareOutcome(outcome.id);
    if (prep.kind !== 'action') throw new Error('expected action');

    h.core.presentApproval(outcome.id, prep.summary, 'one friendly nudge email to Dana');
    h.core.approve(outcome.id, 'Omar', 'send this nudge');
    const verify = await h.core.executeAndVerify(outcome.id);
    expect(verify.status).toBe('verified');
    if (verify.status !== 'verified') throw new Error('unreachable');
    expect(verify.record.source).toBe('read:sent-folder+recipient-mailbox');
    expect(verify.record.evidence.deliveredToRecipientMailbox).toBe(true);

    // Exactly one send; cc empty on the wire; the nudge landed in Dana's mailbox only.
    expect(h.world.writesFor('email.send')).toHaveLength(1);
    expect(h.world.sentMessages[0]!.cc).toEqual([]);
    expect(h.world.mailboxes.get(DANA)).toHaveLength(1);
    expect([...h.world.mailboxes.keys()].sort()).toEqual([DANA, OMAR].sort());
    // No CEO anywhere: not in the audit trail, not in any world artifact.
    const blob = JSON.stringify({
      audit: h.core.audit.all(),
      writeCalls: h.world.writeCalls,
      sent: h.world.sentMessages,
      mailboxes: [...h.world.mailboxes.entries()],
    }).toLowerCase();
    expect(blob).not.toContain('ceo@');

    // The send is NOT the outcome (I4): watch the ledger, keep the Outcome open.
    const watch = h.core.startWatch({
      outcomeId: outcome.id,
      kind: 'ledger',
      description: 'invoice #1047: a matching $1800 payment posts to the ledger',
      closeCondition: {
        kind: 'ledger-payment-posted',
        params: { invoiceNumber: '1047', amount: 1800 },
        description: 'a matching ledger payment posts',
      },
      followUpAction: 'friendly-reminder',
    });
    expect(h.core.engine.get(outcome.id).state).toBe('Watching');
    expect(h.core.engine.get(outcome.id).history.map((t) => t.to)).toEqual([
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
    ]);
    // Watching outcomes close ONLY on ground truth — "the send was the outcome" is illegal here.
    expect(() => h.core.closeAsActionWasOutcome(outcome.id, { sent: true })).toThrow(
      IllegalTransitionError,
    );

    // Dana emails "payment sent!" — a receipt is NOT a ledger row; it does not close (I4).
    h.world.deliverToMailbox(OMAR, {
      messageId: 'msg-dana-receipt',
      from: DANA,
      to: OMAR,
      subject: 'Re: Friendly nudge: invoice #1047',
      body: 'payment sent!',
      sentAt: h.clock.now().toISOString(),
    });
    h.clock.advance(6 * HOUR + MINUTE);
    await h.core.watches.tick();
    expect(h.core.engine.get(outcome.id).state).toBe('Watching');
    expect(h.core.watches.get(watch.id)!.state).toBe('active');

    // A PARTIAL payment ($900 of $1800) does not satisfy the close condition either.
    h.world.payments.push({
      invoiceNumber: '1047',
      amount: 900,
      postedAt: h.clock.now().toISOString(),
      method: 'eft',
    });
    h.clock.advance(6 * HOUR + MINUTE);
    await h.core.watches.tick();
    expect(h.core.engine.get(outcome.id).state).toBe('Watching');

    // Dana: "the rest is scheduled Friday" -> move the poll to Monday, stay silent (I8).
    let followUps = 0;
    h.core.watches.registerFollowUp('ledger-payment-posted', async () => {
      followUps += 1;
    });
    h.core.watches.retarget(watch.id, {
      nextPollAt: MONDAY_9,
      reason: 'Dana confirmed the remaining payment is scheduled Friday',
      resetFollowUpWindow: true,
    });
    const lastPollBeforeWeekend = h.core.watches.get(watch.id)!.lastPolledAt;

    // All weekend: no polls, ZERO follow-ups — silence.
    h.clock.set('2026-07-18T12:00:00.000Z'); // Saturday
    await h.core.watches.tick();
    h.clock.set('2026-07-19T12:00:00.000Z'); // Sunday
    await h.core.watches.tick();
    expect(followUps).toBe(0);
    expect(h.core.watches.get(watch.id)!.lastPolledAt).toBe(lastPollBeforeWeekend);
    expect(h.core.engine.get(outcome.id).state).toBe('Watching');

    // Monday: the matching $1800 ledger payment posts — NOW it closes, on ground truth.
    h.world.payments.push({
      invoiceNumber: '1047',
      amount: 1800,
      postedAt: '2026-07-20T08:45:00.000Z',
      method: 'eft',
    });
    h.clock.set('2026-07-20T09:30:00.000Z');
    await h.core.watches.tick();
    expect(h.core.watches.get(watch.id)!.state).toBe('satisfied');
    const closed = h.core.engine.get(outcome.id);
    expect(closed.state).toBe('Closed');
    expect(closed.closure!.kind).toBe('ground-truth');
    expect((closed.closure!.evidence.payment as { amount: number }).amount).toBe(1800);
    expect(followUps).toBe(0);
  });
});
