package normalize

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yingyeothon/service/tracer/internal/envelope"
)

func fixture(t *testing.T, name string) *envelope.Envelope {
	t.Helper()
	f, err := os.Open(filepath.Join("../../testdata/envelopes", name))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	env, err := envelope.Parse(f)
	if err != nil {
		t.Fatal(err)
	}
	return env
}

func item(t *testing.T, env *envelope.Envelope, typ string) []byte {
	t.Helper()
	for _, it := range env.Items {
		if it.Header.Type == typ {
			return it.Payload
		}
	}
	t.Fatalf("no %s item", typ)
	return nil
}

const recv = int64(1_800_000_000_000)

func TestEventFromAndroidCapture(t *testing.T) {
	env := fixture(t, "sentry-android/event-screenshot-view-hierarchy.envelope")
	e, err := Event(item(t, env, "event"), "event", env.Header.EventID, recv)
	if err != nil {
		t.Fatal(err)
	}
	if e.EventID != env.Header.EventID || e.Level != "warning" || e.Message != "capture report: rejected move" || e.Title != e.Message {
		t.Fatalf("event %+v", e)
	}
	if e.TraceID == "" || e.Release != "capture@1.0.0+1" || e.Dist != "abc1234" || e.Environment != "debug" || e.Device == "" || e.OS != "Android 15" {
		t.Fatalf("correlation %+v", e)
	}
	if e.UserID != "00000000000000000000000000000000" || e.TsMs == recv || len(e.Breadcrumbs) == 0 {
		t.Fatalf("user/ts/breadcrumbs %q %d %d", e.UserID, e.TsMs, len(e.Breadcrumbs))
	}
	found := false
	for _, tg := range e.Tags {
		found = found || tg == [2]string{"feature", "board"}
	}
	if !found {
		t.Fatalf("tags %v", e.Tags)
	}
	// fingerprint ["{{ default }}", "rejected-move"] differs from the default group.
	if e.GroupKey == GroupKey(nil, defaultGroup("", "", e.Message)) {
		t.Fatal("fingerprint ignored")
	}
	var m map[string]json.RawMessage
	json.Unmarshal(e.JSON, &m)
	if _, ok := m["breadcrumbs"]; ok {
		t.Fatal("breadcrumbs kept in json")
	}
	if _, ok := m["modules"]; ok {
		t.Fatal("modules kept in json")
	}
}

func TestExceptionGrouping(t *testing.T) {
	env := fixture(t, "sentry-android/exception-session-update.envelope")
	e, err := Event(item(t, env, "event"), "event", "", recv)
	if err != nil {
		t.Fatal(err)
	}
	if e.ExceptionType != "StateError" || e.Title != "StateError: Bad state: capture exception" || e.Level != "error" {
		t.Fatalf("exception %+v", e)
	}
	// Same type + frame, different value → same group.
	a := GroupKey(nil, defaultGroup("StateError", "m|f", "x"))
	b := GroupKey(nil, defaultGroup("StateError", "m|f", "y"))
	c := GroupKey(nil, defaultGroup("StateError", "m|g", "x"))
	if a != b || a == c {
		t.Fatal("default grouping wrong")
	}
	if GroupKey([]string{"custom"}, []string{"msg:a"}) != GroupKey([]string{"custom"}, []string{"msg:b"}) {
		t.Fatal("explicit fingerprint must ignore the default")
	}
}

func TestFeedback(t *testing.T) {
	env := fixture(t, "sentry-android/feedback.envelope")
	e, err := Event(item(t, env, "feedback"), "feedback", "", recv)
	if err != nil {
		t.Fatal(err)
	}
	if e.Type != "feedback" || e.Message != "capture feedback note" || e.AssociatedEventID == "" || e.GroupKey != "" || e.Level != "info" {
		t.Fatalf("feedback %+v", e)
	}
}

func TestTransaction(t *testing.T) {
	env := fixture(t, "sentry-android/transaction.envelope")
	tx, err := Transaction(item(t, env, "transaction"), "", recv)
	if err != nil {
		t.Fatal(err)
	}
	if tx.Name != "capture.flow" || tx.Op != "ui.load" || tx.TraceID == "" || tx.EndMs-tx.StartMs <= 0 || tx.EndMs-tx.StartMs > 10_000 {
		t.Fatalf("tx %+v", tx)
	}
}

