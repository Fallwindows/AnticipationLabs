import type {
  AirlineReadPort,
  AirlineWritePort,
  BillingReadPort,
  BillingWritePort,
  CalendarReadPort,
  CommerceReadPort,
  CommerceWritePort,
  EmailDraft,
  EmailReadPort,
  EmailWritePort,
  HotelReadPort,
  LedgerReadPort,
  ReadPorts,
  ReservationReadPort,
  ReservationWritePort,
  SentMessage,
  TelephonyReadPort,
  TelephonyWritePort,
  WorkReadPort,
  WriteReceipt,
  WritePorts,
} from '../ports.js';
import { AdapterRefusalError, AdapterTimeoutError } from '../ports.js';
import type { FixtureWorld } from './fixtureWorld.js';

/**
 * FixtureAdapters (§6): deterministic implementations of every port over a shared
 * FixtureWorld. Writes always record the attempt and apply the side effect BEFORE the
 * simulated timeout fires — that is exactly the failure mode idempotency (I7) exists
 * for: the caller doesn't know whether the write landed; re-reading is the only safe
 * recovery.
 */

function maybeTimeout(world: FixtureWorld, action: string): void {
  if (world.failNextWriteWithTimeout.has(action)) {
    world.failNextWriteWithTimeout.delete(action);
    throw new AdapterTimeoutError(`${action} timed out after the request was sent`);
  }
}

/** The request never landed: record the attempt, apply nothing, time out. */
function maybeLose(world: FixtureWorld, action: string, idempotencyKey: string, args: unknown): boolean {
  if (world.loseNextWrite.has(action)) {
    world.loseNextWrite.delete(action);
    world.recordWrite(action, idempotencyKey, args);
    throw new AdapterTimeoutError(`${action} was lost in transit; nothing landed`);
  }
  return false;
}

class FixtureEmail implements EmailReadPort, EmailWritePort {
  constructor(private world: FixtureWorld) {}

  async sendEmail(draft: EmailDraft, idempotencyKey: string): Promise<WriteReceipt> {
    maybeLose(this.world, 'email.send', idempotencyKey, draft);
    this.world.recordWrite('email.send', idempotencyKey, draft);
    const existing = this.world.sentMessages.find(
      (m) => (m as SentMessage & { idempotencyKey?: string }).idempotencyKey === idempotencyKey,
    );
    if (existing) {
      // provider-side dedup — the fixture behaves like a well-behaved API
      return { ref: existing.messageId };
    }
    const msg: SentMessage & { idempotencyKey?: string } = {
      ...draft,
      messageId: this.world.nextRef('msg'),
      sentAt: this.world.now(),
      idempotencyKey,
    };
    this.world.sentMessages.push(msg);
    this.world.deliverToMailbox(draft.to, msg);
    for (const cc of draft.cc ?? []) this.world.deliverToMailbox(cc, msg);
    maybeTimeout(this.world, 'email.send');
    return { ref: msg.messageId };
  }

  async getSentMessage(messageId: string): Promise<SentMessage | undefined> {
    return this.world.sentMessages.find((m) => m.messageId === messageId);
  }

  async searchSent(query: {
    to?: string;
    subjectContains?: string;
    idempotencyKey?: string;
  }): Promise<SentMessage[]> {
    return this.world.sentMessages.filter((m) => {
      const withKey = m as SentMessage & { idempotencyKey?: string };
      if (query.to && m.to !== query.to) return false;
      if (query.subjectContains && !m.subject.includes(query.subjectContains)) return false;
      if (query.idempotencyKey && withKey.idempotencyKey !== query.idempotencyKey) return false;
      return true;
    });
  }

  async readMailbox(address: string): Promise<SentMessage[]> {
    return this.world.mailboxes.get(address) ?? [];
  }
}

class FixtureCalendar implements CalendarReadPort {
  constructor(private world: FixtureWorld) {}

  async listEvents(range: { from: string; to: string }) {
    return this.world.calendarEvents.filter((e) => e.start >= range.from && e.start <= range.to);
  }
}

class FixtureCommerce implements CommerceReadPort, CommerceWritePort {
  constructor(private world: FixtureWorld) {}

  async getOrderLines(orderId: string) {
    return this.world.orderLines.filter((l) => l.orderId === orderId);
  }

  async getReturnOptions(orderId: string, lineId: string) {
    const opts = this.world.returnOptions.get(`${orderId}/${lineId}`);
    if (!opts) throw new Error(`no return options seeded for ${orderId}/${lineId}`);
    return opts;
  }

  async findExistingReturn(query: { orderId: string; lineId?: string; idempotencyKey?: string }) {
    return this.world.returns.find(
      (r) =>
        r.orderId === query.orderId &&
        (query.lineId === undefined || r.lineId === query.lineId) &&
        (query.idempotencyKey === undefined || r.idempotencyKey === query.idempotencyKey),
    );
  }

  async getReturn(returnId: string) {
    return this.world.returns.find((r) => r.returnId === returnId);
  }

  async getRefunds(returnId: string) {
    return this.world.refunds.filter((r) => r.returnId === returnId);
  }

