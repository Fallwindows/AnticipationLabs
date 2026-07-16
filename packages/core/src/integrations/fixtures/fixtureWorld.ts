import type {
  BillingCharge,
  CalendarEvent,
  CallRecord,
  FlightStatus,
  HotelInfo,
  Invoice,
  ItineraryOption,
  LedgerPayment,
  OrderLine,
  Refund,
  Reservation,
  RestaurantBooking,
  RestaurantOption,
  ReturnOptions,
  ReturnRecord,
  SentMessage,
  Subscription,
  WorkItem,
} from '../ports.js';

/**
 * The deterministic world every FixtureAdapter reads and writes (§12). A scenario
 * fixture seeds this object, the agent acts on it through the adapters, and the test
 * asserts against it. Because verifier reads and actor writes hit the SAME world
 * through DIFFERENT port interfaces, fixture tests genuinely exercise the
 * actor/verifier split rather than mocking it away.
 *
 * `writeCalls` records every side-effect attempt (with idempotency keys) so tests can
 * assert fire-once behavior; `failNextWriteWithTimeout` makes the next write of a
 * given action record its side effect and THEN throw AdapterTimeoutError — the classic
 * double-submit trap of I7.
 */
export class FixtureWorld {
  // email
  sentMessages: SentMessage[] = [];
  mailboxes = new Map<string, SentMessage[]>();
  // calendar
  calendarEvents: CalendarEvent[] = [];
  // commerce
  orderLines: OrderLine[] = [];
  returnOptions = new Map<string, ReturnOptions>(); // key: orderId/lineId
  returns: ReturnRecord[] = [];
  refunds: Refund[] = [];
  // airline
  flightStatuses: FlightStatus[] = [];
  alternatives = new Map<string, ItineraryOption[]>(); // key: pnr
  reservations: Reservation[] = [];
  // hotel / telephony
  hotels: HotelInfo[] = [];
  calls: CallRecord[] = [];
  // work
  workItems: WorkItem[] = [];
  // ledger
  invoices: Invoice[] = [];
  payments: LedgerPayment[] = [];
  // restaurants
  restaurants: RestaurantOption[] = [];
  bookings: RestaurantBooking[] = [];
  // billing
  subscriptions: Subscription[] = [];
  charges: BillingCharge[] = [];

  /** every write-port invocation, in order */
  writeCalls: { action: string; idempotencyKey: string; args: unknown; at: string }[] = [];

  /** action names whose next write should side-effect then time out (I7 tests) */
  failNextWriteWithTimeout = new Set<string>();

  /**
   * action names whose next write is LOST: recorded as attempted but never lands,
   * then times out. The complementary I7 case — re-reads will exhaust with nothing
   * found, and the machine must still offer a way out (Verifying -> Cancelled).
   */
  loseNextWrite = new Set<string>();

  private seq = 0;
  /** injected by the fixture harness so world timestamps follow the test clock */
  now: () => string = () => '1970-01-01T00:00:00.000Z';

  nextRef(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(3, '0')}`;
  }

  recordWrite(action: string, idempotencyKey: string, args: unknown): void {
    this.writeCalls.push({ action, idempotencyKey, args, at: this.now() });
  }

  writesFor(action: string): { action: string; idempotencyKey: string; args: unknown; at: string }[] {
    return this.writeCalls.filter((w) => w.action === action);
  }

  deliverToMailbox(address: string, msg: SentMessage): void {
    const box = this.mailboxes.get(address) ?? [];
    box.push(msg);
    this.mailboxes.set(address, box);
  }
}
