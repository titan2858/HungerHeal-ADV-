import { DonationStatus } from '../models/DonationStatus.js';
import { STATUS } from '../domain/statusMachine.js';
import { toDonorView } from '../events/handlers.js';
import { publishCollected } from '../events/producer.js';
import { ApiError } from '../utils/ApiError.js';

// GET /tracking/:donationId - "where is my donation?"
export async function getTracking(req, res, next) {
  try {
    const record = await DonationStatus.findOne({ donationId: req.params.donationId });

    if (!record) {
      throw ApiError.notFound('no tracking record for this donation');
    }

    // Authorization by who is involved, not by role alone. A donor sees their
    // own donations; an agent sees ones offered to or accepted by them. Anyone
    // else gets the same 404, which reveals nothing about whether the id is
    // real.
    const isDonor = record.donorId === req.user.id;
    const isAssignedAgent = record.assignedAgentId === req.user.id;
    const wasOffered = record.timeline.some((t) => t.agentId === req.user.id);

    if (!isDonor && !isAssignedAgent && !wasOffered) {
      throw ApiError.notFound('no tracking record for this donation');
    }

    const view = toDonorView(record);

    // The agent's phone number is contact information, not public data. Only
    // the donor and the agent themselves need it.
    if (!isDonor && !isAssignedAgent) {
      delete view.assignedAgentPhone;
    }

    res.json({ tracking: view });
  } catch (err) {
    next(err);
  }
}

// GET /tracking - the caller's own donations, newest activity first.
export async function listTracking(req, res, next) {
  try {
    const { status, limit, offset } = req.validatedQuery;

    // Scoped at the query, so one user's request can never reach another's
    // rows in the first place.
    const filter =
      req.user.role === 'AGENT'
        ? { assignedAgentId: req.user.id }
        : { donorId: req.user.id };

    if (status) filter.status = status;

    const [records, total] = await Promise.all([
      DonationStatus.find(filter).sort({ updatedAt: -1 }).skip(offset).limit(limit),
      DonationStatus.countDocuments(filter),
    ]);

    res.json({
      tracking: records.map((r) => {
        const view = toDonorView(r);
        // The list view does not need the whole history; the detail endpoint
        // has it. Sending every timeline entry for every row would grow
        // without bound as donations get re-offered.
        view.timeline = r.timeline.slice(-3);
        return view;
      }),
      pagination: { total, limit, offset, hasMore: offset + records.length < total },
    });
  } catch (err) {
    next(err);
  }
}

// POST /tracking/:donationId/collected - the agent marks the pickup done.
export async function markCollected(req, res, next) {
  try {
    const { donationId } = req.params;
    const record = await DonationStatus.findOne({ donationId });

    if (!record) {
      throw ApiError.notFound('no tracking record for this donation');
    }

    // Only the agent who accepted it can mark it collected. Without this check
    // any agent could close out someone else's pickup.
    if (record.assignedAgentId !== req.user.id) {
      throw ApiError.forbidden('only the agent who accepted this donation can mark it collected');
    }
    if (record.status === STATUS.COLLECTED) {
      // Not an error: a flaky connection makes double-taps normal, and the
      // outcome the agent wanted has already happened.
      return res.json({ tracking: toDonorView(record), alreadyCollected: true });
    }
    if (record.status !== STATUS.ACCEPTED) {
      throw ApiError.badRequest(`a donation in status ${record.status} cannot be collected`);
    }

    // Published rather than written directly here, even though this service
    // owns the status. The event is what decrements the agent's load counter
    // and reaches notification-service; applying the change locally and
    // skipping the event would leave the rest of the system unaware.
    //
    // This service then consumes its own event through the normal path, so
    // there is exactly one place where a status is written.
    const { published, event } = await publishCollected({
      donationId,
      donorId: record.donorId,
      category: record.category,
      agentId: req.user.id,
      agentName: req.user.name,
      traceId: req.traceId,
    });

    req.log.info({ donationId, agentId: req.user.id, published }, 'donation marked collected');

    res.status(202).json({
      accepted: true,
      // Honest about the asynchrony: the status will be COLLECTED momentarily,
      // once this service consumes its own event.
      status: 'COLLECTING',
      published,
      eventId: event.eventId,
    });
  } catch (err) {
    next(err);
  }
}

// GET /tracking/stats/summary - counts by status, for a dashboard.
export async function summary(req, res, next) {
  try {
    const match =
      req.user.role === 'AGENT'
        ? { assignedAgentId: req.user.id }
        : { donorId: req.user.id };

    const rows = await DonationStatus.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const counts = Object.fromEntries(Object.values(STATUS).map((s) => [s, 0]));
    for (const row of rows) counts[row._id] = row.count;

    res.json({
      counts,
      total: rows.reduce((sum, r) => sum + r.count, 0),
    });
  } catch (err) {
    next(err);
  }
}