  async submitReturn(
    args: {
      orderId: string;
      lineId: string;
      reason: string;
      method: string;
      refundDestination: string;
      pageVersionHash: string;
    },
    idempotencyKey: string,
  ): Promise<WriteReceipt> {
    this.world.recordWrite('commerce.submit-return', idempotencyKey, args);
    const existing = this.world.returns.find((r) => r.idempotencyKey === idempotencyKey);
    if (existing) return { ref: existing.returnId };
    const line = this.world.orderLines.find(
      (l) => l.orderId === args.orderId && l.lineId === args.lineId,
    );
    if (!line) throw new Error(`unknown order line ${args.orderId}/${args.lineId}`);
    const rec = {
      returnId: this.world.nextRef('ret'),
      orderId: args.orderId,
      lineId: args.lineId,
      reason: args.reason,
      method: args.method,
      refundAmount: line.price,
      refundDestination: args.refundDestination,
      qrCodeRef: this.world.nextRef('qr'),
      status: 'created' as const,
      idempotencyKey,
    };
    this.world.returns.push(rec);
    maybeTimeout(this.world, 'commerce.submit-return');
    return { ref: rec.returnId, detail: { qrCodeRef: rec.qrCodeRef } };
  }
}

class FixtureAirline implements AirlineReadPort, AirlineWritePort {
  constructor(private world: FixtureWorld) {}

  async getFlightStatus(flightNumber: string, date: string) {
    return this.world.flightStatuses.find(
      (f) => f.flightNumber === flightNumber && f.date === date,
    );
  }

  async getAlternatives(fromPnr: string) {
    return this.world.alternatives.get(fromPnr) ?? [];
  }

  async getReservation(pnr: string) {
    return this.world.reservations.find((r) => r.pnr === pnr);
  }

  async findReservationByIdempotencyKey(key: string) {
    return this.world.reservations.find((r) => r.idempotencyKey === key);
  }

  async rebook(
    args: { pnr: string; optionId: string; pageVersionHash: string },
    idempotencyKey: string,
  ): Promise<WriteReceipt> {
    this.world.recordWrite('airline.rebook', idempotencyKey, args);
    const existing = this.world.reservations.find((r) => r.idempotencyKey === idempotencyKey);
    if (existing) return { ref: existing.pnr };
    const old = this.world.reservations.find((r) => r.pnr === args.pnr);
    if (!old) throw new Error(`unknown PNR ${args.pnr}`);
    const option = (this.world.alternatives.get(args.pnr) ?? []).find(
      (o) => o.optionId === args.optionId,
    );
    if (!option) throw new Error(`unknown option ${args.optionId} for ${args.pnr}`);
    const rebooked = {
      pnr: this.world.nextRef('pnr'),
      passenger: old.passenger,
      segments: [
        { flightNumber: option.optionId, departure: option.departure, arrival: option.arrival },
      ],
      seat: option.seat,
      baggageChecked: option.baggageThrough,
      status: 'ticketed' as const,
      idempotencyKey,
    };
    this.world.reservations.push(rebooked);
    old.status = 'superseded';
    maybeTimeout(this.world, 'airline.rebook');
    return { ref: rebooked.pnr };
  }
}

class FixtureHotelTelephony implements HotelReadPort, TelephonyReadPort, TelephonyWritePort {
  constructor(
    private world: FixtureWorld,
    private compliance: { enabled: boolean },
  ) {}

  async getHotelInfo(name: string) {
    return this.world.hotels.find((h) => h.name.toLowerCase().includes(name.toLowerCase()));
  }

  async getCallRecord(callId: string) {
    return this.world.calls.find((c) => c.callId === callId);
  }

  async findCallByIdempotencyKey(key: string) {
    return this.world.calls.find((c) => c.idempotencyKey === key);
  }

  async placeCall(
    args: { to: string; script: string; disclosure: string },
    idempotencyKey: string,
  ): Promise<WriteReceipt> {
    if (!this.compliance.enabled) {
      throw new AdapterRefusalError('telephony tier is disabled (compliance gate, DECISIONS D-005)');
    }
    if (!args.disclosure || args.disclosure.trim() === '') {
      throw new AdapterRefusalError('calls must carry a disclosure (I11)');
    }
    this.world.recordWrite('telephony.call', idempotencyKey, args);
    const existing = this.world.calls.find((c) => c.idempotencyKey === idempotencyKey);
    if (existing) return { ref: existing.callId };
    const call = {
      callId: this.world.nextRef('call'),
      to: args.to,
      disclosure: args.disclosure,
      script: args.script,
      spokeTo: 'front desk agent (fixture)',
      promisedETA: '20 minutes',
      transcriptSummary: `Disclosed assistant call. Request: ${args.script.slice(0, 120)}`,
      at: this.world.now(),
      idempotencyKey,
    };
    this.world.calls.push(call);
    maybeTimeout(this.world, 'telephony.call');
    return { ref: call.callId, detail: { spokeTo: call.spokeTo, promisedETA: call.promisedETA } };
  }
}

class FixtureWork implements WorkReadPort {
  constructor(private world: FixtureWorld) {}

