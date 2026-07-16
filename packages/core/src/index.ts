// Domain
export * from './domain/types.js';

// Utilities
export * from './util/clock.js';
export * from './util/ids.js';
export * from './util/events.js';
export * from './util/canonical.js';

// Persistence
export { openDatabase, type Db } from './persistence/db.js';
export * from './persistence/repos.js';

// Subsystems
export { MemoryStore, type FactWrite, type FactQuery } from './memory/memoryStore.js';
export {
  Vault,
  VaultAccessError,
  FileKeyProvider,
  StaticKeyProvider,
  VAULT_PLACEHOLDER,
  type KeyProvider,
} from './memory/vault.js';
export {
  EntityResolver,
  type ResolutionContext,
  type ResolveResult,
  type ResolverConfig,
} from './resolve/entityResolver.js';
export { AuditLog, type AuditWrite } from './audit/auditLog.js';
export { ApprovalService, signatureHash, type TokenCheck } from './approval/approvals.js';
export {
  OutcomeEngine,
  IllegalTransitionError,
  ApprovalGateError,
} from './engine/outcomeEngine.js';
export { EpisodeInterpreter, interpretationSchema, type Interpretation } from './ingest/interpreter.js';
export {
  PreparationService,
  type Preparer,
  type PreparationContext,
  type PreparationResult,
} from './prep/preparation.js';
export { ExecutionActor, type ActorOutcome } from './exec/executionActor.js';
export { Verifier, type VerifyResult } from './verify/verifier.js';
export {
  WatchScheduler,
  WATCH_DEFAULTS,
  type Poller,
  type CloseEvaluator,
  type FollowUpHandler,
  type PollSnapshot,
} from './watch/watchScheduler.js';
export { ChannelPolicy, type Urgency, type Channel, type UrgencyInput } from './channel/channelPolicy.js';

// LLM
export * from './llm/provider.js';
export { LocalProvider, localProviderConfigFromEnv, extractJson, type LocalProviderConfig } from './llm/localProvider.js';
export { FixtureProvider } from './llm/fixtureProvider.js';

// Integrations
export * from './integrations/ports.js';
export { FixtureWorld } from './integrations/fixtures/fixtureWorld.js';
export { buildFixturePorts, type FixturePortsOptions } from './integrations/fixtures/fixtureAdapters.js';

// App
export { AgentCore, type AgentCoreConfig, type IngestReport } from './app/agentCore.js';
