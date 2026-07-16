import { FixtureWorld } from '../integrations/fixtures/fixtureWorld.js';
import type { AgentCore } from '../app/agentCore.js';

/**
 * Demo world for interactive runs: enough seeded state to walk scenario 1 (the
 * Montreal toothbrush) and poke at the panels. Automated tests do NOT use this —
 * each scenario fixture seeds its own world (§12).
 */
export function seedDemoWorld(world: FixtureWorld): void {
  world.hotels.push({
    name: 'Hôtel Le Germain Montréal',
    phone: '+1-514-849-2050',
    amenities: {
      'dental kit': 'complimentary dental kits at the front desk, delivered to rooms on request',
      'shaving kit': 'complimentary on request',
      gym: 'open 6:00–22:00',
    },
  });
}

export function seedDemoMemory(core: AgentCore): void {
  core.memory.add({
    subject: 'Elias',
    predicate: 'is',
    value: "Omar's grandfather, travelling with Omar in Montreal",
    source: { kind: 'seed', ref: 'demo' },
    confidence: 0.95,
  });
  core.memory.add({
    subject: 'Omar',
    predicate: 'hotel-room',
    value: 'room 814 at Hôtel Le Germain Montréal',
    source: { kind: 'evidence', ref: 'gmail-reservation-demo' },
    confidence: 0.98,
    // the room number stops being useful context at checkout (I12)
    expiresAt: '2026-07-19T11:00:00.000Z',
  });
}
