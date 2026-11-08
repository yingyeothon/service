package cmd

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yingyeothon/service/cli/internal/api"
)

// The read API answers come from the tracer's own golden files
// (tracer/testdata/read), so this fake cannot drift from the server.
const (
	trcRes     = "trc_fixture01"
	trcToken   = "yyt_000000000000000000000000000000000000000000000001"
	trcEventID = "7730857f6b4d4655aee7855244455e2d"
)

func tracerGolden(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "tracer", "testdata", "read", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type fakeTracer struct {
	srv   *httptest.Server
	paths []string
}

func newFakeTracer(t *testing.T, png []byte) *fakeTracer {
	t.Helper()
	f := &fakeTracer{}
	sum := sha256.Sum256(png)
	routes := map[string]string{
		"/v1/" + trcRes + "/issues":                             "issues",
		"/v1/" + trcRes + "/events":                             "events",
		"/v1/" + trcRes + "/events/" + trcEventID:               "event-report",
		"/v1/" + trcRes + "/events/" + trcEventID + "/timeline": "timeline-report",
		"/v1/" + trcRes + "/logs":                               "logs",
		"/v1/" + trcRes + "/drops":                              "drops",
		"/v1/" + trcRes + "/usage":                              "usage",
	}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.paths = append(f.paths, r.URL.RequestURI())
		if r.Header.Get("Authorization") != "Bearer "+trcToken {
			w.WriteHeader(401)
			w.Write([]byte(`{"error":{"code":"unauthorized","message":"token unknown or revoked"}}`))
			return
		}
		switch {
		case r.URL.Path == "/v1/"+trcRes+"/attachments/good":
			w.Header().Set("X-Tracer-Sha256", hex.EncodeToString(sum[:]))
			w.Write(png)
			return
		case r.URL.Path == "/v1/"+trcRes+"/attachments/bad":
			w.Header().Set("X-Tracer-Sha256", strings.Repeat("0", 64))
			w.Write(png)
			return
		case r.URL.Path == "/v1/"+trcRes+"/drops-quota":
		}
		name, ok := routes[r.URL.Path]
		if !ok {
			w.WriteHeader(404)
			w.Write([]byte(`{"error":{"code":"not_found","message":"tracer resource not found"}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(tracerGolden(t, name))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func runLocal(t *testing.T, ft *fakeTracer, args ...string) (string, string, error) {
	t.Helper()
	t.Setenv("YYT_TRACER_LOCAL", ft.srv.URL)
	t.Setenv("YYT_TRACER_LOCAL_TOKEN", trcToken)
	return run(t, newFake(t, nil), args...)
}

func TestTracerLocalReads(t *testing.T) {
	ft := newFakeTracer(t, []byte("\x89PNG fake"))
	for _, args := range [][]string{
		{"tracer", "issues", trcRes},
		{"tracer", "events", trcRes},
		{"tracer", "event", trcRes, trcEventID},
		{"tracer", "timeline", trcRes, trcEventID},
		{"tracer", "logs", trcRes},
		{"tracer", "drops", trcRes},
		{"tracer", "usage", trcRes},
	} {
		out, _, err := runLocal(t, ft, args...)
		if err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		golden(t, "tracer_"+args[1], out)
		// --json passes the read API's shape through.
		js, _, err := runLocal(t, ft, append(args, "--json")...)
		if err != nil || !json.Valid([]byte(js)) {
			t.Fatalf("%v --json: %v %q", args, err, js)
		}
	}
}

func TestTracerFlagsBecomeQuery(t *testing.T) {
	ft := newFakeTracer(t, nil)
	if _, _, err := runLocal(t, ft, "tracer", "events", trcRes, "--since", "10m", "--trace-id", "abc", "--tag", "feature:board", "--limit", "5"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := runLocal(t, ft, "tracer", "logs", trcRes, "--attribute", "square:e2", "--cursor", "1:2"); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(ft.paths, "\n")
	for _, want := range []string{"limit=5", "since=10m", "tag=feature%3Aboard", "traceId=abc", "attr=square%3Ae2", "cursor=1%3A2"} {
		if !strings.Contains(got, want) {
			t.Errorf("query lacks %s:\n%s", want, got)
		}
	}
}

func TestTracerAttachmentChecksSha(t *testing.T) {
	png := []byte("\x89PNG fake screenshot bytes")
	ft := newFakeTracer(t, png)
	dir := t.TempDir()
	out := filepath.Join(dir, "shot.png")
	stdout, _, err := runLocal(t, ft, "tracer", "attachment", trcRes, "good", "-o", out)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(out); string(b) != string(png) || !strings.Contains(stdout, "bytes") {
		t.Fatalf("download %q", stdout)
	}
	bad := filepath.Join(dir, "bad.png")
	if _, _, err := runLocal(t, ft, "tracer", "attachment", trcRes, "bad", "-o", bad); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("bad sha accepted: %v", err)
	}
	if _, err := os.Stat(bad); !os.IsNotExist(err) {
		t.Fatal("a mismatching download was written")
	}
	left, _ := filepath.Glob(filepath.Join(dir, ".yyt-tracer-*"))
	if len(left) != 0 {
		t.Fatalf("temp files left: %v", left)
	}
	if _, _, err := runLocal(t, ft, "tracer", "attachment", trcRes, "missing", "-o", filepath.Join(dir, "m")); err == nil {
		t.Fatal("404 accepted")
	} else {
		var ae *api.Error
		if !errors.As(err, &ae) || ae.Status != 404 {
			t.Fatalf("404 not an api.Error (exit code 5): %v", err)
		}
	}
}

func TestTracerRefusals(t *testing.T) {
	ft := newFakeTracer(t, nil)
	t.Setenv("YYT_TRACER_LOCAL_TOKEN", trcToken)
	cases := []struct {
		name string
		env  map[string]string
		args []string
		want string
	}{
		{"remote http", map[string]string{"YYT_TRACER_LOCAL": "http://tracer.example"}, []string{"tracer", "events", trcRes}, "https only"},
		{"name with local", map[string]string{"YYT_TRACER_LOCAL": ft.srv.URL}, []string{"tracer", "events", "my-app"}, "trc_ id"},
		{"no token", map[string]string{"YYT_TRACER_LOCAL": ft.srv.URL, "YYT_TRACER_LOCAL_TOKEN": ""}, []string{"tracer", "events", trcRes}, "YYT_TRACER_LOCAL_TOKEN"},
		{"wrong token", map[string]string{"YYT_TRACER_LOCAL": ft.srv.URL, "YYT_TRACER_LOCAL_TOKEN": "yyt_" + strings.Repeat("f", 48)}, []string{"tracer", "events", trcRes}, "refused YYT_TRACER_LOCAL_TOKEN"},
		{"no -o", map[string]string{"YYT_TRACER_LOCAL": ft.srv.URL}, []string{"tracer", "attachment", trcRes, "good"}, "-o"},
	}
	for _, c := range cases {
		for k, v := range c.env {
			t.Setenv(k, v)
		}
		_, _, err := run(t, newFake(t, nil), c.args...)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", c.name, err)
		}
		t.Setenv("YYT_TRACER_LOCAL_TOKEN", trcToken)
	}
}

// Without --local the console resolves the resource; before the stage has a
// tracer-url the view has no readUrl and the CLI says so.
func TestTracerNotConfiguredOnStage(t *testing.T) {
	t.Setenv("YYT_TRACER_LOCAL", "")
	f := newFake(t, map[string]func(recorded) (int, any){
		"GET /tracers/" + trcRes: func(recorded) (int, any) { return 200, map[string]any{"id": trcRes, "name": "x", "readUrl": nil} },
	})
	_, _, err := run(t, f, "tracer", "events", trcRes)
	if err == nil || !strings.Contains(err.Error(), "not configured on this stage") {
		t.Fatalf("%v", err)
	}
	f2 := newFake(t, map[string]func(recorded) (int, any){
		"GET /tracers/" + trcRes: func(recorded) (int, any) {
			return 200, map[string]any{"id": trcRes, "name": "x", "readUrl": "http://tracer.example"}
		},
	})
	if _, _, err := run(t, f2, "tracer", "events", trcRes); err == nil || !strings.Contains(err.Error(), "https only") {
		t.Fatalf("plain http read URL accepted: %v", err)
	}
}

// Device text cannot forge a table row or reach the terminal raw.
func TestTracerOneLine(t *testing.T) {
	got := oneLine("x\n2026-01-01  error  Pixel  fake\r\t\u009b31m‮evil\x1b[2J")
	if strings.ContainsAny(got, "\n\r\t\x1b\u009b‮") {
		t.Fatalf("%q", got)
	}
	if err := checkTracerURL("https://user:pw@tracer.example", false); err == nil {
		t.Fatal("userinfo accepted")
	}
	if err := checkTracerURL("https://tracer.example/?x=1", false); err == nil {
		t.Fatal("query accepted")
	}
}
