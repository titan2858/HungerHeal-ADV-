package domain

import "time"

// FoodCategories is the fixed set the whole system is built against
// (docs/PLAN.md section 2). Each service keeps its own copy: a little
// duplication in exchange for independent deployability.
var FoodCategories = []string{
	"COOKED_PREPARED",
	"PERISHABLE_RAW",
	"BAKERY",
	"PACKAGED_NON_PERISHABLE",
	"BEVERAGES",
}

var VehicleTypes = []string{"BICYCLE", "MOTORCYCLE", "CAR", "VAN"}

func IsValidCategory(c string) bool {
	for _, known := range FoodCategories {
		if known == c {
			return true
		}
	}
	return false
}

// Capabilities is what an agent can physically carry. Declared at registration
// in auth-service (Phase 1) and mirrored here into Redis, because
// assignment-engine reads it for every candidate agent on every scoring pass
// and a MongoDB round trip per candidate would dominate matching latency.
type Capabilities struct {
	VehicleType           string   `json:"vehicleType"`
	HasInsulatedTransport bool     `json:"hasInsulatedTransport"`
	HasRefrigeration      bool     `json:"hasRefrigeration"`
	CategoriesHandled     []string `json:"categoriesHandled"`
}

// Handles reports whether this agent accepts the given food category at all.
// This is a hard filter applied before scoring - an agent who does not carry
// cooked food should never be offered it, however close they are.
func (c Capabilities) Handles(category string) bool {
	for _, handled := range c.CategoriesHandled {
		if handled == category {
			return true
		}
	}
	return false
}

// Agent is the full live picture of one collection agent, assembled from the
// three Redis structures that hold it: the geo set, the capability hash, and
// the load counter.
type Agent struct {
	AgentID string `json:"agentId"`
	Name    string `json:"name"`
	Phone   string `json:"phone"`

	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`

	Capabilities Capabilities `json:"capabilities"`

	// Historical reliability, carried from auth-service. Feeds the 0.15-weight
	// term of the scoring formula.
	Rating float64 `json:"rating"`

	// Pending pickups this agent has accepted but not yet collected. Feeds the
	// 0.20-weight load term, and is the reason donations spread across agents
	// instead of stacking onto whoever happens to be nearest.
	CurrentLoad int `json:"currentLoad"`

	// Whether the agent is accepting work at all. Distinct from being online.
	Available bool `json:"available"`

	LastSeen time.Time `json:"lastSeen"`
}

// NearbyAgent is an Agent plus how far away it is from the donation.
type NearbyAgent struct {
	Agent
	DistanceKm float64 `json:"distanceKm"`
}
