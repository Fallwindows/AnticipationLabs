import { AgentCore } from '../../src/app/agentCore.js';
import { FixtureWorld } from '../../src/integrations/fixtures/fixtureWorld.js';
import { buildFixturePorts } from '../../src/integrations/fixtures/fixtureAdapters.js';
import { FixtureProvider } from '../../src/llm/fixtureProvider.js';
import { SequentialIdSource } from '../../src/util/ids.js';
import { TestClock } from '../../src/util/clock.js';
import { StaticKeyProvider } from '../../src/memory/vault.js';
import type { ActionSignature, Outcome } from '../../src/domain/types.js';

export interface Harness {
  core: AgentCore;
  clock: TestClock;
  world: FixtureWorld;
  llm: FixtureProvider;
}

/**
 * Deterministic test harness (§12): TestClock, sequential IDs, in-memory SQLite,
 * fixture LLM + fixture adapters over one shared world. No network, no credentials.
 */
export function makeHarness(options: { start?: string; dbPath?: string; telephonyEnabled?: boolean } = {}): Harness {
  const clock = new TestClock(options.start ?? '2026-07-16T09:00:00.000Z');
  const world = new FixtureWorld();
  world.now = () => clock.now().toISOString();
  const ports = buildFixturePorts(world, { telephonyEnabled: options.telephonyEnabled ?? true });
  const llm = new FixtureProvider();
  const core = new AgentCore({
    dbPath: options.dbPath ?? ':memory:',
    llm,
    read: ports.read,
    write: ports.write,
    clock,
    ids: new SequentialIdSource(),
    keyProvider: new StaticKeyProvider(),
  });
  return { core, clock, world, llm };
}

export function sampleSignature(overrides: Partial<ActionSignature> = {}): ActionSignature {
  return {
    actionType: 'email.send',
    target: 'sarah.chen@meridianpartners.example',
    params: {
      from: 'omar@anticipationlabs.example',
      to: 'sarah.chen@meridianpartners.example',
      cc: [],
      subject: 'Meeting notes',
      body: 'Notes as promised.',
      attachments: [],
    },
    pageVersionHash: 'page-v1',
    disclosures: [],
    ...overrides,
  };
}

/** Walk a fresh outcome to Prepared with the given signature. */
export function makePrepared(h: Harness, sig: ActionSignature = sampleSignature()): Outcome {
  const episode = h.core.startEpisode({ participants: ['Omar'] });
  const o = h.core.engine.create({
    title: 'test outcome',
    owner: 'Omar',
    originEpisodeId: episode.id,
    interpretedGoal: 'test goal',
    originClassification: 'commitment',
  });
  h.core.engine.beginInterpretation(o.id);
  return h.core.engine.markPrepared(o.id, sig);
}

/** Walk a fresh outcome to Approved. */
export function makeApproved(h: Harness, sig: ActionSignature = sampleSignature()): Outcome {
  const o = makePrepared(h, sig);
  h.core.engine.requestApproval(o.id);
  return h.core.engine.approve(o.id, 'Omar', 'test scope');
}
