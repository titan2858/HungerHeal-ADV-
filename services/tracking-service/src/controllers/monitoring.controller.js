import { DonationStatus } from '../models/DonationStatus.js';
import { STATUS } from '../domain/statusMachine.js';
import { ApiError } from '../utils/ApiError.js';

// The read-only monitoring view (Phase 10).
//
// docs/PLAN.md is explicit: "No manual admin-assignment panel. If any
// admin/monitoring view exists, it is strictly READ-ONLY - shows what the
// algorithm decided and why (score breakdown), with no assign/reassign
// controls."
//
// So there is deliberately no POST, PATCH or DELETE in this file. The whole
// point of the rebuild was removing the human from assignment; an override
// button would put them straight back, and the first time a donation was slow
// somebody would use it.

// GET /monitoring/donations - every donation in the system, newest first.
export async function listDonations(req, res, next) {
  try {
    const { status, limit, offset, unmatched } = req.validatedQuery;

    const filter = {};
    if (status) filter.status = status;
    // The view that matters most in practice: what is NOT working.
    if (unmatched) filter.status = { $in: [STATUS.UNASSIGNED, STATUS.PENDING_ASSIGNMENT] };

    const [records, total] = await Promise.all([
      DonationStatus.find(filter).sort({ updatedAt: -1 }).skip(offset).limit(limit),
      DonationStatus.countDocuments(filter),
    ]);

    res.json({
      donations: records.map((r) => ({
        donationId: r.donationId,
        title: r.title,
        category: r.category,
        quantity: r.quantity,
        pickupAddress: r.pickupAddress,
        status: r.status,
        assignedAgentName: r.assignedAgentName,
        offerRounds: r.offerRounds,
        agentsOffered: r.agentsOffered,
        searchRadiusKm: r.searchRadiusKm,
        urgency: r.urgency,
        // The headline number for whether matching is working.
        secondsToAccept:
          r.acceptedAt && r.firstOfferedAt
            ? Math.round((r.acceptedAt - r.firstOfferedAt) / 1000)
            : null,
        lastReason: r.lastReason,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        // Enough to know whether there IS a decision to inspect, without
        // shipping every breakdown in a list response.
        topScore: r.lastOffers?.[0]?.score ?? null,
      })),
      pagination: { total, limit, offset, hasMore: offset + records.length < total },
    });
  } catch (err) {
    next(err);
  }
}

// GET /monitoring/donations/:donationId - WHY this agent, in full.
export async function donationDetail(req, res, next) {
  try {
    const record = await DonationStatus.findOne({ donationId: req.params.donationId });
    if (!record) throw ApiError.notFound('no tracking record for this donation');

    res.json({
      donation: {
        donationId: record.donationId,
        title: record.title,
        category: record.category,
        quantity: record.quantity,
        pickupAddress: record.pickupAddress,
        status: record.status,
        urgency: record.urgency,
        responseTimeoutSeconds: record.responseTimeoutSeconds,

        assignedAgentId: record.assignedAgentId,
        assignedAgentName: record.assignedAgentName,

        offerRounds: record.offerRounds,
        searchRadiusKm: record.searchRadiusKm,
        candidatesFound: record.candidatesFound,
        candidatesEligible: record.candidatesEligible,

        firstOfferedAt: record.firstOfferedAt,
        acceptedAt: record.acceptedAt,
        collectedAt: record.collectedAt,
        lastReason: record.lastReason,
        traceId: record.traceId,
      },

      // The centrepiece: every candidate's score with its four weighted terms,
      // exactly as the engine computed them at decision time.
      scoring: {
        weights: {
          distance: 0.35,
          category: 0.25,
          load: 0.2,
          rating: 0.15,
          // The plan's weights sum to 0.95, so a perfect agent scores 0.95 and
          // not 1.0. Stated rather than left to be puzzled over.
          maxPossibleScore: 0.95,
        },
        offers: record.lastOffers ?? [],
      },

      timeline: record.timeline ?? [],
    });
  } catch (err) {
    next(err);
  }
}

// GET /monitoring/stats - is the automation actually working?
export async function systemStats(_req, res, next) {
  try {
    const [byStatus, matching, byCategory, problems] = await Promise.all([
      DonationStatus.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),

      DonationStatus.aggregate([
        { $match: { acceptedAt: { $ne: null }, firstOfferedAt: { $ne: null } } },
        {
          $project: {
            seconds: { $divide: [{ $subtract: ['$acceptedAt', '$firstOfferedAt'] }, 1000] },
            offerRounds: 1,
            // Matched on the first batch, with no re-offer needed. The single
            // best measure of whether the scoring is picking the right agents.
            firstRound: { $cond: [{ $lte: ['$offerRounds', 1] }, 1, 0] },
          },
        },
        {
          $group: {
            _id: null,
            matched: { $sum: 1 },
            avgSeconds: { $avg: '$seconds' },
            maxSeconds: { $max: '$seconds' },
            avgRounds: { $avg: '$offerRounds' },
            firstRoundMatches: { $sum: '$firstRound' },
          },
        },
      ]),

      DonationStatus.aggregate([
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      // Why matching failed, when it failed. Distinguishing "nobody was
      // online" from "everyone declined" is what tells you whether to recruit
      // agents or look at the scoring.
      DonationStatus.aggregate([
        { $match: { lastReason: { $ne: null } } },
        { $group: { _id: '$lastReason', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    const counts = Object.fromEntries(Object.values(STATUS).map((s) => [s, 0]));
    for (const row of byStatus) counts[row._id] = row.count;

    const m = matching[0];
    const total = byStatus.reduce((sum, r) => sum + r.count, 0);

    res.json({
      counts,
      total,
      matching: m
        ? {
            matched: m.matched,
            avgSecondsToAccept: Math.round(m.avgSeconds),
            maxSecondsToAccept: Math.round(m.maxSeconds),
            avgOfferRounds: Math.round(m.avgRounds * 100) / 100,
            firstRoundMatchRate: Math.round((m.firstRoundMatches / m.matched) * 1000) / 10,
          }
        : null,
      byCategory: byCategory.map((c) => ({ category: c._id, count: c.count })),
      failureReasons: problems.map((p) => ({ reason: p._id, count: p.count })),
    });
  } catch (err) {
    next(err);
  }
}
