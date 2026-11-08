// Package query is the home of the read API (`GET /v1/{trc}/…`,
// docs/tracer.md _Read API and CLI_): bounded, read-only queries over the
// store on a separate mux from ingest, consumed by `yyt tracer` and the
// tracer-debug skill. Field names are one contract with both (todo/85 P6).
package query
