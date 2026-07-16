import type { CompletionRequest, LLMProvider, StructuredRequest } from './provider.js';
import { LLMProviderError } from './provider.js';

export interface LocalProviderConfig {
  /** OpenAI-compatible endpoint of the local runtime (Ollama, LM Studio, llama.cpp, vLLM). */
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export function localProviderConfigFromEnv(env = process.env): LocalProviderConfig {
  return {
    baseUrl: env.ANTICIPY_LLM_BASE_URL ?? 'http://127.0.0.1:11434/v1',
    model: env.ANTICIPY_LLM_MODEL ?? 'qwen2.5:14b-instruct',
    apiKey: env.ANTICIPY_LLM_API_KEY,
    timeoutMs: env.ANTICIPY_LLM_TIMEOUT_MS ? Number(env.ANTICIPY_LLM_TIMEOUT_MS) : undefined,
  };
}

/**
 * LocalProvider (DECISIONS D-002): speaks the OpenAI-compatible chat completions
 * protocol to whatever local runtime is configured, so the model and runtime are both
 * swappable without touching callers (I14). Never used by automated tests (§12).
 */
export class LocalProvider implements LLMProvider {
  readonly name: string;

  constructor(private config: LocalProviderConfig) {
    this.name = `local:${config.model}`;
  }

  private async chat(messages: { role: string; content: string }[], temperature = 0.1): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 120_000);
    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.config.model, messages, temperature }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new LLMProviderError(`local runtime returned ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new LLMProviderError('local runtime returned no message content');
      }
      return content;
    } catch (err) {
      if (err instanceof LLMProviderError) throw err;
      throw new LLMProviderError(`local runtime request failed (${this.config.baseUrl})`, err);
    } finally {
      clearTimeout(timer);
    }
  }

  async complete(req: CompletionRequest): Promise<string> {
    const messages = [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: req.prompt },
    ];
    return this.chat(messages, req.temperature);
  }

  async structuredComplete<T>(req: StructuredRequest<T>): Promise<T> {
    const system = [
      req.system ?? '',
      'Respond with a single JSON object only — no prose, no code fences.',
      req.schemaDescription ? `The JSON must match this schema:\n${req.schemaDescription}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    // One retry on parse/validation failure, feeding the error back.
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.chat(
        [
          { role: 'system', content: system },
          {
            role: 'user',
            content: attempt === 0 ? req.prompt : `${req.prompt}\n\nYour previous response was invalid: ${lastError}. Return corrected JSON only.`,
          },
        ],
        req.temperature ?? 0,
      );
      try {
        const jsonText = extractJson(raw);
        const parsed = req.schema.safeParse(JSON.parse(jsonText));
        if (parsed.success) return parsed.data;
        lastError = parsed.error.message.slice(0, 500);
      } catch (err) {
        lastError = err instanceof Error ? err.message.slice(0, 500) : 'unparseable JSON';
      }
    }
    throw new LLMProviderError(`structuredComplete(${req.tag}) failed validation: ${lastError}`);
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.config.model, input: text }),
    });
    if (!res.ok) {
      throw new LLMProviderError(`embeddings request returned ${res.status}`);
    }
    const data = (await res.json()) as { data?: { embedding?: number[] }[] };
    const embedding = data.data?.[0]?.embedding;
    if (!embedding) throw new LLMProviderError('no embedding in response');
    return embedding;
  }
}

/** Tolerates code fences and leading prose from small local models. */
export function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1]! : raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('no JSON object found');
  return candidate.slice(start, end + 1);
}
