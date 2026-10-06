package cmd

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	pushBasePath = "/channels/" + pushID + "/push"
	// A presigned URL's query is a credential: no output may hold it.
	signedMarker = "X-Amz-Signature=SIGNED-MARKER"
)

func sampleTemplate(over map[string]any) map[string]any {
	m := map[string]any{
		"id": "pt_01", "channelId": pushID, "name": "welcome",
		"title": "Hi {{name}}", "body": "Season {{season}} is open", "data": map[string]any{"screen": "season"},
		"variables": []string{"name", "season"},
		"createdBy": "m_1", "createdByLogin": "octo", "updatedBy": "m_1", "updatedByLogin": "octo",
		"createdAt": 1756000000, "updatedAt": 1756000100,
	}
	for k, v := range over {
		m[k] = v
	}
	return m
}

func sampleJob(over map[string]any) map[string]any {
	m := map[string]any{
		"id": "pj_01", "channelId": pushID, "kind": "campaign", "dryRun": false,
		"status": "queued", "error": nil, "errorDetails": nil, "cancelRequested": false,
		"idempotencyKey": "launch-1", "templateId": "pt_01", "uploadId": "pu_01",
		"message": map[string]any{"title": "Hi {{name}}", "body": "Season {{season}} is open", "data": map[string]any{"screen": "season"}},
		"options": map[string]any{}, "author": "m_1",
		"total": nil, "processed": 0,
		"counts": map[string]any{"resolved": 0, "sent": 0, "noToken": 0, "unregistered": 0, "failed": 0,
			"skipped": 0, "duplicates": 0, "missingVariables": 0, "invalid": 0},
		"report": nil, "createdAt": 1756000000, "startedAt": nil, "finishedAt": nil,
	}
	for k, v := range over {
		m[k] = v
	}
	return m
}

func doneJob(over map[string]any) map[string]any {
	m := sampleJob(map[string]any{
		"status": "done", "total": 1200, "processed": 1200,
		"counts": map[string]any{"resolved": 1180, "sent": 1170, "noToken": 15, "unregistered": 4, "failed": 6,
			"skipped": 5, "duplicates": 3, "missingVariables": 2, "invalid": 0},
		"options":   map[string]any{"priority": "high"},
		"report":    map[string]any{"available": true, "expiresAt": 1756604900},
		"startedAt": 1756000002, "finishedAt": 1756000100,
	})
	for k, v := range over {
		m[k] = v
	}
	return m
}

func writeCSV(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

type routes = map[string]func(recorded) (int, any)

func templatesRoute(rows ...any) func(recorded) (int, any) {
	return func(recorded) (int, any) { return 200, map[string]any{"templates": rows, "max": 20} }
}

// jobsRoute answers `GET …/jobs` as the console does: with `idempotencyKey`
// the one job the key holds (compared without case) or none, else the list.
func jobsRoute(rows ...any) func(recorded) (int, any) {
	if rows == nil {
		rows = []any{}
	}
	return func(r recorded) (int, any) {
		u, _ := url.Parse(r.Path)
		if u == nil || !u.Query().Has("idempotencyKey") {
			return 200, map[string]any{"jobs": rows, "next": nil}
		}
		held := []any{}
		for _, row := range rows {
			if j, ok := row.(map[string]any); ok && strings.EqualFold(fmt.Sprint(j["idempotencyKey"]), u.Query().Get("idempotencyKey")) {
				held = append(held, row)
				break
			}
		}
		return 200, map[string]any{"jobs": held, "next": nil}
	}
}

func reqPaths(f *fakeConsole) []string {
	out := make([]string, 0, len(f.reqs))
	for _, r := range f.reqs {
		out = append(out, r.Method+" "+r.Path)
	}
	return out
}

func TestPushTemplateCommands(t *testing.T) {
	dataOnly := sampleTemplate(map[string]any{"id": "pt_02", "name": "sync", "title": "", "body": "",
		"data": map[string]any{"kind": "sync"}, "variables": []string{}, "updatedByLogin": nil})
	var posted, patched map[string]any
	f := newFake(t, routes{
		"GET " + pushBasePath + "/templates": templatesRoute(dataOnly, sampleTemplate(nil)),
		"POST " + pushBasePath + "/templates": func(r recorded) (int, any) {
			posted = r.Body
			return 201, sampleTemplate(nil)
		},
		"PATCH " + pushBasePath + "/templates/pt_01": func(r recorded) (int, any) {
			patched = r.Body
			return 200, sampleTemplate(nil)
		},
		"DELETE " + pushBasePath + "/templates/pt_01": func(recorded) (int, any) { return 204, nil },
	})

	out, _, err := run(t, f, "push", "template", "ls", pushID)
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "push_template_list", out)

	// By name, without case; the variables are the CSV columns a job needs.
	out, _, err = run(t, f, "push", "template", "get", pushID, "WELCOME")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "push_template_get", out)
	byID, _, err := run(t, f, "push", "template", "get", pushID, "pt_01")
	if err != nil || byID != out {
		t.Fatalf("by id: %v\n%s", err, byID)
	}
	if _, _, err := run(t, f, "push", "template", "get", pushID, "nope"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Errorf("unknown template: %v", err)
	}

	// Flags only.
	if _, _, err := run(t, f, "push", "template", "create", pushID, "--name", "welcome", "--title", "Hi {{name}}",
		"--body", "Season {{season}} is open", "--data", "screen=season", "--data", "eq=a=b"); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"name": "welcome", "title": "Hi {{name}}", "body": "Season {{season}} is open",
		"data": map[string]any{"screen": "season", "eq": "a=b"}}
	if fmt.Sprint(posted) != fmt.Sprint(want) {
		t.Errorf("create body = %v", posted)
	}
	// A file (here a `get --json` view, whose view fields are dropped) with a flag on top.
	file := filepath.Join(t.TempDir(), "t.json")
	_ = os.WriteFile(file, []byte(`{"id":"pt_9","variables":["x"],"name":"from-file","title":"T","data":{"k":"v"},"updatedAt":1}`), 0o644)
	if _, _, err := run(t, f, "push", "template", "create", pushID, "--file", file, "--title", "Flag"); err != nil {
		t.Fatal(err)
	}
	want = map[string]any{"name": "from-file", "title": "Flag", "data": map[string]any{"k": "v"}}
	if fmt.Sprint(posted) != fmt.Sprint(want) {
		t.Errorf("file body = %v", posted)
	}
	// Refused before any request: a misspelt field, a non-string, no name.
	f.reqs = nil
	_ = os.WriteFile(file, []byte(`{"name":"x","titel":"T"}`), 0o644)
	if _, _, err := run(t, f, "push", "template", "create", pushID, "--file", file); err == nil || !strings.Contains(err.Error(), `unknown field "titel"`) {
		t.Errorf("misspelt field: %v", err)
	}
	_ = os.WriteFile(file, []byte(`{"name":"x","data":{"n":1}}`), 0o644)
	if _, _, err := run(t, f, "push", "template", "create", pushID, "--file", file); err == nil || !strings.Contains(err.Error(), "object of strings") {
		t.Errorf("non-string data: %v", err)
	}
	if _, _, err := run(t, f, "push", "template", "create", pushID, "--title", "T"); err == nil || !strings.Contains(err.Error(), "needs a name") {
		t.Errorf("no name: %v", err)
	}
	if _, _, err := run(t, f, "push", "template", "create", pushID, "--name", "x", "--data", "novalue"); err == nil || !strings.Contains(err.Error(), "key=value") {
		t.Errorf("bad --data: %v", err)
	}
	if _, _, err := run(t, f, "push", "template", "update", pushID, "welcome"); err == nil || !strings.Contains(err.Error(), "nothing to change") {
		t.Errorf("empty update: %v", err)
	}
	if len(f.reqs) != 0 {
		t.Errorf("requests for refused input: %v", reqPaths(f))
	}

	// PATCH carries only what was given; an empty title is sent (data-only).
	if _, _, err := run(t, f, "push", "template", "update", pushID, "welcome", "--title", "", "--clear-data"); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(patched) != fmt.Sprint(map[string]any{"title": "", "data": map[string]any{}}) {
		t.Errorf("patch body = %v", patched)
	}
	if _, _, err := run(t, f, "push", "template", "update", pushID, "welcome", "--clear-data", "--data", "a=b"); err == nil {
		t.Error("--clear-data with --data must be refused")
	}

	out, _, err = run(t, f, "push", "template", "rm", pushID, "welcome")
	if err != nil || out != "deleted template welcome (pt_01)\n" {
		t.Fatalf("rm: %v %q", err, out)
	}
}

