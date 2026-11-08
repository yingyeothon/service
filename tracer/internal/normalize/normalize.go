// Package normalize turns envelope item payloads into store rows: the
// correlation columns, the group key and bounded strings (docs/tracer.md
// _What a reader gets_). Pure functions: bytes in, rows out.
package normalize

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/yingyeothon/service/tracer/internal/store"
)

// Bounds on what one row keeps (the read API truncates further).
const (
	MaxText        = 8 << 10
	MaxTag         = 200
	MaxTags        = 64
	MaxBreadcrumbs = 500
	MaxDataJSON    = 16 << 10
	MaxLogsPerItem = 1000
)

// ErrInvalid marks a payload that cannot become a row (counted as `invalid`).
var ErrInvalid = errors.New("normalize: invalid item")

// Event normalizes an `event` or `feedback` payload. headerEventID is the
// envelope header's event_id, used when the payload has none.
func Event(payload []byte, typ, headerEventID string, receivedMs int64) (store.Event, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(payload, &m); err != nil {
		return store.Event{}, ErrInvalid
	}
	e := store.Event{Type: typ}
	e.EventID = EventID(str(m["event_id"]))
	if e.EventID == "" {
		e.EventID = EventID(headerEventID)
	}
	if e.EventID == "" {
		return store.Event{}, ErrInvalid
	}
	e.TsMs = TimeMs(m["timestamp"], receivedMs)
	e.Level = clip(str(m["level"]), 32)
	if e.Level == "" {
		e.Level = "error"
		if typ == "feedback" {
			e.Level = "info"
		}
	}
	e.Platform = clip(str(m["platform"]), 64)
	e.Release = clip(str(m["release"]), MaxTag)
	e.Dist = clip(str(m["dist"]), MaxTag)
	e.Environment = clip(str(m["environment"]), MaxTag)

	var ctx struct {
		Trace struct {
			TraceID string `json:"trace_id"`
		} `json:"trace"`
		Device struct {
			Model  string `json:"model"`
			Family string `json:"family"`
		} `json:"device"`
		OS struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"os"`
		Feedback struct {
			Message           string `json:"message"`
			AssociatedEventID string `json:"associated_event_id"`
		} `json:"feedback"`
	}
	_ = json.Unmarshal(m["contexts"], &ctx)
	e.TraceID = HexID(ctx.Trace.TraceID)
	e.Device = clip(firstNonEmpty(ctx.Device.Model, ctx.Device.Family), MaxTag)
	e.OS = clip(strings.TrimSpace(ctx.OS.Name+" "+ctx.OS.Version), MaxTag)
	var user struct {
		ID json.RawMessage `json:"id"`
	}
	_ = json.Unmarshal(m["user"], &user)
	e.UserID = clip(scalar(user.ID), MaxTag)

	e.Message = clip(messageOf(m), MaxText)
	excType, excValue, frameKey := exceptionOf(m["exception"])
	e.ExceptionType, e.ExceptionValue = clip(excType, MaxTag), clip(excValue, MaxText)
	switch {
	case typ == "feedback":
		e.Message = clip(firstNonEmpty(ctx.Feedback.Message, e.Message), MaxText)
		e.AssociatedEventID = EventID(ctx.Feedback.AssociatedEventID)
		e.Title = clip(e.Message, MaxTag)
	case excType != "" || excValue != "":
		e.Title = clip(strings.TrimPrefix(excType+": "+excValue, ": "), MaxTag)
	default:
		e.Title = clip(e.Message, MaxTag)
	}
	if typ != "feedback" {
		e.GroupKey = GroupKey(fingerprintOf(m["fingerprint"]), defaultGroup(excType, frameKey, e.Message))
	}
	e.Tags = tagsOf(m["tags"])
	e.Breadcrumbs = breadcrumbsOf(m["breadcrumbs"], receivedMs)

	delete(m, "breadcrumbs")
	delete(m, "modules")
	b, err := json.Marshal(m)
	if err != nil {
		return store.Event{}, ErrInvalid
	}
	e.JSON = b
	return e, nil
}

// Transaction normalizes a `transaction` payload.
func Transaction(payload []byte, headerEventID string, receivedMs int64) (store.Transaction, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(payload, &m); err != nil {
		return store.Transaction{}, ErrInvalid
	}
	t := store.Transaction{EventID: EventID(firstNonEmpty(str(m["event_id"]), headerEventID))}
	if t.EventID == "" {
		return store.Transaction{}, ErrInvalid
	}
	var ctx struct {
		Trace struct {
			TraceID string `json:"trace_id"`
			Op      string `json:"op"`
			Status  string `json:"status"`
		} `json:"trace"`
		Device struct {
			Model string `json:"model"`
		} `json:"device"`
	}
	_ = json.Unmarshal(m["contexts"], &ctx)
	t.TraceID = HexID(ctx.Trace.TraceID)
	t.Name = clip(str(m["transaction"]), MaxTag)
	t.Op = clip(ctx.Trace.Op, 64)
	t.Status = clip(ctx.Trace.Status, 64)
	t.EndMs = TimeMs(m["timestamp"], receivedMs)
	t.StartMs = TimeMs(m["start_timestamp"], t.EndMs)
	t.Release = clip(str(m["release"]), MaxTag)
	t.Environment = clip(str(m["environment"]), MaxTag)
	t.Device = clip(ctx.Device.Model, MaxTag)
	delete(m, "breadcrumbs")
	delete(m, "modules")
	b, err := json.Marshal(m)
	if err != nil {
		return store.Transaction{}, ErrInvalid
	}
	t.JSON = b
	return t, nil
}

// Logs normalizes a `log` container. Each entry's dedupe key is the first
// 16 bytes of sha256 over its bytes exactly as received.
func Logs(payload []byte, receivedMs int64) ([]store.Log, int, error) {
	items, total, err := ArrayItems(payload, "items", MaxLogsPerItem, false)
	if err != nil || !bytes.HasPrefix(bytes.TrimSpace(payload), []byte("{")) {
		return nil, 0, ErrInvalid
	}
	dropped := total - len(items)
	out := make([]store.Log, 0, len(items))
	for _, raw := range items {
		var it struct {
			Timestamp  json.RawMessage            `json:"timestamp"`
			Level      string                     `json:"level"`
			Body       string                     `json:"body"`
			TraceID    string                     `json:"trace_id"`
			SpanID     string                     `json:"span_id"`
			Attributes map[string]json.RawMessage `json:"attributes"`
		}
		if err := json.Unmarshal(raw, &it); err != nil {
			dropped++
			continue
		}
		sum := sha256.Sum256(raw)
		l := store.Log{
			TsMs:      TimeMs(it.Timestamp, receivedMs),
			Level:     clip(it.Level, 32),
			Body:      clip(it.Body, MaxText),
			TraceID:   HexID(it.TraceID),
			SpanID:    HexID(it.SpanID),
			DedupeKey: sum[:16],
		}
		l.Release = clip(attr(it.Attributes, "sentry.release"), MaxTag)
		l.Environment = clip(attr(it.Attributes, "sentry.environment"), MaxTag)
		l.UserID = clip(attr(it.Attributes, "user.id"), MaxTag)
		l.Device = clip(attr(it.Attributes, "device.model"), MaxTag)
		if len(it.Attributes) > 0 {
			if b, err := json.Marshal(it.Attributes); err == nil && len(b) <= MaxDataJSON {
				l.AttributesJSON = b
			}
		}
		out = append(out, l)
	}
	return out, dropped, nil
}

// Session normalizes a `session` update.
func Session(payload []byte, receivedMs int64) (store.Session, error) {
	var s struct {
		SID       string          `json:"sid"`
		DID       json.RawMessage `json:"did"`
		Status    string          `json:"status"`
		Errors    int64           `json:"errors"`
		Seq       int64           `json:"seq"`
		Started   json.RawMessage `json:"started"`
		Timestamp json.RawMessage `json:"timestamp"`
		Attrs     struct {
			Release     string `json:"release"`
			Environment string `json:"environment"`
		} `json:"attrs"`
	}
	if err := json.Unmarshal(payload, &s); err != nil || s.SID == "" || len(s.SID) > 64 {
		return store.Session{}, ErrInvalid
	}
	status := clip(s.Status, 16)
	if status == "" {
		status = "ok"
	}
	out := store.Session{
		SID: s.SID, DID: clip(scalar(s.DID), MaxTag), Status: status, Errors: max(s.Errors, 0), Seq: max(s.Seq, 0),
		UpdatedMs: TimeMs(s.Timestamp, receivedMs), Release: clip(s.Attrs.Release, MaxTag), Environment: clip(s.Attrs.Environment, MaxTag),
	}
	if len(s.Started) > 0 {
		out.StartedMs = TimeMs(s.Started, 0)
	}
	return out, nil
}

// GroupKey hashes the fingerprint (with `{{ default }}` expanded) or, when
// there is none, the default components.
func GroupKey(fingerprint []string, def []string) string {
	parts := def
	if len(fingerprint) > 0 {
		parts = nil
		for _, f := range fingerprint {
			if t := strings.TrimSpace(f); t == "{{ default }}" || t == "{{default}}" {
				parts = append(parts, def...)
				continue
			}
			parts = append(parts, "fp:"+f)
		}
	}
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))[:32]
}

// defaultGroup: exception type + top in-app frame, else the message.
func defaultGroup(excType, frameKey, message string) []string {
	if excType != "" {
		return []string{"exc:" + excType, "frame:" + frameKey}
	}
	return []string{"msg:" + message}
}

func fingerprintOf(raw json.RawMessage) []string {
	fp, _, err := ArrayItems(raw, "", 32, false)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(fp))
	for _, f := range fp {
		out = append(out, scalar(f))
	}
	return out
}

func messageOf(m map[string]json.RawMessage) string {
	if s := str(m["message"]); s != "" {
		return s
	}
	for _, k := range []string{"message", "logentry"} {
		var o struct {
			Formatted string `json:"formatted"`
			Message   string `json:"message"`
		}
		if json.Unmarshal(m[k], &o) == nil {
			if s := firstNonEmpty(o.Formatted, o.Message); s != "" {
				return s
			}
		}
	}
	return ""
}

type frame struct {
	Function string `json:"function"`
	Module   string `json:"module"`
	Filename string `json:"filename"`
	AbsPath  string `json:"abs_path"`
	InApp    *bool  `json:"in_app"`
}

// MaxExceptions and MaxFrames bound what is decoded of an exception chain.
const (
	MaxExceptions = 10
	MaxFrames     = 200
)

// Exception is one value of a chain with its last MaxFrames frames.
type Exception struct {
	Type      string
	Value     string
	Mechanism json.RawMessage
	Frames    []json.RawMessage
}

// Exceptions streams the exception chain (last MaxExceptions values, each
// with its innermost MaxFrames frames).
func Exceptions(raw json.RawMessage) []Exception {
	values, _, err := ArrayItems(raw, "values", MaxExceptions, true)
	if err != nil {
		return nil
	}
	out := make([]Exception, 0, len(values))
	for _, v := range values {
		var ex struct {
			Type       string          `json:"type"`
			Value      string          `json:"value"`
			Mechanism  json.RawMessage `json:"mechanism"`
			Stacktrace json.RawMessage `json:"stacktrace"`
		}
		if json.Unmarshal(v, &ex) != nil {
			continue
		}
		e := Exception{Type: ex.Type, Value: ex.Value, Mechanism: ex.Mechanism}
		if len(ex.Stacktrace) > 0 {
			e.Frames, _, _ = ArrayItems(ex.Stacktrace, "frames", MaxFrames, true)
		}
		out = append(out, e)
	}
	return out
}

// exceptionOf picks the last value (the one raised) and its innermost in-app
// frame (frames are oldest first).
func exceptionOf(raw json.RawMessage) (typ, value, frameKey string) {
	values := Exceptions(raw)
	if len(values) == 0 {
		return "", "", ""
	}
	ex := values[len(values)-1]
	for i := len(ex.Frames) - 1; i >= 0; i-- {
		var f frame
		if json.Unmarshal(ex.Frames[i], &f) == nil && f.InApp != nil && *f.InApp {
			frameKey = firstNonEmpty(f.Module, f.Filename, f.AbsPath) + "|" + f.Function
			break
		}
	}
	return ex.Type, ex.Value, frameKey
}

func tagsOf(raw json.RawMessage) [][2]string {
	if len(raw) == 0 {
		return nil
	}
	var out [][2]string
	seen := map[string]bool{}
	add := func(k, v string) {
		k, v = clip(k, MaxTag), clip(v, MaxTag)
		if k == "" || seen[k] || len(out) >= MaxTags {
			return
		}
		seen[k] = true
		out = append(out, [2]string{k, v})
	}
	if pairs, err := ObjectPairs(raw, MaxTags); err == nil {
		for _, p := range pairs {
			add(str(p[0]), scalar(p[1]))
		}
		return out
	}
	list, _, err := ArrayItems(raw, "", MaxTags, false)
	if err != nil {
		return out
	}
	for _, it := range list {
		var p []json.RawMessage
		if json.Unmarshal(it, &p) == nil && len(p) == 2 {
			add(scalar(p[0]), scalar(p[1]))
		}
	}
	return out
}

func breadcrumbsOf(raw json.RawMessage, receivedMs int64) []store.Breadcrumb {
	list, _, err := ArrayItems(raw, "values", MaxBreadcrumbs, true)
	if err != nil {
		return nil
	}
	out := make([]store.Breadcrumb, 0, len(list))
	for _, r := range list {
		var b struct {
			Timestamp json.RawMessage `json:"timestamp"`
			Type      string          `json:"type"`
			Category  string          `json:"category"`
			Level     string          `json:"level"`
			Message   string          `json:"message"`
			Data      json.RawMessage `json:"data"`
		}
		if json.Unmarshal(r, &b) != nil {
			continue
		}
		bc := store.Breadcrumb{
			TsMs: TimeMs(b.Timestamp, 0), Type: clip(b.Type, 64), Category: clip(b.Category, MaxTag),
			Level: clip(b.Level, 32), Message: clip(b.Message, MaxText),
		}
		if d := bytes.TrimSpace(b.Data); len(d) > 0 && !bytes.Equal(d, []byte("null")) && len(d) <= MaxDataJSON {
			bc.DataJSON = d
		}
		out = append(out, bc)
	}
	return out
}

func attr(attrs map[string]json.RawMessage, key string) string {
	raw, ok := attrs[key]
	if !ok {
		return ""
	}
	var typed struct {
		Value json.RawMessage `json:"value"`
	}
	if json.Unmarshal(raw, &typed) == nil && len(typed.Value) > 0 {
		return scalar(typed.Value)
	}
	return scalar(raw)
}

// TimeMs reads an RFC 3339 string or float seconds; fallback when absent or bad.
func TimeMs(raw json.RawMessage, fallback int64) int64 {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return fallback
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return fallback
		}
		if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
			return t.UnixMilli()
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return secondsToMs(f, fallback)
		}
		return fallback
	}
	f, err := strconv.ParseFloat(string(raw), 64)
	if err != nil {
		return fallback
	}
	return secondsToMs(f, fallback)
}

func secondsToMs(f float64, fallback int64) int64 {
	if math.IsNaN(f) || math.IsInf(f, 0) || f < 0 || f > 1e11 {
		return fallback
	}
	return int64(math.Round(f * 1000))
}

// EventID lowercases a 32-hex id (dashes removed); anything else is "".
func EventID(s string) string {
	s = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(s), "-", ""))
	if len(s) != 32 || !isHex(s) {
		return ""
	}
	return s
}

// HexID keeps a lowercase hex id of 16 or 32 characters, else "".
func HexID(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if (len(s) != 16 && len(s) != 32) || !isHex(s) {
		return ""
	}
	return s
}

func isHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func str(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

// scalar renders a JSON string/number/bool as text; objects and arrays as compact JSON.
func scalar(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return ""
	}
	if raw[0] == '"' {
		return str(raw)
	}
	var buf bytes.Buffer
	if json.Compact(&buf, raw) != nil {
		return ""
	}
	return buf.String()
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

// clip bounds s to n bytes on a rune boundary.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// Day is the UTC calendar day of a unix-millisecond time.
func Day(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02") }
