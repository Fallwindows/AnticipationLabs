/**
 * Integration ports (§6). Every domain has a READ port and a WRITE port; the split is
 * the mechanical form of the Actor/Verifier separation (I6): Verifiers are constructed
 * with read ports only, so "the actor confirming itself" is a type error, not a code
 * review comment. Each port has three interchangeable implementations per environment:
 * ApiAdapter (sanctioned), BrowserAdapter (automation + user-takeover), FixtureAdapter
 * (deterministic; the only one CI touches — §12).
 */

export class AdapterTimeoutError extends Error {
  constructor(msg = 'adapter timed out awaiting confirmation') {
    super(msg);
    this.name = 'AdapterTimeoutError';
  }
}

export interface WriteReceipt {
  /** adapter-level id of the created artifact (message id, return id, PNR, ...) */
  ref: string;
  detail?: Record<string, unknown>;
}

// -- Email / Calendar ---------------------------------------------------------

export interface EmailDraft {
  from: string;
  to: string;
  cc?: string[];
  subject: string;
  body: string;
  attachments?: { name: string; contentRef: string }[];
}

export interface SentMessage extends EmailDraft {
  messageId: string;
  sentAt: string;
}

export interface EmailReadPort {
  /** read the authoritative Sent folder (verifier's ground truth) */
  getSentMessage(messageId: string): Promise<SentMessage | undefined>;
  searchSent(query: { to?: string; subjectContains?: string; idempotencyKey?: string }): Promise<SentMessage[]>;
  /** fixture recipient mailbox — confirms delivery independently of the sender (§12) */
  readMailbox(address: string): Promise<SentMessage[]>;
}

export interface EmailWritePort {
  sendEmail(draft: EmailDraft, idempotencyKey: string): Promise<WriteReceipt>;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  attendees: string[];
}

export interface CalendarReadPort {
  listEvents(range: { from: string; to: string }): Promise<CalendarEvent[]>;
}

// -- Commerce / returns -------------------------------------------------------

export interface OrderLine {
  orderId: string;
  lineId: string;
  item: string;
  price: number;
  currency: string;
  deliveredAt?: string;
  returnDeadline?: string;
}

export interface ReturnOptions {
  lineId: string;
  methods: { method: string; fee: number; description: string }[];
  refundDestination: string;
  windowEndsAt: string;
  /** hash of the exact return page/version presented (binds into the ActionSignature) */
  pageVersionHash: string;
}

export interface ReturnRecord {
  returnId: string;
  orderId: string;
  lineId: string;
  reason: string;
  method: string;
  refundAmount: number;
  refundDestination: string;
  qrCodeRef?: string;
  status: 'created' | 'dropped-off' | 'received' | 'refunded';
  idempotencyKey?: string;
}

export interface Refund {
  returnId: string;
  amount: number;
  destination: string;
  postedAt: string;
}

export interface CommerceReadPort {
  getOrderLines(orderId: string): Promise<OrderLine[]>;
  getReturnOptions(orderId: string, lineId: string): Promise<ReturnOptions>;
  /** idempotent recovery: find a return that may already exist (I7) */
  findExistingReturn(query: { orderId: string; lineId?: string; idempotencyKey?: string }): Promise<ReturnRecord | undefined>;
  getReturn(returnId: string): Promise<ReturnRecord | undefined>;
  getRefunds(returnId: string): Promise<Refund[]>;
}

export interface CommerceWritePort {
  submitReturn(
    args: { orderId: string; lineId: string; reason: string; method: string; refundDestination: string; pageVersionHash: string },
    idempotencyKey: string,
  ): Promise<WriteReceipt>;
}

// -- Airline ------------------------------------------------------------------

export interface FlightStatus {
  flightNumber: string;
  date: string;
  status: 'on-time' | 'delayed' | 'cancelled' | 'departed';
  scheduledDeparture: string;
  estimatedDeparture?: string;
  connectionAtRisk?: boolean;
}

export interface ItineraryOption {
  optionId: string;
  description: string;
  departure: string;
  arrival: string;
  fareDifference: number;
  seat?: string;
  baggageThrough: boolean;
}

export interface Reservation {
  pnr: string;
  passenger: string;
  segments: { flightNumber: string; departure: string; arrival: string }[];
  seat?: string;
  baggageChecked: boolean;
  status: 'ticketed' | 'cancelled' | 'superseded';
  idempotencyKey?: string;
}

export interface AirlineReadPort {
  getFlightStatus(flightNumber: string, date: string): Promise<FlightStatus | undefined>;
  getAlternatives(fromPnr: string): Promise<ItineraryOption[]>;
  getReservation(pnr: string): Promise<Reservation | undefined>;
  findReservationByIdempotencyKey(key: string): Promise<Reservation | undefined>;
}

export interface AirlineWritePort {
  rebook(args: { pnr: string; optionId: string; pageVersionHash: string }, idempotencyKey: string): Promise<WriteReceipt>;
}