func TestPushTemplateRefusals(t *testing.T) {
	var answer func() (int, any)
	f := newFake(t, routes{
		"POST " + pushBasePath + "/templates": func(recorded) (int, any) { return answer() },
	})
	for _, c := range []struct {
		status  int
		code    string
		details map[string]any
		want    string
	}{
		{409, "conflict", map[string]any{"reason": "push_template_name_taken"}, "names ignore case"},
		{409, "conflict", map[string]any{"reason": "push_template_cap", "max": 20}, "yyt push template rm"},
		{400, "bad_request", map[string]any{"reason": "push_payload_too_large"}, "4,096 bytes"},
		{429, "rate_limited", map[string]any{"retryAfterMs": 500}, "two writes a second"},
	} {
		answer = func() (int, any) { return c.status, apiErr(c.code, "refused", c.details) }
		_, _, err := run(t, f, "push", "template", "create", pushID, "--name", "x", "--title", "T")
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: %v", c.details, err)
		}
	}
}

func TestPushCSVHeaderCheck(t *testing.T) {
	for _, c := range []struct {
		name, content, want string
	}{
		{"ok", "userId,name\nu1,Ann\n", ""},
		{"bom and crlf", "\xef\xbb\xbfuserId,name\r\nu1,Ann\r\n", ""},
		{"quoted", "\"userId\",\"name\"\n", ""},
		{"empty", "", "holds no header"},
		{"blank", "\n\n", "holds no header"},
		{"no user column", "userid,name\n", "no userId column"},
		{"token", "userId,fcm_token\n", "device token"},
		{"token id", "userId,RegistrationId\n", "device token"},
		{"duplicate", "userId,name,name\n", "appears twice"},
		{"name", "userId,first name\n", "not a variable name"},
		{"quote", "userId,na\"me\n", "quote"},
		{"too many columns", manyColumns(33), "more than 32 columns"},
		{"long header", "userId," + strings.Repeat("a", 5000) + "\n", "longer than 1,024 bytes"},
	} {
		got, err := inspectPushCSV(writeCSV(t, c.content))
		switch {
		case c.want == "" && (err != nil || len(got.columns) != 2 || got.columns[0] != "userId" || got.sha256 != shaOf(c.content)):
			t.Errorf("%s: %v %+v", c.name, err, got)
		case c.want != "" && (err == nil || !strings.Contains(err.Error(), c.want) || !strings.Contains(err.Error(), "CSV line 1")):
			t.Errorf("%s: %v", c.name, err)
		}
	}
	// Names that hold "token" without being one are columns like any other.
	if _, err := inspectPushCSV(writeCSV(t, "userId,tokens_left,token_count\n")); err != nil {
		t.Errorf("variable names holding token: %v", err)
	}
	if _, err := inspectPushCSV(filepath.Join(t.TempDir(), "absent.csv")); err == nil || !strings.Contains(err.Error(), "--csv") {
		t.Errorf("absent file: %v", err)
	}
}

// manyColumns is a header of n distinct columns, userId first.
func manyColumns(n int) string {
	cols := []string{"userId"}
	for i := 1; i < n; i++ {
		cols = append(cols, fmt.Sprintf("c%d", i))
	}
	return strings.Join(cols, ",") + "\n"
}

// pushBucket stands in for the bucket a presigned PUT or GET goes to.
type pushBucket struct {
	srv     *httptest.Server
	puts    []string
	headers []http.Header
	status  int
	report  string
}

func newPushBucket(t *testing.T) *pushBucket {
	s := &pushBucket{status: 200, report: "userId,status,reason\nu1,sent,\n"}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = io.WriteString(w, s.report)
			return
		}
		b, _ := io.ReadAll(r.Body)
		s.puts = append(s.puts, string(b))
		s.headers = append(s.headers, r.Header.Clone())
		w.WriteHeader(s.status)
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *pushBucket) url() string { return s.srv.URL + "/obj?" + signedMarker }

