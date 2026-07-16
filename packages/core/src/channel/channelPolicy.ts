import type { Clock } from '../util/clock.js';
import { HOUR } from '../util/clock.js';
import type { EventBus, Notification } from '../util/events.js';
import type { IdSource } from '../util/ids.js';

export type Urgency = 'low' | 'normal' | 'high' | 'critical';
export type Channel = 'quiet-card' | 'chat' | 'priority-push' | 'call';

/**
 * Channel & notification policy (§5.10, I13): the channel is derived from urgency and
 * content sensitivity — a policy, not a fixed default. Routine nudges are quiet
 * cards; a delay that breaks a hard deadline escalates to a call.
 */
export interface UrgencyInput {
  /** the hard deadline this event threatens, if any */
  deadlineAt?: string;
  /** does missing the deadline break a real commitment (keynote, flight, contract)? */
  breaksHardCommitment?: boolean;
  /** intrinsic importance absent any deadline */
  baseImportance?: 'low' | 'normal' | 'high';
}

export class ChannelPolicy {
  constructor(
    private clock: Clock,
    private ids: IdSource,
    private events: EventBus,
  ) {}

  deriveUrgency(input: UrgencyInput): Urgency {
    if (input.deadlineAt) {
      const msLeft = new Date(input.deadlineAt).getTime() - this.clock.now().getTime();
      if (input.breaksHardCommitment && msLeft <= 18 * HOUR) return 'critical';
      if (msLeft <= 4 * HOUR) return 'high';
      if (msLeft <= 24 * HOUR) return input.baseImportance === 'high' ? 'high' : 'normal';
    }
    if (input.baseImportance === 'high') return 'high';
    if (input.baseImportance === 'low') return 'low';
    return 'normal';
  }

  channelFor(urgency: Urgency, sensitive = false): Channel {
    switch (urgency) {
      case 'critical':
        return 'call';
      case 'high':
        return sensitive ? 'chat' : 'priority-push';
      case 'normal':
        return 'chat';
      case 'low':
        return 'quiet-card';
    }
  }

  notify(args: {
    title: string;
    body: string;
    urgency: Urgency;
    outcomeId?: string;
    sensitive?: boolean;
  }): Notification {
    const notification: Notification = {
      id: this.ids.next('ntf'),
      channel: this.channelFor(args.urgency, args.sensitive),
      urgency: args.urgency,
      title: args.title,
      body: args.body,
      outcomeId: args.outcomeId,
      at: this.clock.now().toISOString(),
    };
    this.events.emit({ type: 'notification', notification });
    return notification;
  }
}
