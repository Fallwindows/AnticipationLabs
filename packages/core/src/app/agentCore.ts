import type { Db } from '../persistence/db.js';
import { openDatabase } from '../persistence/db.js';
import {
  ApprovalTokenRepo,
  AuditRepo,
  ChatRepo,
  DisambiguationRepo,
  EntityRepo,
  EpisodeRepo,
  IdempotencyRepo,
  MemoryFactRepo,
  OutcomeRepo,
  WatchRepo,
} from '../persistence/repos.js';
import type { Clock } from '../util/clock.js';
import { SystemClock } from '../util/clock.js';
import type { IdSource } from '../util/ids.js';
import { RandomIdSource } from '../util/ids.js';
import { EventBus, type ChatMessage } from '../util/events.js';
import type {
  ActionSignature,
  Episode,
  EvidenceRef,
  MemoryFact,
  Outcome,
  Utterance,
  WatchKind,
} from '../domain/types.js';
import { PRE_EXECUTION_STATES } from '../domain/types.js';
import type { LLMProvider } from '../llm/provider.js';
import type { ReadPorts, WritePorts } from '../integrations/ports.js';
import { MemoryStore } from '../memory/memoryStore.js';
import { Vault, type KeyProvider, FileKeyProvider } from '../memory/vault.js';
import { EntityResolver, type ResolutionContext, type ResolveResult } from '../resolve/entityResolver.js';
import { AuditLog } from '../audit/auditLog.js';
import { ApprovalService } from '../approval/approvals.js';
import { OutcomeEngine } from '../engine/outcomeEngine.js';
import { EpisodeInterpreter, type Interpretation } from '../ingest/interpreter.js';
import { PreparationService, type PreparationResult } from '../prep/preparation.js';
import { ExecutionActor } from '../exec/executionActor.js';
import { Verifier, type VerifyResult } from '../verify/verifier.js';
import { WatchScheduler } from '../watch/watchScheduler.js';
import { ChannelPolicy, type Urgency } from '../channel/channelPolicy.js';

export interface AgentCoreConfig {
  dbPath: string;
  llm: LLMProvider;
  read: ReadPorts;
  write: WritePorts;
  clock?: Clock;
  ids?: IdSource;
  keyProvider?: KeyProvider;
  /** confidence below which an interpreted commitment stays Dormant (D-006) */
  autoPrepareThreshold?: number;
  /** primary user, used for chat framing */
  userName?: string;
}

export interface IngestReport {
  episode: Episode;
  created: Outcome[];
  reopened: Outcome[];
  superseded: { outcomeId: string; by?: string; reason: string }[];
  dormant: Outcome[];
  factsAdded: MemoryFact[];
}

/**
 * The agent core (§3): one long-running object owning the state machine, memory,
 * watches, audit and the model client. The desktop shell talks to it over the local
 * server; scenario fixtures drive it directly. All state persists to SQLite so watches
 * survive restarts — reconstructing AgentCore over the same dbPath resumes cleanly.
 */
export class AgentCore {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly events: EventBus;
  readonly memory: MemoryStore;
  readonly vault: Vault;
  readonly resolver: EntityResolver;
  readonly audit: AuditLog;
  readonly approvals: ApprovalService;
  readonly engine: OutcomeEngine;
  readonly interpreter: EpisodeInterpreter;
  readonly preparation: PreparationService;
  readonly actor: ExecutionActor;
  readonly verifier: Verifier;
  readonly watches: WatchScheduler;
  readonly channels: ChannelPolicy;
  readonly chatRepo: ChatRepo;
  readonly episodes: EpisodeRepo;

  private outcomeKeyMap = new Map<string, string>(); // `${episodeId}:${key}` -> outcomeId
  private autoPrepareThreshold: number;
  private userName: string;

