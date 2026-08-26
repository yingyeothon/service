package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yingyeothon/service/cli/internal/config"
)

func TestIsID(t *testing.T) {
	for _, id := range []string{"team_1", "prj_x", "auth_0123", "ca_9", "ab_1", "AUTH_UP", "m_1", "art_2"} {
		if !IsID(id) {
			t.Errorf("%q should be an id", id)
		}
	}
	for _, name := range []string{"dooroo", "my-game", "team", "team-1", "authy", "q", "1.0.0"} {
		if IsID(name) {
			t.Errorf("%q should be a name", name)
		}
	}
}

// findContextFile walks up from the start directory, stops at a git root or
// $HOME, and ignores unreadable/malformed files.
func TestFindContextFile(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root) // never walk above the sandbox
	repo := filepath.Join(root, "repo")
	deep := filepath.Join(repo, "apps", "game")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	// Above the git root: must never be found.
	_ = os.WriteFile(filepath.Join(root, ContextFile), []byte(`{"team":"outside"}`), 0o644)
	if cf, p := findContextFile(deep); p != "" {
		t.Fatalf("found %v at %s above the git root", cf, p)
	}
	// At the git root: found from a subdirectory.
	_ = os.WriteFile(filepath.Join(repo, ContextFile), []byte(`{"team":"dooroo","project":"game"}`), 0o644)
	cf, p := findContextFile(deep)
	if cf.Team != "dooroo" || cf.Project != "game" || p != filepath.Join(repo, ContextFile) {
		t.Fatalf("got %+v at %s", cf, p)
	}
	// A nearer malformed file is skipped, not fatal, and the search continues.
	_ = os.WriteFile(filepath.Join(deep, ContextFile), []byte(`{oops`), 0o644)
	if cf, _ := findContextFile(deep); cf.Team != "dooroo" {
		t.Fatalf("malformed file must be skipped, got %+v", cf)
	}
	// A world-writable directory ends the search before its file is read.
	shared := filepath.Join(root, "shared")
	_ = os.MkdirAll(shared, 0o777)
	_ = os.Chmod(shared, 0o777)
	_ = os.WriteFile(filepath.Join(shared, ContextFile), []byte(`{"team":"planted"}`), 0o644)
	if cf, p := findContextFile(shared); p != "" {
		t.Fatalf("world-writable dir must be skipped, got %+v", cf)
	}
	// A nearer valid file wins; a file path as start uses its directory.
	_ = os.WriteFile(filepath.Join(deep, ContextFile), []byte(`{"project":"other"}`), 0o644)
	cf, _ = findContextFile(filepath.Join(deep, "pubspec.yaml"))
	if cf.Project != "other" || cf.Team != "" {
		t.Fatalf("nearest file must win, got %+v", cf)
	}
}

// contextSpec layers flag > env > .yyt.json > profile, per field.
func TestContextSpecLayering(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	_ = os.WriteFile(filepath.Join(dir, ContextFile), []byte(`{"team":"file-team","project":"file-prj"}`), 0o644)
	cfg := config.Config{Team: "team_prof", Project: "prj_prof"}

	a := &App{}
	s := a.contextSpec(dir, cfg)
	if s.Team != "file-team" || s.Project != "file-prj" || s.TeamSource != filepath.Join(dir, ContextFile) {
		t.Fatalf("file must beat profile: %+v", s)
	}
	t.Setenv("YYT_PROJECT", "env-prj")
	s = a.contextSpec(dir, cfg)
	if s.Team != "file-team" || s.Project != "env-prj" || s.ProjectSource != "env" {
		t.Fatalf("env must beat file per field: %+v", s)
	}
	a.teamFlag = "flag-team"
	s = a.contextSpec(dir, cfg)
	if s.Team != "flag-team" || s.TeamSource != "flag" || s.Project != "" {
		t.Fatalf("flag team must drop the lower-layer project: %+v", s)
	}
	a.projectFlag = "flag-prj"
	if s = a.contextSpec(dir, cfg); s.Project != "flag-prj" || s.ProjectSource != "flag" {
		t.Fatalf("flag project: %+v", s)
	}
	a.projectFlag = ""
	// Nothing but the profile.
	t.Setenv("YYT_PROJECT", "")
	a.teamFlag = ""
	s = a.contextSpec(t.TempDir(), cfg)
	if s.Team != "team_prof" || s.Project != "prj_prof" || s.TeamSource != "profile" {
		t.Fatalf("profile fallback: %+v", s)
	}
	if s = a.contextSpec(t.TempDir(), config.Config{}); s.explicitTeam() || s.explicitProject() {
		t.Fatalf("empty: %+v", s)
	}
	// A project from a lower layer than the team is dropped, never combined.
	a.teamFlag = "other"
	if s = a.contextSpec(t.TempDir(), cfg); s.Team != "other" || s.Project != "" {
		t.Fatalf("profile project must not survive a flag team: %+v", s)
	}
	t.Setenv("YYT_PROJECT", "env-prj")
	if s = a.contextSpec(t.TempDir(), cfg); s.Project != "" {
		t.Fatalf("env project must not survive a flag team: %+v", s)
	}
	a.teamFlag = ""
	if s = a.contextSpec(dir, cfg); s.Team != "file-team" || s.Project != "env-prj" {
		t.Fatalf("env project may combine with a file team: %+v", s)
	}
}

