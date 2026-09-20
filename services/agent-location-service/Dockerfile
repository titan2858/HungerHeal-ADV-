# Multi-stage build. The Go toolchain is ~800MB; the binary it produces is a
# few MB. Only the binary needs to ship.
FROM golang:1.26-alpine AS build

WORKDIR /src

# Dependencies as their own layer, keyed on the manifests, so editing source
# does not re-download modules on every rebuild.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO_ENABLED=0 produces a statically linked binary with no libc dependency,
# which is what makes the scratch/alpine final stage possible at all.
# -ldflags="-s -w" strips the symbol table and DWARF data - a smaller image,
# and nothing in production reads them.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/server ./cmd/server

# ---------------------------------------------------------------- runtime
FROM alpine:3.20

# wget for the healthcheck; ca-certificates so the outbound HTTPS call to
# auth-service works if it is ever fronted by TLS.
RUN apk add --no-cache ca-certificates wget && adduser -D -u 10001 app

COPY --from=build /out/server /usr/local/bin/server

USER app
EXPOSE 4004

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:4004/health || exit 1

ENTRYPOINT ["/usr/local/bin/server"]