func TestLogs(t *testing.T) {
	for _, f := range []string{"sentry-android/log.envelope", "sentry-dart/log.envelope"} {
		env := fixture(t, f)
		logs, dropped, err := Logs(item(t, env, "log"), recv)
		if err != nil || dropped != 0 || len(logs) == 0 {
			t.Fatalf("%s: %v %d %d", f, err, dropped, len(logs))
		}
		for _, l := range logs {
			if len(l.DedupeKey) != 16 || l.Body == "" || l.Release != "capture@1.0.0+1" || l.TsMs == recv || l.TraceID == "" {
				t.Fatalf("%s: %+v", f, l)
			}
		}
		if len(logs) > 1 && string(logs[0].DedupeKey) == string(logs[1].DedupeKey) {
			t.Fatal("distinct logs share a key")
		}
	}
	// Same bytes → same key; one byte different → different key.
	a, _, _ := Logs([]byte(`{"items":[{"timestamp":1.5,"body":"x"}]}`), recv)
	b, _, _ := Logs([]byte(`{"items":[{"timestamp":1.5,"body":"x"}]}`), recv)
	c, _, _ := Logs([]byte(`{"items":[{"timestamp":1.5,"body":"y"}]}`), recv)
	if string(a[0].DedupeKey) != string(b[0].DedupeKey) || string(a[0].DedupeKey) == string(c[0].DedupeKey) {
		t.Fatal("dedupe key not content-based")
	}
	if a[0].TsMs != 1500 {
		t.Fatalf("float seconds → ms: %d", a[0].TsMs)
	}
}

func TestSession(t *testing.T) {
	env := fixture(t, "sentry-android/session-init.envelope")
	s, err := Session(item(t, env, "session"), recv)
	if err != nil || s.Status != "ok" || s.Seq != 0 || s.StartedMs == 0 || s.DID == "" || s.Release == "" {
		t.Fatalf("init %+v %v", s, err)
	}
	env = fixture(t, "sentry-android/exception-session-update.envelope")
	u, err := Session(item(t, env, "session"), recv)
	if err != nil || u.SID != s.SID || u.Seq == 0 || u.Errors != 1 {
		t.Fatalf("update %+v %v", u, err)
	}
	if _, err := Session([]byte(`{"status":"ok"}`), recv); err == nil {
		t.Fatal("session without sid accepted")
	}
}

func TestInvalidAndBounds(t *testing.T) {
	if _, err := Event([]byte(`{"message":"no id"}`), "event", "", recv); err == nil {
		t.Fatal("event without id accepted")
	}
	e, err := Event([]byte(`{"message":"hdr id"}`), "event", "0123456789ABCDEF0123456789abcdef", recv)
	if err != nil || e.EventID != "0123456789abcdef0123456789abcdef" || e.TsMs != recv {
		t.Fatalf("header id fallback %+v %v", e, err)
	}
	if _, err := Event([]byte(`[1]`), "event", "", recv); err == nil {
		t.Fatal("array accepted")
	}
	if clip("가나다", 4) != "가" {
		t.Fatalf("clip broke a rune: %q", clip("가나다", 4))
	}
	if TimeMs(json.RawMessage(`"2026-11-08T06:42:15.834Z"`), 0) != 1794120135834 || TimeMs(json.RawMessage(`"junk"`), 7) != 7 || TimeMs(json.RawMessage(`1e300`), 7) != 7 {
		t.Fatal("TimeMs")
	}
	tags := tagsOf(json.RawMessage(`[["a","1"],["b",2]]`))
	if len(tags) != 2 || tags[1] != [2]string{"b", "2"} {
		t.Fatalf("pair tags %v", tags)
	}
}

// Attributes full of `<>&` that fit as sent still fit as stored (json.Marshal
// would escape each to 6 bytes and drop them whole).
func TestLogAttributesKeepHTMLCharacters(t *testing.T) {
	v := strings.Repeat("&", 7000) + strings.Repeat("<", 7000)
	payload := `{"items":[{"timestamp":1.5,"body":"x","attributes":{"a":{"value":"` + v + `","type":"string"}}}]}`
	logs, _, err := Logs([]byte(payload), recv)
	if err != nil || len(logs) != 1 {
		t.Fatal(err)
	}
	if len(logs[0].AttributesJSON) == 0 || !strings.Contains(string(logs[0].AttributesJSON), "&&&<<<") {
		t.Fatalf("attributes dropped or escaped: %d bytes", len(logs[0].AttributesJSON))
	}
}
