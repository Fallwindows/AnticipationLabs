import { TERMINAL_STATES, type Watch, type WatchKind } from '../domain/types.js';
import type { ReadPorts } from '../integrations/ports.js';
import type { Clock } from '../util/clock.js';
import { MINUTE, HOUR, DAY } from '../util/clock.js';
import type { IdSource } from '../util/ids.js';
import type { EventBus } from '../util/events.js';
import { WatchRepo } from '../persistence/repos.js';
import { OutcomeEngine } from '../engine/outcomeEngine.js';
import { AuditLog } from '../audit/auditLog.js';

/** Ground-truth snapshot a poller returns; evaluated against the close condition. */
export type PollSnapshot = Record<string, unknown>;

export type Poller = (watch: Watch, read: ReadPorts) => Promise<PollSnapshot>;

export type CloseEvaluator = (
  watch: Watch,
  snapshot: PollSnapshot,
  nowIso: string,
) => { met: boolean; evidence?: Record<string, unknown>; followUpWanted?: boolean };

/** Called when the follow-up budget allows one follow-up this window (I8). */
export type FollowUpHandler = (watch: Watch, snapshot: PollSnapshot) => Promise<void>;

/** Per-kind cadence defaults (DECISIONS D-007). */
export const WATCH_DEFAULTS: Record<WatchKind, { intervalMs: number; windowMs: number; timeoutMs?: number }> = {
  ledger: { intervalMs: 6 * HOUR, windowMs: DAY, timeoutMs: 14 * DAY },
  mailbox: { intervalMs: 15 * MINUTE, windowMs: DAY, timeoutMs: 7 * DAY },
  reply: { intervalMs: 15 * MINUTE, windowMs: DAY, timeoutMs: 7 * DAY },
  refund: { intervalMs: 12 * HOUR, windowMs: 3 * DAY, timeoutMs: 30 * DAY },
  flight: { intervalMs: 5 * MINUTE, windowMs: 30 * MINUTE },
  delivery: { intervalMs: 5 * MINUTE, windowMs: 20 * MINUTE, timeoutMs: 2 * HOUR },
  dropoff: { intervalMs: 12 * HOUR, windowMs: 3 * DAY, timeoutMs: 30 * DAY },
  billing: { intervalMs: DAY, windowMs: 30 * DAY },
  custom: { intervalMs: HOUR, windowMs: DAY },
};

/**
 * Durable watch scheduler (§5.9, I8). Watches persist in SQLite and survive restarts —
 * a fresh scheduler over the same database resumes exactly where the old one stopped.
 * Each tick: poll due watches' ground truth, evaluate the close condition, close the
 * Outcome ONLY when the condition is met (I4), send at most one follow-up per policy
 * window, honor timeouts by notifying (never by fabricating closure), and re-target
 * when the world changes ("Dana confirmed Friday" -> check the ledger Monday).
 */
export class WatchScheduler {
  private pollers = new Map<string, Poller>();
  private evaluators = new Map<string, CloseEvaluator>();
  private followUps = new Map<string, FollowUpHandler>();
  private onTimeout: (watch: Watch) => void = () => {};

  constructor(
    private repo: WatchRepo,
    private engine: OutcomeEngine,
    private read: ReadPorts,
    private clock: Clock,
    private ids: IdSource,
    private events: EventBus,
    private audit: AuditLog,
  ) {
    this.registerBuiltins();
  }

  registerPoller(closeConditionKind: string, poller: Poller): void {
    this.pollers.set(closeConditionKind, poller);
  }

  registerEvaluator(closeConditionKind: string, evaluator: CloseEvaluator): void {
    this.evaluators.set(closeConditionKind, evaluator);
  }

  registerFollowUp(closeConditionKind: string, handler: FollowUpHandler): void {
    this.followUps.set(closeConditionKind, handler);
  }

  setTimeoutHandler(handler: (watch: Watch) => void): void {
    this.onTimeout = handler;
  }

