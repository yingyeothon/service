package cmd

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// Every runnable leaf documents itself for people and agents: an Example and
// an output line (`help --json` → example, output). Exceptions are listed by
// command path with the reason; keep this empty unless a command has nothing
// to show.
var helpDocExceptions = map[string]string{}

func TestEveryLeafHasExampleAndOutput(t *testing.T) {
	root := NewRoot(&App{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}})
	var missing []string
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		if c.Hidden || c.Name() == "completion" {
			return
		}
		if isLeaf(c) {
			if _, ok := helpDocExceptions[c.CommandPath()]; !ok {
				if strings.TrimSpace(c.Example) == "" {
					missing = append(missing, c.CommandPath()+": Example")
				}
				if strings.TrimSpace(c.Annotations[OutputAnnotation]) == "" {
					missing = append(missing, c.CommandPath()+": output")
				}
			}
		}
		for _, s := range c.Commands() {
			walk(s)
		}
	}
	walk(root)
	if len(missing) > 0 {
		t.Fatalf("%d missing:\n%s", len(missing), strings.Join(missing, "\n"))
	}
}

// `yyt help --json` is a stable document: schema 1, the exit-code and
// environment tables, and the tree below the named command.
func TestHelpJSON(t *testing.T) {
	var out bytes.Buffer
	root := NewRoot(&App{Out: &out, Err: &bytes.Buffer{}})
	root.SetArgs([]string{"help", "--json", "catalog", "share"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	var doc helpDoc
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Schema != 1 || len(doc.ExitCodes) != len(ExitCodes) || len(doc.Env) != len(EnvVars) {
		t.Fatalf("doc header: %+v", doc)
	}
	if len(doc.Commands) == 0 || doc.Commands[0].Path != "yyt catalog share" {
		t.Fatalf("subtree: %+v", doc.Commands)
	}
	for _, c := range doc.Commands {
		if !strings.HasPrefix(c.Path, "yyt catalog share") {
			t.Fatalf("outside the subtree: %s", c.Path)
		}
	}
	// A misspelt path is an error, never the whole tree with exit 0.
	for _, args := range [][]string{{"help", "--json", "pushh"}, {"help", "pushh"}, {"help", "--json", "catalog", "bogus"}} {
		root = NewRoot(&App{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}})
		root.SetArgs(args)
		if err := root.Execute(); err == nil {
			t.Fatalf("%v: want an error", args)
		}
	}
	// Help topics print their text.
	out.Reset()
	root = NewRoot(&App{Out: &out, Err: &bytes.Buffer{}})
	root.SetArgs([]string{"help", "agents"})
	if err := root.Execute(); err != nil || !strings.Contains(out.String(), "## Errors and exit codes") {
		t.Fatalf("help agents: %v %.200q", err, out.String())
	}
}

// Every Example line resolves to a command that exists, and every --flag it
// uses is one that command takes: an example that cannot run teaches the
// wrong thing to people and agents alike.
var quoted = regexp.MustCompile(`"[^"]*"|'[^']*'`)

func TestExamplesUseRealCommandsAndFlags(t *testing.T) {
	root := NewRoot(&App{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}})
	var bad []string
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		for _, line := range strings.Split(c.Example, "\n") {
			line = strings.TrimSpace(line)
			// Only the yyt invocation of a pipeline (`printf … | yyt …`).
			if i := strings.Index(line, "yyt "); i >= 0 {
				line = line[i:]
			} else {
				continue
			}
			// A quoted argument is one value, whatever it contains.
			line = quoted.ReplaceAllString(line, "VALUE")
			if j := strings.IndexAny(line, "|;&>#"); j >= 0 {
				line = line[:j]
			}
			words := strings.Fields(line)[1:]
			// Global flags may come before the command path.
			var path []string
			for i := 0; i < len(words); i++ {
				w := words[i]
				if strings.HasPrefix(w, "--") {
					name := strings.SplitN(strings.TrimPrefix(w, "--"), "=", 2)[0]
					if f := root.PersistentFlags().Lookup(name); f != nil {
						if f.Value.Type() != "bool" && !strings.Contains(w, "=") {
							i++
						}
						continue
					}
				}
				path = append(path, words[i:]...)
				break
			}
			target, rest, err := root.Find(path)
			if err != nil || target == root {
				bad = append(bad, c.CommandPath()+": "+line+" (no such command)")
				continue
			}
			for _, w := range rest {
				if !strings.HasPrefix(w, "-") || w == "-" {
					continue
				}
				name := strings.TrimLeft(strings.SplitN(w, "=", 2)[0], "-")
				if strings.HasPrefix(w, "--") {
					if target.Flags().Lookup(name) == nil && target.InheritedFlags().Lookup(name) == nil {
						bad = append(bad, c.CommandPath()+": "+line+" (unknown flag --"+name+")")
					}
				} else if len(name) == 1 && target.Flags().ShorthandLookup(name) == nil && target.InheritedFlags().ShorthandLookup(name) == nil {
					bad = append(bad, c.CommandPath()+": "+line+" (unknown flag -"+name+")")
				}
			}
		}
		for _, s := range c.Commands() {
			walk(s)
		}
	}
	walk(root)
	if len(bad) > 0 {
		t.Fatalf("%d example lines do not run:\n%s", len(bad), strings.Join(bad, "\n"))
	}
}
