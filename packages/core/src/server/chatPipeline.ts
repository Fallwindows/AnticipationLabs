import type { AgentCore } from '../app/agentCore.js';
import type { Episode } from '../domain/types.js';
import type { LLMProvider } from '../llm/provider.js';
import { LLMProviderError } from '../llm/provider.js';
import { HOUR, MINUTE, DAY } from '../util/clock.js';

/**
 * Live chat pipeline: turns free-form user messages into episodes, interpretation,
 * read-only preparation, and approval cards — and drives the post-approval
 * execute→verify→watch flow. Scenario fixtures bypass this and drive AgentCore
 * directly; this class is what the interactive app uses.
 */
export class ChatPipeline {
  private episode: Episode | null = null;

  constructor(
    private core: AgentCore,
    private llm: LLMProvider,
    private userName = 'Omar',
  ) {}

  private ensureEpisode(): Episode {
    if (!this.episode) {
      this.episode = this.core.startEpisode({ participants: [this.userName] });
    }
    return this.episode;
  }

  /** Start a fresh episode (e.g. the user switched topics). */
  newEpisode(): void {
    this.episode = null;
  }

  async onUserMessage(text: string): Promise<void> {
    this.core.postChat({ role: 'user', text, kind: 'text' });
    const episode = this.ensureEpisode();
    this.core.addUtterance(episode.id, { speaker: this.userName, text, channel: 'chat' });

    const report = await this.core.interpretEpisode(episode.id);

    for (const outcome of [...report.created, ...report.reopened]) {
      const current = this.core.engine.get(outcome.id);
      if (current.state !== 'Interpreting' || !current.preparationHint) continue;
      try {
        const prep = await this.core.prepareOutcome(current.id);
        if (prep.kind === 'action') {
          this.core.presentApproval(
            current.id,
            prep.summary,
            `one ${prep.signature.actionType} to ${prep.signature.target}`,
          );
        }
      } catch (err) {
        this.core.postChat({
          role: 'system',
          text: `Preparation for "${current.title}" needs more information: ${err instanceof Error ? err.message : String(err)}`,
          kind: 'text',
          outcomeId: current.id,
        });
      }
    }

    // Conversational reply is optional — a fixture provider without a canned
    // 'chat-reply' simply stays quiet and lets the cards speak.
    try {
      const reply = await this.llm.complete({
        tag: 'chat-reply',
        system:
          'You are Anticipy. Reply in one or two short sentences. Never promise an action that has not been approved.',
        prompt: text,
      });
      this.core.postChat({ role: 'anticipy', text: reply, kind: 'text' });
    } catch (err) {
      if (!(err instanceof LLMProviderError)) throw err;
    }
  }

  /**
   * Human approved the card: execute through the gate, verify independently, then
   * attach the domain-appropriate ground-truth watch (I4/I8).
   */
  async onApprove(outcomeId: string, approvedBy: string): Promise<void> {
    const outcome = this.core.engine.get(outcomeId);
    const sig = outcome.preparedAction;
    if (!sig) throw new Error('nothing prepared to approve');
    this.core.approve(outcomeId, approvedBy, `one ${sig.actionType} to ${sig.target}`);
    const result = await this.core.executeAndVerify(outcomeId);

    if (result.status !== 'verified') {
      this.core.postChat({
        role: 'anticipy',
        text: `I attempted the action but could not verify it yet (${result.status}). I will not retry blindly — the outcome stays open for re-checking.`,
        kind: 'text',
        outcomeId,
      });
      return;
    }

    const ev = result.record.evidence;
    switch (sig.actionType) {
      case 'telephony.call':
        this.core.postChat({
          role: 'anticipy',
          text: `Done — spoke to ${String(ev.spokeTo)}, promised ETA ${String(ev.promisedETA)}. I'll follow up if it doesn't arrive.`,
          kind: 'text',
          outcomeId,
        });
        this.core.startWatch({
          outcomeId,
          kind: 'delivery',
          description: `delivery promised by ${String(ev.spokeTo)} (ETA ${String(ev.promisedETA)})`,
          closeCondition: {
            kind: 'delivery-confirmed',
            params: { callId: ev.callId },
            description: 'user or counterparty confirms delivery',
          },
          followUpAction: 'nudge-front-desk',
          followUpWindowMs: 20 * MINUTE,
          firstPollAt: new Date(this.core.clock.now().getTime() + 20 * MINUTE).toISOString(),
        });
        break;
      case 'commerce.submit-return':
        this.core.startWatch({
          outcomeId,
          kind: 'refund',
          description: `refund of ${String(sig.params.refundAmount)} to ${String(sig.params.refundDestination)}`,
          closeCondition: {
            kind: 'refund-posted',
            params: {
              returnId: ev.returnId,
              amount: sig.params.refundAmount,
              destination: sig.params.refundDestination,
            },
            description: 'refund posts to the original payment method',
          },
        });
        break;
      case 'email.send':
        this.core.startWatch({
          outcomeId,
          kind: 'reply',
          description: `reply from ${sig.target}`,
          closeCondition: {
            kind: 'reply-received',
            params: { mailbox: String(sig.params.from), from: sig.target },
            description: 'a reply arrives',
          },
        });
        break;
      case 'billing.cancel': {
        const since = this.core.clock.now().toISOString();
        this.core.startWatch({
          outcomeId,
          kind: 'billing',
          description: 'final billing period shows no rogue charge',
          closeCondition: {
            kind: 'no-rogue-charge',
            params: {
              subscriptionId: sig.target,
              since,
              periodEnd: String(ev.effectiveDate ?? since),
              allowedFinalAmount: sig.params.earlyTerminationFee ?? 0,
            },
            description: 'no unexpected charge through the effective date',
          },
        });
        break;
      }
      case 'airline.rebook':
        this.core.startWatch({
          outcomeId,
          kind: 'flight',
          description: 'replacement itinerary until flown',
          closeCondition: {
            kind: 'flight-completed',
            params: {
              flightNumber: String(sig.params.optionId),
              date: this.core.clock.now().toISOString().slice(0, 10),
            },
            description: 'replacement flight departs',
          },
        });
        break;
      default:
        // reservation.book, chat.deliver-brief: the verified action was the deliverable.
        this.core.closeAsActionWasOutcome(outcomeId, ev);
        break;
    }

    // If a watch was attached while Verified, the engine moved to Watching already
    // via startWatch; announce quietly.
    if (sig.actionType !== 'telephony.call') {
      this.core.postChat({
        role: 'anticipy',
        text: `Verified: ${JSON.stringify(ev)}`,
        kind: 'text',
        outcomeId,
      });
    }
  }
}

export const CHAT_PIPELINE_TIMEOUTS = { HOUR, DAY };
