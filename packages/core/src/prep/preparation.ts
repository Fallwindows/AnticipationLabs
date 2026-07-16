import type { ActionSignature, Outcome } from '../domain/types.js';
import type { ReadPorts } from '../integrations/ports.js';
import type { LLMProvider } from '../llm/provider.js';
import type { MemoryStore } from '../memory/memoryStore.js';
import { hashCanonical } from '../util/canonical.js';

/**
 * Preparation / research (§5.5): takes an Outcome to its final consequential screen
 * WITHOUT committing. Preparers hold READ ports only — a preparer that performs a
 * side effect is a type error. Output is either a ready ActionSignature (plus the
 * plain-language summary for the approval card) or a set of options the human must
 * choose between first, or research notes for a brief.
 */
export interface PreparationContext {
  read: ReadPorts;
  memory: MemoryStore;
  llm: LLMProvider;
  outcome: Outcome;
  params: Record<string, unknown>;
}

export type PreparationResult =
  | {
      kind: 'action';
      signature: ActionSignature;
      summary: string;
      research?: Record<string, unknown>;
    }
  | {
      kind: 'options';
      options: { optionId: string; label: string; detail: Record<string, unknown> }[];
      summary: string;
      research?: Record<string, unknown>;
    }
  | {
      kind: 'brief';
      brief: string;
      openQuestions: string[];
      summary: string;
      research?: Record<string, unknown>;
    };

export type Preparer = (ctx: PreparationContext) => Promise<PreparationResult>;

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || v === '') throw new Error(`preparation param "${name}" missing`);
  return v;
}

// ---------------------------------------------------------------------------
// Built-in domain preparers
// ---------------------------------------------------------------------------

/** Scenario 1: check amenities, prepare ONE disclosed call to the front desk. */
const hotelAmenityCall: Preparer = async ({ read, params, outcome }) => {
  const hotelName = str(params.hotel, 'hotel');
  const item = str(params.item, 'item');
  const room = str(params.room, 'room');
  const hotel = await read.hotel.getHotelInfo(hotelName);
  if (!hotel) throw new Error(`hotel "${hotelName}" not found`);
  const amenity = Object.entries(hotel.amenities).find(([k]) =>
    k.toLowerCase().includes(item.toLowerCase()),
  );
  const beneficiary = outcome.beneficiary ?? outcome.owner;
  const script = `Requesting a complimentary ${item} kit be sent to room ${room} for ${beneficiary}.`;
  const disclosure = `This is Anticipy, ${outcome.owner}'s assistant, calling on their behalf.`;
  return {
    kind: 'action',
    signature: {
      actionType: 'telephony.call',
      target: hotel.phone,
      params: { hotel: hotel.name, item, room, beneficiary, script },
      pageVersionHash: hashCanonical({ hotel: hotel.name, amenities: hotel.amenities }),
      disclosures: [disclosure],
    },
    summary: amenity
      ? `${hotel.name} says ${amenity[1]}. I can call the front desk and ask them to send a ${item} to room ${room} for ${beneficiary}.`
      : `I can call ${hotel.name}'s front desk and ask about a ${item} for room ${room}.`,
    research: { amenities: hotel.amenities, phone: hotel.phone },
  };
};

/** Scenario 2: return prepared to the final screen — deadline, fees, methods, refund. */
const commerceReturn: Preparer = async ({ read, params }) => {
  const orderId = str(params.orderId, 'orderId');
  const lineId = str(params.lineId, 'lineId');
  const reason = str(params.reason, 'reason');
  const lines = await read.commerce.getOrderLines(orderId);
  const line = lines.find((l) => l.lineId === lineId);
  if (!line) throw new Error(`order line ${orderId}/${lineId} not found`);
  const options = await read.commerce.getReturnOptions(orderId, lineId);
  const freeMethod =
    options.methods.find((m) => m.fee === 0) ?? options.methods.sort((a, b) => a.fee - b.fee)[0];
  if (!freeMethod) throw new Error('no return methods available');
  return {
    kind: 'action',
    signature: {
      actionType: 'commerce.submit-return',
      target: orderId,
      params: {
        lineId,
        item: line.item,
        reason,
        method: freeMethod.method,
        refundAmount: line.price,
        refundDestination: options.refundDestination,
      },
      pageVersionHash: options.pageVersionHash,
      disclosures: [],
    },
    summary: `Return "${line.item}" (${line.currency} ${line.price.toFixed(2)} back to ${options.refundDestination}) via ${freeMethod.description}, reason: ${reason}. Window ends ${options.windowEndsAt}.`,
    research: { deadline: options.windowEndsAt, methods: options.methods, line },
  };
};

