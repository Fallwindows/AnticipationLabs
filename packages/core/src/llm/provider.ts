import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Provider-swappable brain (§5.12, I14). Everything the rest of the system asks a
 * model is expressed against this interface. The default is a local/self-hosted
 * runtime (LocalProvider); tests use FixtureProvider. Prompt assembly must only ever
 * include memory obtained through MemoryStore.promptView (§5.2) — callers pass
 * pre-redacted context; providers never see stores.
 */
export interface CompletionRequest {
  system?: string;
  prompt: string;
  /**
   * Stable label for the request site (e.g. 'interpret-episode'). Lets the fixture
   * provider key canned responses, and shows up in logs.
   */
  tag: string;
  temperature?: number;
}

export interface StructuredRequest<T> extends CompletionRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- input type may differ (zod defaults)
  schema: ZodType<T, ZodTypeDef, any>;
  /** JSON schema text shown to the model for structure guidance. */
  schemaDescription?: string;
}

export interface LLMProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<string>;
  structuredComplete<T>(req: StructuredRequest<T>): Promise<T>;
  embed(text: string): Promise<number[]>;
}

export class LLMProviderError extends Error {
  constructor(
    msg: string,
    public override cause?: unknown,
  ) {
    super(msg);
    this.name = 'LLMProviderError';
  }
}
