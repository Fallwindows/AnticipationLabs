import type { CompletionRequest, LLMProvider, StructuredRequest } from './provider.js';
import { LLMProviderError } from './provider.js';

/**
 * Deterministic provider for fixtures and CI (§12): canned responses keyed by request
 * tag, consumed as FIFO queues so multi-turn interactions replay exactly. Every
 * prompt that reaches the provider is recorded so tests can assert what the model was
 * (and was NOT — e.g. vault values) shown.
 */
export class FixtureProvider implements LLMProvider {
  readonly name = 'fixture';

  private queues = new Map<string, unknown[]>();
  /** Every request the "model" saw — inspectable by tests (prompt-injection & vault hygiene). */
  readonly seen: { tag: string; system?: string; prompt: string }[] = [];

  enqueue(tag: string, response: unknown): this {
    const q = this.queues.get(tag) ?? [];
    q.push(response);
    this.queues.set(tag, q);
    return this;
  }

  private take(tag: string): unknown {
    const q = this.queues.get(tag);
    if (!q || q.length === 0) {
      throw new LLMProviderError(
        `FixtureProvider has no canned response for tag "${tag}". Enqueue one in the scenario fixture.`,
      );
    }
    return q.shift();
  }

  async complete(req: CompletionRequest): Promise<string> {
    this.seen.push({ tag: req.tag, system: req.system, prompt: req.prompt });
    const res = this.take(req.tag);
    if (typeof res !== 'string') {
      throw new LLMProviderError(`canned response for "${req.tag}" is not a string`);
    }
    return res;
  }

  async structuredComplete<T>(req: StructuredRequest<T>): Promise<T> {
    this.seen.push({ tag: req.tag, system: req.system, prompt: req.prompt });
    const res = this.take(req.tag);
    const parsed = req.schema.safeParse(res);
    if (!parsed.success) {
      throw new LLMProviderError(
        `canned response for "${req.tag}" fails schema validation: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  async embed(text: string): Promise<number[]> {
    // Deterministic pseudo-embedding: stable across runs, unique per text.
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    }
    return [((h >>> 0) % 1000) / 1000, ((h >>> 8) % 1000) / 1000, ((h >>> 16) % 1000) / 1000];
  }
}
