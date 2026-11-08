// Package envelope parses the Sentry envelope wire format
// (https://develop.sentry.dev/sdk/envelopes/).
//
// Body layout: an envelope header JSON line, then for each item an item header
// JSON line followed by the payload — exactly `length` bytes when the header has
// `length`, otherwise up to the next newline. The package is IO-free apart from
// the io.Reader it is given: decompression, size caps and HTTP live in ingest.
package envelope

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// Header is the first line of an envelope.
type Header struct {
	EventID string          `json:"event_id,omitempty"`
	DSN     string          `json:"dsn,omitempty"`
	SentAt  string          `json:"sent_at,omitempty"`
	SDK     json.RawMessage `json:"sdk,omitempty"`
	// Trace is the dynamic sampling context (`trace_id`, `release`, …).
	Trace json.RawMessage `json:"trace,omitempty"`
}

// ItemHeader precedes each item payload.
type ItemHeader struct {
	Type           string `json:"type"`
	Length         *int64 `json:"length,omitempty"`
	ContentType    string `json:"content_type,omitempty"`
	Filename       string `json:"filename,omitempty"`
	AttachmentType string `json:"attachment_type,omitempty"`
}

// Item is one header + payload pair (Parse only; the streaming Reader hands
// out payload readers instead).
type Item struct {
	Header  ItemHeader
	Payload []byte
}

// Envelope is a parsed envelope.
type Envelope struct {
	Header Header
	Items  []Item
}

// Item types tracer stores (docs/tracer.md _Ingest_).
const (
	TypeEvent       = "event"
	TypeFeedback    = "feedback"
	TypeLog         = "log"
	TypeAttachment  = "attachment"
	TypeTransaction = "transaction"
	TypeSession     = "session"
	TypeSessions    = "sessions"
)

// Item types accepted and counted (`drops` reason `not_stored`) but not kept.
// Any other type is counted as `unknown`; neither is ever an error.
const (
	TypeClientReport    = "client_report"
	TypeReplayEvent     = "replay_event"
	TypeReplayRecording = "replay_recording"
	TypeReplayVideo     = "replay_video" // sentry-android session replay (captured 2026-11-08)
	TypeProfile         = "profile"
	TypeCheckIn         = "check_in"
	TypeSpan            = "span"
	TypeTraceMetric     = "trace_metric"
	TypeStatsd          = "statsd"
)

// NotStored reports whether a type is accepted and counted but not kept.
func NotStored(t string) bool {
	switch t {
	case TypeSessions, TypeClientReport, TypeReplayEvent, TypeReplayRecording, TypeReplayVideo,
		TypeProfile, TypeCheckIn, TypeSpan, TypeTraceMetric, TypeStatsd:
		return true
	}
	return false
}

// MaxHeaderLine bounds the envelope and item header lines.
const MaxHeaderLine = 64 << 10

var (
	// ErrHeaderTooLong: a header line is longer than MaxHeaderLine.
	ErrHeaderTooLong = errors.New("envelope: header line too long")
	// ErrItemTooLarge: an item without `length` is longer than the reader's item cap.
	ErrItemTooLarge = errors.New("envelope: item too large")
	// ErrMalformed: a header line is not a JSON object or a length is negative.
	ErrMalformed = errors.New("envelope: malformed")
	// ErrTruncated: the body ended inside a `length`-delimited payload.
	ErrTruncated = errors.New("envelope: truncated payload")
)

// Reader streams an envelope: the header first, then one item at a time. A
// payload reader is valid until the next call to Next; whatever the caller
// left unread is discarded then.
type Reader struct {
	br        *bufio.Reader
	header    Header
	maxNoLen  int64
	pending   io.Reader
	needNL    bool
	done      bool
	skipped   int64
	consumed  int64
	lineEnded bool
}

// NewReader reads the envelope header line. maxLineItem caps a payload that
// has no `length` (it must be buffered to find its newline); a longer one is
// skipped and reported by Next as ErrItemTooLarge, after which Next goes on.
func NewReader(r io.Reader, maxLineItem int64) (*Reader, error) {
	er := &Reader{br: bufio.NewReaderSize(r, 32<<10), maxNoLen: maxLineItem}
	line, err := er.readLine(MaxHeaderLine, ErrHeaderTooLong)
	if err != nil && !(errors.Is(err, io.EOF) && len(line) > 0) {
		if errors.Is(err, io.EOF) {
			return nil, ErrMalformed
		}
		return nil, err
	}
	if err := decodeObject(line, &er.header); err != nil {
		return nil, err
	}
	return er, nil
}

// Header is the envelope header.
func (r *Reader) Header() Header { return r.header }

