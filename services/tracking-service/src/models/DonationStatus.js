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

const donationStatusSchema = new mongoose.Schema(
  {
    // Not _id: keeping the donation's own id as a plain indexed field makes it
    // obvious this is a projection of something donation-service owns, rather
    // than a second source of truth for the donation itself.
    donationId: { type: String, required: true, unique: true, index: true },
    donorId: { type: String, required: true, index: true },
    category: { type: String, default: null },

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
