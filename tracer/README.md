# tracer

Debug-data collector for debug builds (`docs/decisions.md` _Debug collector (`tracer`)_, design in `docs/tracer.md`). Third Go module of this repository; shares nothing with `cli/` or `gateway/`. Progress: `todo/85` (machine-local).

Status: P3 (local-mode ingest). `tracer serve` reads `TRACER_*` environment variables, opens SQLite with the design schema, answers `GET /livez`, `GET /healthz`, `GET /metrics`, and ingests `POST /api/{trc_id}/envelope/` / `/store/` (gzip/deflate, size caps, 4 in flight, daily quota stages, stage cap and disk line, attachments as blob files, one writer goroutine). `go build -tags dev` adds `tracer dev seed`. Server mode (`TRACER_CONSOLE_URL`) refuses to start until the console client (P5); the read API (P6), retention (P7) and the image (P8) follow.

## Configuration

| Variable                 | Default                        | Notes                                                                             |
| ------------------------ | ------------------------------ | --------------------------------------------------------------------------------- |
| `TRACER_CONSOLE_URL`     | —                              | set = server mode; unset = local mode                                             |
| `TRACER_STAGE`           | `local` in local mode          | `dev`/`prod` in server mode (required)                                            |
| `TRACER_TOKEN` / `_FILE` | —                              | SSM `tracer-token`, ≥ 32 chars, server mode only; unlocks `/metrics` detail       |
| `TRACER_LISTEN`          | `127.0.0.1:8095`               | loopback IP literal in both modes (Caddy fronts the host); wildcard refused       |
| `TRACER_DATA_DIR`        | `tracer-data` in local mode    | `tracer.db` + `blobs/`; required in server mode                                   |
| `TRACER_STAGE_BYTES`     | dev 536870912, prod 1610612736 | DB + WAL + blobs cap                                                              |
| `TRACER_DISK_MAX_PCT`    | 70                             | root volume usage that refuses ingest                                             |
| `TRACER_LOG_LEVEL`       | `info`                         | debug, info, warn, error                                                          |
| `TRACER_LOCAL_CONFIG`    | `tracer.json` in local mode    | local mode only (`tracer.example.json`)                                           |
| `TRACER_DUMP_DIR`        | —                              | local mode only: each accepted request's raw body + scrubbed headers, for capture |

`tracer.json` holds resources (`id` `trc_…`, plaintext `writeKey` hashed at load, optional `dailyBytes`) and one static `readToken` (`yyt_` + 48 hex) for the local read API.

```sh
cd tracer
gofmt -l . && go vet ./... && go test -race ./... && CGO_ENABLED=0 go build ./...
cp tracer.example.json tracer.json   # gitignored; put a random writeKey in it
go run ./cmd/tracer serve
curl 127.0.0.1:8095/livez
```

`go.mod` says `go 1.26.0` because `modernc.org/sqlite` (pure Go, keeps `CGO_ENABLED=0`) requires it.
