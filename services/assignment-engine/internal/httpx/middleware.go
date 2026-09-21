package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"hungerheal/assignment-engine/internal/logging"
)

type ctxKey string

const userKey ctxKey = "user"

// User is the caller, taken from the verified token. No database lookup is
// involved: the token is signed by auth-service, so its contents are
// trustworthy on their own. That is what lets this service keep working when
// auth-service is down.
type User struct {
	ID    string
	Role  string
	Email string
	Name  string
	Phone string
}

func UserFrom(ctx context.Context) (User, bool) {
	u, ok := ctx.Value(userKey).(User)
	return u, ok
}

// Trace gives every request a traceId, reusing an incoming x-trace-id rather
// than replacing it. That reuse is what makes one donation followable across
// all services - including from a Node service into this Go one.
func Trace(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			traceID := r.Header.Get("x-trace-id")
			if traceID == "" {
				traceID = newTraceID()
			}

			w.Header().Set("x-trace-id", traceID)
			ctx := logging.WithTrace(r.Context(), traceID)

			started := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

			next.ServeHTTP(rec, r.WithContext(ctx))

			logger.With("traceId", traceID).Info("request completed",
				"method", r.Method,
				"path", r.URL.Path,
				"status", rec.status,
				"durationMs", float64(time.Since(started).Microseconds())/1000,
			)
		})
	}
}

// Recover turns a panic into a 500 instead of killing the whole process.
// Go's default behaviour on an unrecovered panic in a handler goroutine is to
// crash the server - one malformed request would take down every agent's
// location reporting at once.
func Recover(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					logging.FromContext(r.Context(), logger).Error("panic recovered",
						"panic", rec, "path", r.URL.Path)
					Internal(w, r)
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// RequireAuth verifies the bearer token against the shared secret.
func RequireAuth(secret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			parts := strings.SplitN(header, " ", 2)
			if len(parts) != 2 || parts[0] != "Bearer" {
				Unauthorized(w, r, "missing Bearer token")
				return
			}

			claims := jwt.MapClaims{}
			token, err := jwt.ParseWithClaims(parts[1], claims, func(t *jwt.Token) (any, error) {
				// Pinning the algorithm is essential. Without this check an
				// attacker can present a token signed with "none", or an RS256
				// token verified against the public key as an HMAC secret, and
				// have it accepted.
				if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
					return nil, jwt.ErrSignatureInvalid
				}
				return []byte(secret), nil
			}, jwt.WithIssuer("hungerheal-auth"), jwt.WithValidMethods([]string{"HS256"}))

			if err != nil || !token.Valid {
				Unauthorized(w, r, "invalid or expired token")
				return
			}

			user := User{
				ID:    str(claims["sub"]),
				Role:  str(claims["role"]),
				Email: str(claims["email"]),
				Name:  str(claims["name"]),
				Phone: str(claims["phone"]),
			}

			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, user)))
		})
	}
}

// RequireRole guards endpoints that only make sense for one role - only an
// agent can report an agent's location.
func RequireRole(roles ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, ok := UserFrom(r.Context())
			if !ok {
				Unauthorized(w, r, "authentication required")
				return
			}
			for _, role := range roles {
				if user.Role == role {
					next.ServeHTTP(w, r)
					return
				}
			}
			Forbidden(w, r, "requires role: "+strings.Join(roles, " or "))
		})
	}
}

// Chain applies middleware in the order given, so Chain(a, b)(h) runs a, then
// b, then h.
func Chain(middleware ...func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(final http.Handler) http.Handler {
		for i := len(middleware) - 1; i >= 0; i-- {
			final = middleware[i](final)
		}
		return final
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func newTraceID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
