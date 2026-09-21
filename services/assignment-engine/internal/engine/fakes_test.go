package engine

import (
	"context"
	"sync"
	"time"

	"hungerheal/assignment-engine/internal/offers"
)

// An in-memory OfferStore. It implements the real semantics that matter - SETNX
// wins exactly once, declines accumulate - so the claim race and the re-score
// loop can be tested without Redis. The Redis implementation has its own tests
// against a real server.
type fakeOfferStore struct {
	mu        sync.Mutex
	states    map[string]offers.State
	claims    map[string]string
	declines  map[string]map[string]bool
	deadlines map[string]time.Time
	loads     map[string]int64

	saveErr  error
	claimErr error
}

func newFakeOfferStore() *fakeOfferStore {
	return &fakeOfferStore{
		states:    map[string]offers.State{},
		claims:    map[string]string{},
		declines:  map[string]map[string]bool{},
		deadlines: map[string]time.Time{},
		loads:     map[string]int64{},
	}
}

func (f *fakeOfferStore) SaveState(_ context.Context, st offers.State, _ time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.saveErr != nil {
		return f.saveErr
	}
	f.states[st.DonationID] = st
	f.deadlines[st.DonationID] = st.ExpiresAt
	return nil
}

func (f *fakeOfferStore) GetState(_ context.Context, donationID string) (*offers.State, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	st, ok := f.states[donationID]
	if !ok {
		return nil, nil
	}
	copied := st
	return &copied, nil
}

// The whole point of the fake: like SETNX, exactly one caller wins.
func (f *fakeOfferStore) Claim(_ context.Context, donationID, agentID string, _ time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.claimErr != nil {
		return f.claimErr
	}
	if _, taken := f.claims[donationID]; taken {
		return offers.ErrAlreadyClaimed
	}
	f.claims[donationID] = agentID
	delete(f.deadlines, donationID)
	return nil
}

func (f *fakeOfferStore) ClaimedBy(_ context.Context, donationID string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.claims[donationID], nil
}

func (f *fakeOfferStore) Decline(_ context.Context, donationID string, agentIDs ...string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.declines[donationID] == nil {
		f.declines[donationID] = map[string]bool{}
	}
	for _, id := range agentIDs {
		f.declines[donationID][id] = true
	}
	return nil
}

func (f *fakeOfferStore) Declined(_ context.Context, donationID string) (map[string]bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]bool{}
	for id := range f.declines[donationID] {
		out[id] = true
	}
	return out, nil
}

func (f *fakeOfferStore) PendingResponses(_ context.Context, donationID string, offeredTo []string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	pending := 0
	for _, id := range offeredTo {
		if !f.declines[donationID][id] {
			pending++
		}
	}
	return pending, nil
}

func (f *fakeOfferStore) ClearDeadline(_ context.Context, donationID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.deadlines, donationID)
	return nil
}

func (f *fakeOfferStore) IncrementAgentLoad(_ context.Context, agentID string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loads[agentID]++
	return f.loads[agentID], nil
}

// --- the extra methods the watcher needs ---

func (f *fakeOfferStore) DueNow(_ context.Context, now time.Time, _ int64) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var due []string
	for id, at := range f.deadlines {
		if !at.After(now) {
			due = append(due, id)
		}
	}
	return due, nil
}

func (f *fakeOfferStore) TakeDeadline(_ context.Context, donationID string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.deadlines[donationID]; !ok {
		return false, nil
	}
	delete(f.deadlines, donationID)
	return true, nil
}
