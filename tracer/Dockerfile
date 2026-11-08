# Build: docker build -t ghcr.io/yingyeothon/yyt-tracer:dev --build-arg VERSION=dev tracer/
# The private `yyt-stateful` repo pulls and runs the image; this repo only builds it.
# Cross-compiles on the build platform (no QEMU): `--platform=$BUILDPLATFORM`
# keeps the Go toolchain native and `TARGETOS`/`TARGETARCH` pick the output.
# go.mod needs Go 1.26 (modernc.org/sqlite); CGO stays off (pure Go SQLite).
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
ARG VERSION=dev
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build -trimpath \
    -ldflags "-s -w -X main.version=${VERSION}" \
    -o /out/tracer ./cmd/tracer && mkdir -p /out/data

# Distroless static: no shell (so no HEALTHCHECK instruction — probe
# GET /livez from the host), non-root, CA roots present for the https calls
# to the console. Run with a read-only root and one writable volume at /data
# (a named volume starts owned by uid 65532; a host bind mount must be
# `chown 65532:65532` first), host network, TRACER_LISTEN on loopback behind
# Caddy, and the 64 MB hard limit from `--memory` (GOMEMLIMIT is only the Go
# soft limit) — docs/tracer.md _Operations_. Without TRACER_CONSOLE_URL the
# binary is in local mode and wants a tracer.json; server mode refuses to
# start until the console client lands (todo/85 P5): do not tag before that.
# `tracer dev …` is not in this build.
FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.source="https://github.com/yingyeothon/service"
COPY --from=build /out/tracer /tracer
# An empty /data owned by nonroot, so a fresh named volume starts writable.
COPY --from=build --chown=65532:65532 /out/data /data
ENV TRACER_DATA_DIR=/data \
    TRACER_LISTEN=127.0.0.1:8095 \
    GOMEMLIMIT=48MiB
VOLUME ["/data"]
USER nonroot:nonroot
ENTRYPOINT ["/tracer"]
CMD ["serve"]
