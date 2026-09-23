# Phase 12 — api-gateway and full containerization

Before this phase the browser needed to know seven service ports and the
frontend only ran via `npm run dev`. After it, **one command starts everything
and the browser knows one address.**

```bash
docker compose up -d --build     # 13 containers, including the frontend
open http://localhost:8080
bash scripts/smoke-gateway.sh    # 28 checks, every request through the gateway
```

---

## What changed

| | Before | After |
|---|---|---|
| Frontend | `npm run dev` on :5173 | nginx container on **:8080** |
| Browser talks to | 7 service ports via Vite's proxy | **one origin** |
| JWT verified | by each service | **once at the edge**, then again per service |
| Rate limiting | nowhere | at the gateway, covering every service |
| "Is it up?" | 7 separate `curl`s | **one `/ready`** |

---

## The gateway

### Verifying the token once, at the edge

This is what the JWT design in Phase 1 was building toward. The gateway
verifies the signature and forwards the decoded identity downstream as headers:

```js
proxyReq.setHeader('x-user-id', req.user.id);
proxyReq.setHeader('x-user-role', req.user.role);
```

**Every service still verifies independently.** That is deliberate — defence in
depth, and they must keep working when called directly, which every smoke suite
from Phases 1–11 still does. But the pattern is now visible: no service ever
calls auth-service to ask *"who is this?"*, because a signed token **is** the
proof. That is the difference from a session id, which would need a lookup on
every request and make auth-service a dependency of every operation in the
system.

### Rate limiting belongs here

Phase 1 deliberately left rate limiting out of auth-service, noting it belonged
at the gateway "so it covers every service, not just this one". This is that.

Two policies:

- **General**: 300 requests/minute. Generous, because a donor posting five
  photos is a legitimate burst.
- **Auth**: 20/minute, and **`skipSuccessfulRequests`** — only *failed*
  attempts count. A legitimate user logging in repeatedly is never locked out;
  someone guessing passwords is stopped after twenty tries.

### No `express.json()`, deliberately

Parsing the body would consume the request stream, and the proxy would forward
an **empty body** downstream. It is a classic and baffling gateway bug — POSTs
mysteriously arrive with nothing in them. The gateway routes and authenticates;
it never needs to read a payload, so the stream is left untouched for the proxy
to pipe.

### Route order is load-bearing

`/api/monitoring` and `/api/tracking` both live on tracking-service, and
Express matches prefixes **in order**. Registered the other way round,
`/api/tracking` would swallow every monitoring request. There is a smoke check
for exactly that.

### Optional services degrade rather than break

analytics-service only runs under the `analytics` profile, so its route may have
nothing behind it. The gateway returns **502 with an explanation** rather than
failing to start — the correct answer for a service that is not deployed.

---

## The bug the smoke test caught

The first run failed 16 of 28 checks with:

```
"no route for POST /signup"
```

**`app.use(prefix, ...)` strips the prefix before the middleware runs.** By the
time the proxy saw it, `/api/auth/signup` was already just `/signup`, so a
`pathRewrite` doing `path.replace(/^\/api\/auth/, '/auth')` matched nothing and
auth-service received `/signup`.

The fix was to stop *substituting* the public prefix and instead **prepend the
service's own base path**:

```js
pathRewrite: (path) => `${route.basePath}${path}`
```

Which is both correct and simpler — each route now declares where it lands
rather than encoding a regex that has to agree with the mount point.

Worth noting how this was found: every service had been proven directly, and
every path had been proven through Vite's proxy. Neither could catch a gateway
that mounts routes differently. **A new integration layer needs its own
integration test**, and "it worked through the other proxy" is not evidence.

---

## The frontend as a container

A two-stage build: `vite build` produces static files, and nginx serves them.

**The dev server is not a production server** — it compiles on demand, ships
source maps, and is deliberately unoptimised.

Three things in `nginx.conf` worth knowing:

**`index.html` must never be cached.** It is the file that references the
hashed asset bundles, so a stale copy points at assets that no longer exist —
the classic "users see a white page after deploy" bug. The hashed assets
themselves are cached for a year, because their names change on every build.

**SPA fallback**: `try_files $uri $uri/ /index.html`. Any unknown path is a
client-side route, so index.html is served and React decides — rather than a
404 for a page that exists.

**`/api` is proxied to the gateway**, so the browser only ever sees one origin.
No CORS to configure, no service ports for the frontend to know. In development
Vite's proxy plays exactly this role, which is why **the frontend code is
identical either way** — it always calls relative `/api/...` paths.

---

## One endpoint answers "is it up?"

```json
GET /ready
{
  "status": "ready",
  "services": {
    "auth-service": "up", "donation-service": "up", "geocoding-service": "up",
    "agent-location-service": "up", "assignment-engine": "up",
    "tracking-service": "up", "notification-service": "up"
  }
}
```

503 when anything is down, so a demo script or an orchestrator can wait on this
one endpoint instead of polling seven.

---

## Testing

**28 checks, every one through :4000 or :8080.** No service port is touched
directly — that is the point of the phase, so the test honours it.

It walks the whole journey through the gateway (signup → on shift → donate →
offer → accept → track), then checks the gateway's own concerns: token
rejection at the edge, the traceId surviving the extra hop, route precedence,
rate limiting on failed logins only, and the 502 for an undeployed optional
service.

The earlier suites still hit services directly, and that is deliberate: they
prove each service works **on its own**, which is what lets them be developed
and debugged independently.

---

## Deliberately not in this phase

- **HTTPS / TLS.** A real deployment terminates TLS at the load balancer or
  ingress in front of this gateway. Adding self-signed certs locally would
  demonstrate nothing and complicate every `curl` in the project.
- **Service discovery.** Docker's DNS resolves service names on the compose
  network, which is all this needs. Consul or Kubernetes DNS is the answer at a
  scale this is not at.
- **Circuit breaking / retries at the gateway.** Worth having in production.
  The services already degrade sensibly on their own — the outbox in Phase 2,
  the geocoding fallback in Phase 3 — so adding a breaker here would be
  machinery without a current failure mode to justify it.
- **Removing per-service JWT verification.** The gateway forwards the decoded
  identity, so services *could* trust the headers. They do not, because then a
  service would be unprotected the moment anything reached it without going
  through the gateway.