  async searchIssues(query: { project?: string; text?: string }) {
    return this.world.workItems.filter(
      (i) =>
        (query.project === undefined || i.project === query.project) &&
        (query.text === undefined ||
          i.summary.toLowerCase().includes(query.text.toLowerCase())),
    );
  }
}

class FixtureLedger implements LedgerReadPort {
  constructor(private world: FixtureWorld) {}

  async getInvoice(invoiceNumber: string) {
    return this.world.invoices.find((i) => i.invoiceNumber === invoiceNumber);
  }

  async listPayments(invoiceNumber: string) {
    return this.world.payments.filter((p) => p.invoiceNumber === invoiceNumber);
  }
}

class FixtureReservations implements ReservationReadPort, ReservationWritePort {
  constructor(private world: FixtureWorld) {}

  async searchRestaurants() {
    return this.world.restaurants;
  }

  async getBooking(reservationNumber: string) {
    return this.world.bookings.find((b) => b.reservationNumber === reservationNumber);
  }

  async findBookingByIdempotencyKey(key: string) {
    return this.world.bookings.find((b) => b.idempotencyKey === key);
  }

  async book(
    args: { restaurantId: string; slot: string; partySize: number; pageVersionHash: string },
    idempotencyKey: string,
  ): Promise<WriteReceipt> {
    this.world.recordWrite('reservation.book', idempotencyKey, args);
    const existing = this.world.bookings.find((b) => b.idempotencyKey === idempotencyKey);
    if (existing) return { ref: existing.reservationNumber };
    const restaurant = this.world.restaurants.find((r) => r.restaurantId === args.restaurantId);
    if (!restaurant) throw new Error(`unknown restaurant ${args.restaurantId}`);
    if (!restaurant.availableSlots.includes(args.slot)) {
      throw new Error(`slot ${args.slot} not available at ${restaurant.name}`);
    }
    const booking = {
      reservationNumber: this.world.nextRef('res'),
      restaurantId: args.restaurantId,
      slot: args.slot,
      partySize: args.partySize,
      terms: restaurant.cancellationPolicy,
      status: 'confirmed' as const,
      idempotencyKey,
    };
    this.world.bookings.push(booking);
    maybeTimeout(this.world, 'reservation.book');
    return { ref: booking.reservationNumber, detail: { terms: booking.terms } };
  }
}

class FixtureBilling implements BillingReadPort, BillingWritePort {
  constructor(private world: FixtureWorld) {}

  async getSubscription(subscriptionId: string) {
    return this.world.subscriptions.find((s) => s.subscriptionId === subscriptionId);
  }

  async listCharges(subscriptionId: string, since: string) {
    return this.world.charges.filter(
      (c) => c.subscriptionId === subscriptionId && c.chargedAt >= since,
    );
  }

  async findCancellationByIdempotencyKey(key: string) {
    return this.world.subscriptions.find((s) => s.idempotencyKey === key && s.cancellation);
  }

  async cancelSubscription(
    args: { subscriptionId: string; mode: 'immediate' | 'at-term'; pageVersionHash: string },
    idempotencyKey: string,
  ): Promise<WriteReceipt> {
    this.world.recordWrite('billing.cancel', idempotencyKey, args);
    const sub = this.world.subscriptions.find((s) => s.subscriptionId === args.subscriptionId);
    if (!sub) throw new Error(`unknown subscription ${args.subscriptionId}`);
    if (sub.cancellation && sub.idempotencyKey === idempotencyKey) {
      return { ref: sub.cancellation.confirmationRef };
    }
    sub.status = args.mode === 'at-term' ? 'cancel-at-term' : 'cancelled';
    sub.cancellation = {
      effectiveDate: args.mode === 'at-term' ? sub.renewalDate : this.world.now(),
      confirmationRef: this.world.nextRef('cnf'),
    };
    sub.idempotencyKey = idempotencyKey;
    maybeTimeout(this.world, 'billing.cancel');
    return { ref: sub.cancellation.confirmationRef, detail: { effectiveDate: sub.cancellation.effectiveDate } };
  }
}

export interface FixturePortsOptions {
  telephonyEnabled?: boolean;
}

/** Builds the read+write port bundles over one shared world. */
export function buildFixturePorts(
  world: FixtureWorld,
  options: FixturePortsOptions = {},
): { read: ReadPorts; write: WritePorts } {
  const email = new FixtureEmail(world);
  const calendar = new FixtureCalendar(world);
  const commerce = new FixtureCommerce(world);
  const airline = new FixtureAirline(world);
  const hotelTel = new FixtureHotelTelephony(world, {
    enabled: options.telephonyEnabled ?? true,
  });
  const work = new FixtureWork(world);
  const ledger = new FixtureLedger(world);
  const reservations = new FixtureReservations(world);
  const billing = new FixtureBilling(world);

  return {
    read: {
      email,
      calendar,
      commerce,
      airline,
      hotel: hotelTel,
      telephony: hotelTel,
      work,
      ledger,
      reservations,
      billing,
    },
    write: {
      email,
      commerce,
      airline,
      telephony: hotelTel,
      reservations,
      billing,
    },
  };
}