func (s *pushBucket) grant(size any) map[string]any {
	return map[string]any{
		"uploadId": "pu_new", "url": s.url(), "method": "PUT",
		"headers":   map[string]any{"content-type": "text/csv", "content-length": fmt.Sprint(size)},
		"expiresAt": 1756000900, "usableUntil": 1756086400, "maxBytes": 102401024,
	}
}

const sampleCSV = "userId,name,season\nu1,Ann,2\nu2,Bob,2\n"

func TestPushJobSubmit(t *testing.T) {
	noSleep(t)
	s3 := newPushBucket(t)
	var uploads, jobBodies []map[string]any
	jobPosts := 0
	f := newFake(t, routes{
		"GET " + pushBasePath + "/templates": templatesRoute(sampleTemplate(nil)),
		"GET " + pushBasePath + "/jobs":      jobsRoute(),
		"POST " + pushBasePath + "/uploads": func(r recorded) (int, any) {
			uploads = append(uploads, r.Body)
			return 201, s3.grant(r.Body["size"])
		},
		"POST " + pushBasePath + "/jobs": func(r recorded) (int, any) {
			jobPosts++
			// Another write of the member holds the write slot: the submit
			// is idempotent, so it is repeated.
			if jobPosts == 1 {
				return 429, apiErr("rate_limited", "slow down", map[string]any{"retryAfterMs": 500})
			}
			jobBodies = append(jobBodies, r.Body)
			return 202, map[string]any{"job": sampleJob(map[string]any{"idempotencyKey": r.Body["idempotencyKey"], "uploadId": r.Body["uploadId"]}), "created": true}
		},
	})
	csv := writeCSV(t, sampleCSV)

	out, errs, err := run(t, f, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv,
		"--priority", "high", "--ttl", "0", "--collapse-key", "launch")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "push_job_submitted", out)
	if len(uploads) != 1 || fmt.Sprint(uploads[0]["size"]) != fmt.Sprint(len(sampleCSV)) {
		t.Fatalf("uploads = %v", uploads)
	}
	// The file goes up as it is, with the signed headers.
	if len(s3.puts) != 1 || s3.puts[0] != sampleCSV || s3.headers[0].Get("Content-Type") != "text/csv" ||
		s3.headers[0].Get("Content-Length") != fmt.Sprint(len(sampleCSV)) {
		t.Fatalf("PUT = %q %v", s3.puts, s3.headers)
	}
	key := derivedPushKey("-send", "campaign", "pt_01", shaOf(sampleCSV))
	b := jobBodies[0]
	if b["templateId"] != "pt_01" || b["uploadId"] != "pu_new" || b["idempotencyKey"] != key || b["priority"] != "high" ||
		fmt.Sprint(b["ttlSec"]) != "0" || b["collapseKey"] != "launch" {
		t.Errorf("job body = %v", b)
	}
	if _, has := b["dryRun"]; has {
		t.Errorf("dryRun must be absent on a real job: %v", b)
	}
	if !pushIdemKey.MatchString(key) {
		t.Errorf("derived key %q is not a key the server takes", key)
	}
	// The key and the dry run's are looked up by key, not by paging the list;
	// the upload is created once although the submit met a 429.
	sibling := derivedPushKey("-dry", "campaign", "pt_01", shaOf(sampleCSV))
	if got, want := strings.Join(reqPaths(f), "\n"), strings.Join([]string{
		"GET " + pushBasePath + "/templates",
		"GET " + pushBasePath + "/jobs?idempotencyKey=" + key,
		"GET " + pushBasePath + "/jobs?idempotencyKey=" + sibling,
		"POST " + pushBasePath + "/uploads",
		"POST " + pushBasePath + "/jobs",
		"POST " + pushBasePath + "/jobs",
	}, "\n"); got != want {
		t.Errorf("requests:\n%s\nwant:\n%s", got, want)
	}
	for _, want := range []string{"idempotency key: " + key, "uploaded " + csv, "submitted campaign pj_01", "yyt push job get " + pushID + " pj_01"} {
		if !strings.Contains(errs, want) {
			t.Errorf("stderr lacks %q:\n%s", want, errs)
		}
	}
	if strings.Contains(out+errs, "SIGNED-MARKER") {
		t.Errorf("the presigned URL leaked:\n%s%s", out, errs)
	}

	// A dry run of the same file has another key, and --dry-run in the body.
	if _, _, err := run(t, f, "push", "job", "submit", pushID, "--template", "pt_01", "--csv", csv, "--dry-run"); err != nil {
		t.Fatal(err)
	}
	b = jobBodies[1]
	if b["dryRun"] != true || b["idempotencyKey"] != derivedPushKey("-dry", "campaign", "pt_01", shaOf(sampleCSV)) || b["idempotencyKey"] == key {
		t.Errorf("dry-run body = %v", b)
	}
	// A given key is sent as it is.
	if _, errs, err = run(t, f, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv, "--idempotency-key", "launch-1"); err != nil {
		t.Fatal(err)
	}
	if jobBodies[2]["idempotencyKey"] != "launch-1" || strings.Contains(errs, "idempotency key:") {
		t.Errorf("given key: %v\n%s", jobBodies[2], errs)
	}

	// Refused before any request.
	f.reqs = nil
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"--template", "welcome", "--csv", writeCSV(t, "userId,token\n")}, "device token"},
		{[]string{"--template", "welcome", "--csv", csv, "--priority", "urgent"}, "--priority"},
		{[]string{"--template", "welcome", "--csv", csv, "--ttl", "9999999"}, "--ttl"},
		{[]string{"--template", "welcome", "--csv", csv, "--idempotency-key", "-bad"}, "--idempotency-key"},
		{[]string{"--template", "welcome"}, "csv"},
	} {
		if _, _, err := run(t, f, append([]string{"push", "job", "submit", pushID}, c.args...)...); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: %v", c.args, err)
		}
	}
	if len(f.reqs) != 0 {
		t.Errorf("requests for refused input: %v", reqPaths(f))
	}
	// A variable without a column costs the template read and nothing else.
	_, _, err = run(t, f, "push", "job", "submit", pushID, "--template", "welcome", "--csv", writeCSV(t, "userId,name\nu1,Ann\n"))
	if err == nil || !strings.Contains(err.Error(), "missing: season") {
		t.Errorf("missing column: %v", err)
	}
	if got := reqPaths(f); len(got) != 1 || got[0] != "GET "+pushBasePath+"/templates" {
		t.Errorf("requests = %v", got)
	}
}

