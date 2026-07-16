import { describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from '../helpers/harness.js';
import { IllegalTransitionError } from '../../src/engine/outcomeEngine.js';
import type { CoreEvent } from '../../src/util/events.js';

/**
 * Scenario 8 (§10.8) — Missed connection / urgency changes channel.
 *
 * A gate announcement matters only after matching flight # + itinerary: DL999 noise
 * produces no outcome activity. The delay threatens tomorrow's 9am keynote — a hard
 * commitment — so the notification escalates to a CALL, not a passive card (I13).
 * "I'm screwed" is emotion, never authorization (I3). Preparation verifies the
 * authoritative airline status and presents REAL alternatives (Houston 8:10pm tonight
 * vs. 6am + hotel) with fare/seat/baggage; nothing is booked without a choice. After
 * the chosen rebooking, the verifier reads the new PNR/seat/baggage from the
 * reservation system (I6), the old itinerary is superseded, and a watch follows the
 * replacement flight until it actually departs (ground truth, I4).
 */

const START = '2026-07-16T18:00:00.000Z'; // 6pm at the airport
const TODAY = '2026-07-16';
const KEYNOTE_AT = '2026-07-17T09:00:00.000Z'; // 9am keynote tomorrow — 15h away

function seed(h: Harness): void {
  // Omar's ticketed itinerary: UA482 with a tight connection.
  h.world.reservations.push({
    pnr: 'ABC123',
    passenger: 'Omar',
    segments: [
      { flightNumber: 'UA482', departure: '2026-07-16T19:30:00.000Z', arrival: '2026-07-16T21:10:00.000Z' },
      { flightNumber: 'UA982', departure: '2026-07-16T21:55:00.000Z', arrival: '2026-07-17T00:20:00.000Z' },
    ],
    seat: '14C',
    baggageChecked: true,
    status: 'ticketed',
  });
  h.world.flightStatuses.push(
    {
      flightNumber: 'UA482',
      date: TODAY,
      status: 'delayed',
      scheduledDeparture: '2026-07-16T19:30:00.000Z',
      estimatedDeparture: '2026-07-16T21:40:00.000Z',
      connectionAtRisk: true,
    },
    // Unrelated airline noise: also delayed, but not on Omar's itinerary.
    {
      flightNumber: 'DL999',
      date: TODAY,
      status: 'delayed',
      scheduledDeparture: '2026-07-16T19:00:00.000Z',
      connectionAtRisk: true,
    },
    // The Houston replacement candidate, tonight.
    {
      flightNumber: 'UA1287',
      date: TODAY,
      status: 'on-time',
      scheduledDeparture: '2026-07-17T01:10:00.000Z',
    },
  );
  // Real alternatives with fare difference, seat, and baggage handling.
  h.world.alternatives.set('ABC123', [
    {
      optionId: 'UA1287',
      description: 'Tonight via Houston — UA1287 departing 8:10pm, lands 11:05pm',
      departure: '2026-07-17T01:10:00.000Z',
      arrival: '2026-07-17T04:05:00.000Z',
      fareDifference: 75,
      seat: '21C',
      baggageThrough: true,
    },
    {
      optionId: 'UA0606',
      description: 'Tomorrow 6:00am direct + overnight hotel near the airport',
      departure: '2026-07-17T11:00:00.000Z',
      arrival: '2026-07-17T13:05:00.000Z',
      fareDifference: 0,
      seat: '9A',
      baggageThrough: false,
    },
  ]);
}

/** "I'm screwed" — classified as emotion, the outcome parks Dormant (I3). */
async function driveToDormant(h: Harness) {
  const episode = h.core.startEpisode({
    participants: ['Omar'],
    evidence: [
      { kind: 'itinerary', ref: 'ABC123', data: { segments: ['UA482', 'UA982'] } },
      { kind: 'gate-announcement', ref: 'pa-ua482', data: { flightNumber: 'UA482', status: 'delayed' } },
    ],
  });
  h.core.addUtterance(episode.id, {
    speaker: 'Omar',
    text: "UA482 is delayed?! I'm screwed — the keynote is at 9am tomorrow.",
    channel: 'chat',
  });
  h.llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'make-keynote',
        title: 'Get Omar to the 9am keynote despite the UA482 delay',
        interpretedGoal:
          'Omar arrives in time for the 9am keynote tomorrow; UA482 delay puts the connection at risk',
        owner: 'Omar',
        classification: 'emotion',
        confidence: 0.9,
        constraints: [
          { kind: 'deadline', description: '9am keynote tomorrow is a hard commitment' },
        ],
      },
    ],
    facts: [],
  });
  const report = await h.core.interpretEpisode(episode.id);
  return { episode, outcome: report.created[0]! };
}

