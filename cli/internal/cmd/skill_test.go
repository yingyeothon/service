package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yingyeothon/service/cli"
)

func skillHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home) // os.UserHomeDir on Windows
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("CODEX_HOME", "")
	return home
}

func embeddedSkill(t *testing.T) []byte {
	t.Helper()
	b, err := cli.Skills.ReadFile("skills/tracer-debug/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSkillListAndShow(t *testing.T) {
	f := newFake(t, nil)
	out, _, err := run(t, f, "skill", "list", "--json")
	var got struct{ Skills []skill }
	if err != nil || json.Unmarshal([]byte(out), &got) != nil || len(got.Skills) == 0 ||
		got.Skills[0].Name != "tracer-debug" || !strings.HasPrefix(got.Skills[0].Description, "Debug an app") {
		t.Fatalf("list: %v %s", err, out)
	}
	out, _, err = run(t, f, "skill", "show", "tracer-debug")
	if err != nil || out != string(embeddedSkill(t)) {
		t.Fatalf("show: %v", err)
	}
	if _, _, err := run(t, f, "skill", "show", "nope"); err == nil || !strings.Contains(err.Error(), "have: tracer-debug") {
		t.Fatalf("unknown skill: %v", err)
	}
}

func TestSkillInstallTargets(t *testing.T) {
	f := newFake(t, nil)
	home := skillHome(t)
	// Neither agent set up: refuse rather than guess.
	if _, _, err := run(t, f, "skill", "install", "tracer-debug"); err == nil || !strings.Contains(err.Error(), "--target") {
		t.Fatalf("no agent: %v", err)
	}
	// Only Claude Code set up: installs there alone.
	os.MkdirAll(filepath.Join(home, ".claude"), 0o755)
	out, _, err := run(t, f, "skill", "install", "tracer-debug")
	claude := filepath.Join(home, ".claude", "skills", "tracer-debug")
	if err != nil || out != "installed claude "+claude+"\n" {
		t.Fatalf("claude: %v %q", err, out)
	}
	if b, _ := os.ReadFile(filepath.Join(claude, "SKILL.md")); string(b) != string(embeddedSkill(t)) {
		t.Fatal("claude copy differs")
	}
	if _, err := os.Stat(filepath.Join(home, ".codex")); err == nil {
		t.Fatal("codex dir created without --target")
	}
	// Again: unchanged; a local edit: updated.
	if out, _, _ := run(t, f, "skill", "install", "tracer-debug"); !strings.HasPrefix(out, "unchanged claude") {
		t.Fatalf("rerun: %q", out)
	}
	os.WriteFile(filepath.Join(claude, "SKILL.md"), []byte("old"), 0o644)
	if out, _, _ := run(t, f, "skill", "install", "tracer-debug"); !strings.HasPrefix(out, "updated claude") {
		t.Fatalf("refresh: %q", out)
	}
	// --target all creates codex too; CODEX_HOME moves it.
	codexHome := filepath.Join(home, "cx")
	t.Setenv("CODEX_HOME", codexHome)
	out, _, err = run(t, f, "skill", "install", "tracer-debug", "--target", "all", "--json")
	var got struct {
		Skill   string
		Targets []skillInstall
	}
	if err != nil || json.Unmarshal([]byte(out), &got) != nil || len(got.Targets) != 2 ||
		got.Targets[1].Agent != "codex" || got.Targets[1].Path != filepath.Join(codexHome, "skills", "tracer-debug") ||
		got.Targets[1].Status != "installed" {
		t.Fatalf("all: %v %s", err, out)
	}
	// --dir: exactly there; exclusive with --target.
	dir := filepath.Join(t.TempDir(), "proj", ".claude", "skills")
	if out, _, err := run(t, f, "skill", "install", "tracer-debug", "--dir", dir); err != nil || !strings.HasPrefix(out, "installed dir ") {
		t.Fatalf("dir: %v %q", err, out)
	}
	if _, _, err := run(t, f, "skill", "install", "tracer-debug", "--dir", dir, "--target", "claude"); err == nil {
		t.Fatal("--dir with --target accepted")
	}
	if _, _, err := run(t, f, "skill", "install", "tracer-debug", "--target", "cursor"); err == nil {
		t.Fatal("unknown target accepted")
	}
}

func TestSkillInstallReplacesSymlinkOnlyWithForce(t *testing.T) {
	f := newFake(t, nil)
	home := skillHome(t)
	src := filepath.Join(t.TempDir(), "checkout", "tracer-debug")
	os.MkdirAll(src, 0o755)
	os.WriteFile(filepath.Join(src, "SKILL.md"), []byte("repo copy"), 0o644)
	link := filepath.Join(home, ".claude", "skills", "tracer-debug")
	os.MkdirAll(filepath.Dir(link), 0o755)
	if err := os.Symlink(src, link); err != nil {
		t.Skip(err)
	}
	if _, _, err := run(t, f, "skill", "install", "tracer-debug"); err == nil || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("symlink: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(src, "SKILL.md")); string(b) != "repo copy" {
		t.Fatal("wrote through the symlink")
	}
	if _, _, err := run(t, f, "skill", "install", "tracer-debug", "--force"); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Lstat(link); st.Mode()&os.ModeSymlink != 0 {
		t.Fatal("still a symlink")
	}
	if b, _ := os.ReadFile(filepath.Join(src, "SKILL.md")); string(b) != "repo copy" {
		t.Fatal("--force touched the link target")
	}
}
