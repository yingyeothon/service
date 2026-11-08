# tracer

Sentry-SDK-compatible collector for debug builds (`docs/decisions.md` _Debug collector (`tracer`)_, design in `docs/tracer.md`). Third Go module of this repository; shares nothing with `cli/` or `gateway/`.

Status: skeleton. `tracer serve` loads `tracer.json` (see `tracer.example.json`), opens SQLite with its migrations, answers `GET /healthz`, and authenticates `POST /api/{id}/envelope/` / `/store/` by `sentry_key` (`X-Sentry-Auth` or query) before answering 501. Ingest parsing, the read API (`/v1/…`), console integration (`/tr/*`) and the container image are tracked in `todo/85-tracer.md`.

```sh
cd tracer
gofmt -l . && go vet ./... && go test -race ./... && CGO_ENABLED=0 go build ./...
cp tracer.example.json tracer.json   # local mode: loopback only, static resources
go run ./cmd/tracer serve -config tracer.json
curl 127.0.0.1:8095/healthz
```

`go.mod` says `go 1.26.0` because `modernc.org/sqlite` (pure Go, keeps `CGO_ENABLED=0`) requires it.