// Running the same command again asks for the job the key names, with that
// job's upload: nothing is uploaded and the server replays.
func TestPushJobSubmitReplay(t *testing.T) {
	csv := writeCSV(t, sampleCSV)
	key := derivedPushKey("-send", "campaign", "pt_01", shaOf(sampleCSV))
	held := doneJob(map[string]any{"idempotencyKey": strings.ToUpper(key), "uploadId": "pu_old"})
	var body map[string]any
	f := newFake(t, routes{
		"GET " + pushBasePath + "/templates": templatesRoute(sampleTemplate(nil)),
		"GET " + pushBasePath + "/jobs":      jobsRoute(sampleJob(map[string]any{"id": "pj_other", "idempotencyKey": "x"}), held),
		"POST " + pushBasePath + "/jobs": func(r recorded) (int, any) {
			body = r.Body
			return 200, map[string]any{"job": held, "created": false}
		},
	})
	out, errs, err := run(t, f, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv, "--wait")
	if err != nil {
		t.Fatal(err)
	}
	if body["uploadId"] != "pu_old" || body["idempotencyKey"] != key {
		t.Errorf("replay body = %v", body)
	}
	if !strings.Contains(errs, "replayed campaign pj_01") || !strings.Contains(errs, "nothing was submitted or sent again") {
		t.Errorf("stderr:\n%s", errs)
	}
	golden(t, "push_job_get", out)
	for _, p := range reqPaths(f) {
		if strings.Contains(p, "/uploads") {
			t.Errorf("a replay must not upload: %v", reqPaths(f))
		}
		if strings.HasPrefix(p, "GET "+pushBasePath+"/jobs") && !strings.Contains(p, "?idempotencyKey=") {
			t.Errorf("the held job is read by its key, not from the list: %s", p)
		}
	}

	// A given key that names a job: said so, since the file is not compared.
	_, errs, err = run(t, f, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv, "--idempotency-key", key)
	if err != nil || !strings.Contains(errs, "is not uploaded or compared") {
		t.Errorf("given key replay: %v\n%s", err, errs)
	}

	// The key of a broadcast names no upload: refused here, with the hint.
	f2 := newFake(t, routes{
		"GET " + pushBasePath + "/templates": templatesRoute(sampleTemplate(nil)),
		"GET " + pushBasePath + "/jobs":      jobsRoute(sampleJob(map[string]any{"kind": "broadcast", "uploadId": nil, "idempotencyKey": "k1"})),
	})
	_, _, err = run(t, f2, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv, "--idempotency-key", "k1")
	if err == nil || !strings.Contains(err.Error(), "pass a new --idempotency-key") {
		t.Errorf("broadcast key: %v", err)
	}
}