  constructor(private config: AgentCoreConfig) {
    this.db = openDatabase(config.dbPath);
    this.clock = config.clock ?? new SystemClock();
    this.ids = config.ids ?? new RandomIdSource();
    this.events = new EventBus();
    this.autoPrepareThreshold = config.autoPrepareThreshold ?? 0.6;
    this.userName = config.userName ?? 'Omar';

    const outcomes = new OutcomeRepo(this.db);
    const facts = new MemoryFactRepo(this.db);
    const entities = new EntityRepo(this.db);
    const tokens = new ApprovalTokenRepo(this.db);
    const watchRepo = new WatchRepo(this.db);
    const disambiguations = new DisambiguationRepo(this.db);
    const auditRepo = new AuditRepo(this.db);
    const idempotency = new IdempotencyRepo(this.db);
    this.chatRepo = new ChatRepo(this.db);
    this.episodes = new EpisodeRepo(this.db);

    this.audit = new AuditLog(auditRepo, this.clock, this.ids, this.events);
    this.memory = new MemoryStore(facts, this.clock, this.ids, this.events);
    this.vault = new Vault(
      this.db,
      config.keyProvider ?? new FileKeyProvider(`${config.dbPath}.vaultkey`),
      this.clock,
      this.ids,
      this.audit,
    );
    this.resolver = new EntityResolver(
      entities,
      disambiguations,
      this.clock,
      this.ids,
      this.events,
    );
    this.approvals = new ApprovalService(tokens, this.clock, this.ids, this.events);
    this.engine = new OutcomeEngine(
      outcomes,
      this.approvals,
      this.audit,
      this.clock,
      this.ids,
      this.events,
    );
    this.interpreter = new EpisodeInterpreter(config.llm, this.memory);
    this.preparation = new PreparationService(config.read, this.memory, config.llm);
    this.actor = new ExecutionActor(
      this.engine,
      config.write,
      this.vault,
      this.audit,
      idempotency,
      this.clock,
      this.ids,
      this.chatRepo,
      this.events,
    );
    this.verifier = new Verifier(config.read, this.chatRepo, this.audit, this.clock);
    this.watches = new WatchScheduler(
      watchRepo,
      this.engine,
      config.read,
      this.clock,
      this.ids,
      this.events,
      this.audit,
    );
    this.channels = new ChannelPolicy(this.clock, this.ids, this.events);
    this.watches.setTimeoutHandler((watch) => {
      this.channels.notify({
        title: 'Watch timed out',
        body: `${watch.description} passed its timeout without resolution. The outcome stays open.`,
        urgency: 'normal',
        outcomeId: watch.outcomeId,
      });
    });
  }

  // -- Chat -------------------------------------------------------------------

  postChat(message: Omit<ChatMessage, 'id' | 'at'>): ChatMessage {
    const msg: ChatMessage = {
      ...message,
      id: this.ids.next('chat'),
      at: this.clock.now().toISOString(),
    };
    this.chatRepo.save(msg);
    this.events.emit({ type: 'chat.message', message: msg });
    return msg;
  }

  // -- Ingestion (§5.1) ----------------------------------------------------------

  startEpisode(args: { participants: string[]; evidence?: EvidenceRef[] }): Episode {
    const episode: Episode = {
      id: this.ids.next('ep'),
      utterances: [],
      evidence: args.evidence ?? [],
      participants: args.participants,
      ingestedAt: this.clock.now().toISOString(),
    };
    this.episodes.save(episode);
    return episode;
  }

  addUtterance(episodeId: string, u: Omit<Utterance, 'at'> & { at?: string }): Episode {
    const episode = this.mustEpisode(episodeId);
    const next: Episode = {
      ...episode,
      utterances: [
        ...episode.utterances,
        { ...u, at: u.at ?? this.clock.now().toISOString() },
      ],
    };
    this.episodes.save(next);
    return next;
  }

  addEvidence(episodeId: string, evidence: EvidenceRef): Episode {
    const episode = this.mustEpisode(episodeId);
    const next: Episode = { ...episode, evidence: [...episode.evidence, evidence] };
    this.episodes.save(next);
    return next;
  }

  private mustEpisode(id: string): Episode {
    const e = this.episodes.get(id);
    if (!e) throw new Error(`unknown episode ${id}`);
    return e;
  }

  /**
   * Interpret the episode AS A WHOLE (I2) and apply the result: create outcomes,
   * supersede corrected guesses, park discussion/emotion as Dormant (I3), and write
   * extracted facts (corrections supersede prior beliefs).
   */
  async interpretEpisode(episodeId: string): Promise<IngestReport> {
    const episode = this.mustEpisode(episodeId);
    const interpretation = await this.interpreter.interpret(episode);
    return this.applyInterpretation(episode, interpretation);
  }

