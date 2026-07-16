import type { ActionSignature, Outcome } from '../domain/types.js';
import type { WritePorts } from '../integrations/ports.js';
import { AdapterRefusalError, AdapterTimeoutError, type WriteReceipt } from '../integrations/ports.js';
import { VAULT_PLACEHOLDER, type Vault } from '../memory/vault.js';
import { AuditLog } from '../audit/auditLog.js';
import { OutcomeEngine } from '../engine/outcomeEngine.js';
import { IdempotencyRepo } from '../persistence/repos.js';
import type { Clock } from '../util/clock.js';
import { canonicalJson, sha256Hex } from '../util/canonical.js';
import { signatureHash } from '../approval/approvals.js';
import type { ChatMessage, EventBus } from '../util/events.js';
import type { IdSource } from '../util/ids.js';
import { ChatRepo } from '../persistence/repos.js';

export type ActorOutcome =
  | { status: 'attempted'; receipt: WriteReceipt }
  | { status: 'timeout' }
  | { status: 'refused'; reason: string };

/**
 * Execution actors (§5.7). Fire-once: the actor performs the side effect through a
 * write port, attaches the idempotency key, discloses identity on external contact,
 * writes the audit entry — and then HANDS OFF to the verifier. The actor's own report
 * is recorded as "attempted", never as success (I6). Vault placeholders in params are
 * substituted here, at the adapter boundary, after the model is out of the loop and
 * after the approval hash was checked (§5.11).
 */
export class ExecutionActor {
  constructor(
    private engine: OutcomeEngine,
    private write: WritePorts,
    private vault: Vault,
    private audit: AuditLog,
    private idempotency: IdempotencyRepo,
    private clock: Clock,
    private ids: IdSource,
    private chat: ChatRepo,
    private events: EventBus,
  ) {}

  /** Deterministic idempotency key: same outcome + same signature => same key (I7). */
  idempotencyKeyFor(outcome: Outcome): string {
    if (!outcome.preparedAction) throw new Error('no prepared action');
    return `idem_${sha256Hex(outcome.id + signatureHash(outcome.preparedAction)).slice(0, 24)}`;
  }

  private static DISPATCHABLE = new Set([
    'email.send',
    'commerce.submit-return',
    'airline.rebook',
    'telephony.call',
    'reservation.book',
    'billing.cancel',
    'chat.deliver-brief',
  ]);

  /**
   * Approved -> Executing -> Executed. Consumes the approval token via the engine gate;
   * any signature drift throws there and nothing fires.
   */
  async execute(outcomeId: string): Promise<ActorOutcome> {
    let outcome = this.engine.get(outcomeId);
    if (!outcome.preparedAction) throw new Error('no prepared action');
    const signature = outcome.preparedAction;
    const key = this.idempotencyKeyFor(outcome);

    // Routability and shape are checked BEFORE the gate — an unroutable or malformed
    // signature must fail while the approval token is still alive and the machine is
    // still in a recoverable state, never after.
    if (!ExecutionActor.DISPATCHABLE.has(signature.actionType)) {
      throw new Error(`no actor dispatch for actionType "${signature.actionType}"`);
    }
    if (!Array.isArray(signature.disclosures) || typeof signature.params !== 'object' || signature.params === null) {
      throw new Error('malformed action signature: params/disclosures missing');
    }
    // External contact requires disclosure (I11) — refuse while the token is
    // still alive, not after it has been consumed.
    if (signature.actionType === 'telephony.call' && signature.disclosures.join(' ').trim() === '') {
      throw new Error('telephony.call requires a disclosure in the signed signature (I11)');
    }

    // Gate: consumes the single-use token bound to this exact signature (I5).
    outcome = this.engine.startExecution(outcomeId, key);

    // Fire-once bookkeeping: if an attempt was ever recorded for this key, the actor
    // must NOT submit again — recovery goes through the verifier's re-read (I7).
    const fresh = this.idempotency.recordAttempt(
      key,
      outcomeId,
      signature.actionType,
      this.clock.now().toISOString(),
    );
    if (!fresh) {
      this.audit.append({
        outcomeId,
        actor: `actor:${signature.actionType}`,
        action: `${signature.actionType}.skip-resubmit`,
        target: signature.target,
        result: 'attempt already recorded for idempotency key; deferring to verifier re-read',
        signatureHash: signatureHash(signature),
      });
      this.engine.markExecuted(outcomeId, 'skipped duplicate submit; awaiting re-read');
      return { status: 'timeout' };
    }

    const disclosure = signature.disclosures.join(' ') || undefined;
    try {
      const receipt = await this.dispatch(outcome, signature, key);
      this.idempotency.recordResult(key, receipt.ref);
      this.audit.append({
        outcomeId,
        actor: `actor:${signature.actionType}`,
        action: signature.actionType,
        target: signature.target,
        disclosure,
        spokeTo: typeof receipt.detail?.spokeTo === 'string' ? receipt.detail.spokeTo : undefined,
        promisedETA:
          typeof receipt.detail?.promisedETA === 'string' ? receipt.detail.promisedETA : undefined,
        result: `attempted; adapter ref ${receipt.ref} (unverified)`,
        signatureHash: signatureHash(signature),
      });
      this.engine.markExecuted(outcomeId, `adapter ref ${receipt.ref}`);
      return { status: 'attempted', receipt };
    } catch (err) {
      if (err instanceof AdapterRefusalError) {
        // Contract: the adapter refused BEFORE any side effect. The token is spent
        // (the audit shows why); the machine proceeds to verification, which will
        // confirm nothing happened, leaving a cancellable Verifying outcome.
        this.audit.append({
          outcomeId,
          actor: `actor:${signature.actionType}`,
          action: signature.actionType,
          target: signature.target,
          disclosure,
          result: `REFUSED by adapter (no side effect): ${err.message}`,
          signatureHash: signatureHash(signature),
        });
        this.engine.markExecuted(outcomeId, `adapter refused: ${err.message}`);
        return { status: 'refused', reason: err.message };
      }
      if (err instanceof AdapterTimeoutError) {
        this.audit.append({
          outcomeId,
          actor: `actor:${signature.actionType}`,
          action: signature.actionType,
          target: signature.target,
          disclosure,
          result: 'attempted; TIMED OUT awaiting confirmation — outcome unknown, verifier must re-read',
          signatureHash: signatureHash(signature),
        });
        this.engine.markExecuted(outcomeId, 'timed out; result unknown');
        return { status: 'timeout' };
      }
      // Any other adapter failure: the attempt happened and MAY have side-effected.
      // Never strand the machine in Executing (its only edge is Executed) — record
      // the failure and hand off to verification, which re-reads ground truth. From
      // Verifying, the human kill switch is legal again.
      this.audit.append({
        outcomeId,
        actor: `actor:${signature.actionType}`,
        action: signature.actionType,
        target: signature.target,
        disclosure,
        result: `attempt FAILED: ${err instanceof Error ? err.message : String(err)} — verifier must establish ground truth`,
        signatureHash: signatureHash(signature),
      });
      this.engine.markExecuted(outcomeId, `attempt failed: ${err instanceof Error ? err.message : String(err)}`);
      return { status: 'timeout' };
    }
  }

