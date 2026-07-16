import { describe, expect, it } from 'vitest';
import { makeHarness, makePrepared, sampleSignature } from '../helpers/harness.js';
import { signatureHash } from '../../src/approval/approvals.js';
import { ApprovalGateError } from '../../src/engine/outcomeEngine.js';
import type { ActionSignature } from '../../src/domain/types.js';

/**
 * Approval-binding tests (§12, I5): mutate one field of the ActionSignature and the
 * token no longer authorizes anything. Single-use, scoped, expiring.
 */
describe('Approval binding (I5)', () => {
  const mutations: { name: string; mutate: (s: ActionSignature) => ActionSignature }[] = [
    { name: 'recipient/target', mutate: (s) => ({ ...s, target: 'other@evil.example' }) },
    {
      name: 'item/params.subject',
      mutate: (s) => ({ ...s, params: { ...s.params, subject: 'Different subject' } }),
    },
    {
      name: 'amount',
      mutate: (s) => ({ ...s, params: { ...s.params, amount: 999999 } }),
    },
    {
      name: 'refund destination',
      mutate: (s) => ({ ...s, params: { ...s.params, refundDestination: 'gift card' } }),
    },
    { name: 'page version', mutate: (s) => ({ ...s, pageVersionHash: 'page-v2' }) },
    { name: 'disclosures', mutate: (s) => ({ ...s, disclosures: ['something else'] }) },
    { name: 'actionType', mutate: (s) => ({ ...s, actionType: 'email.send-all' }) },
  ];

  for (const { name, mutate } of mutations) {
    it(`editing ${name} invalidates the approval`, () => {
      const h = makeHarness();
      const sig = sampleSignature();
      const o = makePrepared(h, sig);
      h.core.engine.requestApproval(o.id);
      const approved = h.core.engine.approve(o.id, 'Omar', 'scope');
      const token = h.core.approvals.get(approved.approvalTokenId!)!;

      const mutated = mutate(sig);
      expect(signatureHash(mutated)).not.toBe(signatureHash(sig));
      const check = h.core.approvals.check(token.id, mutated);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toBe('signature-mismatch');
    });
  }

  it('hash is canonical: key order does not matter, content does', () => {
    const a = sampleSignature();
    const b: ActionSignature = JSON.parse(JSON.stringify(a));
    // rebuild params in reverse key order
    b.params = Object.fromEntries(Object.entries(b.params).reverse());
    expect(signatureHash(a)).toBe(signatureHash(b));
  });

  it('editing the prepared action through the engine invalidates and re-requests approval', () => {
    const h = makeHarness();
    const sig = sampleSignature();
    const o = makePrepared(h, sig);
    h.core.engine.requestApproval(o.id);
    const approved = h.core.engine.approve(o.id, 'Omar', 'scope');
    const tokenId = approved.approvalTokenId!;

    const edited = h.core.editAction(
      o.id,
      { ...sig, params: { ...sig.params, body: 'Edited body.' } },
      'Omar',
    );
    expect(edited.state).toBe('AwaitingApproval');
    expect(edited.approvalTokenId).toBeUndefined();
    const token = h.core.approvals.get(tokenId)!;
    expect(token.invalidatedAt).toBeTruthy();
    expect(token.invalidationReason).toContain('edited');
    // and execution is impossible until a fresh approval on the new signature
    expect(() => h.core.engine.startExecution(o.id, 'idem_e')).toThrow();
  });

  it('a token is single-use: consuming twice fails', () => {
    const h = makeHarness();
    const sig = sampleSignature();
    const o = makePrepared(h, sig);
    h.core.engine.requestApproval(o.id);
    const approved = h.core.engine.approve(o.id, 'Omar', 'scope');
    const first = h.core.approvals.consume(approved.approvalTokenId!, sig);
    expect(first.ok).toBe(true);
    const second = h.core.approvals.consume(approved.approvalTokenId!, sig);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('consumed');
  });

  it('tokens expire on the clock', () => {
    const h = makeHarness();
    const sig = sampleSignature();
    const o = makePrepared(h, sig);
    h.core.engine.requestApproval(o.id);
    const expiresAt = new Date(h.clock.now().getTime() + 60_000).toISOString();
    const approved = h.core.engine.approve(o.id, 'Omar', 'scope', expiresAt);
    h.clock.advanceMinutes(2);
    expect(() => h.core.engine.startExecution(o.id, 'idem_x')).toThrow(ApprovalGateError);
    const check = h.core.approvals.check(approved.approvalTokenId!, sig);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('expired');
  });

  it('the execution gate re-hashes at execution time: drift after approval is caught', () => {
    const h = makeHarness();
    const sig = sampleSignature();
    const o = makePrepared(h, sig);
    h.core.engine.requestApproval(o.id);
    h.core.engine.approve(o.id, 'Omar', 'scope');
    // Simulate drift: engine.editPreparedAction from Approved returns to AwaitingApproval,
    // so the only way to "drift" past the gate would be a stale token — build one:
    const stale = h.core.approvals.byOutcome(o.id)[0]!;
    const driftedSig = { ...sig, target: 'attacker@evil.example' };
    const check = h.core.approvals.check(stale.id, driftedSig);
    expect(check.ok).toBe(false);
  });
});
