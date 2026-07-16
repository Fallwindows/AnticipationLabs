import { describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from '../helpers/harness.js';
import type { Entity } from '../../src/domain/types.js';

/**
 * Scenario 4 (§10.4) — "I'll send the meeting notes."
 *
 * A direct commitment: correct Sarah Chen (two exist), a deadline, and an explicit
 * exclusion (no budget figures). Draft verified against source; approval binds exact
 * recipient/subject/body/attachment — any edit invalidates (I5). The independent
 * verifier confirms Sent AND the fixture recipient mailbox. Verified delivery closes
 * it because the promise was to SEND, not to obtain sign-off (the I4 boundary).
 */

const sarahMeridian: Entity = {
  id: 'person-sarah-meridian',
  type: 'person',
  names: ['Sarah Chen'],
  aliases: ['Sarah'],
  attributes: {
    descriptor: 'Meridian Partners — was in today\'s product review',
    email: 'sarah.chen@meridianpartners.example',
  },
};
const sarahVentures: Entity = {
  id: 'person-sarah-ventures',
  type: 'person',
  names: ['Sarah Chen'],
  aliases: ['Sarah'],
  attributes: {
    descriptor: 'Halcyon Ventures — no recent contact',
    email: 's.chen@halcyonvc.example',
  },
};

function seed(h: Harness): void {
  h.core.resolver.addEntity(sarahMeridian);
  h.core.resolver.addEntity(sarahVentures);
  h.core.memory.add({
    subject: 'product-review-meeting',
    predicate: 'attendees',
    value: 'Omar, Sarah Chen (Meridian Partners), Priya',
    source: { kind: 'evidence', ref: 'calendar-2026-07-16' },
    confidence: 0.97,
  });
  h.core.memory.add({
    subject: 'product-review-meeting',
    predicate: 'decisions',
    value: 'ship the beta July 28; Meridian gets weekly status emails; budget review moved to August',
    source: { kind: 'evidence', ref: 'meeting-notes-doc' },
    confidence: 0.9,
  });
}

async function driveToApproval(h: Harness) {
  const episode = h.core.startEpisode({
    participants: ['Omar', 'Sarah Chen'],
    evidence: [{ kind: 'calendar-event', ref: 'calendar-2026-07-16', data: { title: 'Product review' } }],
  });
  h.core.addUtterance(episode.id, {
    speaker: 'Omar',
    text: "I'll send you the meeting notes by end of day — everything except the budget figures, those aren't final.",
    channel: 'meeting-voice',
  });

  h.llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'send-notes',
        title: 'Send Sarah Chen the meeting notes',
        interpretedGoal:
          'send today\'s product-review notes to Sarah Chen (Meridian) by end of day, WITHOUT the budget figures',
        owner: 'Omar',
        classification: 'commitment',
        confidence: 0.93,
        constraints: [
          { kind: 'exclusion', description: 'no budget figures in the email' },
          { kind: 'deadline', description: 'send by end of day' },
          { kind: 'scope', description: 'the promise is to SEND notes, not to obtain sign-off' },
        ],
        preparation: {
          kind: 'email-send',
          params: {
            from: 'omar@anticipationlabs.example',
            to: 'sarah.chen@meridianpartners.example',
            subject: 'Product review notes — July 16',
            attachments: [{ name: 'product-review-2026-07-16.pdf', contentRef: 'notes-doc-v4' }],
          },
        },
      },
    ],
    facts: [],
  });
  const report = await h.core.interpretEpisode(episode.id);
  const outcome = report.created[0]!;

  // The resolver picks the RIGHT Sarah from meeting context, not name similarity (I9).
  const resolution = h.core.resolveEntity('Sarah', {
    speaker: 'Omar',
    meetingContext: ['person-sarah-meridian'],
    participants: ['person-sarah-meridian'],
  });
  expect(resolution.kind).toBe('resolved');
  if (resolution.kind === 'resolved') {
    expect(resolution.resolution.entity.id).toBe('person-sarah-meridian');
  }

  // Drafting checks each decision against source and honors the exclusion.
  h.llm.enqueue(
    'draft-email',
    'Hi Sarah,\n\nNotes from today: we ship the beta July 28, and Meridian will get weekly status emails. Full notes attached.\n\nBest,\nOmar',
  );
  const prep = await h.core.prepareOutcome(outcome.id);
  if (prep.kind !== 'action') throw new Error('expected action');
  h.core.presentApproval(outcome.id, prep.summary, 'one email to Sarah Chen (Meridian)');
  return { outcome, prep };
}

