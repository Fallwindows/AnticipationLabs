import { AgentCore } from '../app/agentCore.js';
import { FixtureWorld } from '../integrations/fixtures/fixtureWorld.js';
import { buildFixturePorts } from '../integrations/fixtures/fixtureAdapters.js';
import { FixtureProvider } from '../llm/fixtureProvider.js';
import { SequentialIdSource } from '../util/ids.js';
import { TestClock, MINUTE } from '../util/clock.js';
import { StaticKeyProvider } from '../memory/vault.js';
import { signatureHash } from '../approval/approvals.js';

/**
 * Console demo: scenario 8 (missed connection) end-to-end on fixtures.
 * Demonstrates: emotion is not approval (I3), urgency escalates the channel (I13),
 * real alternatives with fare/seat/baggage, tamper-proof approval binding (I5),
 * independent verification of the new PNR (I6), supersession of the old itinerary,
 * and a ground-truth watch on the replacement flight (I4/I8).
 * Run: pnpm --filter @anticipy/core demo:flight
 */
const say = (s: string): void => console.log(s);
const hr = (t: string): void => console.log(`\n━━━ ${t} ${'━'.repeat(Math.max(0, 60 - t.length))}`);

async function demo(): Promise<void> {
  const clock = new TestClock('2026-07-17T20:30:00.000Z'); // evening at the airport
  const world = new FixtureWorld();
  world.now = () => clock.now().toISOString();
  const ports = buildFixturePorts(world);
  const llm = new FixtureProvider();

  const core = new AgentCore({
    dbPath: ':memory:',
    llm,
    read: ports.read,
    write: ports.write,
    clock,
    ids: new SequentialIdSource(),
    keyProvider: new StaticKeyProvider(),
  });

  core.events.on((e) => {
    if (e.type === 'outcome.changed' && e.from !== e.to) {
      say(`      [state]  ${e.from ?? '∅'} → ${e.to}${e.reason ? `   (${e.reason})` : ''}`);
    }
    if (e.type === 'notification') {
      say(`      [notify] channel=${e.notification.channel} urgency=${e.notification.urgency}  "${e.notification.title}: ${e.notification.body}"`);
    }
  });

  // -- the world tonight -------------------------------------------------------
  world.reservations.push({
    pnr: 'OMR482',
    passenger: 'Omar',
    segments: [{ flightNumber: 'UA482', departure: '2026-07-17T21:15:00.000Z', arrival: '2026-07-18T02:40:00.000Z' }],
    seat: '14A',
    baggageChecked: true,
    status: 'ticketed',
  });
  world.flightStatuses.push({
    flightNumber: 'UA482',
    date: '2026-07-17',
    status: 'delayed',
    scheduledDeparture: '2026-07-17T21:15:00.000Z',
    estimatedDeparture: '2026-07-17T23:50:00.000Z',
    connectionAtRisk: true,
  });
  world.alternatives.set('OMR482', [
    {
      optionId: 'UA1885',
      description: 'Via Houston, departs 20:10 tonight, lands 07:05 — before the keynote',
      departure: '2026-07-17T22:10:00.000Z',
      arrival: '2026-07-18T07:05:00.000Z',
      fareDifference: 0,
      seat: '21C',
      baggageThrough: true,
    },
    {
      optionId: 'UA0600',
      description: '6:00 a.m. direct + airport hotel tonight, lands 08:35 — tight',
      departure: '2026-07-18T06:00:00.000Z',
      arrival: '2026-07-18T08:35:00.000Z',
      fareDifference: -120,
      seat: '8D',
      baggageThrough: false,
    },
  ]);
  core.memory.add({
    subject: 'Omar',
    predicate: 'keynote',
    value: 'Friday 9:00 a.m. — hard commitment, cannot slip',
    source: { kind: 'evidence', ref: 'calendar' },
    confidence: 0.97,
  });

  hr('20:30 — gate announcement matches Omar’s itinerary (UA482, PNR OMR482)');
  const episode = core.startEpisode({
    participants: ['Omar'],
    evidence: [{ kind: 'gate-announcement', ref: 'UA482', data: { status: 'delayed', connectionAtRisk: true } }],
  });
  core.addUtterance(episode.id, { speaker: 'Omar', text: "I'm screwed.", channel: 'chat' });
  llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'keynote-arrival',
        title: 'Get Omar to the 9 a.m. keynote despite the missed connection',
        interpretedGoal: 'protect the Friday 9:00 keynote; current itinerary no longer achieves it',
        owner: 'Omar',
        classification: 'emotion',
        confidence: 0.9,
        constraints: [{ kind: 'deadline', description: 'must arrive before Friday 9:00 a.m. keynote' }],
      },
    ],
    facts: [],
  });
  say('  Omar: "I\'m screwed."');
  const first = await core.interpretEpisode(episode.id);
  const outcome = first.created[0]!;
  say(`      → interpreter classified this as EMOTION, not approval (I3).`);
  say(`      → airline write calls so far: ${world.writesFor('airline.rebook').length} (nothing booked)`);

  hr('The deadline makes this urgent → the channel is a CALL, not a quiet card (I13)');
  const urgency = core.channels.deriveUrgency({
    deadlineAt: '2026-07-18T09:00:00.000Z',
    breaksHardCommitment: true,
  });
  core.notify({
    title: 'Your connection is at risk',
    body: 'UA482 is delayed ~2.5h; the 9 a.m. keynote is in danger. I have alternatives ready.',
    urgency,
    outcomeId: outcome.id,
  });

  hr('Omar answers: "Okay — what are my options?"');
  core.addUtterance(episode.id, { speaker: 'Omar', text: 'Okay — what are my options?', channel: 'call' });
  llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'keynote-arrival',
        title: 'Get Omar to the 9 a.m. keynote despite the missed connection',
        interpretedGoal: 'rebook onto an itinerary that protects the keynote',
        owner: 'Omar',
        classification: 'commitment',
        confidence: 0.95,
        constraints: [{ kind: 'deadline', description: 'must arrive before Friday 9:00 a.m. keynote' }],
      },
    ],
    facts: [],
  });
  await core.interpretEpisode(episode.id);

  const options = await core.prepareOutcome(outcome.id, 'flight-alternatives', {
    pnr: 'OMR482',
    flightNumber: 'UA482',
    date: '2026-07-17',
  });
  if (options.kind !== 'options') throw new Error('expected options');
  say(`  Anticipy verified the AUTHORITATIVE airline status first: ${options.summary}`);
  for (const o of options.options) say(`      option ${o.optionId}: ${o.label}`);
  say(`      → still nothing booked without a choice: ${world.writesFor('airline.rebook').length} write calls`);

  hr('Omar picks Houston. Anticipy prepares the exact rebooking and asks (I5)');
  const prep = await core.prepareOutcome(outcome.id, 'flight-rebook', { pnr: 'OMR482', optionId: 'UA1885' });
  if (prep.kind !== 'action') throw new Error('expected action');
  core.presentApproval(outcome.id, prep.summary, 'one rebooking of PNR OMR482 onto UA1885');
  say('  ┌─ APPROVAL CARD ───────────────────────────────────────────');
  say(`  │ action      ${prep.signature.actionType}`);
  say(`  │ target PNR  ${prep.signature.target}`);
  for (const [k, v] of Object.entries(prep.signature.params)) say(`  │ ${k.padEnd(14)}${JSON.stringify(v)}`);
  say(`  │ signature   ${signatureHash(prep.signature).slice(0, 16)}…  (single-use, any edit voids it)`);
  say('  └───────────────────────────────────────────────────────────');

  // Tamper check: what if something swapped the option after approval was granted?
  const approved = core.approve(outcome.id, 'Omar', 'rebook onto UA1885 exactly as shown');
  const tampered = { ...prep.signature, params: { ...prep.signature.params, optionId: 'UA0600' } };
  const check = core.approvals.check(approved.approvalTokenId!, tampered);
  say(`  Tamper test — same token, option swapped to UA0600: authorized=${check.ok ? 'YES (BUG!)' : 'NO — signature-mismatch (I5 holds)'}`);

  hr('Execute once → verify independently against the reservation system (I6)');
  const verify = await core.executeAndVerify(outcome.id);
  if (verify.status !== 'verified') throw new Error(`verification failed: ${verify.status}`);
  const ev = verify.record.evidence;
  say(`  Verifier read (source: ${verify.record.source}):`);
  say(`      new PNR ${String(ev.pnr)}, seat ${String(ev.seat)}, baggage through-checked: ${String(ev.baggageChecked)}`);
  const oldRes = world.reservations.find((r) => r.pnr === 'OMR482')!;
  say(`  Old itinerary OMR482 status: ${oldRes.status.toUpperCase()} (superseded, not orphaned)`);

  hr('Booked is not boarded (I4): watch the replacement until it actually flies');
  const segments = ev.segments as { flightNumber: string; departure: string }[];
  const newFlight = segments[0]!;
  world.flightStatuses.push({
    flightNumber: newFlight.flightNumber,
    date: newFlight.departure.slice(0, 10),
    status: 'on-time',
    scheduledDeparture: newFlight.departure,
  });
  core.startWatch({
    outcomeId: outcome.id,
    kind: 'flight',
    description: `replacement ${newFlight.flightNumber} until departed`,
    closeCondition: {
      kind: 'flight-completed',
      params: { flightNumber: newFlight.flightNumber, date: newFlight.departure.slice(0, 10) },
      description: 'replacement flight departs',
    },
  });
  clock.advance(30 * MINUTE);
  await core.watches.tick();
  say(`  21:00 — ${newFlight.flightNumber} still on the ground → outcome stays ${core.engine.get(outcome.id).state}`);

  clock.advance(80 * MINUTE);
  world.flightStatuses.find((f) => f.flightNumber === newFlight.flightNumber)!.status = 'departed';
  await core.watches.tick();
  say(`  22:20 — ${newFlight.flightNumber} DEPARTED → ground truth closes the outcome`);

  hr('Audit trail (append-only, hash-chained)');
  for (const entry of core.audit.all()) {
    say(`  #${entry.seq} [${entry.actor}] ${entry.action} → ${entry.result.slice(0, 95)}`);
  }
  say(`\n  audit chain intact: ${core.audit.verifyChain() === null}`);
  say(`  total airline submissions, entire session: ${world.writesFor('airline.rebook').length}`);
  core.close();
}

demo().catch((err) => {
  console.error(err);
  process.exit(1);
});