// A dry run and the job after it share one upload; an upload that is gone is
// replaced by a fresh one.
func TestPushJobSubmitReusesDryRunUpload(t *testing.T) {
	noSleep(t)
	s3 := newPushBucket(t)
	csv := writeCSV(t, sampleCSV)
	dry := doneJob(map[string]any{"id": "pj_dry", "dryRun": true, "uploadId": "pu_dry",
		"idempotencyKey": derivedPushKey("-dry", "campaign", "pt_01", shaOf(sampleCSV))})
	expired := false
	var used []any
	f := newFake(t, routes{
		"GET " + pushBasePath + "/templates": templatesRoute(sampleTemplate(nil)),
		"GET " + pushBasePath + "/jobs":      jobsRoute(dry),
		"POST " + pushBasePath + "/uploads":  func(r recorded) (int, any) { return 201, s3.grant(r.Body["size"]) },
		"POST " + pushBasePath + "/jobs": func(r recorded) (int, any) {
			used = append(used, r.Body["uploadId"])
			if expired && r.Body["uploadId"] == "pu_dry" {
				return 409, apiErr("conflict", "the upload is too old; upload the file again", map[string]any{"reason": "upload_expired"})
			}
			return 202, map[string]any{"job": sampleJob(nil), "created": true}
		},
	})
	_, errs, err := run(t, f, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(used) != "[pu_dry]" || len(s3.puts) != 0 || !strings.Contains(errs, "reused the upload of campaign (dry run) pj_dry") {
		t.Errorf("used = %v, puts = %d\n%s", used, len(s3.puts), errs)
	}

	expired, used = true, nil
	_, errs, err = run(t, f, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(used) != "[pu_dry pu_new]" || len(s3.puts) != 1 || strings.Contains(errs, "reused") {
		t.Errorf("used = %v, puts = %d\n%s", used, len(s3.puts), errs)
	}
}

func TestPushJobSubmitWait(t *testing.T) {
	waits := noSleep(t)
	s3 := newPushBucket(t)
	csv := writeCSV(t, sampleCSV)
	var states []map[string]any
	gets := 0
	f := newFake(t, routes{
		"GET " + pushBasePath + "/templates": templatesRoute(sampleTemplate(nil)),
		"GET " + pushBasePath + "/jobs":      jobsRoute(),
		"POST " + pushBasePath + "/uploads":  func(r recorded) (int, any) { return 201, s3.grant(r.Body["size"]) },
		"POST " + pushBasePath + "/jobs": func(recorded) (int, any) {
			return 202, map[string]any{"job": sampleJob(map[string]any{"dryRun": true}), "created": true}
		},
		"GET " + pushBasePath + "/jobs/pj_01": func(recorded) (int, any) {
			s := states[min(gets, len(states)-1)]
			gets++
			return 200, map[string]any{"job": s}
		},
	})
	dryDone := doneJob(map[string]any{"dryRun": true, "total": 3, "processed": 3, "options": map[string]any{},
		"counts": map[string]any{"resolved": 1, "sent": 0, "noToken": 1, "unregistered": 0, "failed": 0,
			"skipped": 1, "duplicates": 1, "missingVariables": 0, "invalid": 0}})
	states = []map[string]any{
		sampleJob(map[string]any{"dryRun": true, "status": "running", "total": 3, "processed": 0}),
		sampleJob(map[string]any{"dryRun": true, "status": "running", "total": 3, "processed": 0}),
		dryDone,
	}
	out, errs, err := run(t, f, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv, "--dry-run", "--wait")
	if err != nil {
		t.Fatal(err)
	}
	// A dry run prints its numbers.
	golden(t, "push_job_dry_run", out)
	if gets != 3 || strings.Count(errs, "pj_01: running 0/3") != 1 || !strings.Contains(errs, "pj_01: queued") {
		t.Errorf("gets = %d\n%s", gets, errs)
	}
	for _, w := range *waits {
		if w != pushJobPoll {
			t.Errorf("poll interval %v", w)
		}
	}

	// A failed job is a failed command, with the request to make.
	gets = 0
	states = []map[string]any{sampleJob(map[string]any{"status": "failed", "error": "recipients_over_limit",
		"errorDetails": map[string]any{"limit": "push.recipientsPerJob", "value": 10000}, "finishedAt": 1756000050})}
	out, _, err = run(t, f, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv, "--wait")
	want := `yyt limit request push.recipientsPerJob <value> --channel ` + pushID + ` --reason "..."`
	if err == nil || !strings.Contains(err.Error(), "job pj_01 failed: recipients_over_limit") || !strings.Contains(err.Error(), want) {
		t.Errorf("failed job: %v", err)
	}
	if !strings.Contains(out, "status:       failed") || !strings.Contains(out, want) {
		t.Errorf("the job is still printed:\n%s", out)
	}

	// The wait gives up; the job does not.
	gets = 0
	states = []map[string]any{sampleJob(map[string]any{"status": "running"})}
	_, _, err = run(t, f, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv, "--wait", "--timeout", "7s")
	if err == nil || !strings.Contains(err.Error(), "still running after 7s") || !strings.Contains(err.Error(), "yyt push job get") {
		t.Errorf("timeout: %v", err)
	}
}

func TestPushJobFailures(t *testing.T) {
	str := func(s string) *string { return &s }
	for code := range pushJobErrors {
		if got := pushJobFailure(pushJob{Error: str(code)}); !strings.HasPrefix(got, code+" (") {
			t.Errorf("%s: %q", code, got)
		}
	}
	got := pushJobFailure(pushJob{Error: str("csv_invalid"), ErrorDetails: []byte(`{"reason":"column_count","line":42}`)})
	if !strings.Contains(got, "CSV line 42: the row does not have as many fields as the header") || !strings.Contains(got, "nothing was sent") {
		t.Errorf("csv_invalid: %q", got)
	}
	got = pushJobFailure(pushJob{Error: str("csv_invalid"), ErrorDetails: []byte(`{"reason":"no_rows","line":2}`)})
	if !strings.Contains(got, "a header and no rows") {
		t.Errorf("no_rows: %q", got)
	}
	if got := pushJobFailure(pushJob{Error: str("something_new")}); got != "something_new" {
		t.Errorf("unknown: %q", got)
	}
	// Every rule the server's reader names has words.
	for _, r := range []string{"empty", "invalid_utf8", "nul_byte", "bare_cr", "quote", "unterminated_quote", "row_too_long",
		"field_too_long", "too_many_columns", "column_count", "header_name", "duplicate_header", "user_column_missing",
		"token_column", "no_rows", "missing_columns"} {
		if _, ok := pushCSVReasons[r]; !ok {
			t.Errorf("no words for CSV rule %s", r)
		}
	}
}

// Every refusal of a submit names the next step.
func TestPushSubmitRefusals(t *testing.T) {
	noSleep(t)
	s3 := newPushBucket(t)
	csv := writeCSV(t, sampleCSV)
	var answer func() (int, any)
	drops, dropStatus := 0, []int{}
	f := newFake(t, routes{
		"GET " + pushBasePath + "/templates": templatesRoute(sampleTemplate(nil)),
		"GET " + pushBasePath + "/jobs":      jobsRoute(),
		"POST " + pushBasePath + "/uploads":  func(r recorded) (int, any) { return 201, s3.grant(r.Body["size"]) },
		"POST " + pushBasePath + "/jobs":     func(recorded) (int, any) { return answer() },
		"DELETE " + pushBasePath + "/uploads/pu_new": func(recorded) (int, any) {
			drops++
			if len(dropStatus) > 0 {
				st := dropStatus[0]
				dropStatus = dropStatus[1:]
				return st, apiErr("x", "refused", nil)
			}
			return 204, nil
		},
	})
	for _, c := range []struct {
		status  int
		code    string
		message string
		details map[string]any
		want    string
	}{
		{400, "bad_request", "the CSV cannot be read", map[string]any{"reason": "csv_invalid", "csv": "bare_cr", "line": 1}, "CSV line 1: a CR without an LF"},
		{400, "bad_request", "the CSV lacks a column the template names", map[string]any{"reason": "csv_missing_columns", "columns": []string{"name", "season"}}, "a column for each of: name, season"},
		{409, "conflict", "the channel submitted 10 of 10 jobs today", map[string]any{"limit": "push.jobsPerDay", "value": 10},
			`(ask for more: yyt limit request push.jobsPerDay <value> --channel ` + pushID + ` --reason "...")`},
		{409, "conflict", "reused", map[string]any{"reason": "idempotency_key_reused"}, "pass a new --idempotency-key"},
		{409, "conflict", "missing", map[string]any{"reason": "upload_missing"}, "run the command again"},
		{409, "conflict", "size", map[string]any{"reason": "upload_size_mismatch"}, "signed size"},
		{409, "conflict", "old", map[string]any{"reason": "upload_expired"}, "older than 24 hours"},
		// The cap is worded from the answer's `max`, whatever it is.
		{409, "conflict", "dry", map[string]any{"reason": "push_dry_run_cap", "max": 20}, "(20 dry runs a day and channel; the count resets at 00:00 UTC)"},
		{409, "conflict", "dry", map[string]any{"reason": "push_dry_run_cap", "max": 7}, "(7 dry runs a day and channel"},
		{409, "conflict", "dry", map[string]any{"reason": "push_dry_run_cap"}, "(the channel ran its dry runs of the day"},
		{409, "conflict", "push channel registration is not finished", map[string]any{"reason": "push_not_registered"}, "yyt push channel sender-key set"},
		{410, "gone", "x", map[string]any{"reason": "channel_inactive"}, "yyt push channel extend " + pushID},
		{503, "unavailable", "push not configured", map[string]any{"reason": "push_not_configured"}, "a --dry-run is still accepted"},
		{503, "unavailable", "x", map[string]any{"reason": "push_sender_unavailable"}, "a platform admin's to fix"},
		{503, "unavailable", "x", map[string]any{"reason": "push_storage_unavailable"}, "no storage for recipient files"},
		// An older console: no reason, told by status and message.
		{410, "gone", "channel expired or disabled", nil, "yyt push channel extend " + pushID},
		{503, "unavailable", "push sender unavailable", nil, "a platform admin's to fix"},
		{503, "unavailable", "push storage unavailable", nil, "no storage for recipient files"},
		{503, "unavailable", "channel secret cannot be read", nil, "try again shortly"},
	} {
		answer = func() (int, any) { return c.status, apiErr(c.code, c.message, c.details) }
		drops = 0
		_, errs, err := run(t, f, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", c.message, err)
		}
		if err != nil && strings.Contains(err.Error()+errs, "SIGNED-MARKER") {
			t.Errorf("%s: the presigned URL leaked", c.message)
		}
		// A refusal recorded no job, so the upload made for it is removed;
		// after a 5xx a job may exist, and the upload is left.
		if want := map[bool]int{true: 1, false: 0}[c.status < 500]; drops != want {
			t.Errorf("%d %s: upload deletes = %d, want %d", c.status, c.message, drops, want)
		}
	}

	// The delete takes the write slot the refused submit just took: a 429 is
	// retried. Any other failure of it is not the command's error.
	answer = func() (int, any) {
		return 409, apiErr("conflict", "reused", map[string]any{"reason": "idempotency_key_reused"})
	}
	drops, dropStatus = 0, []int{429}
	if _, _, err := run(t, f, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv); err == nil || drops != 2 {
		t.Errorf("delete after a 429: drops = %d, %v", drops, err)
	}
	drops, dropStatus = 0, []int{409}
	if _, _, err := run(t, f, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv); err == nil ||
		!strings.Contains(err.Error(), "pass a new --idempotency-key") || drops != 1 {
		t.Errorf("a failed delete: drops = %d, %v", drops, err)
	}

	// The upload's own refusals, and a bucket that refuses the PUT.
	f2 := newFake(t, routes{
		"GET " + pushBasePath + "/templates": templatesRoute(sampleTemplate(nil)),
		"GET " + pushBasePath + "/jobs":      jobsRoute(),
		"POST " + pushBasePath + "/uploads": func(recorded) (int, any) {
			return 409, apiErr("conflict", "the channel holds 20 uploads", map[string]any{"reason": "push_upload_cap", "max": 20})
		},
	})
	if _, _, err := run(t, f2, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv); err == nil || !strings.Contains(err.Error(), "wait for the oldest") {
		t.Errorf("upload cap: %v", err)
	}
	// The upload route takes no write slot: its 429 is not waited out.
	posts := 0
	f3 := newFake(t, routes{
		"GET " + pushBasePath + "/templates": templatesRoute(sampleTemplate(nil)),
		"GET " + pushBasePath + "/jobs":      jobsRoute(),
		"POST " + pushBasePath + "/uploads": func(recorded) (int, any) {
			posts++
			return 429, apiErr("rate_limited", "slow down", map[string]any{"retryAfterMs": 500})
		},
	})
	if _, _, err := run(t, f3, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv); err == nil || posts != 1 || !strings.Contains(err.Error(), "two writes a second") {
		t.Errorf("upload 429: posts = %d, %v", posts, err)
	}
	// A PUT the bucket refuses leaves an upload nothing names: removed.
	s3.status = 403
	drops = 0
	_, errs, err := run(t, f, "push", "job", "submit", pushID, "--template", "welcome", "--csv", csv)
	if err == nil || !strings.Contains(err.Error(), "upload PUT failed: HTTP 403") || strings.Contains(err.Error()+errs, "SIGNED-MARKER") || drops != 1 {
		t.Errorf("PUT 403: drops = %d, %v\n%s", drops, err, errs)
	}
}

func TestPushJobListGetCancel(t *testing.T) {
	next := "1756000000.pj_00"
	failed := sampleJob(map[string]any{"id": "pj_02", "status": "failed", "error": "canceled", "idempotencyKey": "k2", "total": 10, "finishedAt": 1756000200})
	bcast := doneJob(map[string]any{"id": "pj_03", "kind": "broadcast", "templateId": nil, "uploadId": nil, "total": 2, "idempotencyKey": "k3",
		"counts": map[string]any{"resolved": 0, "sent": 1, "noToken": 0, "unregistered": 0, "failed": 1,
			"skipped": 0, "duplicates": 0, "missingVariables": 0, "invalid": 0}, "report": nil})
	var listed string
	f := newFake(t, routes{
		"GET " + pushBasePath + "/jobs": func(r recorded) (int, any) {
			listed = r.Path
			return 200, map[string]any{"jobs": []any{bcast, failed, doneJob(map[string]any{"dryRun": true})}, "next": next}
		},
		"GET " + pushBasePath + "/jobs/pj_03": func(recorded) (int, any) { return 200, map[string]any{"job": bcast} },
		"GET " + pushBasePath + "/jobs/pj_04": func(recorded) (int, any) {
			return 200, map[string]any{"job": doneJob(map[string]any{"id": "pj_04", "cancelRequested": true})}
		},
		"POST " + pushBasePath + "/jobs/pj_01/cancel": func(recorded) (int, any) {
			return 200, map[string]any{"job": sampleJob(map[string]any{"status": "running", "cancelRequested": true})}
		},
	})
	out, errs, err := run(t, f, "push", "job", "ls", pushID, "--limit", "3", "--cursor", "1756000300.pj_09")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "push_job_list", out)
	if !strings.HasSuffix(listed, "/jobs?cursor=1756000300.pj_09&limit=3") || !strings.Contains(errs, "more: --cursor "+next) {
		t.Errorf("list path = %s\n%s", listed, errs)
	}
	if _, _, err := run(t, f, "push", "job", "ls", pushID, "--limit", "500"); err == nil {
		t.Error("--limit 500 must be refused")
	}

	out, _, err = run(t, f, "push", "job", "get", pushID, "pj_03")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "push_job_broadcast_get", out)
	if out, _, err = run(t, f, "push", "job", "get", pushID, "pj_03", "--json"); err != nil || !strings.Contains(out, `"kind": "broadcast"`) || strings.Contains(out, `"job"`) {
		t.Errorf("--json is the job: %v\n%s", err, out)
	}

	out, errs, err = run(t, f, "push", "job", "cancel", pushID, "pj_01")
	if err != nil || !strings.Contains(out, "running (cancel requested)") || !strings.Contains(errs, "cancel requested") {
		t.Errorf("cancel: %v\n%s\n%s", err, out, errs)
	}
	// A cancel during the last batch: the job is done, and that is said
	// instead of an error or a pending cancel.
	out, errs, err = run(t, f, "push", "job", "get", pushID, "pj_04")
	if err != nil || !strings.Contains(out, "status:       done (finished before the cancel took effect)") || strings.Contains(out, "error:") || errs != "" {
		t.Errorf("late cancel: %v\n%s\n%s", err, out, errs)
	}
	f.reqs = nil
	if _, _, err := run(t, f, "push", "job", "get", pushID, "../x"); err == nil || !strings.Contains(err.Error(), "not a job id") || len(f.reqs) != 0 {
		t.Errorf("bad job id: %v %v", err, reqPaths(f))
	}
}

