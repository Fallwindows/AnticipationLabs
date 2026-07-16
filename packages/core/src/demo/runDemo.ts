import { AgentCore } from '../app/agentCore.js';
import { FixtureWorld } from '../integrations/fixtures/fixtureWorld.js';
import { buildFixturePorts } from '../integrations/fixtures/fixtureAdapters.js';
import { FixtureProvider } from '../llm/fixtureProvider.js';
import { SequentialIdSource } from '../util/ids.js';
import { TestClock, MINUTE } from '../util/clock.js';
import { StaticKeyProvider } from '../memory/vault.js';
import { seedDemoMemory, seedDemoWorld } from './seedWorld.js';

/**
 * Console demo: scenario 1 (the Montreal toothbrush) end-to-end on fixtures, printing
 * every state transition, the approval card, the verifier read, and the watch.
 * Run: pnpm --filter @anticipy/core demo
 */
async function demo(): Promise<void> {
  const clock = new TestClock('2026-07-17T21:40:00.000Z');
  const world = new FixtureWorld();
  world.now = () => clock.now().toISOString();
  seedDemoWorld(world);
  const ports = buildFixturePorts(world, { telephonyEnabled: true });
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
  seedDemoMemory(core);

  core.events.on((e) => {
    if (e.type === 'outcome.changed') {
      console.log(`  [state] ${e.outcomeId}: ${e.from ?? '∅'} -> ${e.to}${e.reason ? ` (${e.reason})` : ''}`);
    }
    if (e.type === 'chat.message' && e.message.role === 'anticipy') {
      console.log(`  [anticipy] ${e.message.text}`);
    }
    if (e.type === 'notification') {
      console.log(`  [${e.notification.channel}] ${e.notification.title}: ${e.notification.body}`);
    }
  });

  console.log('— Omar, in the car with Elias, near the hotel —');
  console.log('  [omar] "Ugh, Elias forgot his toothbrush. We\'ll have to stop at London Drugs."');

  llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'toothbrush',
        title: 'Elias needs a toothbrush tonight',
        interpretedGoal:
          'Elias has no toothbrush at the hotel; get him one without a special trip. "London Drugs" is a signal, not a command (I1).',
        owner: 'Omar',
        beneficiary: 'Elias',
        classification: 'commitment',
        confidence: 0.86,
        constraints: [{ kind: 'preference', description: 'avoid a special store trip' }],
        preparation: {
          kind: 'hotel-amenity-call',
          params: { hotel: 'Le Germain', item: 'dental kit', room: '814' },
        },
      },
    ],
    facts: [],
  });

  const episode = core.startEpisode({ participants: ['Omar', 'Elias'] });
  core.addUtterance(episode.id, {
    speaker: 'Omar',
    text: "Ugh, Elias forgot his toothbrush. We'll have to stop at London Drugs.",
    channel: 'car-voice',
  });
  const report = await core.interpretEpisode(episode.id);
  const outcome = report.created[0]!;

  const prep = await core.prepareOutcome(outcome.id);
  if (prep.kind !== 'action') throw new Error('expected an action');
  core.presentApproval(outcome.id, prep.summary, 'one disclosed call to the hotel front desk');

  console.log('  [omar] "Yes, please."');
  core.approve(outcome.id, 'Omar', 'one disclosed call to Hôtel Le Germain front desk');
  const verify = await core.executeAndVerify(outcome.id);
  if (verify.status !== 'verified') throw new Error(`verification failed: ${verify.status}`);
  console.log(`  [verifier] read call log: spoke to ${String(verify.record.evidence.spokeTo)}, ETA ${String(verify.record.evidence.promisedETA)}`);

  core.startWatch({
    outcomeId: outcome.id,
    kind: 'delivery',
    description: 'dental kit delivery to room 814',
    closeCondition: {
      kind: 'delivery-confirmed',
      params: {},
      description: 'Omar confirms the kit arrived',
    },
    followUpAction: 'nudge-front-desk',
    firstPollAt: new Date(clock.now().getTime() + 20 * MINUTE).toISOString(),
  });

  clock.advanceMinutes(25);
  console.log('— 25 minutes later —');
  console.log('  [omar] "Got it, thanks!"');
  const watch = core.watches.all()[0]!;
  core.watches.satisfyExternally(watch.id, { userConfirmation: 'got it' });

  console.log('\n— Audit log —');
  for (const entry of core.audit.all()) {
    console.log(`  #${entry.seq} [${entry.actor}] ${entry.action} -> ${entry.result}`);
  }
  console.log(`\nAudit chain intact: ${core.audit.verifyChain() === null}`);
  core.close();
}

demo().catch((err) => {
  console.error(err);
  process.exit(1);
});
