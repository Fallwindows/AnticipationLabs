import { describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from '../helpers/harness.js';
import { IllegalTransitionError } from '../../src/engine/outcomeEngine.js';
import { HOUR, DAY } from '../../src/util/clock.js';
import type { Entity } from '../../src/domain/types.js';

/**
 * Scenario 6 (§10.6) — OpenCall research.
 *
 * A research commitment only — not authorization to install, contact sales, change
 * prod, or migrate (I10). Resolve the product; check license, release activity, SIP,
 * data residency, pricing, interruption handling, migration cost; compare to the
 * current Twilio/ConversationRelay path. Surface a preliminary brief with unresolved
 * questions; the deep pass stays a durable open commitment. "Research" never becomes
 * "adopt".
 */

const TOPIC = 'OpenCall';

const FINDINGS = [
  'License: Apache-2.0 core with a commercial cloud tier; self-hosting is permitted.',
  'Release activity: monthly tagged releases, last one three weeks ago; active maintainers.',
  'SIP: native SIP trunking in and out; SIP REFER transfer support is unconfirmed.',
  'Data residency: managed tier is US-only today; self-host keeps call media in-region.',
  'Pricing: usage-based per-minute on the managed tier; self-host cost is infra plus ops time.',
  'Interruption handling: barge-in supported; docs are unclear on partial-utterance recovery.',
  'Migration cost vs the current Twilio/ConversationRelay path: webhook surface differs; rough estimate 2-3 weeks of adapter work and full re-testing of ConversationRelay features.',
].join('\n');

const OPEN_QUESTIONS = [
  'Does OpenCall support SIP REFER transfers to a human agent?',
  'Is EU data residency available on the managed tier, or only via self-host?',
  'How does interruption handling behave on partial utterances under packet loss?',
];

const BRIEF_TEXT =
  'Preliminary brief on OpenCall: Apache-2.0 core with active monthly releases; native SIP trunking (REFER unconfirmed); managed tier is US-only for data residency; per-minute pricing; barge-in works but partial-utterance recovery is undocumented; migrating off Twilio/ConversationRelay is roughly 2-3 weeks of adapter work. Research only — no install, no sales contact, no production change, no migration. Unresolved questions listed below; a deep pass stays open.';

const openCall: Entity = {
  id: 'product-opencall',
  type: 'product',
  names: ['OpenCall'],
  aliases: ['Open Call'],
  attributes: {
    descriptor: 'open-source voice/telephony platform',
    vocabulary: 'sip, telephony, voice',
  },
};

const twilio: Entity = {
  id: 'product-twilio',
  type: 'product',
  names: ['Twilio'],
  aliases: ['ConversationRelay'],
  attributes: {
    descriptor: 'current voice-stack vendor (ConversationRelay)',
    vocabulary: 'sip, telephony',
  },
};

function seed(h: Harness): void {
  h.core.resolver.addEntity(openCall);
  h.core.resolver.addEntity(twilio);
  h.core.memory.add({
    subject: 'voice-stack',
    predicate: 'current-path',
    value: 'Twilio ConversationRelay handles all production voice traffic',
    source: { kind: 'seed', ref: 'arch-notes' },
    confidence: 0.95,
  });
}

/** Interpret the episode and surface the preliminary brief; outcome stays Interpreting. */
async function driveToPreliminaryBrief(h: Harness) {
  const episode = h.core.startEpisode({
    participants: ['Omar'],
    evidence: [{ kind: 'chat-note', ref: 'voice-stack-thread', data: { topic: TOPIC } }],
  });
  h.core.addUtterance(episode.id, {
    speaker: 'Omar',
    text: 'Look into OpenCall for me — license, releases, SIP, data residency, pricing, how it handles interruptions, and what migrating off Twilio would cost. Research only: do NOT install anything, do not talk to their sales people, and obviously do not touch prod or migrate anything.',
    channel: 'chat',
  });

  h.llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'research-opencall',
        title: 'Research OpenCall as a possible voice-stack alternative',
        interpretedGoal:
          'produce a research brief on OpenCall (license, release activity, SIP, data residency, pricing, interruption handling, migration cost) compared to the current Twilio/ConversationRelay path — research only, never adoption',
        owner: 'Omar',
        classification: 'commitment',
        confidence: 0.9,
        constraints: [
          {
            kind: 'authority-limit',
            description:
              'research only — do not install, contact sales, change production, or migrate',
          },
          {
            kind: 'scope',
            description:
              'compare against the current Twilio/ConversationRelay path; the deliverable is a brief, not adoption',
          },
        ],
        preparation: {
          kind: 'research-brief',
          params: { topic: TOPIC, findings: FINDINGS, openQuestions: OPEN_QUESTIONS },
        },
      },
    ],
    facts: [],
  });
  const report = await h.core.interpretEpisode(episode.id);
  const outcome = report.created[0]!;

  // Resolve the product from context evidence, not name similarity alone.
  const resolution = h.core.resolveEntity('OpenCall', {
    speaker: 'Omar',
    explicitReferences: ['product-opencall'],
    vocabulary: ['sip', 'telephony'],
  });
  expect(resolution.kind).toBe('resolved');
  if (resolution.kind === 'resolved') {
    expect(resolution.resolution.entity.id).toBe('product-opencall');
  }

  // Read-only research pass -> preliminary brief with open questions.
  h.llm.enqueue('research-brief', BRIEF_TEXT);
  const prep = await h.core.prepareOutcome(outcome.id);
  if (prep.kind !== 'brief') throw new Error('expected brief');
  return { outcome, prep };
}

