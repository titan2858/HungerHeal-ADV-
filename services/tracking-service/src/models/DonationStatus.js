import mongoose from 'mongoose';
import { STATUS } from '../domain/statusMachine.js';

// One entry per thing that happened to a donation.
//
// The timeline is the point of this service, not a side effect of it. A status
// field alone answers "where is it now?"; the timeline answers "what happened,
// when, and to whom?" - which is what a donor actually asks when their food has
// not been collected, and what Phase 10's monitoring view reads.
const timelineEntrySchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    eventType: { type: String, required: true },
    // Null when the event was recorded but did not move the status - a
    // rejection by one of three agents, for instance.
    fromStatus: { type: String, default: null },
    toStatus: { type: String, default: null },
    // Human-readable, written at the time. Regenerating this later would mean
    // reading agent state that has since changed.
    summary: { type: String, required: true },
    // Whichever of these the event involved.
    agentId: { type: String, default: null },
    agentName: { type: String, default: null },
    round: { type: Number, default: null },
    reason: { type: String, default: null },
    eventId: { type: String, required: true },
    traceId: { type: String, default: null },
  },
  { _id: false },
);

// One agent's score for one donation, exactly as assignment-engine computed it.
//
// Stored rather than recomputed, because recomputing it later would read agent
// state that has since changed - their load, their position, even their rating.
// The only honest record of WHY an agent was chosen is the one captured at the
// moment of the decision.
const scoredOfferSchema = new mongoose.Schema(
  {
    agentId: { type: String, required: true },
    agentName: { type: String, default: null },
    rank: { type: Number, required: true },
    score: { type: Number, required: true },
    breakdown: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const donationStatusSchema = new mongoose.Schema(
  {
    // Not _id: keeping the donation's own id as a plain indexed field makes it
    // obvious this is a projection of something donation-service owns, rather
    // than a second source of truth for the donation itself.
    donationId: { type: String, required: true, unique: true, index: true },
    donorId: { type: String, required: true, index: true },
    category: { type: String, default: null },

    // Copied from donation.created so the donor's dashboard can show what a
    // donation actually WAS without a second call to donation-service for
    // every row. The event already carries all of it.
    title: { type: String, default: null },
    pickupAddress: { type: String, default: null },
    quantity: {
      amount: { type: Number, default: null },
      unit: { type: String, default: null },
    },
    // Lets the dashboard show how much time is left before the food should no
    // longer be distributed - the difference between "waiting" and "waiting,
    // and it expires in 40 minutes".
    bestBefore: { type: Date, default: null },

    status: {
      type: String,
      enum: Object.values(STATUS),
      default: STATUS.PENDING_ASSIGNMENT,
      index: true,
    },

    // Who is collecting, once someone has accepted.
    assignedAgentId: { type: String, default: null },
    assignedAgentName: { type: String, default: null },
    assignedAgentPhone: { type: String, default: null },

    // How many offer rounds it took. A donation that needed four rounds is a
    // very different story from one accepted on the first, and the difference
    // is invisible from the status alone.
    offerRounds: { type: Number, default: 0 },
    agentsOffered: { type: Number, default: 0 },

    // Timestamps for the questions Phase 11's analytics will ask.
    firstOfferedAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    collectedAt: { type: Date, default: null },

    lastEventAt: { type: Date, default: null },
    lastReason: { type: String, default: null },

    // --- the monitoring view's raw material (Phase 10) ---
    // The most recent round of offers with their full score breakdowns, plus
    // how the search that produced them went.
    lastOffers: { type: [scoredOfferSchema], default: [] },
    searchRadiusKm: { type: Number, default: null },
    candidatesFound: { type: Number, default: null },
    candidatesEligible: { type: Number, default: null },
    urgency: { type: String, default: null },
    responseTimeoutSeconds: { type: Number, default: null },

    timeline: { type: [timelineEntrySchema], default: [] },

    traceId: { type: String, default: null },
  },
  { timestamps: true },
);

// The donor dashboard's query: my donations, most recently updated first.
donationStatusSchema.index({ donorId: 1, updatedAt: -1 });
// The agent's query: what have I accepted and not yet collected?
donationStatusSchema.index({ assignedAgentId: 1, status: 1 });

donationStatusSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id?.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const DonationStatus = mongoose.model('DonationStatus', donationStatusSchema);
