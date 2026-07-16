import { describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from '../helpers/harness.js';
import { IllegalTransitionError } from '../../src/engine/outcomeEngine.js';

/**
 * Scenario 3 (§10.3) — Dinner (location + prefs + availability + authority).
 *
 * "We should grab dinner sometime" is discussion, not a booking (I3): it parks
 * Dormant and nothing is searched or booked. "Next Thursday" reopens the same
 * episode key as a commitment. Preparation respects Daniel's vegetarian diet,
 * the quiet preference, travel time from the 6:30 meeting, availability,
 * deposits and cancellation terms — and the CORRECTED fact "Omar avoids Thai
 * only before flying" (I2) means Thai stays on the table since nobody flies
 * that day. The consequence is two-part and separately approved: book (reading
 * back reservation number + terms), then invite Daniel. A watch on Daniel's
 * reply closes only on acceptance; a decline reopens scheduling instead (I4).
 */

const OMAR_EMAIL = 'omar@anticipationlabs.example';
const DANIEL_EMAIL = 'daniel.reyes@personalmail.example';

function seed(h: Harness): void {
  // Four seeded restaurants: one Thai that fits everything (proving the corrected
  // fact wins), one quiet+veg bistro, and three that each violate one constraint.
  h.world.restaurants.push(
    {
      restaurantId: 'rest-thai',
      name: 'Baan Sabai',
      cuisine: 'Thai',
      noiseLevel: 'quiet',
      vegetarianFriendly: true,
      travelMinutesFromMeeting: 12,
      deposit: { amount: 25, currency: 'CAD' },
      cancellationPolicy: 'Free cancellation until 24h before; deposit refunded',
      availableSlots: ['19:15', '19:45'],
    },
    {
      restaurantId: 'rest-bistro',
      name: 'Verdure Bistro',
      cuisine: 'French',
      noiseLevel: 'quiet',
      vegetarianFriendly: true,
      travelMinutesFromMeeting: 18,
      cancellationPolicy: 'No deposit; cancel anytime',
      availableSlots: ['19:30'],
    },
    {
      restaurantId: 'rest-loud',
      name: 'Rumore Trattoria',
      cuisine: 'Italian',
      noiseLevel: 'loud', // violates "quiet"
      vegetarianFriendly: true,
      travelMinutesFromMeeting: 8,
      cancellationPolicy: 'No deposit',
      availableSlots: ['19:00'],
    },
    {
      restaurantId: 'rest-steak',
      name: 'Ember & Oak',
      cuisine: 'Steakhouse',
      noiseLevel: 'quiet',
      vegetarianFriendly: false, // violates Daniel's diet
      travelMinutesFromMeeting: 10,
      deposit: { amount: 50, currency: 'CAD' },
      cancellationPolicy: '48h notice required',
      availableSlots: ['19:30'],
    },
    {
      restaurantId: 'rest-far',
      name: 'Quiet Fern',
      cuisine: 'Vegetarian',
      noiseLevel: 'quiet',
      vegetarianFriendly: true,
      travelMinutesFromMeeting: 45, // violates travel time from the 6:30 meeting
      cancellationPolicy: 'No deposit',
      availableSlots: ['19:30'],
    },
  );

  // The 6:30pm meeting next Thursday that travel time is measured from.
  h.world.calendarEvents.push({
    id: 'cal-meridian-0723',
    title: 'Meridian sync',
    start: '2026-07-23T18:30:00.000Z',
    end: '2026-07-23T19:00:00.000Z',
    attendees: ['Omar'],
  });

  // Daniel is vegetarian.
  h.core.memory.add({
    subject: 'Daniel',
    predicate: 'diet',
    value: 'vegetarian',
    source: { kind: 'seed', ref: 'profile-daniel' },
    confidence: 0.95,
  });
  // OLD belief: Omar dislikes Thai...
  h.core.memory.add({
    subject: 'Omar',
    predicate: 'cuisine-note',
    value: 'dislikes Thai',
    source: { kind: 'inference', ref: 'old-episode' },
    confidence: 0.6,
  });
  // ...CORRECTED (I2): only before flying. Nobody flies next Thursday.
  h.core.memory.correct({
    subject: 'Omar',
    predicate: 'cuisine-note',
    value: 'avoids Thai only before flying (fine otherwise)',
    source: { kind: 'user-correction', ref: 'omar-correction' },
    confidence: 0.95,
  });
}

/** "We should grab dinner sometime" — discussion, parks Dormant (I3). */
async function driveDiscussion(h: Harness) {
  const episode = h.core.startEpisode({ participants: ['Omar', 'Daniel'] });
  h.core.addUtterance(episode.id, {
    speaker: 'Omar',
    text: 'We should grab dinner sometime, Daniel — somewhere quiet, and vegetarian-friendly for you.',
    channel: 'chat',
  });
  h.llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'dinner-daniel',
        title: 'Dinner with Daniel',
        interpretedGoal:
          'have dinner with Daniel at some point — no date fixed; talking about it is not booking it',
        owner: 'Omar',
        classification: 'discussion',
        confidence: 0.4,
        constraints: [
          { kind: 'preference', description: 'somewhere quiet' },
          { kind: 'preference', description: 'vegetarian-friendly — Daniel is vegetarian' },
        ],
      },
    ],
    facts: [],
  });
  const report = await h.core.interpretEpisode(episode.id);
  return { episode, dinner: report.created[0]! };
}

