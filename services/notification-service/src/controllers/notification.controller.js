import { Notification } from '../models/Notification.js';
import { ApiError } from '../utils/ApiError.js';

// GET /notifications - the caller's inbox.
export async function list(req, res, next) {
  try {
    const { unreadOnly, kind, limit, offset, includeExpired } = req.validatedQuery;

    // Scoped to the caller at the query level. There is no parameter that lets
    // anyone ask for somebody else's inbox.
    const filter = { recipientId: req.user.id };
    if (unreadOnly) filter.readAt = null;
    if (kind) filter.kind = kind;

    // A 90-second collection request shown an hour later is worse than
    // useless: tapping it fails. Filtered here so the app does not have to
    // know the rule.
    if (!includeExpired) {
      filter.$or = [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }];
    }

    const [notifications, total, unread] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit),
      Notification.countDocuments(filter),
      Notification.countDocuments({ recipientId: req.user.id, readAt: null }),
    ]);

    res.json({
      notifications: notifications.map((n) => n.toJSON()),
      unreadCount: unread,
      pagination: { total, limit, offset, hasMore: offset + notifications.length < total },
    });
  } catch (err) {
    next(err);
  }
}

// GET /notifications/unread-count - what the badge polls.
export async function unreadCount(req, res, next) {
  try {
    const count = await Notification.countDocuments({
      recipientId: req.user.id,
      readAt: null,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    });
    res.json({ unreadCount: count });
  } catch (err) {
    next(err);
  }
}

// PATCH /notifications/:id/read
export async function markRead(req, res, next) {
  try {
    const notification = await Notification.findOne({
      _id: req.params.id,
      // In the query, not checked afterwards, so one user can never mark
      // another's notification read.
      recipientId: req.user.id,
    }).catch(() => null);

    if (!notification) {
      throw ApiError.notFound('notification not found');
    }

    if (!notification.readAt) {
      notification.readAt = new Date();
      await notification.save();
    }

    res.json({ notification: notification.toJSON() });
  } catch (err) {
    next(err);
  }
}

// POST /notifications/read-all
export async function markAllRead(req, res, next) {
  try {
    const result = await Notification.updateMany(
      { recipientId: req.user.id, readAt: null },
      { $set: { readAt: new Date() } },
    );
    res.json({ markedRead: result.modifiedCount ?? 0 });
  } catch (err) {
    next(err);
  }
}
