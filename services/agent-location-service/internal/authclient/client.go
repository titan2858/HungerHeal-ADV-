package authclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"hungerheal/agent-location-service/internal/domain"
)

// Fetches an agent's registration data from auth-service.
//
// Why this exists: capabilities are declared at signup and live in
// auth-service's MongoDB, but assignment-engine needs them in Redis on the
// matching hot path. Rather than adding a new endpoint, this reuses the
// existing GET /auth/me, forwarding the AGENT'S OWN token - so this service
// never holds a privileged machine credential that could read anyone's record.
//
// It is called once per agent, on their first location report, and the result
// is cached in Redis indefinitely. Capabilities are not presence: an agent who
// goes offline for a week has not stopped owning an insulated box.

type Client struct {
	baseURL string
	http    *http.Client
}

func New(baseURL string, timeout time.Duration) *Client {
	return &Client{
		baseURL: baseURL,
		// A timeout is not optional on a cross-service call. Without one, an
		// unresponsive auth-service would hold this service's goroutines open
		// until the OS gave up, which can be minutes.
		http: &http.Client{Timeout: timeout},
	}
}

type meResponse struct {
	User struct {
		ID           string  `json:"id"`
		Name         string  `json:"name"`
		Phone        string  `json:"phone"`
		Role         string  `json:"role"`
		Rating       float64 `json:"rating"`
		Capabilities struct {
			VehicleType           string   `json:"vehicleType"`
			HasInsulatedTransport bool     `json:"hasInsulatedTransport"`
			HasRefrigeration      bool     `json:"hasRefrigeration"`
			CategoriesHandled     []string `json:"categoriesHandled"`
		} `json:"capabilities"`
	} `json:"user"`
}

// FetchAgent retrieves the caller's own profile using their bearer token.
func (c *Client) FetchAgent(ctx context.Context, bearerToken, traceID string) (*domain.Agent, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/auth/me", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", bearerToken)
	// Keeps the lookup on the same trace as the location report that triggered it.
	req.Header.Set("x-trace-id", traceID)

	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("auth-service unreachable: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("auth-service returned %d", res.StatusCode)
	}

	var body meResponse
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("could not decode auth-service response: %w", err)
	}

	if body.User.Role != "AGENT" {
		return nil, fmt.Errorf("user %s is not an agent", body.User.ID)
	}

	return &domain.Agent{
		AgentID: body.User.ID,
		Name:    body.User.Name,
		Phone:   body.User.Phone,
		Rating:  body.User.Rating,
		// Whether they are accepting work is this service's concern, and
		// defaults to yes.
		Available: true,
		Capabilities: domain.Capabilities{
			VehicleType:           body.User.Capabilities.VehicleType,
			HasInsulatedTransport: body.User.Capabilities.HasInsulatedTransport,
			HasRefrigeration:      body.User.Capabilities.HasRefrigeration,
			CategoriesHandled:     body.User.Capabilities.CategoriesHandled,
		},
	}, nil
}
