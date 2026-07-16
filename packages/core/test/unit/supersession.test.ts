import { describe, expect, it } from 'vitest';
import { makeApproved, makeHarness } from '../helpers/harness.js';
import { IllegalTransitionError } from '../../src/engine/outcomeEngine.js';

/**
 * Supersession tests (§12, I2): a correction mid-episode overrides the earlier guess;
 * supersession fires only from pre-execution states.
 */
describe('Supersession (I2)', () => {
  it('a correction mid-episode supersedes the earlier outcome and re-targets', async () => {
    const h = makeHarness();
    const episode = h.core.startEpisode({ participants: ['Omar'] });
    h.core.addUtterance(episode.id, {
      speaker: 'Omar',
      text: 'The bamboo plant arrived cracked — return it.',
      channel: 'chat',
    });

    h.llm.enqueue('interpret-episode', {
      outcomes: [
        {
          key: 'return-plant',
          title: 'Return the bamboo plant',
          interpretedGoal: 'return the damaged bamboo plant',
          owner: 'Omar',
          classification: 'commitment',
          confidence: 0.75,
        },
      ],
      facts: [],
    });
    const first = await h.core.interpretEpisode(episode.id);
    const plantOutcome = first.created[0]!;
    expect(h.core.engine.get(plantOutcome.id).state).toBe('Interpreting');

    // Correction: it was the POT, not the plant.
    h.core.addUtterance(episode.id, {
      speaker: 'Omar',
      text: 'Wait, no — the plant is fine. It was the ceramic pot that cracked.',
      channel: 'chat',
    });
    h.llm.enqueue('interpret-episode', {
      outcomes: [
        {
          key: 'return-pot',
          title: 'Return the ceramic pot',
          interpretedGoal: 'return the cracked ceramic pot; the plant is NOT returned',
          owner: 'Omar',
          classification: 'commitment',
          confidence: 0.92,
          supersedesKey: 'return-plant',
        },
      ],
      facts: [],
    });
    const second = await h.core.interpretEpisode(episode.id);

    expect(second.superseded).toHaveLength(1);
    expect(second.superseded[0]!.outcomeId).toBe(plantOutcome.id);
    const plant = h.core.engine.get(plantOutcome.id);
    expect(plant.state).toBe('Superseded');
    expect(plant.supersededBy).toBe(second.created[0]!.id);
  });

  it('supersession invalidates outstanding approvals', () => {
    const h = makeHarness();
    const o = makeApproved(h);
    const tokenId = h.core.engine.get(o.id).approvalTokenId!;
    h.core.engine.supersede(o.id, 'later statement changed the assignment');
    expect(h.core.engine.get(o.id).state).toBe('Superseded');
    expect(h.core.approvals.get(tokenId)!.invalidatedAt).toBeTruthy();
  });

  it('supersession is refused once a side effect is in flight (§5.4)', async () => {
    const h = makeHarness();
    const o = makeApproved(h);
    h.core.engine.startExecution(o.id, 'idem_s');
    expect(() => h.core.engine.supersede(o.id, 'too late')).toThrow(IllegalTransitionError);
  });

  it('memory corrections supersede prior facts and the chain is inspectable', () => {
    const h = makeHarness();
    const original = h.core.memory.add({
      subject: 'sister',
      predicate: 'availability',
      value: 'Tuesdays (per mother)',
      source: { kind: 'utterance', ref: 'ep1', assertedBy: 'mother' },
      confidence: 0.5,
    });
    const corrected = h.core.memory.correct({
      subject: 'sister',
      predicate: 'availability',
      value: 'Fridays after two, downtown only (per sister)',
      source: { kind: 'user-correction', ref: 'ep2', assertedBy: 'sister' },
      confidence: 0.95,
    });
    const active = h.core.memory.lookup('sister', 'availability')!;
    expect(active.id).toBe(corrected.id);
    expect(active.value).toContain('Fridays after two');
    const chain = h.core.memory.get(original.id)!;
    expect(chain.supersededBy).toBe(corrected.id);
    // never deleted: still inspectable
    expect(h.core.memory.inspect().map((f) => f.id)).toContain(original.id);
  });
});
