package envelope

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func parseString(t *testing.T, s string) (*Envelope, error) {
	t.Helper()
	return Parse(strings.NewReader(s))
}

func TestParseShapes(t *testing.T) {
	cases := []struct {
		name  string
		body  string
		types []string
		last  string
	}{
		{"length items", "{\"event_id\":\"e1\"}\n{\"type\":\"event\",\"length\":2}\n{}\n{\"type\":\"attachment\",\"length\":3}\nabc\n", []string{"event", "attachment"}, "abc"},
		{"no length", "{}\n{\"type\":\"event\"}\n{\"a\":1}\n{\"type\":\"session\"}\n{\"sid\":\"x\"}\n", []string{"event", "session"}, "{\"sid\":\"x\"}"},
		{"no trailing newline", "{}\n{\"type\":\"event\",\"length\":2}\n{}", []string{"event"}, "{}"},
		{"no trailing newline no length", "{}\n{\"type\":\"log\"}\n{\"items\":[]}", []string{"log"}, "{\"items\":[]}"},
		{"empty payload", "{}\n{\"type\":\"attachment\",\"length\":0}\n\n{\"type\":\"event\",\"length\":2}\n{}\n", []string{"attachment", "event"}, "{}"},
		{"payload with newlines", "{}\n{\"type\":\"attachment\",\"length\":5}\na\nb\nc\n", []string{"attachment"}, "a\nb\nc"},
		{"header only", "{\"event_id\":\"e\"}\n", nil, ""},
		{"header only no newline", "{\"event_id\":\"e\"}", nil, ""},
		{"crlf", "{}\r\n{\"type\":\"event\"}\r\n{}\r\n", []string{"event"}, "{}"},
		{"unknown type", "{}\n{\"type\":\"future_thing\",\"length\":1}\nx\n", []string{"future_thing"}, "x"},
		{"blank line between", "{}\n{\"type\":\"event\",\"length\":2}\n{}\n\n{\"type\":\"log\",\"length\":2}\n{}\n", []string{"event", "log"}, "{}"},
	}
	for _, c := range cases {
		env, err := parseString(t, c.body)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		var got []string
		for _, it := range env.Items {
			got = append(got, it.Header.Type)
		}
		if strings.Join(got, ",") != strings.Join(c.types, ",") {
			t.Errorf("%s: types %v, want %v", c.name, got, c.types)
		}
		if len(env.Items) > 0 && string(env.Items[len(env.Items)-1].Payload) != c.last {
			t.Errorf("%s: last payload %q, want %q", c.name, env.Items[len(env.Items)-1].Payload, c.last)
		}
	}
}

func TestParseErrors(t *testing.T) {
	cases := map[string]struct {
		body string
		want error
	}{
		"empty":            {"", ErrMalformed},
		"header not json":  {"nope\n", ErrMalformed},
		"header array":     {"[1]\n", ErrMalformed},
		"item not json":    {"{}\nnope\n", ErrMalformed},
		"negative length":  {"{}\n{\"type\":\"event\",\"length\":-1}\n", ErrMalformed},
		"truncated":        {"{}\n{\"type\":\"attachment\",\"length\":10}\nabc", ErrTruncated},
		"header too long":  {"{\"x\":\"" + strings.Repeat("a", MaxHeaderLine) + "\"}\n", ErrHeaderTooLong},
		"item header long": {"{}\n{\"type\":\"" + strings.Repeat("a", MaxHeaderLine) + "\"}\n", ErrHeaderTooLong},
	}
	for name, c := range cases {
		if _, err := parseString(t, c.body); !errors.Is(err, c.want) {
			t.Errorf("%s: err %v, want %v", name, err, c.want)
		}
	}
}

func TestReaderLineItemCapSkipsOneItem(t *testing.T) {
	big := strings.Repeat("x", 100<<10) // larger than the bufio buffer too
	r, err := NewReader(strings.NewReader("{}\n{\"type\":\"event\"}\n"+big+"\n{\"type\":\"session\"}\n{\"sid\":\"s\"}\n"), 50)
	if err != nil {
		t.Fatal(err)
	}
	ih, _, err := r.Next()
	if !errors.Is(err, ErrItemTooLarge) || ih.Type != "event" || r.Skipped() != int64(len(big)) {
		t.Fatalf("first: %v %v %d", ih, err, r.Skipped())
	}
	ih, pr, err := r.Next()
	if err != nil || ih.Type != "session" {
		t.Fatalf("after skip: %v %v", ih, err)
	}
	b, _ := io.ReadAll(pr)
	if string(b) != "{\"sid\":\"s\"}" {
		t.Fatalf("payload %q", b)
	}
	// Oversized last item without a trailing newline.
	r, _ = NewReader(strings.NewReader("{}\n{\"type\":\"event\"}\n"+big), 50)
	if _, _, err := r.Next(); !errors.Is(err, ErrItemTooLarge) {
		t.Fatalf("last: %v", err)
	}
	if _, _, err := r.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("after last: %v", err)
	}
}

func TestReaderSkipsUnreadPayload(t *testing.T) {
	r, err := NewReader(strings.NewReader("{}\n{\"type\":\"attachment\",\"length\":4}\nabcd\n{\"type\":\"event\",\"length\":2}\n{}\n"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if ih, _, err := r.Next(); err != nil || ih.Type != "attachment" {
		t.Fatalf("first: %v %v", ih, err)
	}
	ih, pr, err := r.Next()
	if err != nil || ih.Type != "event" {
		t.Fatalf("second: %v %v", ih, err)
	}
	b, _ := io.ReadAll(pr)
	if string(b) != "{}" {
		t.Fatalf("payload %q", b)
	}
	if _, _, err := r.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("end: %v", err)
	}
}

// TestGoldenFixtures parses every captured envelope: item lengths and types
// must match the item headers exactly (docs/tracer.md _Ingest_).
func TestGoldenFixtures(t *testing.T) {
	files, _ := filepath.Glob("../../testdata/envelopes/*/*.envelope")
	if len(files) < 9 {
		t.Fatalf("fixtures: %d", len(files))
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		env, err := Parse(bytes.NewReader(b))
		if err != nil {
			t.Errorf("%s: %v", f, err)
			continue
		}
		if len(env.Header.SDK) == 0 {
			t.Errorf("%s: no sdk in header", f)
		}
		for _, it := range env.Items {
			if it.Header.Length == nil || int64(len(it.Payload)) != *it.Header.Length {
				t.Errorf("%s: %s length mismatch", f, it.Header.Type)
			}
		}
	}
}