describe('Scenario 4 — meeting notes', () => {
  it('drafts against source, honors the budget exclusion, binds approval to the exact email (I5)', async () => {
    const h = makeHarness();
    seed(h);
    const { outcome, prep } = await driveToApproval(h);
    if (prep.kind !== 'action') throw new Error('unreachable');

    // The draft honors the exclusion: no budget content.
    expect(String(prep.signature.params.body).toLowerCase()).not.toContain('budget');
    expect(prep.signature.target).toBe('sarah.chen@meridianpartners.example');
    expect((prep.signature.params.attachments as { name: string }[])[0]!.name).toBe(
      'product-review-2026-07-16.pdf',
    );
    // The drafting prompt carried the exclusion to the model.
    const draftReq = h.llm.seen.find((r) => r.tag === 'draft-email')!;
    expect(draftReq.prompt).toContain('no budget figures');

    // Any edit invalidates: recipient, subject, body, or attachment (I5).
    const approved = h.core.approve(outcome.id, 'Omar', 'send this email');
    for (const mutate of [
      { ...prep.signature, target: 's.chen@halcyonvc.example' },
      { ...prep.signature, params: { ...prep.signature.params, subject: 'Other' } },
      { ...prep.signature, params: { ...prep.signature.params, body: 'Edited' } },
      { ...prep.signature, params: { ...prep.signature.params, attachments: [] } },
    ]) {
      const check = h.core.approvals.check(approved.approvalTokenId!, mutate);
      expect(check.ok).toBe(false);
    }
  });

  it('sends once, verifies via sent folder AND recipient mailbox, closes as action-was-outcome (I4/I6)', async () => {
    const h = makeHarness();
    seed(h);
    const { outcome } = await driveToApproval(h);
    h.core.approve(outcome.id, 'Omar', 'send this email');

    const verify = await h.core.executeAndVerify(outcome.id);
    expect(verify.status).toBe('verified');
    if (verify.status !== 'verified') throw new Error('unreachable');
    expect(verify.record.source).toBe('read:sent-folder+recipient-mailbox');
    expect(verify.record.evidence.deliveredToRecipientMailbox).toBe(true);
    expect(verify.record.evidence.messageId).toBeTruthy();
    expect(verify.record.evidence.attachments).toEqual(['product-review-2026-07-16.pdf']);

    // The recipient's fixture mailbox actually holds the exact message (§12).
    const inbox = h.world.mailboxes.get('sarah.chen@meridianpartners.example')!;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.subject).toBe('Product review notes — July 16');

    // The promise was to SEND: verified delivery closes it (I4 boundary) — no
    // sign-off watch, no follow-up obligation invented.
    h.core.closeAsActionWasOutcome(outcome.id, verify.record.evidence);
    const closed = h.core.engine.get(outcome.id);
    expect(closed.state).toBe('Closed');
    expect(closed.closure!.kind).toBe('action-was-outcome');
    expect(h.core.watches.all()).toHaveLength(0);

    // Exactly one send.
    expect(h.world.writesFor('email.send')).toHaveLength(1);

    // Full transition record:
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
      'Closed',
    ]);
  });

  it('an edit after approval forces re-approval before anything sends (I5)', async () => {
    const h = makeHarness();
    seed(h);
    const { outcome, prep } = await driveToApproval(h);
    if (prep.kind !== 'action') throw new Error('unreachable');
    h.core.approve(outcome.id, 'Omar', 'send this email');

    // Omar tweaks the body on the card -> back to AwaitingApproval, token dead.
    const edited = h.core.editAction(
      outcome.id,
      { ...prep.signature, params: { ...prep.signature.params, body: 'Shorter version.' } },
      'Omar',
    );
    expect(edited.state).toBe('AwaitingApproval');
    expect(h.world.writesFor('email.send')).toHaveLength(0);

    // Re-approve the new signature; now it sends the edited body.
    h.core.approve(outcome.id, 'Omar', 'send the edited email');
    const verify = await h.core.executeAndVerify(outcome.id);
    expect(verify.status).toBe('verified');
    expect(h.world.sentMessages[0]!.body).toBe('Shorter version.');
  });
});
