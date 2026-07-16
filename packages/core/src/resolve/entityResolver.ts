import type {
  DisambiguationRequest,
  Entity,
  Resolution,
  ResolutionEvidence,
} from '../domain/types.js';
import type { Clock } from '../util/clock.js';
import type { IdSource } from '../util/ids.js';
import type { EventBus } from '../util/events.js';
import { DisambiguationRepo, EntityRepo } from '../persistence/repos.js';

/**
 * Context available when resolving a mention: who is speaking, what meeting/thread the
 * episode is anchored to, and the domain vocabulary present in the episode text.
 */
export interface ResolutionContext {
  speaker?: string;
  /** entity ids of people in the conversation/thread */
  participants?: string[];
  /** entity id of a meeting-linked project/person, when the episode is anchored to one */
  meetingContext?: string[];
  /** salient domain terms from the episode ("migration", "cutover", "sprint") */
  vocabulary?: string[];
  /** entity ids explicitly referenced earlier in the same episode */
  explicitReferences?: string[];
}

export type ResolveResult =
  | { kind: 'resolved'; resolution: Resolution }
  | { kind: 'ask'; request: DisambiguationRequest }
  | { kind: 'none' };

export interface ResolverConfig {
  /** resolve at/above this confidence; ask below it (DECISIONS D-006) */
  askThreshold: number;
}

/**
 * Entity resolver / disambiguator (§5.3, I9). Scores candidates on evidence from
 * context and memory — relationship to the speaker, meeting/thread anchoring, domain
 * vocabulary — NOT name similarity alone. Below the ask-threshold it emits a
 * DisambiguationRequest instead of resolving; and a person can never be resolved (at
 * any score) without at least one piece of non-name evidence.
 */
export class EntityResolver {
  constructor(
    private entities: EntityRepo,
    private disambiguations: DisambiguationRepo,
    private clock: Clock,
    private ids: IdSource,
    private events: EventBus,
    private config: ResolverConfig = { askThreshold: 0.8 },
  ) {}

  addEntity(e: Entity): void {
    this.entities.save(e);
  }

  private nameMatches(entity: Entity, mention: string): boolean {
    const m = mention.toLowerCase();
    return [...entity.names, ...entity.aliases].some(
      (n) => n.toLowerCase() === m || n.toLowerCase().includes(m) || m.includes(n.toLowerCase()),
    );
  }

  private score(entity: Entity, mention: string, ctx: ResolutionContext): ResolutionEvidence[] {
    const evidence: ResolutionEvidence[] = [];
    if (this.nameMatches(entity, mention)) {
      evidence.push({
        kind: 'name-similarity',
        description: `"${mention}" matches ${entity.names[0]}`,
        weight: 0.35,
      });
    }
    if (ctx.explicitReferences?.includes(entity.id)) {
      evidence.push({
        kind: 'explicit-reference',
        description: 'explicitly referenced earlier in this episode',
        weight: 0.5,
      });
    }
    if (ctx.meetingContext?.includes(entity.id)) {
      evidence.push({
        kind: 'meeting-context',
        description: 'anchored to the meeting/thread this episode is about',
        weight: 0.35,
      });
    }
    if (ctx.participants?.includes(entity.id)) {
      evidence.push({
        kind: 'thread-membership',
        description: 'participant in this conversation/thread',
        weight: 0.25,
      });
    }
    const vocab = (ctx.vocabulary ?? []).map((v) => v.toLowerCase());
    const entityVocab = (entity.attributes['vocabulary'] ?? '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const overlap = entityVocab.filter((v) => vocab.includes(v));
    if (overlap.length > 0) {
      evidence.push({
        kind: 'domain-vocabulary',
        description: `episode vocabulary overlaps: ${overlap.join(', ')}`,
        weight: Math.min(0.35, 0.15 * overlap.length),
      });
    }
    const rel = entity.attributes['relationTo'];
    if (rel && ctx.speaker && rel.toLowerCase().includes(ctx.speaker.toLowerCase())) {
      evidence.push({
        kind: 'relationship',
        description: `known relationship to ${ctx.speaker}: ${entity.attributes['relation'] ?? rel}`,
        weight: 0.25,
      });
    }
    return evidence;
  }

  resolve(mention: string, ctx: ResolutionContext, outcomeId?: string): ResolveResult {
    const candidates: Resolution[] = [];
    for (const entity of this.entities.all()) {
      const evidence = this.score(entity, mention, ctx);
      if (evidence.length === 0) continue;
      const confidence = Math.min(1, evidence.reduce((s, e) => s + e.weight, 0));
      candidates.push({ entity, confidence, evidence });
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    const top = candidates[0];
    if (!top) return { kind: 'none' };
    const second = candidates[1];

    const onlyNameEvidence = top.evidence.every((e) => e.kind === 'name-similarity');
    const isPerson = top.entity.type === 'person';
    const belowThreshold = top.confidence < this.config.askThreshold;
    const tooClose = second !== undefined && top.confidence - second.confidence < 0.15;

    // I9: a human is never selected on name similarity alone, regardless of score.
    if (belowThreshold || (isPerson && onlyNameEvidence) || tooClose) {
      const request: DisambiguationRequest = {
        id: this.ids.next('dis'),
        mention,
        question: this.buildQuestion(mention, candidates.slice(0, 3)),
        candidates: candidates.slice(0, 3).map((c) => ({
          entityId: c.entity.id,
          label: `${c.entity.names[0]} (${c.entity.type})`,
          confidence: Number(c.confidence.toFixed(2)),
        })),
        outcomeId,
        createdAt: this.clock.now().toISOString(),
      };
      this.disambiguations.save(request);
      this.events.emit({
        type: 'disambiguation.requested',
        requestId: request.id,
        question: request.question,
      });
      return { kind: 'ask', request };
    }
    return { kind: 'resolved', resolution: top };
  }

  private buildQuestion(mention: string, candidates: Resolution[]): string {
    const labels = candidates.map((c) => {
      const attr = c.entity.attributes['descriptor'];
      return attr ? `${c.entity.names[0]} (${attr})` : c.entity.names[0];
    });
    return `When you say "${mention}", do you mean ${labels.join(' or ')}?`;
  }

  /** The human answered the disambiguation question. */
  answerDisambiguation(requestId: string, entityId: string): Resolution {
    const req = this.disambiguations.get(requestId);
    if (!req) throw new Error(`unknown disambiguation request ${requestId}`);
    const entity = this.entities.get(entityId);
    if (!entity) throw new Error(`unknown entity ${entityId}`);
    this.disambiguations.save({ ...req, resolvedEntityId: entityId });
    return {
      entity,
      confidence: 1,
      evidence: [
        { kind: 'explicit-reference', description: 'user answered disambiguation', weight: 1 },
      ],
    };
  }

  pendingDisambiguations(): DisambiguationRequest[] {
    return this.disambiguations.all().filter((d) => !d.resolvedEntityId);
  }
}
