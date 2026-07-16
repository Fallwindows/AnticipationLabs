import { describe, expect, it } from 'vitest';
import { makeApproved, makeHarness, makePrepared, sampleSignature } from '../helpers/harness.js';
import { IllegalTransitionError, ApprovalGateError } from '../../src/engine/outcomeEngine.js';
import { LEGAL_TRANSITIONS, type OutcomeState } from '../../src/domain/types.js';

/**
 * State-machine tests (§12): exact transition paths, forbidden illegal edges.
 * "No Executing without token; no premature Closed" are the load-bearing ones.
 */
describe('Outcome state machine (§4.1, §5.4)', () => {
  it('walks the full happy path with the exact expected transition sequence', async () => {
    const h = makeHarness();
    const o = makeApproved(h);
    await h.core.executeAndVerify(o.id);
    h.core.startWatch({
      outcomeId: o.id,
      kind: 'reply',
      description: 'reply watch',
      closeCondition: {
        kind: 'reply-received',
        params: { mailbox: 'omar@anticipationlabs.example', from: o.preparedAction!.target },
        description: 'reply arrives',
      },
    });
    const watch = h.core.watches.all()[0]!;
    h.core.watches.satisfyExternally(watch.id, { reply: 'ok' });

    const path = h.core.engine.get(o.id).history.map((t) => t.to);
    expect(path).toEqual([
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
  });

  it('refuses Executing without a matching approval token (I5)', () => {
    const h = makeHarness();
    const o = makePrepared(h);
    // Prepared -> Executing is not even a legal edge
    expect(() => h.core.engine.startExecution(o.id, 'idem_x')).toThrow(IllegalTransitionError);
    // AwaitingApproval -> Executing also refused
    h.core.engine.requestApproval(o.id);
    expect(() => h.core.engine.startExecution(o.id, 'idem_x')).toThrow(IllegalTransitionError);
  });

  it('refuses a second execution: the token is single-use (I5)', async () => {
    const h = makeHarness();
    const o = makeApproved(h);
    await h.core.executeAndVerify(o.id);
    // Machine is in Verified; even forcing state back would need a fresh token.
    expect(() => h.core.engine.startExecution(o.id, 'idem_2')).toThrow(IllegalTransitionError);
  });

  it('refuses premature Closed from every state where closing is illegal (I4)', () => {
    const h = makeHarness();
    const o = makePrepared(h);
    expect(() =>
      h.core.engine.close(o.id, { kind: 'ground-truth', evidence: {} }),
    ).toThrow(IllegalTransitionError);
    h.core.engine.requestApproval(o.id);
    expect(() =>
      h.core.engine.close(o.id, { kind: 'ground-truth', evidence: {} }),
    ).toThrow(IllegalTransitionError);
    h.core.engine.approve(o.id, 'Omar', 'scope');
    expect(() =>
      h.core.engine.close(o.id, { kind: 'ground-truth', evidence: {} }),
    ).toThrow(IllegalTransitionError);
  });

  it('a Watching outcome refuses to close without ground truth (I4)', async () => {
    const h = makeHarness();
    const o = makeApproved(h);
    await h.core.executeAndVerify(o.id);
    h.core.startWatch({
      outcomeId: o.id,
      kind: 'ledger',
      description: 'payment watch',
      closeCondition: {
        kind: 'ledger-payment-posted',
        params: { invoiceNumber: '1047', amount: 100 },
        description: 'payment posts',
      },
    });
    expect(h.core.engine.get(o.id).state).toBe('Watching');
    expect(() =>
      h.core.engine.close(o.id, { kind: 'action-was-outcome', evidence: {} }),
    ).toThrow(IllegalTransitionError);
  });

  it('discussion parks as Dormant and new evidence reopens it (I3)', () => {
    const h = makeHarness();
    const episode = h.core.startEpisode({ participants: ['Omar'] });
    const o = h.core.engine.create({
      title: 'dinner talk',
      owner: 'Omar',
      originEpisodeId: episode.id,
      interpretedGoal: 'dinner might happen',
      originClassification: 'discussion',
    });
    h.core.engine.beginInterpretation(o.id);
    h.core.engine.markDormant(o.id, 'discussion is not authorization');
    expect(h.core.engine.get(o.id).state).toBe('Dormant');
    h.core.engine.reopenFromDormant(o.id, 'a date was fixed');
    expect(h.core.engine.get(o.id).state).toBe('Interpreting');
  });

  it('cancel (kill switch) works from pre-execution states and Watching, and is refused mid-execution (§9)', async () => {
    const h = makeHarness();
    const a = makePrepared(h);
    h.core.cancelOutcome(a.id, 'never mind');
    expect(h.core.engine.get(a.id).state).toBe('Cancelled');

    const b = makeApproved(h);
    h.core.cancelOutcome(b.id, 'never mind, I found mine');
    expect(h.core.engine.get(b.id).state).toBe('Cancelled');
    // its approval died with it
    const tokens = h.core.approvals.byOutcome(b.id);
    expect(tokens.every((t) => t.invalidatedAt)).toBe(true);

    // mid-flight: the machine must reach ground truth first
    const c = makeApproved(h);
    h.core.engine.startExecution(c.id, 'idem_c');
    expect(() => h.core.engine.cancel(c.id, 'stop!')).toThrow(IllegalTransitionError);
  });

  it('terminal states accept no further transitions', () => {
    const h = makeHarness();
    const o = makePrepared(h);
    h.core.engine.cancel(o.id, 'done with it');
    expect(() => h.core.engine.beginInterpretation(o.id)).toThrow(IllegalTransitionError);
    expect(() => h.core.engine.markPrepared(o.id, sampleSignature())).toThrow(IllegalTransitionError);
    expect(() => h.core.engine.supersede(o.id, 'x')).toThrow(IllegalTransitionError);
  });

  it('verification evidence must not come from an actor (I6)', () => {
    const h = makeHarness();
    const o = makeApproved(h);
    h.core.engine.startExecution(o.id, 'idem_v');
    h.core.engine.markExecuted(o.id, 'sent!');
    h.core.engine.beginVerification(o.id);
    expect(() =>
      h.core.engine.markVerified(o.id, {
        verifiedAt: h.clock.now().toISOString(),
        source: 'actor:email',
        evidence: { trustMe: true },
      }),
    ).toThrow(ApprovalGateError);
  });

  it('the legal-transition table itself has no edges into Executing except Approved and Verifying-recovery', () => {
    const from = (Object.keys(LEGAL_TRANSITIONS) as OutcomeState[]).filter((s) =>
      LEGAL_TRANSITIONS[s].includes('Executing'),
    );
    expect(from.sort()).toEqual(['Approved', 'Verifying']);
  });
});