  private applyInterpretation(episode: Episode, interpretation: Interpretation): IngestReport {
    const report: IngestReport = {
      episode,
      created: [],
      reopened: [],
      superseded: [],
      dormant: [],
      factsAdded: [],
    };

    for (const f of interpretation.facts) {
      const write = {
        subject: f.subject,
        predicate: f.predicate,
        value: f.value,
        confidence: f.confidence,
        sensitivity: f.sensitivity,
        expiresAt: f.expiresAt,
        source: {
          kind: 'utterance' as const,
          ref: episode.id,
          assertedBy: f.assertedBy,
        },
      };
      report.factsAdded.push(f.corrects ? this.memory.correct(write) : this.memory.add(write));
    }

    for (const cand of interpretation.outcomes) {
      const mapKey = `${episode.id}:${cand.key}`;
      const existingId = this.outcomeKeyMap.get(mapKey);

      // Supersession first: a later statement replaced an earlier candidate (I2).
      let supersededTargetId: string | undefined;
      if (cand.supersedesKey) {
        supersededTargetId = this.outcomeKeyMap.get(`${episode.id}:${cand.supersedesKey}`);
      }

      let outcome: Outcome | undefined;
      if (existingId) {
        outcome = this.engine.get(existingId);
        if (outcome.state === 'Dormant' && cand.classification === 'commitment') {
          outcome = this.engine.reopenFromDormant(outcome.id, 'new evidence: now a commitment');
          report.reopened.push(outcome);
        }
      } else {
        outcome = this.engine.create({
          title: cand.title,
          owner: cand.owner,
          beneficiary: cand.beneficiary,
          originEpisodeId: episode.id,
          interpretedGoal: cand.interpretedGoal,
          originClassification: cand.classification,
          constraints: cand.constraints,
        });
        this.outcomeKeyMap.set(mapKey, outcome.id);
        outcome = this.engine.beginInterpretation(outcome.id);
        report.created.push(outcome);
      }

      if (supersededTargetId && supersededTargetId !== outcome.id) {
        const prior = this.engine.get(supersededTargetId);
        if (PRE_EXECUTION_STATES.includes(prior.state)) {
          this.engine.supersede(
            supersededTargetId,
            `superseded by later statement in episode (${cand.key})`,
            outcome.id,
          );
          this.watches.cancelForOutcome(supersededTargetId, 'outcome superseded');
          report.superseded.push({
            outcomeId: supersededTargetId,
            by: outcome.id,
            reason: cand.key,
          });
        }
      }

      // Persist the preparation hint; discussion/emotion or low confidence stays Dormant (I3).
      const current = this.engine.get(outcome.id);
      if (cand.preparation && current.state === 'Interpreting') {
        this.setPreparationHint(outcome.id, cand.preparation);
      }
      if (current.state === 'Interpreting') {
        const notActionable =
          cand.classification === 'discussion' ||
          cand.classification === 'emotion' ||
          cand.confidence < this.autoPrepareThreshold;
        if (notActionable) {
          report.dormant.push(
            this.engine.markDormant(
              outcome.id,
              cand.classification === 'commitment'
                ? `confidence ${cand.confidence.toFixed(2)} below auto-prepare threshold`
                : `${cand.classification} is not authorization (I3)`,
            ),
          );
        }
      }
    }
    return report;
  }

  private setPreparationHint(outcomeId: string, hint: { kind: string; params: Record<string, unknown> }): void {
    const o = this.engine.get(outcomeId);
    const repo = new OutcomeRepo(this.db);
    repo.save({ ...o, preparationHint: hint, updatedAt: this.clock.now().toISOString() });
  }

  // -- Entity resolution (§5.3) ----------------------------------------------------

  resolveEntity(mention: string, ctx: ResolutionContext, outcomeId?: string): ResolveResult {
    return this.resolver.resolve(mention, ctx, outcomeId);
  }

  // -- Preparation (§5.5) ----------------------------------------------------------