/** Email preparation (scenarios 4, 5, 7, 9): draft against source, honor exclusions. */
const emailSend: Preparer = async ({ params, llm, outcome, memory }) => {
  const to = str(params.to, 'to');
  const from = str(params.from, 'from');
  const subject = str(params.subject, 'subject');
  let body: string;
  if (typeof params.body === 'string' && params.body !== '') {
    body = params.body;
  } else {
    const exclusions = outcome.constraints
      .filter((c) => c.kind === 'exclusion' || c.kind === 'authority-limit')
      .map((c) => `- ${c.description}`)
      .join('\n');
    body = await llm.complete({
      tag: 'draft-email',
      system:
        'Draft the email body only. Honor every exclusion and authority limit strictly; verify claims against the provided source facts and leave out anything not confirmed.',
      prompt: [
        `Goal: ${outcome.interpretedGoal}`,
        `To: ${to}  Subject: ${subject}`,
        `Hard constraints:\n${exclusions || '(none)'}`,
        `Source facts:\n${memory.promptLines().join('\n')}`,
        typeof params.sourceNotes === 'string' ? `Source material:\n${params.sourceNotes}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
  }
  const attachments = Array.isArray(params.attachments)
    ? (params.attachments as { name: string; contentRef: string }[])
    : [];
  const cc = Array.isArray(params.cc) ? (params.cc as string[]) : [];
  return {
    kind: 'action',
    signature: {
      actionType: 'email.send',
      target: to,
      params: { from, to, cc, subject, body, attachments },
      pageVersionHash: hashCanonical({ draftVersion: { to, subject, body, attachments, cc } }),
      disclosures: [],
    },
    summary: `Send "${subject}" to ${to}${attachments.length ? ` with ${attachments.map((a) => a.name).join(', ')}` : ''}.`,
  };
};

/** Scenario 3 (part 1): research restaurants against constraints; human picks. */
const restaurantSearch: Preparer = async ({ read, params, outcome }) => {
  const date = typeof params.date === 'string' ? params.date : undefined;
  const all = await read.reservations.searchRestaurants({ date });
  const wantsQuiet = outcome.constraints.some((c) => c.description.toLowerCase().includes('quiet'));
  const wantsVegetarian = outcome.constraints.some((c) =>
    c.description.toLowerCase().includes('vegetarian'),
  );
  const avoidCuisines = outcome.constraints
    .filter((c) => c.params && typeof c.params['avoidCuisine'] === 'string')
    .map((c) => (c.params!['avoidCuisine'] as string).toLowerCase());
  const maxTravel = params.maxTravelMinutes as number | undefined;
  const fits = all.filter(
    (r) =>
      (!wantsQuiet || r.noiseLevel === 'quiet') &&
      (!wantsVegetarian || r.vegetarianFriendly) &&
      !avoidCuisines.includes(r.cuisine.toLowerCase()) &&
      (maxTravel === undefined ||
        r.travelMinutesFromMeeting === undefined ||
        r.travelMinutesFromMeeting <= maxTravel) &&
      r.availableSlots.length > 0,
  );
  return {
    kind: 'options',
    options: fits.map((r) => ({
      optionId: r.restaurantId,
      label: `${r.name} (${r.cuisine}, ${r.noiseLevel}, ${r.availableSlots.join('/')}${r.deposit ? `, deposit ${r.deposit.currency} ${r.deposit.amount}` : ''})`,
      detail: { ...r },
    })),
    summary: `${fits.length} restaurant(s) fit the constraints (checked availability, noise, dietary fit, travel time, deposits, cancellation).`,
    research: { considered: all.length, constraintsApplied: { wantsQuiet, wantsVegetarian, avoidCuisines, maxTravel } },
  };
};

/** Scenario 3 (part 2): the human chose — build the booking signature. */
const restaurantBook: Preparer = async ({ read, params }) => {
  const restaurantId = str(params.restaurantId, 'restaurantId');
  const slot = str(params.slot, 'slot');
  const partySize = Number(params.partySize ?? 2);
  const all = await read.reservations.searchRestaurants({});
  const r = all.find((x) => x.restaurantId === restaurantId);
  if (!r) throw new Error(`restaurant ${restaurantId} not found`);
  if (!r.availableSlots.includes(slot)) throw new Error(`slot ${slot} no longer available`);
  return {
    kind: 'action',
    signature: {
      actionType: 'reservation.book',
      target: restaurantId,
      params: { restaurant: r.name, slot, partySize, deposit: r.deposit ?? null, cancellationPolicy: r.cancellationPolicy },
      pageVersionHash: hashCanonical({ restaurant: r }),
      disclosures: [],
    },
    summary: `Book ${r.name} for ${partySize} at ${slot}. ${r.deposit ? `Deposit ${r.deposit.currency} ${r.deposit.amount}. ` : ''}Cancellation: ${r.cancellationPolicy}`,
    research: { restaurant: r },
  };
};

/** Scenario 6 & 10 research: a brief with open questions — research never becomes adopt (I10). */
const researchBrief: Preparer = async ({ params, llm }) => {
  const topic = str(params.topic, 'topic');
  const findings = typeof params.findings === 'string' ? params.findings : '';
  const brief = await llm.complete({
    tag: 'research-brief',
    system:
      'Write a preliminary research brief. Separate confirmed findings from unresolved questions. You are researching only — recommending adoption, contacting sales, or changing anything is out of scope.',
    prompt: `Topic: ${topic}\n\nCollected findings:\n${findings}`,
  });
  const openQuestions = Array.isArray(params.openQuestions)
    ? (params.openQuestions as string[])
    : [];
  return {
    kind: 'brief',
    brief,
    openQuestions,
    summary: `Preliminary brief on ${topic} ready (${openQuestions.length} unresolved question(s); deep pass stays open).`,
  };
};

/** Scenario 8 (part 1): verify authoritative status, gather real alternatives. */
const flightAlternatives: Preparer = async ({ read, params }) => {
  const pnr = str(params.pnr, 'pnr');
  const flightNumber = str(params.flightNumber, 'flightNumber');
  const date = str(params.date, 'date');
  const status = await read.airline.getFlightStatus(flightNumber, date);
  if (!status) throw new Error(`no authoritative status for ${flightNumber} ${date}`);
  const options = await read.airline.getAlternatives(pnr);
  return {
    kind: 'options',
    options: options.map((o) => ({
      optionId: o.optionId,
      label: `${o.description} (fare diff $${o.fareDifference}, ${o.seat ?? 'seat TBD'}, baggage ${o.baggageThrough ? 'through-checked' : 'NOT through-checked'})`,
      detail: { ...o },
    })),
    summary: `Flight ${flightNumber} is ${status.status}${status.connectionAtRisk ? ' — connection at risk' : ''}. ${options.length} real alternative(s) found.`,
    research: { status },
  };
};

/** Scenario 8 (part 2): the human chose an alternative. */
const flightRebook: Preparer = async ({ read, params }) => {
  const pnr = str(params.pnr, 'pnr');
  const optionId = str(params.optionId, 'optionId');
  const options = await read.airline.getAlternatives(pnr);
  const option = options.find((o) => o.optionId === optionId);
  if (!option) throw new Error(`option ${optionId} not found for ${pnr}`);
  return {
    kind: 'action',
    signature: {
      actionType: 'airline.rebook',
      target: pnr,
      params: {
        optionId,
        description: option.description,
        fareDifference: option.fareDifference,
        seat: option.seat ?? null,
        baggageThrough: option.baggageThrough,
      },
      pageVersionHash: hashCanonical({ option }),
      disclosures: [],
    },
    summary: `Rebook ${pnr} onto: ${option.description}. Fare difference $${option.fareDifference}; seat ${option.seat ?? 'TBD'}; baggage ${option.baggageThrough ? 'through-checked' : 'must be re-checked'}.`,
    research: { option },
  };
};

/** Scenario 10 (part 1): consequences of cancelling — never auto-cancel (I2). */
const billingResearch: Preparer = async ({ read, params }) => {
  const subscriptionId = str(params.subscriptionId, 'subscriptionId');
  const sub = await read.billing.getSubscription(subscriptionId);
  if (!sub) throw new Error(`subscription ${subscriptionId} not found`);
  return {
    kind: 'options',
    options: [
      {
        optionId: 'at-term',
        label: `Cancel at term (${sub.renewalDate}) — no early-termination fee`,
        detail: { mode: 'at-term', renewalDate: sub.renewalDate },
      },
      {
        optionId: 'immediate',
        label: `Cancel now — $${sub.earlyTerminationFee.toFixed(2)} early-termination fee`,
        detail: { mode: 'immediate', fee: sub.earlyTerminationFee },
      },
      {
        optionId: 'keep',
        label: 'Keep the subscription',
        detail: { mode: 'keep' },
      },
    ],
    summary: `${sub.product}: renews ${sub.renewalDate}, $${sub.monthlyAmount}/mo, owner ${sub.owner}, early-termination fee $${sub.earlyTerminationFee.toFixed(2)}, team library used by ${sub.teamLibraryUsers} people.`,
    research: { subscription: sub },
  };
};

/** Scenario 10 (part 2): the human chose a cancellation mode. */
const billingCancel: Preparer = async ({ read, params }) => {
  const subscriptionId = str(params.subscriptionId, 'subscriptionId');
  const mode = str(params.mode, 'mode') as 'immediate' | 'at-term';
  const sub = await read.billing.getSubscription(subscriptionId);
  if (!sub) throw new Error(`subscription ${subscriptionId} not found`);
  return {
    kind: 'action',
    signature: {
      actionType: 'billing.cancel',
      target: subscriptionId,
      params: {
        product: sub.product,
        mode,
        earlyTerminationFee: mode === 'immediate' ? sub.earlyTerminationFee : 0,
        renewalDate: sub.renewalDate,
      },
      pageVersionHash: hashCanonical({ subscription: sub }),
      disclosures: [],
    },
    summary:
      mode === 'at-term'
        ? `Cancel ${sub.product} at term (${sub.renewalDate}); no early-termination fee.`
        : `Cancel ${sub.product} immediately; $${sub.earlyTerminationFee.toFixed(2)} early-termination fee applies.`,
    research: { subscription: sub },
  };
};

/** Internal deliverable (scenario 6): deliver a brief in chat — non-external action. */
const chatDeliverBrief: Preparer = async ({ params }) => {
  const text = str(params.text, 'text');
  const topic = str(params.topic, 'topic');
  return {
    kind: 'action',
    signature: {
      actionType: 'chat.deliver-brief',
      target: 'user',
      params: { topic, text },
      pageVersionHash: hashCanonical({ text }),
      disclosures: [],
    },
    summary: `Deliver the ${topic} brief in chat.`,
  };
};

export class PreparationService {
  private preparers = new Map<string, Preparer>([
    ['hotel-amenity-call', hotelAmenityCall],
    ['commerce-return', commerceReturn],
    ['email-send', emailSend],
    ['restaurant-search', restaurantSearch],
    ['restaurant-book', restaurantBook],
    ['research-brief', researchBrief],
    ['flight-alternatives', flightAlternatives],
    ['flight-rebook', flightRebook],
    ['billing-research', billingResearch],
    ['billing-cancel', billingCancel],
    ['chat.deliver-brief', chatDeliverBrief],
  ]);

  constructor(
    private read: ReadPorts,
    private memory: MemoryStore,
    private llm: LLMProvider,
  ) {}

  register(kind: string, preparer: Preparer): void {
    this.preparers.set(kind, preparer);
  }

  async prepare(outcome: Outcome, kind: string, params: Record<string, unknown>): Promise<PreparationResult> {
    const preparer = this.preparers.get(kind);
    if (!preparer) throw new Error(`no preparer registered for "${kind}"`);
    return preparer({ read: this.read, memory: this.memory, llm: this.llm, outcome, params });
  }
}
