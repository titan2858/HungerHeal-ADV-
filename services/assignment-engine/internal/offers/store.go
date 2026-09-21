// Package offers holds the live state of an offer: who it went to, who has
// declined, when it expires, and who finally claimed it.
//
// All four of Phase 6's mechanisms live here, and three of them are the same
// Redis primitive - SETNX - used for different purposes:
//
//	dedup        SETNX processed:<eventId>      "have I already handled this?"
//	claim lock   SETNX donation:<id>:claimed    "did anyone else accept first?"
//	declined     SADD  donation:<id>:declined   "who should I not re-offer this to?"
//	deadlines    ZADD  offers:deadlines         "which offers have run out of time?"
package offers

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	dedupFmt    = "processed:%s"
	claimFmt    = "donation:%s:claimed"
	declinedFmt = "donation:%s:declined"
	stateFmt    = "donation:%s:offer"

	// A sorted set of donationId -> deadline-as-unix-seconds.
	//
	// WHY NOT REDIS KEY EXPIRY + KEYSPACE NOTIFICATIONS? That is the obvious
	// alternative: set a key with a 90s TTL and react when Redis announces it
	// died. It is the wrong tool here because keyspace notifications are
	// fire-and-forget - they are only delivered to subscribers connected at the
	// moment of expiry. Restart this service during a deploy and every pending
	// deadline in that window is silently lost, with the donations stuck
	// forever and nothing in the logs to say why.
	//
	// A sorted set is durable state instead of a notification. The watcher asks
	// "what is overdue right now?" on every tick, so a restart loses nothing -
	// it simply finds the overdue offers on its next pass.
	DeadlinesKey = "offers:deadlines"
)

// ErrAlreadyClaimed is returned when a second agent tries to accept.
var ErrAlreadyClaimed = errors.New("donation already claimed by another agent")

type Store struct {
	rdb      *redis.Client
	dedupTTL time.Duration
}

func New(rdb *redis.Client, dedupTTL time.Duration) *Store {
	return &Store{rdb: rdb, dedupTTL: dedupTTL}
}

// ---------------------------------------------------------------- dedup

// BeginProcessing claims an event for processing. It returns false when this
// event has already been handled and should be skipped.
//
// This is the fix for Kafka's at-least-once delivery. A consumer that crashes
// after doing its work but before committing its offset sees the same message
// again on restart; without this the engine would score a donation twice and
// publish two donation.assigned events, so six agents get notified for one meal
// and two of them drive to the same door.
//
// SETNX is atomic, which is what makes it safe even when two engine instances
// receive the same redelivery simultaneously: exactly one gets true.
func (s *Store) BeginProcessing(ctx context.Context, eventID string) (bool, error) {
	if eventID == "" {
		// No id to deduplicate on. Processing it is the lesser evil: skipping
		// would silently drop a real donation.
		return true, nil
	}
	return s.rdb.SetNX(ctx, fmt.Sprintf(dedupFmt, eventID), "1", s.dedupTTL).Result()
}

// AbandonProcessing releases the dedup key after a FAILED attempt.
//
// Without this, the ordering is a trap: BeginProcessing marks the event handled
// BEFORE the work runs, so if the work then fails (Redis blipped, Kafka refused
// the publish) the message is redelivered - and skipped, because the marker is
// still there. The donation would be lost precisely when the system was already
// having a bad day. Releasing on failure makes the retry actually retry.
func (s *Store) AbandonProcessing(ctx context.Context, eventID string) error {
	if eventID == "" {
		return nil
	}
	return s.rdb.Del(ctx, fmt.Sprintf(dedupFmt, eventID)).Err()
}

// ------------------------------------------------------------ offer state

// State is what the engine needs to re-score a donation after a timeout,
// without going back to donation-service for it.
type State struct {
	DonationID string
	DonorID    string
	Category   string
	Address    string
	Lat        float64
	Lng        float64
	TraceID    string

	// Which round of offers this is. 1 is the first batch; it increments on
	// every timeout-driven re-score.
	Round int

	// The radius that produced the current batch, so the next round can start
	// from there rather than beginning again at 5km.
	RadiusKm float64

	OfferedTo []string
	ExpiresAt time.Time
}

