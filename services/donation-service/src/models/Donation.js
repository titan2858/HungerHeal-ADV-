import mongoose from 'mongoose';
import { FOOD_CATEGORIES, QUANTITY_UNITS, DONATION_STATUSES } from '../domain/categories.js';

const imageSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },
    // The path a client can fetch: /uploads/<filename>
    url: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
  },
  { _id: false },
);

// A GeoJSON Point. Both fields are required, so a half-populated location
// cannot be stored at all.
const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Point'], required: true, default: 'Point' },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (v) =>
          Array.isArray(v) &&
          v.length === 2 &&
          v[0] >= -180 && v[0] <= 180 &&
          v[1] >= -90 && v[1] <= 90,
        message: 'coordinates must be [longitude, latitude] within valid ranges',
      },
    },
  },
  { _id: false },
);

const donationSchema = new mongoose.Schema(
  {
    // Who donated. Just the id - there is no join to the users collection,
    // because that collection belongs to auth-service and lives in another
    // database entirely.
    donorId: { type: String, required: true, index: true },
    donorName: { type: String, required: true },
    donorPhone: { type: String, required: true },

    title: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, trim: true, maxlength: 2000 },

    // Present from day one because assignment scoring depends on it (Phase 5).
    // Retrofitting it later would leave every existing donation unscoreable.
    category: { type: String, enum: FOOD_CATEGORIES, required: true, index: true },

    quantity: {
      amount: { type: Number, required: true, min: 0.1 },
      unit: { type: String, enum: QUANTITY_UNITS, required: true },
    },

    pickupAddress: { type: String, required: true, trim: true, maxlength: 500 },

    // GeoJSON, because that is the only shape MongoDB's 2dsphere index accepts.
    // Note the order is [longitude, latitude] - the reverse of how coordinates
    // are usually spoken, and the same trap as Redis GEOADD.
    //
    // Optional in this phase: Phase 3's geocoding-service fills it in from the
    // address. A donation without coordinates cannot be matched to an agent,
    // so assignment-engine will skip it until it has them.
    //
    // `default: undefined` is load-bearing and NOT a style choice. Declared as
    // a plain nested object with a default on `type`, Mongoose helpfully writes
    // `location: { type: 'Point' }` with no coordinates for every ungeocoded
    // donation - and the 2dsphere index rejects that with "Can't extract geo
    // keys", turning a valid donation into a 500. A subdocument defaulting to
    // undefined stays genuinely absent until there is something to store.
    location: {
      type: pointSchema,
      default: undefined,
    },

    images: { type: [imageSchema], default: [] },

    // After this moment the food should no longer be distributed. Drives the
    // EXPIRED status and, later, how urgently this donation is pushed.
    bestBefore: { type: Date, required: true },

    status: {
      type: String,
      enum: DONATION_STATUSES,
      default: 'PENDING_ASSIGNMENT',
      index: true,
    },

    // Set by tracking-service in Phase 7 once an agent accepts. Kept here so a
    // donor's "where is my donation" view is a single read.
    assignedAgentId: { type: String, default: null },

    // --- outbox bookkeeping; see events/outbox.js ---
    // False means the donation is saved but its donation.created event has not
    // reached Kafka yet. The sweeper retries these.
    eventPublished: { type: Boolean, default: false, index: true },
    eventPublishAttempts: { type: Number, default: 0 },

    // Carried onto the Kafka event so one donation's journey through every
    // service can be followed by grepping a single id.
    traceId: { type: String, required: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.__v;
        // Internal plumbing; no client has any use for it.
        delete ret.eventPublished;
        delete ret.eventPublishAttempts;
        return ret;
      },
    },
  },
);

// Supports "find donations near this point", used from Phase 5 onward and by
// any map view. A 2dsphere index treats the earth as a sphere rather than a
// flat plane, so distances stay correct at any latitude.
donationSchema.index({ location: '2dsphere' });

// The donor dashboard's main query: my donations, newest first.
donationSchema.index({ donorId: 1, createdAt: -1 });

export const Donation = mongoose.model('Donation', donationSchema);
