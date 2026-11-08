// Package envelope parses the Sentry envelope wire format
// (https://develop.sentry.dev/sdk/envelopes/).
//
// Body layout: an envelope header JSON line, then for each item an item header
// JSON line followed by the payload — exactly `length` bytes when the header has
// `length`, otherwise up to the next newline. The package is IO-free apart from
// the io.Reader it is given: decompression, size caps and HTTP live in ingest.
package envelope

import (
	"encoding/json"
	"errors"
	"io"
)

// ErrNotImplemented is returned until the ingest parser lands (todo/85-tracer.md).
var ErrNotImplemented = errors.New("envelope: parser not implemented")

// Header is the first line of an envelope.
type Header struct {
	EventID string          `json:"event_id,omitempty"`
	DSN     string          `json:"dsn,omitempty"`
	SentAt  string          `json:"sent_at,omitempty"`
	SDK     json.RawMessage `json:"sdk,omitempty"`
}

// ItemHeader precedes each item payload.
type ItemHeader struct {
	Type           string `json:"type"`
	Length         *int64 `json:"length,omitempty"`
	ContentType    string `json:"content_type,omitempty"`
	Filename       string `json:"filename,omitempty"`
	AttachmentType string `json:"attachment_type,omitempty"`
}

// Item is one header + payload pair.
type Item struct {
	Header  ItemHeader
	Payload []byte
}

// Envelope is a parsed envelope.
type Envelope struct {
	Header Header
	Items  []Item
}

// Item types tracer stores; every other type is counted in `drops` and discarded.
const (
	TypeEvent       = "event"
	TypeLog         = "log"
	TypeAttachment  = "attachment"
	TypeTransaction = "transaction"
	TypeSession     = "session"
	TypeSessions    = "sessions"
)

// Parse reads a whole (already decompressed and size-capped) envelope.
func Parse(r io.Reader) (*Envelope, error) {
	return nil, ErrNotImplemented
}
