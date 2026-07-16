import type { ActionSignature, Outcome, VerificationRecord } from '../domain/types.js';
import type { ReadPorts } from '../integrations/ports.js';
import { AuditLog } from '../audit/auditLog.js';
import type { Clock } from '../util/clock.js';
import type { ChatMessage } from '../util/events.js';

/** Read-only view of the chat log — the verifier can never hold a writable repo (I6). */
export interface ChatReadView {
  all(): ChatMessage[];
}

export type VerifyResult =
  | { status: 'verified'; record: VerificationRecord }
  | { status: 'not-found' }
  | { status: 'mismatch'; detail: string };

/**
 * The Verifier (§5.8, I6/I7). Constructed with READ ports only — it cannot perform a
 * side effect by construction. It ignores what the actor said and reads ground truth:
 * the Sent message (and, in fixtures, the recipient's mailbox), the return record and
 * QR, the ticketed PNR with seat/baggage, the reservation number and terms, the
 * cancellation's effective date. Lookups go by idempotency key, which is also how
 * post-timeout recovery finds an already-created result instead of retrying (I7).
 */
export class Verifier {
  constructor(
    private read: ReadPorts,
    private chat: ChatReadView,
    private audit: AuditLog,
    private clock: Clock,
  ) {}

  async verify(outcome: Outcome): Promise<VerifyResult> {
    if (!outcome.preparedAction || !outcome.idempotencyKey) {
      return { status: 'mismatch', detail: 'outcome has no prepared action / idempotency key' };
    }
    const result = await this.check(outcome.preparedAction, outcome.idempotencyKey);
    this.audit.append({
      outcomeId: outcome.id,
      actor: `verifier:${outcome.preparedAction.actionType}`,
      action: `${outcome.preparedAction.actionType}.verify`,
      target: outcome.preparedAction.target,
      result:
        result.status === 'verified'
          ? `ground truth confirmed: ${JSON.stringify(result.record.evidence)}`
          : result.status === 'not-found'
            ? 'no ground-truth artifact found (yet)'
            : `MISMATCH: ${result.detail}`,
    });
    return result;
  }

  private record(source: string, evidence: Record<string, unknown>): VerifyResult {
    return {
      status: 'verified',
      record: { verifiedAt: this.clock.now().toISOString(), source, evidence },
    };
  }

  private async check(sig: ActionSignature, key: string): Promise<VerifyResult> {
    switch (sig.actionType) {
      case 'email.send': {
        const matches = await this.read.email.searchSent({ idempotencyKey: key });
        const sent = matches[0];
        if (!sent) return { status: 'not-found' };
        if (sent.to !== sig.target) return { status: 'mismatch', detail: `recipient ${sent.to} != ${sig.target}` };
        if (sent.subject !== String(sig.params.subject)) {
          return { status: 'mismatch', detail: 'subject differs from approved signature' };
        }
        if (sent.body !== String(sig.params.body)) {
          return { status: 'mismatch', detail: 'body differs from approved signature' };
        }
        const wantAttachments = Array.isArray(sig.params.attachments)
          ? (sig.params.attachments as { name: string }[]).map((a) => a.name).sort()
          : [];
        const gotAttachments = (sent.attachments ?? []).map((a) => a.name).sort();
        if (JSON.stringify(wantAttachments) !== JSON.stringify(gotAttachments)) {
          return { status: 'mismatch', detail: 'attachments differ from approved signature' };
        }
        // Independent delivery check: the recipient mailbox, not the sender's word (§12).
        const inbox = await this.read.email.readMailbox(sent.to);
        const delivered = inbox.some((m) => m.messageId === sent.messageId);
        if (!delivered) return { status: 'not-found' };
        return this.record('read:sent-folder+recipient-mailbox', {
          messageId: sent.messageId,
          to: sent.to,
          subject: sent.subject,
          sentAt: sent.sentAt,
          attachments: gotAttachments,
          deliveredToRecipientMailbox: true,
        });
      }
      case 'commerce.submit-return': {
        const ret = await this.read.commerce.findExistingReturn({
          orderId: sig.target,
          idempotencyKey: key,
        });
        if (!ret) return { status: 'not-found' };
        if (ret.reason !== String(sig.params.reason)) {
          return { status: 'mismatch', detail: 'return reason differs' };
        }
        if (ret.refundDestination !== String(sig.params.refundDestination)) {
          return { status: 'mismatch', detail: 'refund destination differs' };
        }
        return this.record('read:returns-page', {
          returnId: ret.returnId,
          qrCodeRef: ret.qrCodeRef,
          refundAmount: ret.refundAmount,
          refundDestination: ret.refundDestination,
          status: ret.status,
        });
      }
      case 'airline.rebook': {
        const res = await this.read.airline.findReservationByIdempotencyKey(key);
        if (!res) return { status: 'not-found' };
        if (res.status !== 'ticketed') return { status: 'mismatch', detail: `reservation is ${res.status}` };
        return this.record('read:reservation-system', {
          pnr: res.pnr,
          seat: res.seat,
          baggageChecked: res.baggageChecked,
          segments: res.segments,
        });
      }
      case 'telephony.call': {
        const call = await this.read.telephony.findCallByIdempotencyKey(key);
        if (!call) return { status: 'not-found' };
        return this.record('read:call-log', {
          callId: call.callId,
          spokeTo: call.spokeTo,
          promisedETA: call.promisedETA,
          disclosure: call.disclosure,
        });
      }
      case 'reservation.book': {
        const booking = await this.read.reservations.findBookingByIdempotencyKey(key);
        if (!booking) return { status: 'not-found' };
        if (booking.status !== 'confirmed') {
          return { status: 'mismatch', detail: `booking is ${booking.status}` };
        }
        return this.record('read:reservation-confirmation', {
          reservationNumber: booking.reservationNumber,
          slot: booking.slot,
          partySize: booking.partySize,
          terms: booking.terms,
        });
      }
      case 'billing.cancel': {
        const sub = await this.read.billing.findCancellationByIdempotencyKey(key);
        if (!sub?.cancellation) return { status: 'not-found' };
        return this.record('read:billing-account', {
          effectiveDate: sub.cancellation.effectiveDate,
          confirmationRef: sub.cancellation.confirmationRef,
          status: sub.status,
        });
      }
      case 'chat.deliver-brief': {
        const msg = this.chat.all().find((m) => m.id === `brief_${key}`);
        if (!msg) return { status: 'not-found' };
        return this.record('read:chat-log', { messageId: msg.id, at: msg.at });
      }
      default:
        return { status: 'mismatch', detail: `no verifier for actionType "${sig.actionType}"` };
    }
  }
}