/** Omar actually asks for options — a commitment reopens the dormant outcome. */
async function driveToCommitment(h: Harness) {
  const { episode, outcome } = await driveToDormant(h);
  h.core.addUtterance(episode.id, {
    speaker: 'Omar',
    text: 'OK — find me another way there tonight. What are my real options?',
    channel: 'chat',
  });
  h.llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'make-keynote', // same key: new evidence reopens the dormant outcome
        title: 'Get Omar to the 9am keynote despite the UA482 delay',
        interpretedGoal:
          'rebook Omar around the delayed UA482 connection so he makes the 9am keynote tomorrow',
        owner: 'Omar',
        classification: 'commitment',
        confidence: 0.92,
        preparation: {
          kind: 'flight-alternatives',
          params: { pnr: 'ABC123', flightNumber: 'UA482', date: TODAY },
        },
      },
    ],
    facts: [],
  });
  const second = await h.core.interpretEpisode(episode.id);
  expect(second.reopened.map((o) => o.id)).toContain(outcome.id);
  return { episode, outcome };
}

describe('Scenario 8 — missed connection / urgency changes channel', () => {
  it('an announcement about an unrelated flight (DL999) produces no outcome activity', async () => {
    const h = makeHarness({ start: START });
    seed(h);
    const before = h.core.engine.all();

    const episode = h.core.startEpisode({
      participants: ['Omar'],
      evidence: [{ kind: 'gate-announcement', ref: 'pa-dl999', data: { flightNumber: 'DL999' } }],
    });
    h.core.addUtterance(episode.id, {
      speaker: 'PA system',
      text: 'Delta flight DL999 to Atlanta is delayed. We apologize for the inconvenience.',
      channel: 'ambient-audio',
    });
    // The interpreter matches announcements against the itinerary: DL999 is not on it.
    h.llm.enqueue('interpret-episode', { outcomes: [], facts: [] });
    const report = await h.core.interpretEpisode(episode.id);

    expect(report.created).toHaveLength(0);
    expect(report.reopened).toHaveLength(0);
    expect(report.dormant).toHaveLength(0);
    expect(h.core.engine.all()).toEqual(before);
    expect(h.core.engine.all()).toHaveLength(0);
    expect(h.world.writeCalls).toHaveLength(0);
  });

  it('a delay that breaks the 9am keynote is critical and CALLS the user, not a passive card (I13)', () => {
    const h = makeHarness({ start: START });
    seed(h);

    // 6pm today, hard 9am keynote tomorrow: 15h out and it breaks a real commitment.
    const urgency = h.core.channels.deriveUrgency({
      deadlineAt: KEYNOTE_AT,
      breaksHardCommitment: true,
    });
    expect(urgency).toBe('critical');
    expect(h.core.channels.channelFor(urgency)).toBe('call');
    // ...whereas a routine nudge would have been a quiet card.
    expect(h.core.channels.channelFor('low')).toBe('quiet-card');

    const ntf = h.core.notify({
      title: 'UA482 delayed — your connection is at risk',
      body: 'The delay threatens the 9am keynote. I have verified alternatives ready.',
      urgency,
    });
    expect(ntf.channel).toBe('call');

    const notifications = h.core.events
      .history()
      .filter((e): e is Extract<CoreEvent, { type: 'notification' }> => e.type === 'notification');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.notification.channel).toBe('call');
    expect(notifications[0]!.notification.urgency).toBe('critical');
  });

  it('"I\'m screwed" is emotion, not approval: the outcome parks Dormant and nothing is rebooked (I3)', async () => {
    const h = makeHarness({ start: START });
    seed(h);
    const { outcome } = await driveToDormant(h);

    const parked = h.core.engine.get(outcome.id);
    expect(parked.state).toBe('Dormant');
    expect(parked.dormantReason).toContain('emotion is not authorization (I3)');

    // Emotion never authorizes: approving from Dormant is an illegal edge...
    expect(() => h.core.approve(outcome.id, 'Omar', 'rebook me')).toThrow(IllegalTransitionError);
    // ...and dormant outcomes are not even prepared.
    await expect(h.core.prepareOutcome(outcome.id, 'flight-rebook', { pnr: 'ABC123', optionId: 'UA1287' }))
      .rejects.toThrow(/dormant outcomes are not prepared/i);

    expect(h.world.writesFor('airline.rebook')).toHaveLength(0);
    expect(h.world.writeCalls).toHaveLength(0);
  });

  it('verifies authoritative status and presents BOTH real alternatives with fare/seat/baggage; nothing booked', async () => {
    const h = makeHarness({ start: START });
    seed(h);
    const { outcome } = await driveToCommitment(h);

    const prep = await h.core.prepareOutcome(outcome.id);
    expect(prep.kind).toBe('options');
    if (prep.kind !== 'options') throw new Error('expected options');

    // The authoritative airline status was verified, not the announcement taken on faith.
    expect(prep.summary).toContain('Flight UA482 is delayed');
    expect(prep.summary).toContain('connection at risk');

    // Both real options, each carrying fare difference, seat, and baggage handling.
    expect(prep.options).toHaveLength(2);
    const houston = prep.options.find((o) => o.optionId === 'UA1287')!;
    const earlyMorning = prep.options.find((o) => o.optionId === 'UA0606')!;
    expect(houston.label).toContain('Houston');
    expect(houston.label).toContain('8:10pm');
    expect(houston.label).toContain('fare diff $75');
    expect(houston.label).toContain('21C');
    expect(houston.label).toContain('baggage through-checked');
    expect(earlyMorning.label).toContain('6:00am');
    expect(earlyMorning.label).toContain('hotel');
    expect(earlyMorning.label).toContain('fare diff $0');
    expect(earlyMorning.label).toContain('9A');
    expect(earlyMorning.label).toContain('baggage NOT through-checked');

    // Presenting options is read-only: nothing booked without a choice.
    expect(h.world.writeCalls).toHaveLength(0);
    expect(h.world.reservations.filter((r) => r.status === 'ticketed')).toHaveLength(1);
    expect(h.core.engine.get(outcome.id).state).toBe('Interpreting');
  });

  it('Omar picks Houston: approved rebooking verifies new PNR/seat/baggage (I6), supersedes the old itinerary, and watches the replacement to departure (I4)', async () => {
    const h = makeHarness({ start: START });
    seed(h);
    const { outcome } = await driveToCommitment(h);
    await h.core.prepareOutcome(outcome.id); // options surfaced; Omar chooses Houston

    const prep = await h.core.prepareOutcome(outcome.id, 'flight-rebook', {
      pnr: 'ABC123',
      optionId: 'UA1287',
    });
    if (prep.kind !== 'action') throw new Error('expected action');
    // The signature binds the exact choice: option, fare, seat, baggage.
    expect(prep.signature.actionType).toBe('airline.rebook');
    expect(prep.signature.target).toBe('ABC123');
    expect(prep.signature.params.optionId).toBe('UA1287');
    expect(prep.signature.params.fareDifference).toBe(75);
    expect(prep.signature.params.seat).toBe('21C');
    expect(prep.signature.params.baggageThrough).toBe(true);
    expect(prep.summary).toContain('$75');
    // Still nothing booked — approval comes first.
    expect(h.world.writesFor('airline.rebook')).toHaveLength(0);

    h.core.presentApproval(outcome.id, prep.summary, 'one rebooking of PNR ABC123');
    h.core.approve(outcome.id, 'Omar', 'rebook onto the Houston 8:10pm option');

    // Execute once; the independent verifier reads the reservation system (I6).
    const verify = await h.core.executeAndVerify(outcome.id);
    expect(verify.status).toBe('verified');
    if (verify.status !== 'verified') throw new Error('unreachable');
    expect(verify.record.source).toBe('read:reservation-system');
    const newPnr = String(verify.record.evidence.pnr);
    expect(newPnr).toBeTruthy();
    expect(newPnr).not.toBe('ABC123');
    expect(verify.record.evidence.seat).toBe('21C');
    expect(verify.record.evidence.baggageChecked).toBe(true);
    const segments = verify.record.evidence.segments as { flightNumber: string }[];
    expect(segments).toHaveLength(1);
    expect(segments[0]!.flightNumber).toBe('UA1287');
    expect(h.world.writesFor('airline.rebook')).toHaveLength(1);

    // The old itinerary is superseded; the replacement is ticketed.
    expect(h.world.reservations.find((r) => r.pnr === 'ABC123')!.status).toBe('superseded');
    expect(h.world.reservations.find((r) => r.pnr === newPnr)!.status).toBe('ticketed');

    // Watch the replacement flight; only ground truth closes it (I4).
    h.core.startWatch({
      outcomeId: outcome.id,
      kind: 'flight',
      description: `replacement flight ${segments[0]!.flightNumber} on ${TODAY}`,
      closeCondition: {
        kind: 'flight-completed',
        params: { flightNumber: segments[0]!.flightNumber, date: TODAY },
        description: 'the replacement flight actually departs',
      },
    });
    expect(h.core.engine.get(outcome.id).state).toBe('Watching');

    // Still on-time at the next poll: NOT closed — a schedule is not a departure.
    h.clock.advanceMinutes(5);
    await h.core.watches.tick();
    expect(h.core.engine.get(outcome.id).state).toBe('Watching');

    // The replacement actually departs — ground truth closes the outcome.
    const replacement = h.world.flightStatuses.find(
      (f) => f.flightNumber === 'UA1287' && f.date === TODAY,
    )!;
    replacement.status = 'departed';
    h.clock.advanceMinutes(5);
    await h.core.watches.tick();
    const closed = h.core.engine.get(outcome.id);
    expect(closed.state).toBe('Closed');
    expect(closed.closure!.kind).toBe('ground-truth');

    // Full transition record, including the Dormant park and reopen:
    expect(closed.history.map((t) => t.to)).toEqual([
      'Discovered',
      'Interpreting',
      'Dormant',
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
});