/** "Next Thursday" fixes the date: the SAME episode key reopens as a commitment. */
async function reopenNextThursday(h: Harness, episodeId: string) {
  h.core.addUtterance(episodeId, {
    speaker: 'Omar',
    text: "Let's lock it in: next Thursday the 23rd, right after my 6:30 meeting. I'll book somewhere and send you the invite.",
    channel: 'chat',
  });
  h.llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'dinner-daniel', // same key -> reopens the Dormant outcome
        title: 'Dinner with Daniel next Thursday',
        interpretedGoal:
          'book dinner with Daniel for Thursday 2026-07-23, reachable from the 18:30 meeting',
        owner: 'Omar',
        classification: 'commitment',
        confidence: 0.92,
        preparation: {
          kind: 'restaurant-search',
          // no avoidCuisine param: nobody flies that day, so the corrected Thai fact
          // does NOT exclude Thai. avoidCuisine would appear ONLY on a flying day.
          params: { date: '2026-07-23', maxTravelMinutes: 20 },
        },
      },
      {
        key: 'invite-daniel',
        title: 'Send Daniel the dinner invite',
        interpretedGoal: 'after booking, email Daniel the reservation details and watch his reply',
        owner: 'Omar',
        classification: 'commitment',
        confidence: 0.9,
        preparation: {
          kind: 'email-send',
          params: { from: OMAR_EMAIL, to: DANIEL_EMAIL, subject: 'Dinner next Thursday' },
        },
      },
    ],
    facts: [
      {
        subject: 'dinner-with-daniel',
        predicate: 'date',
        value: '2026-07-23 (next Thursday, after the 18:30 meeting)',
        confidence: 0.92,
      },
    ],
  });
  const report = await h.core.interpretEpisode(episodeId);
  return { dinner: report.reopened[0]!, invite: report.created[0]! };
}

/** Two-part consequence: (1) book — reading back number+terms; (2) separately approved invite. */
async function bookAndInvite(h: Harness, dinnerId: string, inviteId: string) {
  // Options first — the human picks Baan Sabai 19:15.
  const search = await h.core.prepareOutcome(dinnerId);
  if (search.kind !== 'options') throw new Error('expected options');

  const bookPrep = await h.core.prepareOutcome(dinnerId, 'restaurant-book', {
    restaurantId: 'rest-thai',
    slot: '19:15',
    partySize: 2,
  });
  if (bookPrep.kind !== 'action') throw new Error('expected action');
  // Options and preparation are not authority: approving without the card is illegal.
  expect(() => h.core.approve(dinnerId, 'Omar', 'book it')).toThrow(IllegalTransitionError);
  h.core.presentApproval(dinnerId, bookPrep.summary, 'one reservation at Baan Sabai');
  h.core.approve(dinnerId, 'Omar', 'book Baan Sabai, Thursday 19:15, party of 2');
  const bookVerify = await h.core.executeAndVerify(dinnerId);
  if (bookVerify.status !== 'verified') throw new Error('booking verification failed');
  const reservationNumber = String(bookVerify.record.evidence.reservationNumber);
  const terms = String(bookVerify.record.evidence.terms);

  // Part 2 — the invite, with its OWN approval; the body carries the reservation
  // number and terms just read back from the confirmation page.
  const body = [
    'Hi Daniel,',
    'Dinner is on for next Thursday (July 23) at 7:15pm — Baan Sabai. Quiet room, strong vegetarian menu, 12 minutes from my 6:30 meeting.',
    `Reservation ${reservationNumber}. Terms: ${terms}.`,
    'Omar',
  ].join('\n\n');
  const invitePrep = await h.core.prepareOutcome(inviteId, 'email-send', {
    from: OMAR_EMAIL,
    to: DANIEL_EMAIL,
    subject: 'Dinner next Thursday — Baan Sabai, 7:15pm',
    body,
  });
  if (invitePrep.kind !== 'action') throw new Error('expected action');
  h.core.presentApproval(inviteId, invitePrep.summary, 'one invite email to Daniel');
  h.core.approve(inviteId, 'Omar', 'send the invite');
  const inviteVerify = await h.core.executeAndVerify(inviteId);
  if (inviteVerify.status !== 'verified') throw new Error('invite verification failed');

  return { search, bookPrep, bookVerify, invitePrep, inviteVerify, reservationNumber, terms };
}