  private async dispatch(
    outcome: Outcome,
    signature: ActionSignature,
    key: string,
  ): Promise<WriteReceipt> {
    // Internal actions never receive vault material: their "adapter" is the chat
    // log / event stream, which is persisted and broadcast — exactly the surfaces
    // I12 forbids. Refuse placeholders outright rather than decrypting into chat.
    if (signature.actionType === 'chat.deliver-brief') {
      // fresh non-global copy: the shared regex has /g and stateful lastIndex
      if (new RegExp(VAULT_PLACEHOLDER.source).test(canonicalJson(signature.params))) {
        throw new Error('vault placeholders are not allowed in internal chat deliverables (I12)');
      }
      const msg: ChatMessage = {
        id: `brief_${key}`,
        role: 'anticipy',
        text: String(signature.params.text),
        at: this.clock.now().toISOString(),
        outcomeId: outcome.id,
        kind: 'text',
      };
      this.chat.save(msg);
      this.events.emit({ type: 'chat.message', message: msg });
      return { ref: msg.id };
    }

    // Secret substitution at the adapter boundary (§5.11): the hash bound the
    // placeholder; the raw value exists only inside this call frame, en route to an
    // external adapter.
    const params = this.vault.substituteParams(signature.params, `actor:${signature.actionType}`);
    switch (signature.actionType) {
      case 'email.send':
        return this.write.email.sendEmail(
          {
            from: String(params.from),
            to: signature.target,
            cc: Array.isArray(params.cc) ? (params.cc as string[]) : [],
            subject: String(params.subject),
            body: String(params.body),
            attachments: Array.isArray(params.attachments)
              ? (params.attachments as { name: string; contentRef: string }[])
              : [],
          },
          key,
        );
      case 'commerce.submit-return':
        return this.write.commerce.submitReturn(
          {
            orderId: signature.target,
            lineId: String(params.lineId),
            reason: String(params.reason),
            method: String(params.method),
            refundDestination: String(params.refundDestination),
            pageVersionHash: signature.pageVersionHash,
          },
          key,
        );
      case 'airline.rebook':
        return this.write.airline.rebook(
          { pnr: signature.target, optionId: String(params.optionId), pageVersionHash: signature.pageVersionHash },
          key,
        );
      case 'telephony.call':
        return this.write.telephony.placeCall(
          {
            to: signature.target,
            script: String(params.script),
            disclosure: signature.disclosures.join(' '),
          },
          key,
        );
      case 'reservation.book':
        return this.write.reservations.book(
          {
            restaurantId: signature.target,
            slot: String(params.slot),
            partySize: Number(params.partySize),
            pageVersionHash: signature.pageVersionHash,
          },
          key,
        );
      case 'billing.cancel':
        return this.write.billing.cancelSubscription(
          {
            subscriptionId: signature.target,
            mode: params.mode === 'immediate' ? 'immediate' : 'at-term',
            pageVersionHash: signature.pageVersionHash,
          },
          key,
        );
      default:
        throw new Error(`no actor dispatch for actionType "${signature.actionType}"`);
    }
  }
}
