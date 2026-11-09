# tracer

Debug-data collector for debug builds (`docs/decisions.md` _Debug collector (`tracer`)_, design in `docs/tracer.md`). Third Go module of this repository; shares nothing with `cli/` or `gateway/`. Progress: `todo/85` (machine-local).

Status: dev and prod live (`tracer/v0.2.0`, 2026-11-09, at `trace-dev.yyt.life` / `trace.yyt.life`; `trr_` read tickets and `/v1/` CORS let the console SPA read; local and server mode complete, `yyt tracer` and the `tracer-debug` skill in `skill/`). `tracer serve` reads `TRACER_*` environment variables, opens SQLite with the design schema, answers `GET /livez`, `GET /healthz`, `GET /metrics`, ingests `POST /api/{trc_id}/envelope/` / `/store/` (gzip/deflate, size and item caps, in-flight limits, daily quota stages, stage cap and disk/inode lines, attachments as blob files, one writer goroutine), serves the read API `GET /v1/{trc_id}/…` (local `readToken`, or a `yyt_` token or `trr_` console read ticket through console `POST /tr/authz` in server mode; CORS for `TRACER_READ_ORIGINS` only), serves `GET /tr/usage` to the console (server mode, `tracer-token` bearer), and runs retention (30 days, stage cap, orphan files, WAL checkpoints, and in server mode the purge of resources the console deleted). Image: `docker build -t yyt-tracer:dev tracer/` (distroless, nonroot, `/data` volume, `TRACER_LISTEN=127.0.0.1:8095`, `GOMEMLIMIT=48MiB`); release by pushing a `tracer/vX.Y.Z` tag (`.github/workflows/tracer-release.yml`). `go build -tags dev` adds `tracer dev seed`. Server mode (`TRACER_CONSOLE_URL` + `TRACER_TOKEN`) takes resource config and read authz from the console's `/tr/*` routes (`internal/console`); run it locally against `dev` with `TRACER_STAGE=dev TRACER_CONSOLE_URL=https://console-dev.yyt.life TRACER_TOKEN_FILE=local/deploy/tracer-token.dev TRACER_LISTEN=127.0.0.1:<port> TRACER_DATA_DIR=$(mktemp -d)`.

## Configuration

| Variable                 | Default                        | Notes                                                                                                                                                                                |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TRACER_CONSOLE_URL`     | —                              | set = server mode; unset = local mode                                                                                                                                                |
| `TRACER_STAGE`           | `local` in local mode          | `dev`/`prod` in server mode (required)                                                                                                                                               |
| `TRACER_TOKEN` / `_FILE` | —                              | SSM `tracer-token`, ≥ 32 chars, server mode only; unlocks `/metrics` detail                                                                                                          |
| `TRACER_LISTEN`          | `127.0.0.1:8095`               | loopback IP literal in both modes (Caddy fronts the host); wildcard refused                                                                                                          |
| `TRACER_DATA_DIR`        | `tracer-data` in local mode    | `tracer.db` + `blobs/`; required in server mode                                                                                                                                      |
| `TRACER_STAGE_BYTES`     | dev 536870912, prod 1610612736 | DB + WAL + blobs cap                                                                                                                                                                 |
| `TRACER_DISK_MAX_PCT`    | 70                             | root volume usage that refuses ingest                                                                                                                                                |
| `TRACER_LOG_LEVEL`       | `info`                         | debug, info, warn, error                                                                                                                                                             |
| `TRACER_LOCAL_CONFIG`    | `tracer.json` in local mode    | local mode only (`tracer.example.json`)                                                                                                                                              |
| `TRACER_DUMP_DIR`        | —                              | local mode only: each accepted request's raw body + scrubbed headers, for capture                                                                                                    |
| `TRACER_READ_ORIGINS`    | —                              | comma-separated exact origins (`https://…`, or `http://` to a loopback IP) that get CORS on `/v1/` only; both modes; a default port, non-ASCII host or empty entry refuses the start |

`tracer.json` holds resources (`id` `trc_…`, plaintext `writeKey` hashed at load, optional `dailyBytes`) and one static `readToken` (`yyt_` + 48 hex) for the local read API.

```sh
cd tracer
gofmt -l . && go vet ./... && go test -race ./... && CGO_ENABLED=0 go build ./...
cp tracer.example.json tracer.json   # gitignored; put a random writeKey in it
go run ./cmd/tracer serve
curl 127.0.0.1:8095/livez
```

`go.mod` says `go 1.26.0` because `modernc.org/sqlite` (pure Go, keeps `CGO_ENABLED=0`) requires it.