// -- Hotel & telephony ---------------------------------------------------------

export interface HotelInfo {
  name: string;
  phone: string;
  amenities: Record<string, string>;
}

export interface CallRecord {
  callId: string;
  to: string;
  disclosure: string;
  script: string;
  spokeTo: string;
  promisedETA?: string;
  transcriptSummary: string;
  at: string;
  idempotencyKey?: string;
}

export interface HotelReadPort {
  getHotelInfo(name: string): Promise<HotelInfo | undefined>;
}

export interface TelephonyReadPort {
  getCallRecord(callId: string): Promise<CallRecord | undefined>;
  findCallByIdempotencyKey(key: string): Promise<CallRecord | undefined>;
}

export interface TelephonyWritePort {
  /** disclosed, scoped, single call (I11); refuse if the compliance gate is closed */
  placeCall(
    args: { to: string; script: string; disclosure: string },
    idempotencyKey: string,
  ): Promise<WriteReceipt>;
}

// -- Work tracking (Jira) -------------------------------------------------------

export interface WorkItem {
  key: string;
  project: string;
  summary: string;
  status: string;
  assignee?: string;
  updatedAt: string;
}

export interface WorkReadPort {
  searchIssues(query: { project?: string; text?: string }): Promise<WorkItem[]>;
}

// -- Ledger / invoicing ----------------------------------------------------------

export interface Invoice {
  invoiceNumber: string;
  counterparty: string;
  amount: number;
  currency: string;
  dueDate: string;
  status: 'open' | 'paid' | 'void';
}

export interface LedgerPayment {
  invoiceNumber: string;
  amount: number;
  postedAt: string;
  method: string;
}

export interface LedgerReadPort {
  getInvoice(invoiceNumber: string): Promise<Invoice | undefined>;
  listPayments(invoiceNumber: string): Promise<LedgerPayment[]>;
}

// -- Restaurant reservations ------------------------------------------------------

export interface RestaurantOption {
  restaurantId: string;
  name: string;
  cuisine: string;
  noiseLevel: 'quiet' | 'moderate' | 'loud';
  vegetarianFriendly: boolean;
  travelMinutesFromMeeting?: number;
  deposit?: { amount: number; currency: string };
  cancellationPolicy: string;
  availableSlots: string[];
}

export interface RestaurantBooking {
  reservationNumber: string;
  restaurantId: string;
  slot: string;
  partySize: number;
  terms: string;
  status: 'confirmed' | 'cancelled';
  idempotencyKey?: string;
}

export interface ReservationReadPort {
  searchRestaurants(criteria: { near?: string; date?: string }): Promise<RestaurantOption[]>;
  getBooking(reservationNumber: string): Promise<RestaurantBooking | undefined>;
  findBookingByIdempotencyKey(key: string): Promise<RestaurantBooking | undefined>;
}

export interface ReservationWritePort {
  book(
    args: { restaurantId: string; slot: string; partySize: number; pageVersionHash: string },
    idempotencyKey: string,
  ): Promise<WriteReceipt>;
}

// -- Subscription billing (Adobe) ---------------------------------------------------

export interface Subscription {
  subscriptionId: string;
  product: string;
  owner: string;
  renewalDate: string;
  monthlyAmount: number;
  earlyTerminationFee: number;
  teamLibraryUsers: number;
  status: 'active' | 'cancel-at-term' | 'cancelled';
  cancellation?: { effectiveDate: string; confirmationRef: string };
  idempotencyKey?: string;
}

export interface BillingCharge {
  subscriptionId: string;
  amount: number;
  chargedAt: string;
  description: string;
}

export interface BillingReadPort {
  getSubscription(subscriptionId: string): Promise<Subscription | undefined>;
  listCharges(subscriptionId: string, since: string): Promise<BillingCharge[]>;
  findCancellationByIdempotencyKey(key: string): Promise<Subscription | undefined>;
}

export interface BillingWritePort {
  cancelSubscription(
    args: { subscriptionId: string; mode: 'immediate' | 'at-term'; pageVersionHash: string },
    idempotencyKey: string,
  ): Promise<WriteReceipt>;
}

// -- Bundles ---------------------------------------------------------------------

/** Everything a Verifier may hold: read ports only (I6). */
export interface ReadPorts {
  email: EmailReadPort;
  calendar: CalendarReadPort;
  commerce: CommerceReadPort;
  airline: AirlineReadPort;
  hotel: HotelReadPort;
  telephony: TelephonyReadPort;
  work: WorkReadPort;
  ledger: LedgerReadPort;
  reservations: ReservationReadPort;
  billing: BillingReadPort;
}

/** Write ports are handed only to Execution Actors (§5.7). */
export interface WritePorts {
  email: EmailWritePort;
  commerce: CommerceWritePort;
  airline: AirlineWritePort;
  telephony: TelephonyWritePort;
  reservations: ReservationWritePort;
  billing: BillingWritePort;
}
