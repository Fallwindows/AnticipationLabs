import { describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from '../helpers/harness.js';
import { IllegalTransitionError } from '../../src/engine/outcomeEngine.js';
import { MINUTE } from '../../src/util/clock.js';

/**
 * Scenario 9 (§10.9) — Sister's passport.
 *
 * Omar accepted only the NARROW duty to ask (I10): nudge the sister, never run the
 * passport process, never book appointments. The mother is NOT the authority for the
 * sister's availability — her "Tuesdays" lands as a low-confidence fact asserted by
 * "mother", and the nudge ASKS the sister instead of assuming. The sister's direct
 * correction ("Fridays after two, downtown only") supersedes the mother's claim (I2).
 * Her passport number goes to the vault — never memory, never a prompt (I12); booking
 * would need precise authority plus a local user takeover, where the vault reveals the
 * number and audits the access without recording the number itself. The only world
 * write in the entire scenario is at most ONE email.send (the nudge); the reply-received
 * watch closes the outcome on ground truth only.
 */

const OMAR = 'omar@anticipationlabs.example';
const SISTER = 'leila@family.example';
const PASSPORT = 'HQ7841226';
const SUBJECT = 'Passport renewal — when actually works for you?';
const AUTHORITY_LIMIT =
  'only nudge/ask the sister — NOT run the passport process, NOT book appointments';
const MOTHER_CLAIM = 'available Tuesdays';
const SISTER_CORRECTION = 'Fridays after two, downtown only';

/** The canned nudge: it ASKS about her availability instead of assuming Mom's version. */
const NUDGE_DRAFT =
  'Hey Leila,\n\nMom mentioned you need to renew your passport before the trip. ' +
  'I did not want to assume her version of your schedule — when are you actually ' +
  'free to go in, and which location works for you?\n\nOmar';

/** No side effect anywhere except (at most) the single nudge email. */
function assertOnlyTheNudgeEverWrote(h: Harness, sends: 0 | 1): void {
  expect(h.world.writeCalls.every((w) => w.action === 'email.send')).toBe(true);
  expect(h.world.writesFor('email.send').length).toBeLessThanOrEqual(1);
  expect(h.world.writesFor('email.send')).toHaveLength(sends);
  // No bookings of any kind, anywhere in the world.
  expect(h.world.bookings).toHaveLength(0);
  expect(h.world.reservations).toHaveLength(0);
  expect(h.world.calls).toHaveLength(0);
  expect(h.world.writesFor('reservation.book')).toHaveLength(0);
  expect(h.world.writesFor('airline.rebook')).toHaveLength(0);
}

async function driveToInterpreted(h: Harness) {
  const episode = h.core.startEpisode({ participants: ['Omar', 'Mother'] });
  h.core.addUtterance(episode.id, {
    speaker: 'Mother',
    text:
      "Your sister needs her passport renewed before the trip — she's available Tuesdays. " +
      'Can you sort the whole thing out and book her an appointment?',
    channel: 'phone',
  });
  h.core.addUtterance(episode.id, {
    speaker: 'Omar',
    text:
      "I'm not going to run the whole passport process, and I'm not booking anything. " +
      "I'll ask her what actually works and take it from there.",
    channel: 'phone',
  });

  h.llm.enqueue('interpret-episode', {
    outcomes: [
      {
        key: 'nudge-sister',
        title: 'Ask the sister when she is free for her passport renewal',
        interpretedGoal:
          'nudge the sister about her passport-renewal availability — asking is the ENTIRE accepted duty',
        owner: 'Omar',
        beneficiary: 'sister',
        classification: 'commitment',
        confidence: 0.9,
        constraints: [
          { kind: 'authority-limit', description: AUTHORITY_LIMIT },
          {
            kind: 'scope',
            description:
              "the mother is not the authority for the sister's availability — check with the sister directly",
          },
        ],
        preparation: {
          kind: 'email-send',
          params: { from: OMAR, to: SISTER, subject: SUBJECT },
        },
      },
    ],
    facts: [
      {
        subject: 'sister',
        predicate: 'availability',
        value: MOTHER_CLAIM,
        confidence: 0.35, // secondhand — LOW
        assertedBy: 'mother',
      },
    ],
  });
  const report = await h.core.interpretEpisode(episode.id);
  return { outcome: report.created[0]!, report };
}

async function driveToPrepared(h: Harness) {
  const { outcome } = await driveToInterpreted(h);
  h.llm.enqueue('draft-email', NUDGE_DRAFT);
  const prep = await h.core.prepareOutcome(outcome.id);
  if (prep.kind !== 'action') throw new Error('expected action');
  return { outcome, prep };
}

describe("Scenario 9 — sister's passport", () => {
  it('Omar accepted only the narrow duty to ask: authority-limit recorded; the mother is not the authority (I10)', async () => {
    const h = makeHarness();
    const { outcome, report } = await driveToInterpreted(h);

    // The narrow scope is a first-class constraint on the outcome.
    const stored = h.core.engine.get(outcome.id);
    expect(stored.constraints.length).toBeGreaterThan(0);
    expect(
      stored.constraints.some(
        (c) => c.kind === 'authority-limit' && c.description === AUTHORITY_LIMIT,
      ),
    ).toBe(true);
    expect(stored.state).toBe('Interpreting');

    // The mother's "Tuesdays" is stored as HER claim, secondhand and low confidence.
    expect(report.factsAdded).toHaveLength(1);
    const fact = h.core.memory.lookup('sister', 'availability')!;
    expect(fact.value).toBe(MOTHER_CLAIM);
    expect(fact.source.assertedBy).toBe('mother');
    expect(fact.source.kind).toBe('utterance');
    expect(fact.confidence).toBeLessThan(0.5);

    // Interpretation is read-only: nothing touched the world.
    expect(h.world.writeCalls).toHaveLength(0);
    assertOnlyTheNudgeEverWrote(h, 0);
  });

  it("the nudge ASKS the sister about her availability instead of assuming the mother's Tuesdays", async () => {
    const h = makeHarness();
    const { outcome, prep } = await driveToPrepared(h);

    expect(prep.signature.actionType).toBe('email.send');
    expect(prep.signature.target).toBe(SISTER);
    const body = String(prep.signature.params.body);
    // It asks — a question about HER availability, not a booked slot.
    expect(body).toContain('?');
    expect(body).toContain('when are you actually free');
    expect(body).toContain('did not want to assume');

    // The drafting prompt carried the authority limit to the model.
    const draftReq = h.llm.seen.find((r) => r.tag === 'draft-email')!;
    expect(draftReq.prompt).toContain(AUTHORITY_LIMIT);

    // Preparation is read-only (§5.5); approving before the card is illegal (I5).
    expect(h.world.writeCalls).toHaveLength(0);
    expect(h.core.engine.get(outcome.id).state).toBe('Prepared');
    expect(() => h.core.approve(outcome.id, 'Omar', 'send it')).toThrow(IllegalTransitionError);
    assertOnlyTheNudgeEverWrote(h, 0);
  });

  it("the sister's direct correction supersedes the mother's Tuesdays (I2)", async () => {
    const h = makeHarness();
    await driveToInterpreted(h);
    expect(h.core.memory.lookup('sister', 'availability')!.value).toBe(MOTHER_CLAIM);

    // Her reply is its own episode; the correction is HER assertion, high confidence.
    const reply = h.core.startEpisode({ participants: ['Omar', 'Sister'] });
    h.core.addUtterance(reply.id, {
      speaker: 'Sister',
      text: "Fridays after two, downtown only — Tuesdays don't work for me anymore.",
      channel: 'sms',
    });
    h.llm.enqueue('interpret-episode', {
      outcomes: [],
      facts: [
        {
          subject: 'sister',
          predicate: 'availability',
          value: SISTER_CORRECTION,
          confidence: 0.95,
          corrects: true,
          assertedBy: 'sister',
        },
      ],
    });
    await h.core.interpretEpisode(reply.id);

    // The active belief is the sister's version.
    const active = h.core.memory.lookup('sister', 'availability')!;
    expect(active.value).toBe(SISTER_CORRECTION);
    expect(active.source.assertedBy).toBe('sister');
    expect(active.confidence).toBe(0.95);

    // The mother's fact is superseded — the chain stays inspectable.
    const chain = h.core.memory.query({
      subject: 'sister',
      predicate: 'availability',
      includeInactive: true,
    });
    const motherFact = chain.find((f) => f.source.assertedBy === 'mother')!;
    const sisterFact = chain.find((f) => f.source.assertedBy === 'sister')!;
    expect(motherFact.supersededBy).toBe(sisterFact.id);
    assertOnlyTheNudgeEverWrote(h, 0);
  });

  it('the passport number lives ONLY in the vault: never memory, never a prompt, encrypted at rest (I12)', async () => {
    const h = makeHarness();
    await driveToInterpreted(h);

    // She texts the number; it goes straight to the vault. Memory gets ONLY a pointer.
    const vaultId = h.core.vault.put('sister passport number', PASSPORT, 'Omar');
    h.core.memory.add({
      subject: 'sister',
      predicate: 'passport-number',
      value: `vault:${vaultId}`,
      source: { kind: 'utterance', ref: 'ep-sister-sms', assertedBy: 'sister' },
      confidence: 1,
      sensitivity: 'vault-ref',
    });
    expect(h.core.memory.inspect().some((f) => f.value.includes(PASSPORT))).toBe(false);
    const ref = h.core.memory.lookup('sister', 'passport-number')!;
    expect(ref.value).toBe(`vault:${vaultId}`);
    expect(ref.sensitivity).toBe('vault-ref');

    // Another interpretation runs with the vault-ref in memory — the model sees NOTHING.
    const episode = h.core.startEpisode({ participants: ['Omar'] });
    h.core.addUtterance(episode.id, {
      speaker: 'Omar',
      text: 'She texted me her passport number for the renewal form — stored securely, not repeating it here.',
      channel: 'chat',
    });
    h.llm.enqueue('interpret-episode', { outcomes: [], facts: [] });
    await h.core.interpretEpisode(episode.id);
    expect(h.llm.seen.length).toBeGreaterThan(0);
    for (const req of h.llm.seen) {
      expect(req.prompt).not.toContain(PASSPORT);
      expect(req.prompt).not.toContain('vault:');
      expect(req.system ?? '').not.toContain(PASSPORT);
      expect(req.system ?? '').not.toContain('vault:');
    }

    // Raw DB bytes never contain the plaintext.
    const rows = h.core.db.prepare('SELECT ciphertext FROM vault_items').all() as {
      ciphertext: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ciphertext).not.toContain(PASSPORT);
    expect(Buffer.from(rows[0]!.ciphertext, 'base64').toString('utf8')).not.toContain(PASSPORT);

    // Booking needs precise authority + LOCAL TAKEOVER (I12): the user takes over,
    // the vault reveals the number to them, and the access is audited — the audit
    // entry names the purpose, never the number.
    expect(h.core.vault.reveal(vaultId, 'user-takeover', 'takeover-step')).toBe(PASSPORT);
    const reveals = h.core.audit.all().filter((e) => e.action === 'vault.reveal');
    expect(reveals).toHaveLength(1);
    expect(reveals[0]!.result).toContain('user-takeover');
    expect(reveals[0]!.result).toContain('takeover-step');
    expect(reveals[0]!.result).not.toContain(PASSPORT);

    // And still: Anticipy booked nothing.
    assertOnlyTheNudgeEverWrote(h, 0);
  });

  it("sends the nudge once, verifies via the sister's mailbox, and only her reply closes it — ground truth (I4/I8)", async () => {
    const h = makeHarness();
    const { outcome, prep } = await driveToPrepared(h);

    h.core.presentApproval(outcome.id, prep.summary, 'one nudge email to the sister');
    h.core.approve(outcome.id, 'Omar', 'send the nudge');
    const verify = await h.core.executeAndVerify(outcome.id);
    expect(verify.status).toBe('verified');
    if (verify.status !== 'verified') throw new Error('unreachable');
    expect(verify.record.source).toBe('read:sent-folder+recipient-mailbox');
    expect(verify.record.evidence.deliveredToRecipientMailbox).toBe(true);

    // Exactly one send; the sister's fixture mailbox holds the exact nudge.
    expect(h.world.writesFor('email.send')).toHaveLength(1);
    const inbox = h.world.mailboxes.get(SISTER)!;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.subject).toBe(SUBJECT);
    expect(inbox[0]!.body).toBe(NUDGE_DRAFT);

    // The ask was sent, but the duty is answered only when SHE replies: watch it.
    const watch = h.core.startWatch({
      outcomeId: outcome.id,
      kind: 'reply',
      description: 'the sister replies to the passport nudge',
      closeCondition: {
        kind: 'reply-received',
        params: { mailbox: OMAR, from: SISTER },
        description: 'a reply from the sister lands in Omar\'s mailbox',
      },
    });
    expect(h.core.engine.get(outcome.id).state).toBe('Watching');

    // Watching closes ONLY on ground truth — declaring the send the outcome is illegal.
    expect(() => h.core.closeAsActionWasOutcome(outcome.id, { sent: true })).toThrow(
      IllegalTransitionError,
    );

    // No reply yet: a poll keeps it open.
    h.clock.advance(16 * MINUTE);
    await h.core.watches.tick();
    expect(h.core.engine.get(outcome.id).state).toBe('Watching');
    expect(h.core.watches.get(watch.id)!.state).toBe('active');

    // Her reply lands (the correction itself) — the next poll closes on ground truth.
    h.world.deliverToMailbox(OMAR, {
      messageId: 'msg-sister-reply',
      from: SISTER,
      to: OMAR,
      subject: `Re: ${SUBJECT}`,
      body: `${SISTER_CORRECTION} — Tuesdays don't work for me anymore.`,
      sentAt: h.clock.now().toISOString(),
    });
    h.clock.advance(16 * MINUTE);
    await h.core.watches.tick();
    const closed = h.core.engine.get(outcome.id);
    expect(closed.state).toBe('Closed');
    expect(closed.closure!.kind).toBe('ground-truth');
    expect((closed.closure!.evidence.reply as { from: string }).from).toBe(SISTER);
    expect(h.core.watches.get(watch.id)!.state).toBe('satisfied');

    // The exact transition path.
    expect(closed.history.map((t) => t.to)).toEqual([
      'Discovered',
      'Interpreting',
      'Prepared',
      'AwaitingApproval',
      'Approved',
      'Executing',
      'Executed',
      'Verifying',
      'Verified',
      'Watching',
      'Closed',
    ]);

    // Across the whole scenario: the single nudge was the ONLY write — no bookings.
    expect(h.world.writeCalls).toHaveLength(1);
    assertOnlyTheNudgeEverWrote(h, 1);
  });
});
