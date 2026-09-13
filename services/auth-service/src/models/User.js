import mongoose from 'mongoose';
import { FOOD_CATEGORIES, VEHICLE_TYPES, DEFAULT_AGENT_RATING } from '../domain/categories.js';

export const ROLES = Object.freeze(['DONOR', 'AGENT']);

// What an agent can physically carry. Declared once at registration and later
// mirrored into Redis by agent-location-service (Phase 4), because
// assignment-engine must read it on every single scoring pass and cannot
// afford a Mongo round trip per candidate agent.
const capabilitiesSchema = new mongoose.Schema(
  {
    vehicleType: { type: String, enum: VEHICLE_TYPES, required: true },

    // Drives the category-compatibility term in the scoring formula.
    // Cooked food requires insulated transport; raw perishables prefer cooling.
    hasInsulatedTransport: { type: Boolean, default: false },
    hasRefrigeration: { type: Boolean, default: false },

    // The categories this agent is willing to handle at all.
    categoriesHandled: {
      type: [{ type: String, enum: FOOD_CATEGORIES }],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'an agent must handle at least one food category',
      },
    },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    // select: false means every query omits the hash unless it is explicitly
    // asked for. One less way to leak it into an API response by accident.
    passwordHash: { type: String, required: true, select: false },

    phone: { type: String, required: true, trim: true },

    role: { type: String, enum: ROLES, required: true, index: true },

    // ---------------- agent-only fields ----------------
    capabilities: {
      type: capabilitiesSchema,
      required: function () {
        return this.role === 'AGENT';
      },
    },

    // Historical reliability, the 0.15-weight term in the scoring formula.
    // Seeded neutral rather than 0 so a brand-new agent is not locked out.
    rating: {
      type: Number,
      default: DEFAULT_AGENT_RATING,
      min: 0,
      max: 5,
    },
    ratingCount: { type: Number, default: 0, min: 0 },

    // Whether the agent is currently accepting work at all. Distinct from
    // "is online" (that is a Redis TTL concern in Phase 4) and from
    // "current load" (a Redis counter).
    isAvailable: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    // Shape the JSON the API returns: no __v, no passwordHash, id instead of _id.
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        // Donors have no capability/rating concepts; omit the noise.
        if (ret.role === 'DONOR') {
          delete ret.capabilities;
          delete ret.rating;
          delete ret.ratingCount;
          delete ret.isAvailable;
        }
        return ret;
      },
    },
  },
);

export const User = mongoose.model('User', userSchema);
