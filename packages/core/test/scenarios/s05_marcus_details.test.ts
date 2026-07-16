import { describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from '../helpers/harness.js';
import { IllegalTransitionError } from '../../src/engine/outcomeEngine.js';
import type { Entity } from '../../src/domain/types.js';

/**
 * Scenario 5 (§10.5) — "Send my boss the Marcus details."
 *
 * "Marcus" is a PROJECT here, not a person: resolved via Priya + the 4:00 meeting +
 * domain vocabulary, never name similarity (I9). Confirmed Jira facts are separated
 * from a coworker's secondhand rumor; Priya's authority limit ("do not promise
 * Monday") binds the draft. The email carries the real state, leaves the rumor out,
 * and never promises Monday. If the mention is genuinely ambiguous, Anticipy ASKS —
 * a human named Marcus is never contacted on similarity. The commitment was to SEND
 * the details, so verified delivery closes it as action-was-outcome (I4 boundary).
 */

const marcusProject: Entity = {
  id: 'proj-marcus-migration',
  type: 'project',
  names: ['Marcus migration project'],
  aliases: ['Marcus', 'the Marcus migration'],
  attributes: {
    descriptor: 'database migration project — the 4:00 sync with Priya is about it',
    vocabulary: 'migration,cutover,jira,sprint',
  },
};
const marcusLee: Entity = {
  id: 'person-marcus-lee',
  type: 'person',
  names: ['Marcus Lee'],
  aliases: ['Marcus'],
  attributes: {
    descriptor: 'designer on the brand team — no recent contact',
    email: 'marcus.lee@anticipationlabs.example',
  },
};
const marcusChen: Entity = {
  id: 'person-marcus-chen',
  type: 'person',
  names: ['Marcus Chen'],
  aliases: ['Marcus'],
  attributes: {
    descriptor: 'vendor account manager at Datalift',
    email: 'marcus.chen@datalift.example',
  },
};

const RUMOR_TEXT = 'migration might slip two weeks — heard secondhand';

function seed(h: Harness): void {
  h.core.resolver.addEntity(marcusProject);
  h.core.resolver.addEntity(marcusLee);
  h.core.resolver.addEntity(marcusChen);

  // Real, confirmed Jira state for the migration project.
  h.world.workItems.push(
    {
      key: 'MARC-101',
      project: 'marcus-migration',
      summary: 'Cutover runbook',
      status: 'In Review',
      assignee: 'Omar',
      updatedAt: '2026-07-15T18:00:00.000Z',
    },
    {
      key: 'MARC-102',
      project: 'marcus-migration',
      summary: 'Data backfill job',
      status: 'Done',
      assignee: 'Priya',
      updatedAt: '2026-07-14T12:00:00.000Z',
    },
    {
      key: 'MARC-103',
      project: 'marcus-migration',
      summary: 'Rollback plan',
      status: 'In Progress',
      assignee: 'Omar',
      updatedAt: '2026-07-16T08:30:00.000Z',
    },
  );
  // Confirmed facts come straight from the Jira integration, high confidence.
  for (const wi of h.world.workItems) {
    h.core.memory.add({
      subject: 'marcus-migration',
      predicate: `jira-${wi.key}`,
      value: `${wi.summary}: ${wi.status}`,
      source: { kind: 'integration', ref: `jira:${wi.key}` },
      confidence: 0.95,
    });
  }
  // A coworker's RUMOR: secondhand, low confidence, asserted by the coworker.
  h.core.memory.add({
    subject: 'marcus-migration',
    predicate: 'schedule-rumor',
    value: RUMOR_TEXT,
    source: { kind: 'utterance', ref: 'hallway-chat', assertedBy: 'coworker' },
    confidence: 0.3,
  });
}

const MONDAY_CONSTRAINT = 'do not promise a Monday completion';
const CANNED_DRAFT =
  'Hi Dana,\n\nCurrent state of the Marcus migration, straight from Jira: ' +
  'Cutover runbook (MARC-101) is In Review, Data backfill job (MARC-102) is Done, ' +
  'and Rollback plan (MARC-103) is In Progress. The cutover date is not locked yet; ' +
  'we will confirm as soon as the runbook clears review.\n\nOmar';

async function driveToPrepared(h: Harness) {
  const episode = h.core.startEpisode({
    participants: ['Omar', 'Priya'],
    evidence: [
      { kind: 'jira-board', ref: 'marcus-migration', data: { items: 3 } },
      { kind: 'calendar-event', ref: 'sync-1600', data: { title: 'Marcus migration — 4:00 sync' } },
    ],
  });
  h.core.addUtterance(episode.id, {
    speaker: 'Omar',
    text: 'Send my boss the Marcus details after the 4:00 sync.',
    channel: 'chat',
  });
  h.core.addUtterance(episode.id, {
    speaker: 'Priya',
    text: 'One thing — do not promise Monday completion. The cutover date is not ours to commit.',
    channel: 'meeting-voice',
  });

  h.llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'send-marcus-details',
        title: 'Send the boss the Marcus migration status',
        interpretedGoal:
          'email Dana (the boss) the real state of the Marcus migration PROJECT — confirmed Jira facts only',
        owner: 'Omar',
        classification: 'commitment',
        confidence: 0.9,
        constraints: [
          { kind: 'authority-limit', description: MONDAY_CONSTRAINT },
          { kind: 'exclusion', description: 'leave out the secondhand two-week-slip rumor; it is unconfirmed' },
        ],
        preparation: {
          kind: 'email-send',
          params: {
            from: 'omar@anticipationlabs.example',
            to: 'dana@anticipationlabs.example',
            subject: 'Marcus migration — current status',
          },
        },
      },
    ],
    facts: [],
  });
  const report = await h.core.interpretEpisode(episode.id);
  const outcome = report.created[0]!;

  h.llm.enqueue('draft-email', CANNED_DRAFT);
  const prep = await h.core.prepareOutcome(outcome.id);
  if (prep.kind !== 'action') throw new Error('expected action');
  return { outcome, prep };
}

