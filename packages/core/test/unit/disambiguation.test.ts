import { describe, expect, it } from 'vitest';
import { makeHarness } from '../helpers/harness.js';
import type { Entity } from '../../src/domain/types.js';

/**
 * Disambiguation tests (§12, I9): below the confidence threshold Anticipy asks a
 * question — it never contacts a human on a guess, and never resolves a person on
 * name similarity alone.
 */
describe('Entity resolution & disambiguation (I9)', () => {
  const marcusProject: Entity = {
    id: 'proj-marcus',
    type: 'project',
    names: ['Marcus migration project'],
    aliases: ['Marcus', 'the Marcus migration'],
    attributes: { vocabulary: 'migration,cutover,jira,sprint', descriptor: 'the data migration project' },
  };
  const marcusLee: Entity = {
    id: 'person-marcus-lee',
    type: 'person',
    names: ['Marcus Lee'],
    aliases: ['Marcus'],
    attributes: { descriptor: 'engineer on the platform team' },
  };
  const marcusChen: Entity = {
    id: 'person-marcus-chen',
    type: 'person',
    names: ['Marcus Chen'],
    aliases: ['Marcus'],
    attributes: { descriptor: 'the investor' },
  };

  it('resolves "Marcus" to the project from meeting context + vocabulary, not name similarity', () => {
    const h = makeHarness();
    h.core.resolver.addEntity(marcusProject);
    h.core.resolver.addEntity(marcusLee);
    h.core.resolver.addEntity(marcusChen);
    const res = h.core.resolveEntity('Marcus', {
      speaker: 'Priya',
      meetingContext: ['proj-marcus'],
      vocabulary: ['migration', 'cutover'],
    });
    expect(res.kind).toBe('resolved');
    if (res.kind === 'resolved') {
      expect(res.resolution.entity.id).toBe('proj-marcus');
      expect(res.resolution.confidence).toBeGreaterThanOrEqual(0.8);
      const kinds = res.resolution.evidence.map((e) => e.kind);
      expect(kinds).toContain('meeting-context');
      expect(kinds).toContain('domain-vocabulary');
    }
  });

  it('asks instead of resolving when candidates are too close (three Marcuses)', () => {
    const h = makeHarness();
    h.core.resolver.addEntity(marcusLee);
    h.core.resolver.addEntity(marcusChen);
    const res = h.core.resolveEntity('Marcus', {});
    expect(res.kind).toBe('ask');
    if (res.kind === 'ask') {
      expect(res.request.question).toContain('Marcus');
      expect(res.request.candidates.length).toBeGreaterThanOrEqual(2);
    }
    expect(h.core.resolver.pendingDisambiguations()).toHaveLength(1);
  });

  it('never resolves a person on name similarity alone, even unopposed', () => {
    const h = makeHarness();
    h.core.resolver.addEntity(marcusLee);
    const res = h.core.resolveEntity('Marcus', {});
    // Only one candidate, name match only -> still an ask (I9).
    expect(res.kind).toBe('ask');
  });

  it('a project CAN resolve on strong non-name context even without a person-gate', () => {
    const h = makeHarness();
    h.core.resolver.addEntity(marcusProject);
    const res = h.core.resolveEntity('Marcus', {
      meetingContext: ['proj-marcus'],
      vocabulary: ['migration', 'cutover', 'sprint'],
    });
    expect(res.kind).toBe('resolved');
  });

  it('an answered disambiguation resolves at full confidence and is recorded', () => {
    const h = makeHarness();
    h.core.resolver.addEntity(marcusLee);
    h.core.resolver.addEntity(marcusChen);
    const res = h.core.resolveEntity('Marcus', {});
    if (res.kind !== 'ask') throw new Error('expected ask');
    const resolution = h.core.resolver.answerDisambiguation(res.request.id, 'person-marcus-lee');
    expect(resolution.entity.id).toBe('person-marcus-lee');
    expect(resolution.confidence).toBe(1);
    expect(h.core.resolver.pendingDisambiguations()).toHaveLength(0);
  });

  it('emits a disambiguation.requested event for the UI', () => {
    const h = makeHarness();
    h.core.resolver.addEntity(marcusLee);
    h.core.resolver.addEntity(marcusChen);
    h.core.resolveEntity('Marcus', {});
    const events = h.core.events.history().filter((e) => e.type === 'disambiguation.requested');
    expect(events).toHaveLength(1);
  });
});
