FROM golang:1.26-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/engine ./cmd/engine

FROM alpine:3.20

RUN apk add --no-cache ca-certificates wget && adduser -D -u 10001 app

COPY --from=build /out/engine /usr/local/bin/engine

USER app
EXPOSE 4005

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=15s \
  CMD wget -q -O /dev/null http://127.0.0.1:4005/health || exit 1

ENTRYPOINT ["/usr/local/bin/engine"]