/** Deliver the preliminary brief via the internal chat.deliver-brief action, to Verified. */
async function deliverBrief(h: Harness, outcomeId: string) {
  const prep = await h.core.prepareOutcome(outcomeId, 'chat.deliver-brief', {
    topic: TOPIC,
    text: BRIEF_TEXT,
  });
  if (prep.kind !== 'action') throw new Error('expected action');
  h.core.presentApproval(outcomeId, prep.summary, 'one internal brief delivery in chat');
  h.core.approve(outcomeId, 'policy:internal-delivery', 'deliver the OpenCall brief in chat');
  const verify = await h.core.executeAndVerify(outcomeId);
  if (verify.status !== 'verified') throw new Error('verification failed');
  return { prep, verify };
}

describe('Scenario 6 — OpenCall research', () => {
  it('interpretation carries research-only constraints; the preliminary brief surfaces with open questions (I10)', async () => {
    const h = makeHarness();
    seed(h);
    const { outcome, prep } = await driveToPreliminaryBrief(h);

    // The constraints exist ON THE OUTCOME: research is not authorization (I10).
    const stored = h.core.engine.get(outcome.id);
    const authorityLimit = stored.constraints.find((c) => c.kind === 'authority-limit');
    expect(authorityLimit).toBeDefined();
    expect(authorityLimit!.description).toContain('research only');
    expect(authorityLimit!.description).toContain('do not install');
    expect(authorityLimit!.description).toContain('contact sales');
    expect(authorityLimit!.description).toContain('change production');
    expect(authorityLimit!.description).toContain('migrate');
    const scope = stored.constraints.find((c) => c.kind === 'scope');
    expect(scope).toBeDefined();
    expect(scope!.description).toContain('Twilio/ConversationRelay');

    // The result is a brief with the unresolved questions — not an action.
    expect(prep.kind).toBe('brief');
    if (prep.kind !== 'brief') throw new Error('unreachable');
    expect(prep.brief).toBe(BRIEF_TEXT);
    expect(prep.openQuestions).toEqual(OPEN_QUESTIONS);
    expect(prep.openQuestions.length).toBeGreaterThanOrEqual(2);
    // A brief does not advance the state machine: the human has seen research, not an act.
    expect(h.core.engine.get(outcome.id).state).toBe('Interpreting');

    // The brief was posted to chat, open questions attached.
    const chatBrief = h.core.chatRepo.all().find((m) => m.text === BRIEF_TEXT);
    expect(chatBrief).toBeDefined();
    expect(chatBrief!.outcomeId).toBe(outcome.id);
    expect((chatBrief!.payload as { openQuestions: string[] }).openQuestions).toEqual(
      OPEN_QUESTIONS,
    );

    // The research prompt covered every requested axis vs the current Twilio path.
    const researchReq = h.llm.seen.find((r) => r.tag === 'research-brief')!;
    for (const axis of ['License', 'Release activity', 'SIP', 'Data residency', 'Pricing', 'Interruption handling', 'Migration cost', 'Twilio/ConversationRelay']) {
      expect(researchReq.prompt).toContain(axis);
    }
    // The preparer told the model that adoption/sales/changes are out of scope (I10).
    expect(researchReq.system).toContain('out of scope');

    // Research touched nothing: zero side-effect attempts.
    expect(h.world.writeCalls).toHaveLength(0);
  });

  it('delivers the preliminary brief via the internal chat.deliver-brief action — same gate, exact transition path', async () => {
    const h = makeHarness();
    seed(h);
    const { outcome } = await driveToPreliminaryBrief(h);

    const prep = await h.core.prepareOutcome(outcome.id, 'chat.deliver-brief', {
      topic: TOPIC,
      text: BRIEF_TEXT,
    });
    if (prep.kind !== 'action') throw new Error('expected action');
    expect(prep.signature.actionType).toBe('chat.deliver-brief');
    expect(prep.signature.target).toBe('user');
    expect(prep.signature.params.topic).toBe(TOPIC);
    expect(prep.signature.params.text).toBe(BRIEF_TEXT);
    expect(h.core.engine.get(outcome.id).state).toBe('Prepared');

    // The internal action passes the SAME gate: approve() from Prepared is illegal.
    expect(() => h.core.approve(outcome.id, 'policy:internal-delivery', 'too early')).toThrow(
      IllegalTransitionError,
    );

    h.core.presentApproval(outcome.id, prep.summary, 'one internal brief delivery in chat');
    h.core.approve(outcome.id, 'policy:internal-delivery', 'deliver the OpenCall brief in chat');

    const verify = await h.core.executeAndVerify(outcome.id);
    expect(verify.status).toBe('verified');
    if (verify.status !== 'verified') throw new Error('unreachable');
    // Verified by the read-only chat-log read, never by the actor's own report (I6).
    expect(verify.record.source).toBe('read:chat-log');
    expect(verify.record.evidence.messageId).toBeTruthy();

    // The delivered brief is in the chat log as its own message.
    const delivered = h.core.chatRepo
      .all()
      .find((m) => String(m.id).startsWith('brief_') && m.text === BRIEF_TEXT);
    expect(delivered).toBeDefined();
    expect(delivered!.outcomeId).toBe(outcome.id);

    // Zero-external-side-effect action, full transition record, exactly:
    const final = h.core.engine.get(outcome.id);
    expect(final.history.map((t) => t.to)).toEqual([
      'Discovered',
      'Interpreting',
      'Prepared',
      'AwaitingApproval',
      'Approved',
      'Executing',
      'Executed',
      'Verifying',
      'Verified',
    ]);
    expect(final.history.find((t) => t.to === 'Approved')!.reason).toBe(
      'approved by policy:internal-delivery',
    );

    // Internal delivery never touches the world.
    expect(h.world.writeCalls).toHaveLength(0);
  });

  it('the deep pass stays a durable open commitment: ticks stay open, timeout notifies but NEVER closes (I4/I8)', async () => {
    const h = makeHarness();
    seed(h);
    const { outcome } = await driveToPreliminaryBrief(h);
    await deliverBrief(h, outcome.id);

    // Ground truth lives in test scope: the deep pass has not been delivered.
    let deepPassDelivered = false;
    h.core.watches.registerPoller('opencall-deep-pass-delivered', async () => ({
      deepPassDelivered,
    }));
    h.core.watches.registerEvaluator('opencall-deep-pass-delivered', (_watch, snapshot) =>
      snapshot.deepPassDelivered === true
        ? { met: true, evidence: { deepPassDelivered: true } }
        : { met: false },
    );

    const watch = h.core.startWatch({
      outcomeId: outcome.id,
      kind: 'custom',
      description: 'deep research pass on OpenCall remains an open commitment',
      closeCondition: {
        kind: 'opencall-deep-pass-delivered',
        params: { topic: TOPIC },
        description: 'closes only when the deep-pass brief is actually delivered',
      },
      // A short timeout — deliberately: passing it must notify, never close.
      timeoutAt: new Date(h.clock.now().getTime() + 6 * HOUR).toISOString(),
    });
    expect(h.core.engine.get(outcome.id).state).toBe('Watching');

    // Several polls come and go; the flag never flipped, so the commitment stays open.
    for (let i = 0; i < 3; i++) {
      h.clock.advanceHours(1);
      await h.core.watches.tick();
      expect(h.core.engine.get(outcome.id).state).toBe('Watching');
      expect(h.core.watches.get(watch.id)!.state).toBe('active');
    }

    // Blow past the timeout: the watch times out, the outcome does NOT close (I4).
    h.clock.advanceHours(4);
    await h.core.watches.tick();
    expect(h.core.watches.get(watch.id)!.state).toBe('timed-out');
    expect(h.core.engine.get(outcome.id).state).toBe('Watching');
    expect(h.core.engine.get(outcome.id).closure).toBeUndefined();

    // The timeout fired a notification instead of fabricating closure.
    const timeoutNotification = h.core.events
      .history()
      .find(
        (e) =>
          e.type === 'notification' &&
          e.notification.outcomeId === outcome.id &&
          e.notification.title === 'Watch timed out',
      );
    expect(timeoutNotification).toBeDefined();
    if (timeoutNotification?.type === 'notification') {
      expect(timeoutNotification.notification.body).toContain('stays open');
    }

    // Still nothing written anywhere.
    expect(h.world.writeCalls).toHaveLength(0);
  });

  it('research never becomes adopt: closes ONLY on ground truth, and the world shows zero writes end-to-end (I10)', async () => {
    const h = makeHarness();
    seed(h);
    const { outcome } = await driveToPreliminaryBrief(h);
    await deliverBrief(h, outcome.id);

    let deepPassDelivered = false;
    h.core.watches.registerPoller('opencall-deep-pass-delivered', async () => ({
      deepPassDelivered,
    }));
    h.core.watches.registerEvaluator('opencall-deep-pass-delivered', (_watch, snapshot) =>
      snapshot.deepPassDelivered === true
        ? { met: true, evidence: { deepPassDelivered: true } }
        : { met: false },
    );
    h.core.startWatch({
      outcomeId: outcome.id,
      kind: 'custom',
      description: 'deep research pass on OpenCall remains an open commitment',
      closeCondition: {
        kind: 'opencall-deep-pass-delivered',
        params: { topic: TOPIC },
        description: 'closes only when the deep-pass brief is actually delivered',
      },
    });
    expect(h.core.engine.get(outcome.id).state).toBe('Watching');

    // A Watching outcome refuses action-was-outcome closure — ground truth only.
    expect(() => h.core.closeAsActionWasOutcome(outcome.id, { note: 'nope' })).toThrow(
      IllegalTransitionError,
    );

    // Days pass without the deep pass — still open.
    h.clock.advance(2 * DAY);
    await h.core.watches.tick();
    expect(h.core.engine.get(outcome.id).state).toBe('Watching');

    // The deep pass lands (the world flag flips) — NOW ground truth closes it.
    deepPassDelivered = true;
    h.clock.advance(2 * HOUR);
    await h.core.watches.tick();
    const closed = h.core.engine.get(outcome.id);
    expect(closed.state).toBe('Closed');
    expect(closed.closure!.kind).toBe('ground-truth');
    expect(closed.closure!.evidence).toEqual({ deepPassDelivered: true });

    // "Research" never became "adopt": zero side-effect attempts of any kind, ever.
    expect(h.world.writeCalls).toHaveLength(0);
    expect(h.world.writesFor('email.send')).toHaveLength(0);
    expect(h.world.writesFor('telephony.call')).toHaveLength(0);
    expect(h.world.writesFor('billing.cancel')).toHaveLength(0);
    expect(h.world.sentMessages).toHaveLength(0);
    expect(h.world.calls).toHaveLength(0);
  });
});
