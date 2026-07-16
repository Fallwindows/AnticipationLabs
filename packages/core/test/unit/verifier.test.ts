import { describe, expect, it } from 'vitest';
import { makeApproved, makeHarness, sampleSignature } from '../helpers/harness.js';

/**
 * Verifier tests (§12, I6): truth comes from an independent read — the Sent folder
 * AND the recipient's fixture mailbox — never from the actor's report.
 */
describe('Verifier — read-only, independent (I6)', () => {
  it('confirms a sent email via sent folder + recipient mailbox', async () => {
    const h = makeHarness();
    const sig = sampleSignature();
    const o = makeApproved(h, sig);
    const result = await h.core.executeAndVerify(o.id);
    expect(result.status).toBe('verified');
    if (result.status === 'verified') {
      expect(result.record.source).toBe('read:sent-folder+recipient-mailbox');
      expect(result.record.evidence.deliveredToRecipientMailbox).toBe(true);
      expect(result.record.evidence.to).toBe(sig.target);
    }
    // the recipient mailbox actually holds the message
    const inbox = h.world.mailboxes.get(sig.target)!;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.subject).toBe('Meeting notes');
  });

  it('reports not-found when the actor claims success but ground truth has nothing', async () => {
    const h = makeHarness();
    const sig = sampleSignature();
    const o = makeApproved(h, sig);
    // Execute normally...
    await h.core.actor.execute(o.id);
    // ...then simulate a lying world: wipe ground truth behind the actor's back.
    h.world.sentMessages.length = 0;
    h.world.mailboxes.clear();
    h.core.engine.beginVerification(o.id);
    const result = await h.core.verifier.verify(h.core.engine.get(o.id));
    expect(result.status).toBe('not-found');
    // outcome must NOT be Verified
    expect(h.core.engine.get(o.id).state).toBe('Verifying');
  });

  it('reports mismatch when the sent artifact differs from the approved signature', async () => {
    const h = makeHarness();
    const sig = sampleSignature();
    const o = makeApproved(h, sig);
    await h.core.actor.execute(o.id);
    // tamper with ground truth: subject differs from what was approved
    h.world.sentMessages[0]!.subject = 'Totally different subject';
    h.core.engine.beginVerification(o.id);
    const result = await h.core.verifier.verify(h.core.engine.get(o.id));
    expect(result.status).toBe('mismatch');
  });

  it('every verifier read lands in the audit log with a verifier actor, never an actor actor', async () => {
    const h = makeHarness();
    const o = makeApproved(h);
    await h.core.executeAndVerify(o.id);
    const entries = h.core.audit.byOutcome(o.id);
    const verifierEntries = entries.filter((e) => e.actor.startsWith('verifier:'));
    expect(verifierEntries.length).toBeGreaterThanOrEqual(1);
    expect(verifierEntries[0]!.action).toBe('email.send.verify');
  });

  it('the verified record is what closes the loop — actor output alone cannot move the machine to Verified', async () => {
    const h = makeHarness();
    const o = makeApproved(h);
    await h.core.actor.execute(o.id);
    // Executed, not Verified:
    expect(h.core.engine.get(o.id).state).toBe('Executed');
  });
});