// Next returns the next item header and a reader over its payload, or io.EOF.
func (r *Reader) Next() (ItemHeader, io.Reader, error) {
	if r.done {
		return ItemHeader{}, nil, io.EOF
	}
	if err := r.finishPending(); err != nil {
		return ItemHeader{}, nil, err
	}
	var line []byte
	for {
		l, err := r.readLine(MaxHeaderLine, ErrHeaderTooLong)
		if errors.Is(err, io.EOF) && len(l) == 0 {
			r.done = true
			return ItemHeader{}, nil, io.EOF
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return ItemHeader{}, nil, err
		}
		if len(bytes.TrimSpace(l)) > 0 {
			line = l
			break
		}
		if errors.Is(err, io.EOF) {
			r.done = true
			return ItemHeader{}, nil, io.EOF
		}
	}
	var ih ItemHeader
	if err := decodeObject(line, &ih); err != nil {
		return ItemHeader{}, nil, err
	}
	if ih.Length != nil {
		if *ih.Length < 0 {
			return ItemHeader{}, nil, ErrMalformed
		}
		r.pending = &exactReader{r: io.LimitReader(r.br, *ih.Length), want: *ih.Length}
		r.needNL = true
		return ih, r.pending, nil
	}
	payload, err := r.readLine(r.maxNoLen, ErrItemTooLarge)
	if errors.Is(err, ErrItemTooLarge) {
		// Skip to the end of the oversized line; the reader stays usable and
		// the caller drops this item only (docs/tracer.md: too_large).
		n, derr := r.consumed, error(nil)
		if !r.lineEnded {
			var more int64
			more, derr = r.discardLine()
			n += more
			if derr == nil {
				n-- // the newline is not payload
			}
		}
		r.lineEnded = false
		r.pending, r.needNL = nil, false
		if derr != nil {
			if !errors.Is(derr, io.EOF) {
				return ItemHeader{}, nil, derr
			}
			r.done = true
		}
		r.skipped = n
		return ih, nil, ErrItemTooLarge
	}
	if err != nil && !errors.Is(err, io.EOF) {
		return ItemHeader{}, nil, err
	}
	if errors.Is(err, io.EOF) {
		r.done = true
	}
	r.pending, r.needNL = nil, false
	return ih, bytes.NewReader(payload), nil
}

// Skipped is the size of the item Next last refused with ErrItemTooLarge.
func (r *Reader) Skipped() int64 { return r.skipped }

// discardLine reads through the next newline, counting what it threw away.
func (r *Reader) discardLine() (int64, error) {
	var n int64
	for {
		chunk, err := r.br.ReadSlice('\n')
		n += int64(len(chunk))
		if err == nil {
			return n, nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return n, err
		}
	}
}

// finishPending drains an unread length-delimited payload and its optional
// trailing newline.
func (r *Reader) finishPending() error {
	if r.pending == nil {
		return nil
	}
	if _, err := io.Copy(io.Discard, r.pending); err != nil {
		return err
	}
	r.pending = nil
	if r.needNL {
		r.needNL = false
		b, err := r.br.Peek(1)
		if err == nil && b[0] == '\n' {
			r.br.Discard(1)
		} else if errors.Is(err, io.EOF) {
			r.done = true
		} else if err != nil {
			return err
		}
	}
	return nil
}

// readLine reads up to and excluding '\n' (and a trailing '\r'), refusing
// lines longer than max (whatever was read of it is consumed). At end of
// input it returns the partial line with io.EOF.
func (r *Reader) readLine(max int64, tooLong error) ([]byte, error) {
	var buf []byte
	for {
		chunk, err := r.br.ReadSlice('\n')
		if int64(len(buf)+len(chunk)) > max+1 {
			r.consumed = int64(len(buf) + len(chunk))
			if err == nil {
				r.consumed--
				r.lineEnded = true
			}
			return nil, tooLong
		}
		buf = append(buf, chunk...)
		if err == nil {
			buf = buf[:len(buf)-1]
			return bytes.TrimSuffix(buf, []byte{'\r'}), nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return buf, err
	}
}

// exactReader turns a short length-delimited payload into ErrTruncated.
type exactReader struct {
	r    io.Reader
	want int64
	got  int64
}

func (e *exactReader) Read(p []byte) (int, error) {
	n, err := e.r.Read(p)
	e.got += int64(n)
	if errors.Is(err, io.EOF) && e.got < e.want {
		return n, ErrTruncated
	}
	return n, err
}

func decodeObject(line []byte, v any) error {
	line = bytes.TrimSpace(line)
	if len(line) == 0 || line[0] != '{' {
		return ErrMalformed
	}
	if err := json.Unmarshal(line, v); err != nil {
		return ErrMalformed
	}
	return nil
}

// Parse reads a whole (already decompressed and size-capped) envelope into
// memory. Tests and `tracer dev seed` use it; ingest streams with Reader.
func Parse(r io.Reader) (*Envelope, error) {
	er, err := NewReader(r, 1<<62)
	if err != nil {
		return nil, err
	}
	env := &Envelope{Header: er.Header()}
	for {
		ih, pr, err := er.Next()
		if errors.Is(err, io.EOF) {
			return env, nil
		}
		if err != nil {
			return nil, err
		}
		p, err := io.ReadAll(pr)
		if err != nil {
			return nil, err
		}
		env.Items = append(env.Items, Item{Header: ih, Payload: p})
	}
}