// SaveState records an offer batch and arms its deadline.
func (s *Store) SaveState(ctx context.Context, st State, ttl time.Duration) error {
	pipe := s.rdb.TxPipeline()

	pipe.HSet(ctx, fmt.Sprintf(stateFmt, st.DonationID), map[string]any{
		"donorId":   st.DonorID,
		"category":  st.Category,
		"address":   st.Address,
		"lat":       strconv.FormatFloat(st.Lat, 'f', -1, 64),
		"lng":       strconv.FormatFloat(st.Lng, 'f', -1, 64),
		"traceId":   st.TraceID,
		"round":     st.Round,
		"radiusKm":  strconv.FormatFloat(st.RadiusKm, 'f', -1, 64),
		"offeredTo": joinIDs(st.OfferedTo),
		"expiresAt": st.ExpiresAt.Unix(),
	})

	// Kept well beyond the offer deadline so a late accept can still be given a
	// meaningful answer rather than a bare 404.
	pipe.Expire(ctx, fmt.Sprintf(stateFmt, st.DonationID), ttl)

	// Arm the deadline. ZADD overwrites an existing member's score, so a
	// re-offer replaces the old deadline instead of leaving a stale one behind.
	pipe.ZAdd(ctx, DeadlinesKey, redis.Z{
		Score:  float64(st.ExpiresAt.Unix()),
		Member: st.DonationID,
	})

	_, err := pipe.Exec(ctx)
	return err
}

func (s *Store) GetState(ctx context.Context, donationID string) (*State, error) {
	h, err := s.rdb.HGetAll(ctx, fmt.Sprintf(stateFmt, donationID)).Result()
	if err != nil {
		return nil, err
	}
	if len(h) == 0 {
		return nil, nil
	}

	lat, _ := strconv.ParseFloat(h["lat"], 64)
	lng, _ := strconv.ParseFloat(h["lng"], 64)
	radius, _ := strconv.ParseFloat(h["radiusKm"], 64)
	round, _ := strconv.Atoi(h["round"])
	expires, _ := strconv.ParseInt(h["expiresAt"], 10, 64)

	return &State{
		DonationID: donationID,
		DonorID:    h["donorId"],
		Category:   h["category"],
		Address:    h["address"],
		Lat:        lat,
		Lng:        lng,
		TraceID:    h["traceId"],
		Round:      round,
		RadiusKm:   radius,
		OfferedTo:  splitIDs(h["offeredTo"]),
		ExpiresAt:  time.Unix(expires, 0).UTC(),
	}, nil
}

// ------------------------------------------------------------ claim lock

// Claim is the race arbiter: the first agent to call it wins the donation, and
// everyone else gets ErrAlreadyClaimed.
//
// The plan requires notifying the top 3 IN PARALLEL - offering them one at a
// time would mean 4.5 minutes of 90-second waits for a meal that is going cold.
// Parallel offers create a race: three phones buzz at once and two agents can
// tap Accept in the same second. Without a lock they both drive to the same
// address, one wastes a trip, and both stop using the app.
//
// SETNX settles it. Redis executes commands one at a time, so there is no
// window in which two callers can both create the key - exactly one gets true,
// and it does not matter how close together the taps were.
func (s *Store) Claim(ctx context.Context, donationID, agentID string, ttl time.Duration) error {
	won, err := s.rdb.SetNX(ctx, fmt.Sprintf(claimFmt, donationID), agentID, ttl).Result()
	if err != nil {
		return err
	}
	if !won {
		return ErrAlreadyClaimed
	}

	// Claimed, so the deadline no longer applies. Removing it here rather than
	// leaving it to expire stops the watcher from re-offering a donation that
	// someone is already driving to collect.
	return s.rdb.ZRem(ctx, DeadlinesKey, donationID).Err()
}

// ClaimedBy returns which agent holds the donation, or "" if nobody does.
func (s *Store) ClaimedBy(ctx context.Context, donationID string) (string, error) {
	v, err := s.rdb.Get(ctx, fmt.Sprintf(claimFmt, donationID)).Result()
	if err == redis.Nil {
		return "", nil
	}
	return v, err
}

// ------------------------------------------------------------- declines