describe('Scenario 5 — "Send my boss the Marcus details"', () => {
  it('resolves "Marcus" to the PROJECT via meeting context + vocabulary, not name similarity (I9)', () => {
    const h = makeHarness();
    seed(h);

    const resolution = h.core.resolveEntity('Marcus', {
      speaker: 'Omar',
      meetingContext: ['proj-marcus-migration'],
      vocabulary: ['migration', 'cutover', 'sprint'],
    });
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') throw new Error('unreachable');
    expect(resolution.resolution.entity.id).toBe('proj-marcus-migration');
    expect(resolution.resolution.entity.type).toBe('project');
    expect(resolution.resolution.confidence).toBeGreaterThanOrEqual(0.8);
    const kinds = resolution.resolution.evidence.map((e) => e.kind);
    expect(kinds).toContain('meeting-context');
    expect(kinds).toContain('domain-vocabulary');
  });

  it('a bare "Marcus" is two-ways ambiguous: it ASKS, and no human Marcus is contacted', () => {
    const h = makeHarness();
    seed(h);

    const bare = h.core.resolveEntity('Marcus', {});
    expect(bare.kind).toBe('ask');
    if (bare.kind !== 'ask') throw new Error('unreachable');
    expect(bare.request.question).toContain('Marcus');
    expect(bare.request.candidates.length).toBeGreaterThanOrEqual(2);
    // A DisambiguationRequest, not a resolution — therefore nothing was emailed
    // to Marcus Lee or Marcus Chen on name similarity.
    expect(h.core.resolver.pendingDisambiguations()).toHaveLength(1);
    expect(h.world.writesFor('email.send')).toHaveLength(0);
  });

  it('drafts the real Jira state, leaves out the rumor, honors "do not promise Monday" (authority limit)', async () => {
    const h = makeHarness();
    seed(h);
    const { outcome, prep } = await driveToPrepared(h);

    // The drafting prompt carried Priya's authority limit to the model.
    const draftReq = h.llm.seen.find((r) => r.tag === 'draft-email')!;
    expect(draftReq.prompt).toContain(MONDAY_CONSTRAINT);
    // Confirmed Jira facts were available as source facts.
    expect(draftReq.prompt).toContain('Cutover runbook: In Review');
    expect(draftReq.prompt).toContain('Data backfill job: Done');
    expect(draftReq.prompt).toContain('Rollback plan: In Progress');

    // The body states the real Jira state...
    const body = String(prep.signature.params.body);
    expect(body).toContain('MARC-101');
    expect(body).toContain('In Review');
    expect(body).toContain('MARC-102');
    expect(body).toContain('Done');
    expect(body).toContain('MARC-103');
    expect(body).toContain('In Progress');
    // ...does NOT carry the coworker's rumor...
    expect(body).not.toContain(RUMOR_TEXT);
    expect(body.toLowerCase()).not.toContain('slip');
    expect(body.toLowerCase()).not.toContain('two weeks');
    expect(body.toLowerCase()).not.toContain('secondhand');
    // ...and does NOT promise Monday.
    expect(body.toLowerCase()).not.toContain('monday');

    // Read-only so far: nothing sent (§5.5); approve() is illegal before the card (I5).
    expect(h.world.writeCalls).toHaveLength(0);
    expect(() => h.core.approve(outcome.id, 'Omar', 'send it')).toThrow(IllegalTransitionError);
  });

  it('approval binds exact recipient/subject/body; any drift is refused (I5)', async () => {
    const h = makeHarness();
    seed(h);
    const { outcome, prep } = await driveToPrepared(h);

    h.core.presentApproval(outcome.id, prep.summary, 'one status email to Dana (the boss)');
    const approved = h.core.approve(outcome.id, 'Omar', 'send this status email');
    expect(prep.signature.actionType).toBe('email.send');
    expect(prep.signature.target).toBe('dana@anticipationlabs.example');

    for (const drifted of [
      // never a human Marcus, and never any other recipient:
      { ...prep.signature, target: 'marcus.lee@anticipationlabs.example' },
      { ...prep.signature, params: { ...prep.signature.params, to: 'marcus.chen@datalift.example' } },
      { ...prep.signature, params: { ...prep.signature.params, subject: 'Other subject' } },
      { ...prep.signature, params: { ...prep.signature.params, body: `${CANNED_DRAFT}\nDone by Monday!` } },
    ]) {
      const check = h.core.approvals.check(approved.approvalTokenId!, drifted);
      expect(check.ok).toBe(false);
    }
  });

  it('sends exactly once, verifies via sent folder + recipient mailbox, closes as action-was-outcome (I4/I6)', async () => {
    const h = makeHarness();
    seed(h);
    const { outcome, prep } = await driveToPrepared(h);
    h.core.presentApproval(outcome.id, prep.summary, 'one status email to Dana (the boss)');
    h.core.approve(outcome.id, 'Omar', 'send this status email');

    const verify = await h.core.executeAndVerify(outcome.id);
    expect(verify.status).toBe('verified');
    if (verify.status !== 'verified') throw new Error('unreachable');
    expect(verify.record.source).toBe('read:sent-folder+recipient-mailbox');
    expect(verify.record.evidence.deliveredToRecipientMailbox).toBe(true);
    expect(verify.record.evidence.to).toBe('dana@anticipationlabs.example');

    // The boss's fixture mailbox holds the exact message; the rumor never left the building.
    const inbox = h.world.mailboxes.get('dana@anticipationlabs.example')!;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.subject).toBe('Marcus migration — current status');
    expect(inbox[0]!.body.toLowerCase()).not.toContain('slip');
    expect(inbox[0]!.body.toLowerCase()).not.toContain('monday');
    // No human Marcus was ever contacted.
    expect(h.world.mailboxes.get('marcus.lee@anticipationlabs.example')).toBeUndefined();
    expect(h.world.mailboxes.get('marcus.chen@datalift.example')).toBeUndefined();

    // Exactly one send.
    expect(h.world.writesFor('email.send')).toHaveLength(1);

    // The commitment was to SEND the details: verified delivery IS the outcome (I4 boundary).
    h.core.closeAsActionWasOutcome(outcome.id, verify.record.evidence);
    const closed = h.core.engine.get(outcome.id);
    expect(closed.state).toBe('Closed');
    expect(closed.closure!.kind).toBe('action-was-outcome');
    expect(h.core.watches.all()).toHaveLength(0);

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

    // Terminal: nothing further is legal.
    expect(() => h.core.engine.approve(outcome.id, 'Omar', 'again')).toThrow(IllegalTransitionError);
  });
});
