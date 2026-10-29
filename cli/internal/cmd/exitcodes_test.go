package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The README and the agent guide list the table, line for line, between
// their markers, and the guide names every environment variable.
func TestExitCodesMatchReadme(t *testing.T) {
	for _, doc := range []string{"../../README.md", "../../agent-guide.md"} {
		checkExitCodeBlock(t, doc)
	}
	guide, err := os.ReadFile("../../agent-guide.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range EnvVars {
		if !strings.Contains(string(guide), "`"+e.Name+"`") {
			t.Fatalf("agent-guide.md lacks %s", e.Name)
		}
	}
}

func checkExitCodeBlock(t *testing.T, doc string) {
	t.Helper()
	raw, err := os.ReadFile(doc)
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)
	begin := strings.Index(s, "<!-- exit-codes:begin -->")
	end := strings.Index(s, "<!-- exit-codes:end -->")
	if begin < 0 || end < begin {
		t.Fatalf("%s: exit-code markers missing", doc)
	}
	got := strings.TrimSpace(s[begin+len("<!-- exit-codes:begin -->") : end])
	var want []string
	for i, e := range ExitCodes {
		if e.Code != i {
			t.Fatalf("ExitCodes[%d] has code %d: keep the table dense and ordered", i, e.Code)
		}
		want = append(want, fmt.Sprintf("- `%d` %s", e.Code, e.Meaning))
	}
	if got != strings.Join(want, "\n") {
		t.Fatalf("%s: exit codes drifted:\n got:\n%s\nwant:\n%s", doc, got, strings.Join(want, "\n"))
	}
}

// Root help carries the exit codes and every YYT_* variable the source reads.
func TestRootHelpContract(t *testing.T) {
	long := rootLong()
	for _, e := range ExitCodes {
		if !strings.Contains(long, fmt.Sprintf("  %d  %s", e.Code, e.Meaning)) {
			t.Fatalf("root help lacks exit code %d", e.Code)
		}
	}
	listed := map[string]bool{}
	for _, e := range EnvVars {
		listed[e.Name] = true
		if !strings.Contains(long, e.Name) {
			t.Fatalf("root help lacks %s", e.Name)
		}
	}
	re := regexp.MustCompile(`Getenv\("(YYT_[A-Z_]+)"\)`)
	for _, dir := range []string{".", "../config"} {
		files, _ := filepath.Glob(filepath.Join(dir, "*.go"))
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			src, _ := os.ReadFile(f)
			for _, m := range re.FindAllStringSubmatch(string(src), -1) {
				if !listed[m[1]] {
					t.Fatalf("%s reads %s but EnvVars does not list it", f, m[1])
				}
			}
		}
	}
}
