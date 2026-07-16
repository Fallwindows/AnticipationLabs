import { z } from 'zod';
import type { Episode } from '../domain/types.js';
import type { LLMProvider } from '../llm/provider.js';
import type { MemoryStore } from '../memory/memoryStore.js';
import { redactSensitiveText } from '../util/redact.js';

/**
 * Structured output contract for episode interpretation (§5.1). The interpreter:
 *  (a) detects candidate Outcomes,
 *  (b) infers the real goal behind surface phrasing (I1 — "London Drugs" → toothbrush),
 *  (c) applies supersession across the episode (I2 — later statements win),
 *  (d) classifies utterances as discussion / commitment / emotion (I3).
 * It never creates an executing action — its outcomes land as Discovered/Interpreting
 * and, at most, carry a preparation HINT for the read-only preparation service.
 */
export const interpretationSchema = z.object({
  outcomes: z.array(
    z.object({
      /** stable key within the episode, so re-interpretation can supersede prior guesses */
      key: z.string(),
      title: z.string(),
      interpretedGoal: z.string(),
      owner: z.string(),
      beneficiary: z.string().optional(),
      classification: z.enum(['commitment', 'discussion', 'emotion', 'signal']),
      confidence: z.number().min(0).max(1),
      constraints: z
        .array(
          z.object({
            kind: z.enum(['exclusion', 'buffer', 'authority-limit', 'preference', 'deadline', 'scope']),
            description: z.string(),
            params: z.record(z.unknown()).optional(),
          }),
        )
        .default([]),
      /** key of an earlier candidate in this episode that this one replaces (I2) */
      supersedesKey: z.string().optional(),
      /** hint for the preparation service; NEVER an action itself */
      preparation: z
        .object({
          kind: z.string(),
          params: z.record(z.unknown()).default({}),
        })
        .optional(),
    }),
  ),
  facts: z
    .array(
      z.object({
        subject: z.string(),
        predicate: z.string(),
        value: z.string(),
        confidence: z.number().min(0).max(1),
        sensitivity: z.enum(['low', 'normal', 'high']).default('normal'),
        expiresAt: z.string().optional(),
        /** true when this corrects an earlier belief (supersedes same subject+predicate) */
        corrects: z.boolean().default(false),
        assertedBy: z.string().optional(),
      }),
    )
    .default([]),
});

export type Interpretation = z.infer<typeof interpretationSchema>;

const SYSTEM_PROMPT = `You are the episode interpreter of Anticipy, an anticipatory personal agent.
You read a whole conversation episode plus linked evidence and reduce it to desired END STATES (outcomes), never keyword triggers.
Rules you must encode in your output:
- Infer the outcome the person actually wants, not the surface phrasing (a store name is a signal, not a command).
- Later statements supersede earlier ones; corrections override prior guesses (use supersedesKey).
- Classify honestly: talking about something is "discussion"; "I'm screwed" is "emotion"; only real commitments are "commitment". Discussion and emotion are NEVER authorization.
- Record narrow scope: accept only the responsibility actually offered, note exclusions and authority limits as constraints.
- Facts you extract carry confidence, sensitivity and who asserted them. Never extract passport numbers, identity documents or credentials as facts.`;

export class EpisodeInterpreter {
  constructor(
    private llm: LLMProvider,
    private memory: MemoryStore,
  ) {}

  /**
   * Interprets the episode as a whole (I2). Context facts come exclusively from the
   * memory redaction view (§5.2) — high-sensitivity and vault material never reaches
   * the prompt.
   */
  async interpret(episode: Episode): Promise<Interpretation> {
    // Utterance and evidence text is user/third-party controlled and may contain
    // identity documents or card numbers the vault never saw — scrub before any of
    // it reaches the model (I12; the memory side is already the redaction view).
    const transcript = episode.utterances
      .map((u, i) => `[${i}] ${u.speaker} (${u.channel}, ${u.at}): ${redactSensitiveText(u.text)}`)
      .join('\n');
    const evidence = episode.evidence
      .map((e) => `- ${e.kind} ${e.ref}: ${redactSensitiveText(JSON.stringify(e.data ?? {}))}`)
      .join('\n');
    const memoryLines = this.memory.promptLines().join('\n');

    const prompt = [
      `## Known facts (redacted memory view)`,
      memoryLines || '(none)',
      `## Linked evidence`,
      evidence || '(none)',
      `## Episode transcript`,
      transcript,
      `## Task`,
      `Interpret the WHOLE episode. Emit outcomes (with supersession for corrected guesses) and extracted facts.`,
    ].join('\n\n');

    return this.llm.structuredComplete({
      tag: 'interpret-episode',
      system: SYSTEM_PROMPT,
      prompt,
      schema: interpretationSchema,
    });
  }
}