  create(args: {
    outcomeId: string;
    kind: WatchKind;
    description: string;
    closeCondition: { kind: string; params: Record<string, unknown>; description: string };
    intervalMs?: number;
    followUpWindowMs?: number;
    followUpAction?: string;
    timeoutAt?: string;
    firstPollAt?: string;
  }): Watch {
    const defaults = WATCH_DEFAULTS[args.kind];
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const intervalMs = args.intervalMs ?? defaults.intervalMs;
    // Caller-supplied timestamps are normalized to UTC so string comparisons in the
    // due-query and timeout checks are timezone-proof.
    const watch: Watch = {
      id: this.ids.next('watch'),
      outcomeId: args.outcomeId,
      kind: args.kind,
      description: args.description,
      pollPolicy: { intervalMs },
      followUpPolicy: args.followUpAction
        ? { windowMs: args.followUpWindowMs ?? defaults.windowMs, action: args.followUpAction }
        : null,
      timeoutAt: args.timeoutAt
        ? new Date(args.timeoutAt).toISOString()
        : defaults.timeoutMs
          ? new Date(now.getTime() + defaults.timeoutMs).toISOString()
          : undefined,
      closeCondition: args.closeCondition,
      state: 'active',
      nextPollAt: args.firstPollAt
        ? new Date(args.firstPollAt).toISOString()
        : new Date(now.getTime() + intervalMs).toISOString(),
      windowStartedAt: nowIso,
      followUpsSentInWindow: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.repo.save(watch);
    this.events.emit({ type: 'watch.created', watchId: watch.id, outcomeId: args.outcomeId });
    return watch;
  }

  get(id: string): Watch | undefined {
    return this.repo.get(id);
  }

  all(): Watch[] {
    return this.repo.all();
  }

  /** The world changed — move the watch (e.g. "scheduled Friday" -> poll Monday, stay silent). */
  retarget(watchId: string, args: { nextPollAt: string; reason: string; resetFollowUpWindow?: boolean }): Watch {
    const watch = this.mustGet(watchId);
    const next: Watch = {
      ...watch,
      nextPollAt: new Date(args.nextPollAt).toISOString(),
      updatedAt: this.clock.now().toISOString(),
      ...(args.resetFollowUpWindow
        ? { windowStartedAt: this.clock.now().toISOString(), followUpsSentInWindow: 0 }
        : {}),
    };
    this.repo.save(next);
    this.audit.append({
      outcomeId: watch.outcomeId,
      actor: 'watch-scheduler',
      action: 'watch.retarget',
      target: watchId,
      result: `${args.reason}; next poll ${args.nextPollAt}`,
    });
    this.events.emit({ type: 'watch.updated', watchId, outcomeId: watch.outcomeId });
    return next;
  }

  cancelForOutcome(outcomeId: string, reason: string): void {
    for (const watch of this.repo.all()) {
      if (watch.outcomeId === outcomeId && watch.state === 'active') {
        this.repo.save({ ...watch, state: 'cancelled', updatedAt: this.clock.now().toISOString() });
        this.events.emit({ type: 'watch.updated', watchId: watch.id, outcomeId });
        this.audit.append({
          outcomeId,
          actor: 'watch-scheduler',
          action: 'watch.cancelled',
          target: watch.id,
          result: reason,
        });
      }
    }
  }

  /**
   * External ground truth arrived without polling — the human-confirmation path
   * ("got it, thanks"). Guarded: only an ACTIVE watch on an outcome that is actually
   * Watching can close it, evidence must be non-empty, and sibling watches are torn
   * down so nothing keeps polling a closed outcome.
   */
  satisfyExternally(watchId: string, evidence: Record<string, unknown>, closeOutcome = true): void {
    const watch = this.mustGet(watchId);
    if (watch.state !== 'active') {
      throw new Error(`watch ${watchId} is ${watch.state}; only an active watch can be satisfied`);
    }
    if (closeOutcome) {
      if (Object.keys(evidence).length === 0) {
        throw new Error('external satisfaction requires evidence — ground truth is not a label (I4)');
      }
      const outcome = this.engine.get(watch.outcomeId);
      if (outcome.state !== 'Watching') {
        throw new Error(
          `outcome ${watch.outcomeId} is ${outcome.state}; external ground truth closes only Watching outcomes`,
        );
      }
    }
    this.repo.save({ ...watch, state: 'satisfied', updatedAt: this.clock.now().toISOString() });
    this.events.emit({ type: 'watch.updated', watchId, outcomeId: watch.outcomeId });
    if (closeOutcome) {
      this.engine.close(watch.outcomeId, { kind: 'ground-truth', evidence });
      this.cancelForOutcome(watch.outcomeId, 'outcome closed by external ground truth');
    }
  }

  private mustGet(id: string): Watch {
    const w = this.repo.get(id);
    if (!w) throw new Error(`unknown watch ${id}`);
    return w;
  }

  private ticking = false;

  /**
   * One scheduler pass. Deterministic under TestClock: advance the clock, call tick().
   * Reentrancy-guarded (an overlapping timer tick is a no-op) and error-isolated per
   * watch — one poisoned watch (bad adapter, unregistered close-condition kind after
   * a restart) must never stall every other watch or the timeout sweep.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const nowIso = this.clock.now().toISOString();
      for (const watch of this.repo.due(nowIso)) {
        try {
          await this.pollOne(watch, nowIso);
        } catch (err) {
          // Push the failing watch forward one interval so it cannot starve the queue.
          const current = this.repo.get(watch.id);
          if (current && current.state === 'active') {
            this.repo.save({
              ...current,
              nextPollAt: new Date(this.clock.now().getTime() + current.pollPolicy.intervalMs).toISOString(),
              updatedAt: nowIso,
            });
          }
          this.audit.append({
            outcomeId: watch.outcomeId,
            actor: 'watch-scheduler',
            action: 'watch.poll-error',
            target: watch.id,
            result: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Timeouts fire even when a poll isn't due.
      for (const watch of this.repo.activeTimedOut(nowIso)) {
        this.repo.save({ ...watch, state: 'timed-out', updatedAt: nowIso });
        this.events.emit({ type: 'watch.updated', watchId: watch.id, outcomeId: watch.outcomeId });
        this.audit.append({
          outcomeId: watch.outcomeId,
          actor: 'watch-scheduler',
          action: 'watch.timeout',
          target: watch.id,
          result: `timed out at ${watch.timeoutAt}; outcome NOT closed (I4)`,
        });
        this.onTimeout(watch);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async pollOne(watch: Watch, nowIso: string): Promise<void> {
    const poller = this.pollers.get(watch.closeCondition.kind);
    const evaluator = this.evaluators.get(watch.closeCondition.kind);
    if (!poller || !evaluator) {
      throw new Error(`no poller/evaluator registered for close condition "${watch.closeCondition.kind}"`);
    }
    const snapshot = await poller(watch, this.read);
    const verdict = evaluator(watch, snapshot, nowIso);

    // Re-read after the await: a concurrent cancel/satisfy must never be clobbered
    // by a stale in-memory copy (that would resurrect a cancelled watch as active).
    const current = this.repo.get(watch.id);
    if (!current || current.state !== 'active') return;

    let next: Watch = {
      ...current,
      lastPolledAt: nowIso,
      lastPollResult: snapshot,
      nextPollAt: new Date(this.clock.now().getTime() + current.pollPolicy.intervalMs).toISOString(),
      updatedAt: nowIso,
    };

    if (verdict.met) {
      next = { ...next, state: 'satisfied' };
      this.repo.save(next);
      this.events.emit({ type: 'watch.updated', watchId: watch.id, outcomeId: watch.outcomeId });
      const outcome = this.engine.get(watch.outcomeId);
      if (outcome.state === 'Watching') {
        this.engine.close(watch.outcomeId, {
          kind: 'ground-truth',
          evidence: verdict.evidence ?? snapshot,
        });
        this.cancelForOutcome(watch.outcomeId, 'outcome closed by met close condition');
      }
      return;
    }

    // Follow-up budget: at most one per window (I8) — and only while the outcome is
    // still genuinely being watched.
    const followUpPolicy = next.followUpPolicy;
    if (verdict.followUpWanted && followUpPolicy) {
      const windowEnd = new Date(next.windowStartedAt).getTime() + followUpPolicy.windowMs;
      if (this.clock.now().getTime() >= windowEnd) {
        next = { ...next, windowStartedAt: nowIso, followUpsSentInWindow: 0 };
      }
      const outcome = this.engine.get(watch.outcomeId);
      if (next.followUpsSentInWindow < 1 && !TERMINAL_STATES.includes(outcome.state)) {
        const handler = this.followUps.get(watch.closeCondition.kind);
        if (handler) {
          await handler(next, snapshot);
          // Re-read once more: the handler awaited, the world may have moved again.
          const afterHandler = this.repo.get(watch.id);
          if (!afterHandler || afterHandler.state !== 'active') return;
          next = { ...next, followUpsSentInWindow: next.followUpsSentInWindow + 1 };
          this.audit.append({
            outcomeId: watch.outcomeId,
            actor: 'watch-scheduler',
            action: `watch.follow-up:${followUpPolicy.action}`,
            target: watch.id,
            result: 'one follow-up sent this window',
          });
        }
      }
    }

    this.repo.save(next);
    this.events.emit({ type: 'watch.updated', watchId: watch.id, outcomeId: watch.outcomeId });
  }

  // -- Built-in pollers/evaluators for the standard close conditions ------------

  private registerBuiltins(): void {
    // Ledger payment posted (scenario 7): only a matching ledger payment closes (I4).
    this.registerPoller('ledger-payment-posted', async (watch, read) => {
      const invoiceNumber = String(watch.closeCondition.params.invoiceNumber);
      const invoice = await read.ledger.getInvoice(invoiceNumber);
      const payments = await read.ledger.listPayments(invoiceNumber);
      return { invoice: invoice ?? null, payments };
    });
    this.registerEvaluator('ledger-payment-posted', (watch, snapshot) => {
      const payments = snapshot.payments as { amount: number }[];
      const wanted = Number(watch.closeCondition.params.amount);
      const match = payments.find((p) => Math.abs(p.amount - wanted) < 0.005);
      return match
        ? { met: true, evidence: { payment: match } }
        : { met: false, followUpWanted: true };
    });

    // Refund posted to the right destination (scenario 2).
    this.registerPoller('refund-posted', async (watch, read) => {
      const returnId = String(watch.closeCondition.params.returnId);
      const ret = await read.commerce.getReturn(returnId);
      const refunds = await read.commerce.getRefunds(returnId);
      return { return: ret ?? null, refunds };
    });
    this.registerEvaluator('refund-posted', (watch, snapshot) => {
      const refunds = snapshot.refunds as { amount: number; destination: string }[];
      const amount = Number(watch.closeCondition.params.amount);
      const destination = String(watch.closeCondition.params.destination);
      const match = refunds.find(
        (r) => Math.abs(r.amount - amount) < 0.005 && r.destination === destination,
      );
      return match ? { met: true, evidence: { refund: match } } : { met: false };
    });

    // A reply arrived from a specific counterparty (scenarios 3, 7, 9).
    this.registerPoller('reply-received', async (watch, read) => {
      const mailbox = String(watch.closeCondition.params.mailbox);
      const from = String(watch.closeCondition.params.from);
      const messages = await read.email.readMailbox(mailbox);
      return { replies: messages.filter((m) => m.from === from) };
    });
    this.registerEvaluator('reply-received', (watch, snapshot) => {
      const replies = snapshot.replies as unknown[];
      return replies.length > 0
        ? { met: true, evidence: { reply: replies[0] } }
        : { met: false, followUpWanted: true };
    });

    // Delivery promise kept (scenario 1): needs external confirmation; polling alone
    // never closes it, but it drives the 20-minute follow-up budget.
    this.registerPoller('delivery-confirmed', async () => ({}));
    this.registerEvaluator('delivery-confirmed', () => ({ met: false, followUpWanted: true }));

    // Final billing period shows no rogue charge (scenario 10): closes on time+absence.
    this.registerPoller('no-rogue-charge', async (watch, read) => {
      const subscriptionId = String(watch.closeCondition.params.subscriptionId);
      const since = String(watch.closeCondition.params.since);
      const charges = await read.billing.listCharges(subscriptionId, since);
      return { charges };
    });
    this.registerEvaluator('no-rogue-charge', (watch, snapshot, nowIso) => {
      const charges = snapshot.charges as { amount: number; description: string }[];
      const periodEnd = String(watch.closeCondition.params.periodEnd);
      const allowedAmount = Number(watch.closeCondition.params.allowedFinalAmount ?? 0);
      const rogue = charges.filter((c) => Math.abs(c.amount - allowedAmount) > 0.005);
      if (rogue.length > 0) return { met: false, followUpWanted: true };
      if (nowIso >= periodEnd) {
        return { met: true, evidence: { finalPeriodClean: true, checkedThrough: nowIso } };
      }
      return { met: false };
    });

    // Replacement itinerary flown/completed (scenario 8).
    this.registerPoller('flight-completed', async (watch, read) => {
      const flightNumber = String(watch.closeCondition.params.flightNumber);
      const date = String(watch.closeCondition.params.date);
      const status = await read.airline.getFlightStatus(flightNumber, date);
      return { status: status ?? null };
    });
    this.registerEvaluator('flight-completed', (_watch, snapshot) => {
      const status = snapshot.status as { status: string } | null;
      return status?.status === 'departed'
        ? { met: true, evidence: { flightStatus: status } }
        : { met: false };
    });

    // Return dropped off then refunded — intermediate stage of scenario 2.
    this.registerPoller('return-progress', async (watch, read) => {
      const returnId = String(watch.closeCondition.params.returnId);
      const ret = await read.commerce.getReturn(returnId);
      return { return: ret ?? null };
    });
    this.registerEvaluator('return-progress', (watch, snapshot) => {
      const ret = snapshot.return as { status: string } | null;
      const until = String(watch.closeCondition.params.untilStatus ?? 'refunded');
      return ret?.status === until ? { met: true, evidence: { return: ret } } : { met: false };
    });
  }
}