  /**
   * Run read-only preparation. If it yields an action, the outcome moves to Prepared
   * with the exact signature attached; options/briefs are surfaced in chat and the
   * outcome stays Interpreting until the human chooses.
   */
  async prepareOutcome(
    outcomeId: string,
    kindOverride?: string,
    paramsOverride?: Record<string, unknown>,
  ): Promise<PreparationResult> {
    let outcome = this.engine.get(outcomeId);
    if (outcome.state === 'Dormant') {
      throw new Error('dormant outcomes are not prepared (I3) — new evidence must reopen them first');
    }
    const kind = kindOverride ?? outcome.preparationHint?.kind;
    const params = paramsOverride ?? outcome.preparationHint?.params ?? {};
    if (!kind) throw new Error(`outcome ${outcomeId} has no preparation hint`);
    const result = await this.preparation.prepare(outcome, kind, params);

    if (result.kind === 'action') {
      this.engine.markPrepared(outcomeId, result.signature);
    } else if (result.kind === 'options') {
      this.postChat({
        role: 'anticipy',
        text: result.summary,
        kind: 'options',
        outcomeId,
        payload: result.options,
      });
    } else {
      this.postChat({
        role: 'anticipy',
        text: result.brief,
        kind: 'text',
        outcomeId,
        payload: { openQuestions: result.openQuestions },
      });
    }
    return result;
  }

  /** Present the approval card: exact signature + plain-language summary (§7). */
  presentApproval(outcomeId: string, summary: string, scopeDescription: string): Outcome {
    const outcome = this.engine.requestApproval(outcomeId);
    this.postChat({
      role: 'anticipy',
      text: summary,
      kind: 'approval-card',
      outcomeId,
      payload: {
        signature: outcome.preparedAction,
        signatureHash: outcome.preparedSignatureHash,
        scopeDescription,
      },
    });
    return outcome;
  }

  approve(outcomeId: string, approvedBy: string, scopeDescription: string, expiresAt?: string): Outcome {
    return this.engine.approve(outcomeId, approvedBy, scopeDescription, expiresAt);
  }

  /** Any edit rebuilds the signature and invalidates the prior approval (I5). */
  editAction(outcomeId: string, signature: ActionSignature, editedBy: string): Outcome {
    return this.engine.editPreparedAction(outcomeId, signature, editedBy);
  }

  // -- Execute + verify (§5.7/§5.8) ---------------------------------------------------

  /**
   * Actor fires once, then the read-only verifier establishes ground truth. When the
   * verifier finds nothing (e.g. post-submit timeout), recovery RE-READS — it never
   * re-submits (I7). Returns the final verification result; on success the outcome is
   * Verified.
   */
  async executeAndVerify(outcomeId: string, maxRereads = 2): Promise<VerifyResult> {
    await this.actor.execute(outcomeId);
    this.engine.beginVerification(outcomeId);
    let result = await this.verifier.verify(this.engine.get(outcomeId));
    let rereads = 0;
    while (result.status === 'not-found' && rereads < maxRereads) {
      this.engine.recoverForReread(outcomeId, 'verifier found no artifact yet');
      this.engine.markExecuted(outcomeId, 're-read pass, nothing re-submitted');
      this.engine.beginVerification(outcomeId);
      result = await this.verifier.verify(this.engine.get(outcomeId));
      rereads += 1;
    }
    if (result.status === 'verified') {
      this.engine.markVerified(outcomeId, result.record);
    }
    return result;
  }

  // -- Watches & closure (§5.9) --------------------------------------------------------

  startWatch(args: {
    outcomeId: string;
    kind: WatchKind;
    description: string;
    closeCondition: { kind: string; params: Record<string, unknown>; description: string };
    intervalMs?: number;
    followUpWindowMs?: number;
    followUpAction?: string;
    timeoutAt?: string;
    firstPollAt?: string;
  }): ReturnType<WatchScheduler['create']> {
    const watch = this.watches.create(args);
    const outcome = this.engine.get(args.outcomeId);
    if (outcome.state === 'Verified') {
      this.engine.startWatching(args.outcomeId, watch.id, `watching: ${args.description}`);
    } else {
      this.engine.attachWatch(args.outcomeId, watch.id);
    }
    return watch;
  }

  /** The verified action WAS the promised outcome (I4 boundary, scenario 4). */
  closeAsActionWasOutcome(outcomeId: string, evidence: Record<string, unknown>): Outcome {
    return this.engine.close(outcomeId, { kind: 'action-was-outcome', evidence });
  }

  /** Explicit human cancel — tears down approvals and watches immediately (§9). */
  cancelOutcome(outcomeId: string, reason: string): Outcome {
    const outcome = this.engine.cancel(outcomeId, reason);
    this.watches.cancelForOutcome(outcomeId, `outcome cancelled: ${reason}`);
    return outcome;
  }

  notify(args: { title: string; body: string; urgency: Urgency; outcomeId?: string; sensitive?: boolean }) {
    return this.channels.notify(args);
  }

  close(): void {
    this.db.close();
  }
}