func TestPushJobReport(t *testing.T) {
	noSleep(t)
	s3 := newPushBucket(t)
	var answer func() (int, any)
	f := newFake(t, routes{
		"GET " + pushBasePath + "/jobs/pj_01/report": func(recorded) (int, any) { return answer() },
	})
	answer = func() (int, any) {
		return 200, map[string]any{"url": s3.url(), "expiresAt": 1756000300, "reportExpiresAt": 1756604900}
	}
	t.Chdir(t.TempDir())

	out, errs, err := run(t, f, "push", "job", "report", pushID, "pj_01")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile("push-report-pj_01.csv")
	if string(got) != s3.report || out != "" || !strings.Contains(errs, "wrote push-report-pj_01.csv") || strings.Contains(out+errs, "SIGNED-MARKER") ||
		!strings.Contains(errs, "invalid-value") {
		t.Fatalf("report: %q\n%s%s", got, out, errs)
	}
	// Kept unless --force, and refused before any request.
	f.reqs = nil
	if _, _, err := run(t, f, "push", "job", "report", pushID, "pj_01"); err == nil || !strings.Contains(err.Error(), "--force") || len(f.reqs) != 0 {
		t.Errorf("overwrite: %v %v", err, reqPaths(f))
	}
	if _, _, err := run(t, f, "push", "job", "report", pushID, "pj_01", "--force"); err != nil {
		t.Errorf("--force: %v", err)
	}
	out, _, err = run(t, f, "push", "job", "report", pushID, "pj_01", "-o", "-")
	if err != nil || out != s3.report {
		t.Errorf("-o -: %v %q", err, out)
	}
	// The URL only when asked for.
	out, errs, err = run(t, f, "push", "job", "report", pushID, "pj_01", "--url")
	if err != nil || out != s3.url()+"\n" || !strings.Contains(errs, "works until 2025-08-24T01:51:40Z") {
		t.Errorf("--url: %v %q\n%s", err, out, errs)
	}
	if _, _, err := run(t, f, "push", "job", "report", pushID, "pj_01", "--url", "-o", "x.csv"); err == nil {
		t.Error("--url with -o must be refused")
	}

	for _, c := range []struct {
		status  int
		code    string
		message string
		details map[string]any
		want    string
	}{
		{409, "conflict", "the job has not finished", map[string]any{"reason": "report_not_ready"}, "yyt push job get"},
		{409, "conflict", "the job has no report", map[string]any{"reason": "report_absent"}, "nothing to report"},
		{410, "gone", "x", map[string]any{"reason": "report_expired"}, "kept 7 days"},
		{410, "gone", "x", map[string]any{"reason": "channel_inactive"}, "yyt push channel extend"},
		{503, "unavailable", "x", map[string]any{"reason": "push_storage_unavailable"}, "no storage"},
		// An older console: no reason.
		{410, "gone", "the report expired", nil, "kept 7 days"},
		{503, "unavailable", "push storage unavailable", nil, "no storage"},
	} {
		answer = func() (int, any) { return c.status, apiErr(c.code, c.message, c.details) }
		if _, _, err := run(t, f, "push", "job", "report", pushID, "pj_01", "-o", "other.csv"); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", c.message, err)
		}
	}
}