describe('Scenario 3 — dinner with Daniel', () => {
  it('"we should grab dinner sometime" is discussion, not a booking: parks Dormant, zero writes (I3)', async () => {
    const h = makeHarness();
    seed(h);
    const { dinner } = await driveDiscussion(h);

    const parked = h.core.engine.get(dinner.id);
    expect(parked.state).toBe('Dormant');
    expect(parked.dormantReason).toContain('discussion is not authorization (I3)');
    expect(parked.history.map((t) => t.to)).toEqual(['Discovered', 'Interpreting', 'Dormant']);

    // No restaurant search ran, nothing was booked, nothing was written anywhere.
    expect(h.world.writeCalls).toHaveLength(0);
    expect(h.world.bookings).toHaveLength(0);
    await expect(h.core.prepareOutcome(dinner.id)).rejects.toThrow(/dormant/i);
  });

  it('"next Thursday" reopens the same episode key: Dormant -> Interpreting, date resolved', async () => {
    const h = makeHarness();
    seed(h);
    const { episode, dinner } = await driveDiscussion(h);
    const reopened = await reopenNextThursday(h, episode.id);

    // The SAME outcome woke up — not a new one.
    expect(reopened.dinner.id).toBe(dinner.id);
    const current = h.core.engine.get(dinner.id);
    expect(current.state).toBe('Interpreting');
    expect(current.history.map((t) => t.to)).toEqual([
      'Discovered',
      'Interpreting',
      'Dormant',
      'Interpreting',
    ]);
    // WHICH Thursday got resolved and remembered.
    expect(h.core.memory.lookup('dinner-with-daniel', 'date')!.value).toContain('2026-07-23');
  });

  it('the correction supersedes "Omar dislikes Thai"; the old fact stays inspectable (I2)', () => {
    const h = makeHarness();
    seed(h);

    const active = h.core.memory.lookup('Omar', 'cuisine-note')!;
    expect(active.value).toBe('avoids Thai only before flying (fine otherwise)');

    const chain = h.core.memory.query({
      subject: 'Omar',
      predicate: 'cuisine-note',
      includeInactive: true,
    });
    expect(chain).toHaveLength(2);
    const old = chain.find((f) => f.value === 'dislikes Thai')!;
    expect(old.supersededBy).toBe(active.id);
    // Superseded fact is out of the active view but never deleted.
    expect(h.core.memory.query({ subject: 'Omar', predicate: 'cuisine-note' })).toHaveLength(1);
    expect(h.core.memory.inspect().some((f) => f.id === old.id)).toBe(true);
  });

  it('restaurant-search respects quiet + vegetarian + travel time; Thai IS an option (corrected fact wins); options carry deposit + cancellation', async () => {
    const h = makeHarness();
    seed(h);
    const { episode, dinner } = await driveDiscussion(h);
    await reopenNextThursday(h, episode.id);

    const prep = await h.core.prepareOutcome(dinner.id);
    if (prep.kind !== 'options') throw new Error('expected options');

    // Exactly the two that satisfy quiet + vegetarian + <=20 min from the meeting.
    const ids = prep.options.map((o) => o.optionId).sort();
    expect(ids).toEqual(['rest-bistro', 'rest-thai']);
    // The Thai restaurant IS among the options: nobody flies that day, so the
    // corrected fact does not exclude Thai — the stale "dislikes Thai" lost.
    expect(ids).toContain('rest-thai');
    expect(ids).not.toContain('rest-loud'); // fails quiet
    expect(ids).not.toContain('rest-steak'); // fails vegetarian
    expect(ids).not.toContain('rest-far'); // fails travel time from the 6:30 meeting

    // Every option is within travel range and carries cancellation (and deposit) info.
    for (const opt of prep.options) {
      const detail = opt.detail as {
        travelMinutesFromMeeting: number;
        cancellationPolicy: string;
        availableSlots: string[];
      };
      expect(detail.travelMinutesFromMeeting).toBeLessThanOrEqual(20);
      expect(detail.cancellationPolicy.length).toBeGreaterThan(0);
      expect(detail.availableSlots.length).toBeGreaterThan(0);
    }
    const thai = prep.options.find((o) => o.optionId === 'rest-thai')!;
    expect(thai.label).toContain('deposit CAD 25');
    expect((thai.detail as { deposit: unknown }).deposit).toEqual({ amount: 25, currency: 'CAD' });

    // The search applied quiet+veg+travel and NO cuisine exclusion (nobody flies).
    const applied = (prep.research as {
      constraintsApplied: {
        wantsQuiet: boolean;
        wantsVegetarian: boolean;
        avoidCuisines: string[];
        maxTravel: number;
      };
    }).constraintsApplied;
    expect(applied.wantsQuiet).toBe(true);
    expect(applied.wantsVegetarian).toBe(true);
    expect(applied.avoidCuisines).toEqual([]);
    expect(applied.maxTravel).toBe(20);

    // Options are read-only research: still nothing written.
    expect(h.world.writeCalls).toHaveLength(0);
  });

  it('two-part consequence, separately approved: book (reads reservation number + terms), then invite (verified via Daniel\'s mailbox)', async () => {
    const h = makeHarness();
    seed(h);
    const { episode, dinner } = await driveDiscussion(h);
    const { invite } = await reopenNextThursday(h, episode.id);
    const run = await bookAndInvite(h, dinner.id, invite.id);

    // Part 1: the booking signature bound deposit + cancellation terms.
    expect(run.bookPrep.kind).toBe('action');
    if (run.bookPrep.kind !== 'action') throw new Error('unreachable');
    expect(run.bookPrep.signature.actionType).toBe('reservation.book');
    expect(run.bookPrep.signature.target).toBe('rest-thai');
    expect(run.bookPrep.signature.params.deposit).toEqual({ amount: 25, currency: 'CAD' });
    expect(run.bookPrep.signature.params.cancellationPolicy).toBe(
      'Free cancellation until 24h before; deposit refunded',
    );
    expect(run.bookPrep.summary).toContain('Deposit CAD 25');
    expect(run.bookPrep.summary).toContain('Cancellation:');

    // The verifier READ the reservation number and terms from the confirmation.
    expect(h.world.writesFor('reservation.book')).toHaveLength(1);
    expect(h.world.bookings).toHaveLength(1);
    expect(run.reservationNumber).toBe(h.world.bookings[0]!.reservationNumber);
    expect(run.terms).toBe('Free cancellation until 24h before; deposit refunded');
    expect(run.bookVerify.record.source).toBe('read:reservation-confirmation');
    expect(run.bookVerify.record.evidence.slot).toBe('19:15');
    expect(run.bookVerify.record.evidence.partySize).toBe(2);

    // Part 2 rode a SEPARATE approval: two distinct single-use tokens.
    const dinnerToken = h.core.engine.get(dinner.id).approvalTokenId;
    const inviteToken = h.core.engine.get(invite.id).approvalTokenId;
    expect(dinnerToken).toBeTruthy();
    expect(inviteToken).toBeTruthy();
    expect(dinnerToken).not.toBe(inviteToken);

    // The invite verified independently via Daniel's mailbox, carrying number + terms.
    expect(run.inviteVerify.record.source).toBe('read:sent-folder+recipient-mailbox');
    expect(run.inviteVerify.record.evidence.deliveredToRecipientMailbox).toBe(true);
    const danielInbox = h.world.mailboxes.get(DANIEL_EMAIL)!;
    expect(danielInbox).toHaveLength(1);
    expect(danielInbox[0]!.body).toContain(`Reservation ${run.reservationNumber}`);
    expect(danielInbox[0]!.body).toContain(run.terms);
    expect(h.world.writesFor('email.send')).toHaveLength(1);

    // The invite's promise was to SEND: verified delivery closes it (I4 boundary).
    h.core.closeAsActionWasOutcome(invite.id, run.inviteVerify.record.evidence);
    const closedInvite = h.core.engine.get(invite.id);
    expect(closedInvite.state).toBe('Closed');
    expect(closedInvite.closure!.kind).toBe('action-was-outcome');
    expect(closedInvite.history.map((t) => t.to)).toEqual([
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

  it("a decline does NOT close the watch — scheduling reopens; only Daniel's acceptance closes on ground truth (I4)", async () => {
    const h = makeHarness();
    seed(h);
    const { episode, dinner } = await driveDiscussion(h);
    const { invite } = await reopenNextThursday(h, episode.id);
    const run = await bookAndInvite(h, dinner.id, invite.id);
    h.core.closeAsActionWasOutcome(invite.id, run.inviteVerify.record.evidence);

    // Watch Omar's mailbox for Daniel's reply — but a bare reply is not enough:
    // the custom close condition requires an ACCEPTING reply.
    h.core.startWatch({
      outcomeId: dinner.id,
      kind: 'reply',
      description: "Daniel's reply to the dinner invite",
      closeCondition: {
        kind: 'daniel-accepts',
        params: { mailbox: OMAR_EMAIL, from: DANIEL_EMAIL },
        description: 'Daniel accepts; a decline reopens scheduling instead of closing',
      },
    });
    expect(h.core.engine.get(dinner.id).state).toBe('Watching');

    h.core.watches.registerPoller('daniel-accepts', async (watch, read) => {
      const mailbox = String(watch.closeCondition.params.mailbox);
      const from = String(watch.closeCondition.params.from);
      const messages = await read.email.readMailbox(mailbox);
      return { replies: messages.filter((m) => m.from === from) };
    });
    let declineHandled = false;
    h.core.watches.registerEvaluator('daniel-accepts', (watch, snapshot) => {
      const replies = (snapshot.replies as { body: string }[] | undefined) ?? [];
      const accept = replies.find((r) => r.body.includes('See you there'));
      if (accept) return { met: true, evidence: { reply: accept } };
      const decline = replies.find((r) => r.body.includes('rain check'));
      if (decline && !declineHandled) {
        declineHandled = true;
        // A decline reopens scheduling: observable notification + a fresh outcome.
        h.core.notify({
          title: 'Daniel declined the dinner invite',
          body: 'Thursday no longer works for Daniel — reopening scheduling.',
          urgency: 'normal',
          outcomeId: watch.outcomeId,
        });
        const reschedule = h.core.engine.create({
          title: 'Reschedule dinner with Daniel',
          owner: 'Omar',
          originEpisodeId: episode.id,
          interpretedGoal:
            'pick a new evening with Daniel; the Baan Sabai booking may need to move or cancel',
          originClassification: 'signal',
        });
        h.core.engine.beginInterpretation(reschedule.id);
      }
      return { met: false };
    });

    // First poll: no reply yet — still Watching.
    h.clock.advanceMinutes(16);
    await h.core.watches.tick();
    expect(h.core.engine.get(dinner.id).state).toBe('Watching');

    // Daniel DECLINES. A reply arrived — but it is not the promised outcome.
    h.world.deliverToMailbox(OMAR_EMAIL, {
      messageId: 'msg-daniel-decline',
      from: DANIEL_EMAIL,
      to: OMAR_EMAIL,
      cc: [],
      subject: 'Re: Dinner next Thursday — Baan Sabai, 7:15pm',
      body: 'Ah, Thursday just fell apart on my end — can we take a rain check?',
      attachments: [],
      sentAt: h.clock.now().toISOString(),
    });
    h.clock.advanceMinutes(16);
    await h.core.watches.tick();

    expect(h.core.engine.get(dinner.id).state).toBe('Watching'); // NOT closed by a decline
    expect(h.core.watches.all().find((w) => w.outcomeId === dinner.id)!.state).toBe('active');
    // Scheduling observably reopened:
    expect(
      h.core.events
        .history()
        .some((e) => e.type === 'notification' && e.notification.title.includes('declined')),
    ).toBe(true);
    const reschedule = h.core.engine.all().find((o) => o.title === 'Reschedule dinner with Daniel');
    expect(reschedule).toBeDefined();
    expect(reschedule!.state).toBe('Interpreting');
    // And a Watching outcome cannot be closed by fiat — ground truth only (I4).
    expect(() => h.core.closeAsActionWasOutcome(dinner.id, { declined: true })).toThrow(
      IllegalTransitionError,
    );

    // Daniel comes back around: ACCEPTANCE is the ground truth that closes.
    h.world.deliverToMailbox(OMAR_EMAIL, {
      messageId: 'msg-daniel-accept',
      from: DANIEL_EMAIL,
      to: OMAR_EMAIL,
      cc: [],
      subject: 'Re: Dinner next Thursday — Baan Sabai, 7:15pm',
      body: 'Scratch that — I moved my thing. Thursday 7:15 at Baan Sabai is ON. See you there!',
      attachments: [],
      sentAt: h.clock.now().toISOString(),
    });
    h.clock.advanceMinutes(16);
    await h.core.watches.tick();

    const closed = h.core.engine.get(dinner.id);
    expect(closed.state).toBe('Closed');
    expect(closed.closure!.kind).toBe('ground-truth');
    expect((closed.closure!.evidence.reply as { body: string }).body).toContain('See you there');
    expect(h.core.watches.all().find((w) => w.outcomeId === dinner.id)!.state).toBe('satisfied');

    // The full life of the dinner outcome, exactly:
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
