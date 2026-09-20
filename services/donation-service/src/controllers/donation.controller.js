import { Donation } from '../models/Donation.js';
import { ApiError } from '../utils/ApiError.js';
import { publishDonationCreated } from '../events/donationEvents.js';
import { geocodeAddress } from '../clients/geocodingClient.js';

// Turns multer's file objects into the subdocuments stored on the donation.
const toImageDocs = (files = []) =>
  files.map((file) => ({
    filename: file.filename,
    url: `/uploads/${file.filename}`,
    mimeType: file.mimetype,
    sizeBytes: file.size,
  }));

export async function createDonation(req, res, next) {
  try {
    const {
      title, description, category,
      quantityAmount, quantityUnit,
      pickupAddress, lat, lng, bestBefore,
    } = req.body;

    // The map picker supplies coordinates directly, which is both the most
    // accurate source and free. This fallback covers the cases it cannot: a
    // typed address, an API client, or a browser that denied geolocation.
    let coordinates = lat !== undefined && lng !== undefined ? { lat, lng } : null;
    let geocoded = null;

    if (!coordinates) {
      geocoded = await geocodeAddress(
        pickupAddress,
        { authorization: req.get('authorization'), traceId: req.traceId },
        req.log,
      );
      if (geocoded) {
        coordinates = { lat: geocoded.lat, lng: geocoded.lng };
        req.log.info(
          { confidence: geocoded.confidence, cached: geocoded.cached },
          'pickup address geocoded',
        );
      }
    }

    const hasCoordinates = coordinates !== null;

    const donation = await Donation.create({
      donorId: req.user.id,
      // Denormalised from the token rather than joined from the users
      // collection: that collection belongs to auth-service and lives in a
      // different database. An agent needs a name and number to call on
      // arrival, and copying them here means collecting a donation never
      // depends on auth-service being up.
      donorName: req.user.name,
      donorPhone: req.user.phone,

      title,
      description,
      category,
      quantity: { amount: quantityAmount, unit: quantityUnit },
      pickupAddress,
      // GeoJSON order is [longitude, latitude] - the reverse of how people say
      // it. Getting this backwards silently puts Bengaluru in the Indian Ocean.
      ...(hasCoordinates
        ? { location: { type: 'Point', coordinates: [coordinates.lng, coordinates.lat] } }
        : {}),
      images: toImageDocs(req.files),
      bestBefore,
      status: 'PENDING_ASSIGNMENT',
      traceId: req.traceId,
      // Saved as unpublished FIRST. See events/outbox.js for why the order
      // of these two writes is the whole ballgame.
      eventPublished: false,
    });

    req.log.info(
      {
        donationId: donation.id,
        category,
        hasCoordinates,
        geocoded: geocoded !== null,
        images: donation.images.length,
      },
      'donation created',
    );

    // The donation is already durable at this point, so a Kafka failure is
    // logged and retried by the sweeper - never turned into an error for the
    // donor, who did nothing wrong and would otherwise be asked to re-submit
    // food that is already recorded.
    const published = await publishDonationCreated(donation, req.log);
    if (published) {
      donation.eventPublished = true;
      donation.eventPublishAttempts = 1;
      await donation.save();
    }

    res.status(201).json({
      donation: donation.toJSON(),
      // Honest signalling rather than a silent partial success: the client can
      // show "submitted, finding an agent" versus "submitted, queued".
      assignmentQueued: published,
      // Surfaced so a donor can see that a vague address resolved roughly, and
      // correct it on the map before an agent is sent to the wrong end of a
      // long road.
      ...(geocoded
        ? { geocoding: { derivedFromAddress: true, confidence: geocoded.confidence, formatted: geocoded.formatted } }
        : {}),
      ...(hasCoordinates
        ? {}
        : {
            notice:
              'the pickup address could not be geocoded - this donation cannot be matched to an agent until it has coordinates',
          }),
    });
  } catch (err) {
    // Uploaded files are cleaned up centrally in errorHandler, which catches
    // this path AND the validation failures that never reach this controller.
    next(err);
  }
}

export async function listDonations(req, res, next) {
  try {
    const { status, category, limit, offset } = req.validatedQuery;

    const filter = {};
    if (status) filter.status = status;
    if (category) filter.category = category;

    // Authorization by role, applied at the query level rather than by
    // filtering results afterwards - a donor's query can never even reach
    // another donor's rows.
    //
    // Donors see only their own donations. Agents see all of them, because
    // browsing what is available is their job.
    if (req.user.role === 'DONOR') {
      filter.donorId = req.user.id;
    }

    const [donations, total] = await Promise.all([
      Donation.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit),
      Donation.countDocuments(filter),
    ]);

    res.json({
      donations: donations.map((d) => d.toJSON()),
      pagination: { total, limit, offset, hasMore: offset + donations.length < total },
    });
  } catch (err) {
    next(err);
  }
}

export async function getDonation(req, res, next) {
  try {
    const donation = await Donation.findById(req.params.id).catch(() => null);

    if (!donation) {
      throw ApiError.notFound('donation not found');
    }

    // Same 404 rather than a 403 for someone else's donation: a 403 would
    // confirm the id exists, letting anyone probe for valid donation ids.
    if (req.user.role === 'DONOR' && donation.donorId !== req.user.id) {
      throw ApiError.notFound('donation not found');
    }

    res.json({ donation: donation.toJSON() });
  } catch (err) {
    next(err);
  }
}