func TestPushBroadcast(t *testing.T) {
	noSleep(t)
	prev := pushNow
	day := time.Date(2026, 10, 6, 23, 59, 0, 0, time.UTC)
	pushNow = func() time.Time { return day }
	t.Cleanup(func() { pushNow = prev })

	plain := sampleTemplate(map[string]any{"id": "pt_03", "name": "maintenance", "title": "Maintenance", "body": "", "variables": []string{}})
	var bodies []map[string]any
	created := true
	f := newFake(t, routes{
		"GET " + pushBasePath + "/templates": templatesRoute(sampleTemplate(nil), plain),
		"POST " + pushBasePath + "/broadcast": func(r recorded) (int, any) {
			bodies = append(bodies, r.Body)
			status := 202
			if !created {
				status = 200
			}
			return status, map[string]any{"job": sampleJob(map[string]any{"kind": "broadcast", "templateId": nil, "uploadId": nil}), "created": created}
		},
	})
	_, errs, err := run(t, f, "push", "broadcast", pushID, "--title", "Maintenance at 03:00", "--body", "About 20 minutes", "--data", "screen=home", "--priority", "high")
	if err != nil {
		t.Fatal(err)
	}
	b := bodies[0]
	key, _ := b["idempotencyKey"].(string)
	if b["title"] != "Maintenance at 03:00" || b["body"] != "About 20 minutes" || fmt.Sprint(b["data"]) != "map[screen:home]" ||
		b["priority"] != "high" || !pushIdemKey.MatchString(key) || !strings.HasSuffix(key, "-20261006") {
		t.Errorf("broadcast body = %v", b)
	}
	if _, has := b["templateId"]; has {
		t.Errorf("an inline broadcast names no template: %v", b)
	}
	if !strings.Contains(errs, "idempotency key: "+key) || !strings.Contains(errs, "submitted broadcast pj_01") {
		t.Errorf("stderr:\n%s", errs)
	}

	// The same command the same day: the same key, and the replay is said.
	created = false
	_, errs, err = run(t, f, "push", "broadcast", pushID, "--title", "Maintenance at 03:00", "--body", "About 20 minutes", "--data", "screen=home", "--priority", "high")
	if err != nil || bodies[1]["idempotencyKey"] != key || !strings.Contains(errs, "nothing was submitted or sent again") {
		t.Errorf("replay: %v %v\n%s", err, bodies[1], errs)
	}
	created = true
	// Another option, another message or another day is another key.
	day = day.Add(time.Minute)
	_, _, _ = run(t, f, "push", "broadcast", pushID, "--title", "Maintenance at 03:00", "--body", "About 20 minutes", "--data", "screen=home", "--priority", "high")
	_, _, _ = run(t, f, "push", "broadcast", pushID, "--title", "Maintenance at 03:00", "--body", "About 20 minutes", "--data", "screen=home")
	_, _, _ = run(t, f, "push", "broadcast", pushID, "--title", "Maintenance at 04:00", "--body", "About 20 minutes", "--data", "screen=home")
	seen := map[any]bool{key: true}
	for _, b := range bodies[2:5] {
		if seen[b["idempotencyKey"]] {
			t.Errorf("key repeats: %v", b["idempotencyKey"])
		}
		seen[b["idempotencyKey"]] = true
	}

	// A template without variables, by name; a given key is sent as it is.
	if _, _, err := run(t, f, "push", "broadcast", pushID, "--template", "maintenance", "--idempotency-key", "m:1"); err != nil {
		t.Fatal(err)
	}
	b = bodies[5]
	if b["templateId"] != "pt_03" || b["idempotencyKey"] != "m:1" || b["title"] != nil {
		t.Errorf("template broadcast = %v", b)
	}

	// Refused before the broadcast route is called.
	n := len(bodies)
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"--template", "welcome"}, "names variables (name, season)"},
		{[]string{"--template", "maintenance", "--title", "x"}, "either --template or a literal message"},
		{nil, "either --template or a literal message"},
		{[]string{"--title", "x", "--idempotency-key", "bad key"}, "--idempotency-key"},
	} {
		if _, _, err := run(t, f, append([]string{"push", "broadcast", pushID}, c.args...)...); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: %v", c.args, err)
		}
	}
	if len(bodies) != n {
		t.Errorf("a refused broadcast was sent")
	}
	// No confirmation flag exists: no yyt command prompts.
	if _, _, err := run(t, f, "push", "broadcast", pushID, "--title", "x", "--yes"); err == nil || !strings.Contains(err.Error(), "unknown flag") {
		t.Errorf("--yes: %v", err)
	}
}

