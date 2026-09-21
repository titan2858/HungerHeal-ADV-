package httpx

import (
	"encoding/json"
	"net/http"

	"hungerheal/assignment-engine/internal/logging"
)

// The error body is byte-identical in shape to what the Node services return,
// so a client parses one format across the whole system:
//   { "error": { "code", "message", "details?", "traceId" } }

type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details []any  `json:"details,omitempty"`
	TraceID string `json:"traceId,omitempty"`
}

func JSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if payload != nil {
		_ = json.NewEncoder(w).Encode(payload)
	}
}

func Error(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	JSON(w, status, map[string]ErrorBody{
		"error": {
			Code:    code,
			Message: message,
			// Returned so a user can report a failure and have it found in the
			// logs immediately.
			TraceID: logging.TraceFrom(r.Context()),
		},
	})
}

func BadRequest(w http.ResponseWriter, r *http.Request, message string) {
	Error(w, r, http.StatusBadRequest, "BAD_REQUEST", message)
}

func Unauthorized(w http.ResponseWriter, r *http.Request, message string) {
	Error(w, r, http.StatusUnauthorized, "UNAUTHORIZED", message)
}

func Forbidden(w http.ResponseWriter, r *http.Request, message string) {
	Error(w, r, http.StatusForbidden, "FORBIDDEN", message)
}

func NotFound(w http.ResponseWriter, r *http.Request, message string) {
	Error(w, r, http.StatusNotFound, "NOT_FOUND", message)
}

func Internal(w http.ResponseWriter, r *http.Request) {
	Error(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "something went wrong")
}