// Decline records that an agent will not take this donation - either they said
// no explicitly, or their offer timed out.
//
// This is what stops the re-score loop from being pointless. Nothing about the
// top 3 changes between rounds, so without an exclusion set a timeout would
// re-score, find the identical top 3, and offer it straight back to the same
// agents who just ignored it. The donation would bounce between them until it
// expired.
func (s *Store) Decline(ctx context.Context, donationID string, agentIDs ...string) error {
	if len(agentIDs) == 0 {
		return nil
	}

	members := make([]any, len(agentIDs))
	for i, id := range agentIDs {
		members[i] = id
	}

	pipe := s.rdb.TxPipeline()
	pipe.SAdd(ctx, fmt.Sprintf(declinedFmt, donationID), members...)
	// Outlives the offer rounds but not forever.
	pipe.Expire(ctx, fmt.Sprintf(declinedFmt, donationID), 24*time.Hour)
	_, err := pipe.Exec(ctx)
	return err
}

// Declined returns the exclusion set, in the shape scoring.RankAgents expects.
func (s *Store) Declined(ctx context.Context, donationID string) (map[string]bool, error) {
	ids, err := s.rdb.SMembers(ctx, fmt.Sprintf(declinedFmt, donationID)).Result()
	if err != nil {
		return nil, err
	}

	out := make(map[string]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out, nil
}

// PendingResponses reports how many of the current batch have not answered yet.
// When it reaches zero the engine can re-score immediately instead of waiting
// out a deadline nobody is going to meet.
func (s *Store) PendingResponses(ctx context.Context, donationID string, offeredTo []string) (int, error) {
	declined, err := s.Declined(ctx, donationID)
	if err != nil {
		return 0, err
	}

	pending := 0
	for _, id := range offeredTo {
		if !declined[id] {
			pending++
		}
	}
	return pending, nil
}

// ------------------------------------------------------------- deadlines

// DueNow returns the donations whose response window has closed.
//
// A poll rather than a subscription, for the reason given on DeadlinesKey: this
// is durable state, so a restart loses nothing.
func (s *Store) DueNow(ctx context.Context, now time.Time, limit int64) ([]string, error) {
	return s.rdb.ZRangeByScore(ctx, DeadlinesKey, &redis.ZRangeBy{
		Min:   "-inf",
		Max:   strconv.FormatInt(now.Unix(), 10),
		Count: limit,
	}).Result()
}

// ClearDeadline removes a donation from the deadline set.
//
// Called BEFORE publishing donation.timeout. If it were called after, a crash
// in between would leave the deadline armed and the same timeout would fire
// again on the next tick, re-offering a donation that was already moving on.
func (s *Store) ClearDeadline(ctx context.Context, donationID string) error {
	return s.rdb.ZRem(ctx, DeadlinesKey, donationID).Err()
}

// TakeDeadline atomically removes a donation from the deadline set and reports
// whether THIS caller was the one that removed it.
//
// The return value is what makes multiple engine instances safe: all of them
// poll the same sorted set and will all see the same overdue donation, but ZREM
// returns 1 only for the one that actually removed it. The others get 0 and do
// nothing, so one timeout produces exactly one donation.timeout event.
func (s *Store) TakeDeadline(ctx context.Context, donationID string) (bool, error) {
	removed, err := s.rdb.ZRem(ctx, DeadlinesKey, donationID).Result()
	return removed > 0, err
}

// ---------------------------------------------------------------- load

// IncrementAgentLoad bumps the counter that feeds the 0.20 load term of the
// scoring formula, on the key agent-location-service owns.
//
// Done here because accepting is the moment the workload actually changes, and
// the counter has to move before the next donation is scored - otherwise an
// agent who just accepted still looks idle and immediately wins another.
func (s *Store) IncrementAgentLoad(ctx context.Context, agentID string) (int64, error) {
	return s.rdb.Incr(ctx, fmt.Sprintf("agent:%s:load", agentID)).Result()
}

// --------------------------------------------------------------- helpers

func joinIDs(ids []string) string {
	out := ""
	for i, id := range ids {
		if i > 0 {
			out += ","
		}
		out += id
	}
	return out
}

func splitIDs(raw string) []string {
	if raw == "" {
		return nil
	}
	out := []string{}
	start := 0
	for i := 0; i <= len(raw); i++ {
		if i == len(raw) || raw[i] == ',' {
			if i > start {
				out = append(out, raw[start:i])
			}
			start = i + 1
		}
	}
	return out
}