func TestPushBroadcastRefusals(t *testing.T) {
	noSleep(t)
	var answer func() (int, any)
	f := newFake(t, routes{
		"POST " + pushBasePath + "/broadcast": func(recorded) (int, any) { return answer() },
	})
	for _, c := range []struct {
		status  int
		message string
		details map[string]any
		want    string
	}{
		{400, "a broadcast message cannot hold {{variables}}", map[string]any{"reason": "template_has_variables"}, "no row to fill"},
		{400, "the message exceeds 4096 bytes", map[string]any{"reason": "push_payload_too_large"}, "shorten it"},
		{409, "the channel submitted 10 of 10 jobs today", map[string]any{"limit": "push.jobsPerDay", "value": 10},
			`yyt limit request push.jobsPerDay <value> --channel ` + pushID + ` --reason "..."`},
		{409, "push channel registration is not finished", map[string]any{"reason": "push_not_registered"}, "sender-key set"},
		{503, "push not configured", map[string]any{"reason": "push_not_configured"}, "platform admin"},
	} {
		answer = func() (int, any) { return c.status, apiErr("x", c.message, c.details) }
		if _, _, err := run(t, f, "push", "broadcast", pushID, "--title", "{{x}}"); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", c.message, err)
		}
	}
}

// The campaign limits start with `push.` and belong to a push channel.
func TestPushChannelLimitScope(t *testing.T) {
	var body map[string]any
	f := newFake(t, routes{
		"POST /limit-requests": func(r recorded) (int, any) {
			body = r.Body
			return 201, map[string]any{"id": "lr_1", "scope": map[string]any{"kind": "channel", "id": pushID, "name": "alerts"},
				"key": "push.jobsPerDay", "unit": "count", "value": 30, "status": "pending", "reason": "launch week", "createdAt": 1756000000}
		},
	})
	for _, key := range []string{"push.jobsPerDay", "push.recipientsPerJob"} {
		if _, _, err := run(t, f, "limit", "request", key, "30", "--reason", "launch week"); err == nil || !strings.Contains(err.Error(), "--channel <push channel>") {
			t.Errorf("%s without --channel: %v", key, err)
		}
	}
	if len(f.reqs) != 0 {
		t.Errorf("requests = %v", reqPaths(f))
	}
	if _, _, err := run(t, f, "limit", "request", "push.jobsPerDay", "30", "--channel", pushID, "--reason", "launch week"); err != nil {
		t.Fatal(err)
	}
	if body["scope"] != "channel:"+pushID || body["key"] != "push.jobsPerDay" || fmt.Sprint(body["value"]) != "30" {
		t.Errorf("request body = %v", body)
	}
	if isTeamLimit("push.jobsPerDay") || !isTeamLimit("push.appsPerTeam") {
		t.Error("only push.appsPerTeam is a team limit")
	}
}
