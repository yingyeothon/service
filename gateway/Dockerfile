# Build: docker build -t ghcr.io/yingyeothon/yyt-gateway:dev --build-arg VERSION=dev gateway/
# The private `yyt-stateful` repo pulls and runs the image; this repo only builds it.
# Cross-compiles on the build platform (no QEMU): `--platform=$BUILDPLATFORM`
# keeps the Go toolchain native and `TARGETOS`/`TARGETARCH` pick the output.
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS build
ARG VERSION=dev
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build -trimpath \
    -ldflags "-s -w -X github.com/yingyeothon/service/gateway/internal/server.Version=${VERSION}" \
    -o /out/gateway ./cmd/gateway

# Distroless static: no shell (so no HEALTHCHECK instruction — probe
# GET /livez from the host), non-root, CA roots present for the https calls
# to console and auth.
FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.source="https://github.com/yingyeothon/service"
COPY --from=build /out/gateway /gateway
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/gateway"]