// --team and --project at the same layer must agree.
func TestContextTeamProjectMismatch(t *testing.T) {
	other := map[string]any{"id": "team_2", "name": "platform", "role": "member"}
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /teams":              func(recorded) (int, any) { return 200, map[string]any{"teams": []any{sampleTeam, other}} },
		"GET /channels/auth_0123": func(recorded) (int, any) { return 200, sampleChannel },
	}, []any{sampleChannel}, nil, nil))
	_, _, err := run(t, f, "channels", "get", "demo", "--team", "platform", "--project", "prj_1")
	if err == nil || !strings.Contains(err.Error(), "belongs to team dooroo, not platform") {
		t.Fatalf("err=%v", err)
	}
	if _, _, err := run(t, f, "channels", "get", "demo", "--team", "dooroo", "--project", "prj_1"); err != nil {
		t.Fatal(err)
	}
}

// `team use` / `project use` pin the context in the profile; the pins survive
// a --token override (which blanks the profile name) and a re-login.
func TestTeamAndProjectUsePinTheProfile(t *testing.T) {
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /me": func(recorded) (int, any) {
			return 200, map[string]any{"id": "m_1", "login": "octo", "role": "member", "via": "token"}
		},
		"GET /channels/auth_0123":   func(recorded) (int, any) { return 200, sampleChannel },
		"PATCH /channels/auth_0123": func(recorded) (int, any) { return 200, sampleChannel },
	}, []any{sampleChannel}, nil, nil))
	cfgPath := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("YYT_CONFIG", cfgPath)
	t.Setenv("YYT_API", "")
	t.Setenv("YYT_TOKEN", "")
	exec := func(args ...string) (string, error) {
		var out strings.Builder
		root := NewRoot(&App{Out: &out, Err: &out})
		root.SetArgs(args)
		err := root.Execute()
		return out.String(), err
	}
	// Without a profile there is nowhere to store the pin.
	if _, err := exec("team", "use", "dooroo", "--api", f.srv.URL, "--token", "yyt_t"); err == nil || !strings.Contains(err.Error(), "no profile") {
		t.Fatalf("err=%v", err)
	}
	if _, err := exec("login", "--api", f.srv.URL, "--token", "yyt_t"); err != nil {
		t.Fatal(err)
	}
	out, err := exec("team", "use", "dooroo")
	if err != nil || !strings.Contains(out, "team dooroo (team_1)") {
		t.Fatalf("%v\n%s", err, out)
	}
	file, _ := config.LoadFile()
	if pr := file.Profiles["default"]; pr.Team != "team_1" || pr.Project != "" {
		t.Fatalf("profile %+v", pr)
	}
	// A team pin alone does not satisfy a write: the project is still missing.
	if _, err := exec("channels", "update", "demo", "--name", "demo2"); err == nil || !strings.Contains(err.Error(), "no project context") {
		t.Fatalf("err=%v", err)
	}
	if _, err := exec("project", "use", "game"); err != nil {
		t.Fatal(err)
	}
	// Now the write has its context from the profile — even with an
	// overriding token, which blanks the profile *credential*, not the pin.
	if _, err := exec("channels", "update", "demo", "--name", "demo2", "--token", "yyt_other"); err != nil {
		t.Fatal(err)
	}
	file, _ = config.LoadFile()
	if pr := file.Profiles["default"]; pr.Team != "team_1" || pr.Project != "prj_1" {
		t.Fatalf("profile %+v", pr)
	}
	// Re-login keeps the pins; switching team clears the project pin.
	if _, err := exec("login", "--api", f.srv.URL, "--token", "yyt_t2"); err != nil {
		t.Fatal(err)
	}
	file, _ = config.LoadFile()
	if pr := file.Profiles["default"]; pr.Token != "yyt_t2" || pr.Project != "prj_1" {
		t.Fatalf("re-login must keep the pins: %+v", pr)
	}
	if _, err := exec("team", "use", "team_1"); err != nil {
		t.Fatal(err)
	}
	file, _ = config.LoadFile()
	if pr := file.Profiles["default"]; pr.Project != "" {
		t.Fatalf("team use must clear the project pin: %+v", pr)
	}
	// An unknown team name is refused before anything is stored.
	if _, err := exec("team", "use", "nobody"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("err=%v", err)
	}
}

