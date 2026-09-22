import mongoose from 'mongoose';
import { RECIPIENT, KIND, PRIORITY } from '../domain/templates.js';

const notificationSchema = new mongoose.Schema(
  {
    recipientId: { type: String, required: true, index: true },
    recipientRole: { type: String, enum: Object.values(RECIPIENT), required: true },

    kind: { type: String, enum: Object.values(KIND), required: true, index: true },
    priority: { type: String, enum: Object.values(PRIORITY), default: PRIORITY.NORMAL },

    title: { type: String, required: true },
    body: { type: String, required: true },

    donationId: { type: String, index: true },

    readAt: { type: Date, default: null },

    // Offers go stale: a 90-second collection request shown an hour later is
    // worse than useless, because tapping it fails. The API filters on this
    // rather than the app having to know the rule.
    expiresAt: { type: Date, default: null },

    // Anything the app needs to render richer than title+body - the agent's
    // rank in the offer, the unassigned reason, and so on.
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },

    // The event that produced this. Keeping it makes a notification traceable
    // back to its cause, and gives the dedup a second line of defence.
    sourceEventId: { type: String, index: true },
    traceId: { type: String, default: null },
  },
  { timestamps: true },
);

// The inbox query: my unread notifications, newest first.
notificationSchema.index({ recipientId: 1, readAt: 1, createdAt: -1 });

// One notification per recipient per source event. Even if dedup in Redis
// fails, this unique index makes a duplicate physically impossible rather than
// merely unlikely - an agent seeing the same collection request twice would
// have them tapping an offer that is already theirs.
notificationSchema.index(
  { sourceEventId: 1, recipientId: 1 },
  { unique: true, partialFilterExpression: { sourceEventId: { $type: 'string' } } },
);

notificationSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id?.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const Notification = mongoose.model('Notification', notificationSchema);
