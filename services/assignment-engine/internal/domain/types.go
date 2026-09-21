// Package domain holds the value types the scoring logic works with.
//
// It imports nothing outside the standard library, on purpose. The scoring
// package depends on this and on nothing else, so "is the algorithm correct?"
// can be answered without a broker, a database, or a network.
package domain

import "time"

// Food categories. The fixed set from docs/PLAN.md section 2.
const (
	CategoryCooked    = "COOKED_PREPARED"
	CategoryPerishRaw = "PERISHABLE_RAW"
	CategoryBakery    = "BAKERY"
	CategoryPackaged  = "PACKAGED_NON_PERISHABLE"
	CategoryBeverages = "BEVERAGES"
)

var FoodCategories = []string{
	CategoryCooked,
	CategoryPerishRaw,
	CategoryBakery,
	CategoryPackaged,
	CategoryBeverages,
}

func IsValidCategory(c string) bool {
	for _, known := range FoodCategories {
		if known == c {
			return true
		}
	}
	return false
}

// Donation is what the engine is trying to place, assembled from the
// donation.created event.
type Donation struct {
	DonationID string    `json:"donationId"`
	DonorID    string    `json:"donorId"`
	Category   string    `json:"category"`
	Lat        float64   `json:"lat"`
	Lng        float64   `json:"lng"`
	BestBefore time.Time `json:"bestBefore"`
	TraceID    string    `json:"traceId"`
}

// Capabilities mirrors what the agent declared at registration.
type Capabilities struct {
	VehicleType           string   `json:"vehicleType"`
	HasInsulatedTransport bool     `json:"hasInsulatedTransport"`
	HasRefrigeration      bool     `json:"hasRefrigeration"`
	CategoriesHandled     []string `json:"categoriesHandled"`
}

// Handles reports whether the agent accepts this category at all.
//
// This is a HARD FILTER applied before scoring, never a score penalty. An agent
// who does not carry cooked food should not be offered it however close they
// are - a low score would still let them win when they are the only candidate.
func (c Capabilities) Handles(category string) bool {
	for _, handled := range c.CategoriesHandled {
		if handled == category {
			return true
		}
	}
	return false
}

// Candidate is one agent being considered for one donation.
type Candidate struct {
	AgentID      string       `json:"agentId"`
	Name         string       `json:"name"`
	Phone        string       `json:"phone"`
	Lat          float64      `json:"lat"`
	Lng          float64      `json:"lng"`
	DistanceKm   float64      `json:"distanceKm"`
	Capabilities Capabilities `json:"capabilities"`
	Rating       float64      `json:"rating"`
	CurrentLoad  int          `json:"currentLoad"`
	Available    bool         `json:"available"`
}