// Ambiguity: two teams → reads fail with the names, ids still work.
func TestContextAmbiguousTeam(t *testing.T) {
	other := map[string]any{"id": "team_2", "name": "platform", "role": "member"}
	pending := map[string]any{"id": "team_3", "name": "secret", "role": "pending"}
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /teams": func(recorded) (int, any) {
			return 200, map[string]any{"teams": []any{sampleTeam, other, pending}}
		},
		"GET /channels/auth_0123": func(recorded) (int, any) { return 200, sampleChannel },
	}, []any{sampleChannel}, nil, nil))
	_, _, err := run(t, f, "channels", "get", "demo")
	if err == nil || !strings.Contains(err.Error(), "ambiguous team (dooroo, platform)") {
		t.Fatalf("err=%v", err)
	}
	// A pending seat is never selectable, and cannot be named either.
	if _, _, err := run(t, f, "channels", "get", "demo", "--team", "secret"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("err=%v", err)
	}
	if _, _, err := run(t, f, "channels", "get", "demo", "--team", "Dooroo"); err != nil {
		t.Fatalf("case-insensitive team name: %v", err)
	}
	if _, _, err := run(t, f, "channels", "get", "auth_0123"); err != nil {
		t.Fatalf("an id needs no context: %v", err)
	}
}

// Member-written text is cleaned of terminal control sequences on the way out.
func TestOutputCleansControlCharacters(t *testing.T) {
	evil := "\x1b]0;pwned\x07title\x1b[2J"
	d := map[string]any{"id": "dsc_1", "teamId": "team_1", "title": evil, "bodyMd": "line\x1b[31m\n\ttab", "createdBy": "x",
		"createdAt": 1, "updatedAt": 1, "mine": true, "comments": []any{}}
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /teams/team_1/discussions/dsc_1": func(recorded) (int, any) { return 200, d },
		"GET /teams/team_1/discussions":       func(recorded) (int, any) { return 200, map[string]any{"discussions": []any{d}} },
	}, nil, nil, nil))
	for _, args := range [][]string{{"team", "discussion", "get", "dsc_1"}, {"team", "discussion", "ls"}} {
		out, _, err := run(t, f, args...)
		if err != nil {
			t.Fatal(err)
		}
		if strings.ContainsRune(out, 0x1b) || strings.ContainsRune(out, 0x07) {
			t.Fatalf("%v leaked control characters:\n%q", args, out)
		}
		if !strings.Contains(out, "title") {
			t.Fatalf("text itself must survive:\n%s", out)
		}
	}
	// --json is machine output and is left verbatim.
	out, _, _ := run(t, f, "team", "discussion", "get", "dsc_1", "--json")
	if !strings.Contains(out, `\u001b`) {
		t.Fatalf("json must be verbatim:\n%s", out)
	}
}

// Context failures get their own exit code so scripts can tell them from
// API errors and local failures.
func TestContextErrorExitCode(t *testing.T) {
	f := newFake(t, nil)
	t.Setenv("YYT_CONFIG", filepath.Join(t.TempDir(), "c.json"))
	t.Setenv("YYT_API", f.srv.URL)
	t.Setenv("YYT_TOKEN", "yyt_test")
	old := os.Args
	os.Args = []string{"yyt", "channels", "create", "--kind", "auth", "--name", "a", "--audience", "a"}
	defer func() { os.Args = old }()
	r, w, _ := os.Pipe()
	oldErr := os.Stderr
	os.Stderr = w
	code := Execute()
	os.Stderr = oldErr
	_ = w.Close()
	_, _ = r.Close(), 0
	if code != 6 {
		t.Fatalf("code=%d", code)
	}
	if len(f.reqs) != 0 {
		t.Fatal("no request expected")
	}
}
