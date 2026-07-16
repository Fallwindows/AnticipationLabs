import { AgentCore } from './app/agentCore.js';
import { FixtureWorld } from './integrations/fixtures/fixtureWorld.js';
import { buildFixturePorts } from './integrations/fixtures/fixtureAdapters.js';
import { LocalProvider, localProviderConfigFromEnv } from './llm/localProvider.js';
import { ChatPipeline } from './server/chatPipeline.js';
import { CoreServer } from './server/server.js';
import { DEFAULT_PORT } from './server/protocol.js';
import { seedDemoMemory, seedDemoWorld } from './demo/seedWorld.js';

/**
 * Agent core service entrypoint (§3). Long-running local process: owns the state
 * machine, watches and persistence; the desktop shell connects to it on 127.0.0.1.
 *
 * Integrations run on FixtureAdapters until the real ApiAdapters (Phase 3) are
 * configured — the architecture and the approval/verify/watch discipline are
 * identical either way (§6). The model is the configured local runtime (D-002).
 */
async function main(): Promise<void> {
  const dbPath = process.env.ANTICIPY_DB ?? 'var/anticipy.sqlite3';
  const port = Number(process.env.ANTICIPY_PORT ?? DEFAULT_PORT);
  const telephonyEnabled = process.env.ANTICIPY_ENABLE_TELEPHONY === '1';

  const world = new FixtureWorld();
  world.now = () => new Date().toISOString();
  seedDemoWorld(world);
  const ports = buildFixturePorts(world, { telephonyEnabled });

  const llm = new LocalProvider(localProviderConfigFromEnv());

  const core = new AgentCore({
    dbPath,
    llm,
    read: ports.read,
    write: ports.write,
    userName: process.env.ANTICIPY_USER ?? 'Omar',
  });
  if (core.memory.query().length === 0) seedDemoMemory(core);

  const pipeline = new ChatPipeline(core, llm, process.env.ANTICIPY_USER ?? 'Omar');
  const server = new CoreServer(core, pipeline, port);
  await server.listen();

  // Watches must fire while the app is open; the scheduler ticks on a timer in
  // production (tests call tick() under a TestClock instead).
  const tickTimer = setInterval(() => {
    core.watches.tick().catch((err) => console.error('[watch-tick]', err));
  }, 30_000);

  console.log(`[anticipy-core] listening on http://127.0.0.1:${port} (db: ${dbPath})`);
  console.log(`[anticipy-core] model: ${llm.name}; telephony tier ${telephonyEnabled ? 'ENABLED' : 'disabled (D-005)'}`);

  const shutdown = (): void => {
    clearInterval(tickTimer);
    server.close();
    core.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
