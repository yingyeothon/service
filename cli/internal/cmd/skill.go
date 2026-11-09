package cmd

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli"
)

// An agent skill shipped inside the binary (cli/skills/<name>/SKILL.md), so
// the installed copy always matches the installed yyt.
type skill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

func skillsFS() fs.FS {
	sub, err := fs.Sub(cli.Skills, "skills")
	if err != nil {
		panic(err) // embedded at build time
	}
	return sub
}

func listSkills() ([]skill, error) {
	entries, err := fs.ReadDir(skillsFS(), ".")
	if err != nil {
		return nil, err
	}
	var out []skill
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		b, err := fs.ReadFile(skillsFS(), path.Join(e.Name(), "SKILL.md"))
		if err != nil {
			return nil, err
		}
		out = append(out, skill{Name: e.Name(), Description: frontmatter(b, "description")})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// frontmatter returns one single-line key of a SKILL.md's leading `---` block.
func frontmatter(b []byte, key string) string {
	lines := strings.Split(string(b), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return ""
	}
	for _, l := range lines[1:] {
		if strings.TrimSpace(l) == "---" {
			break
		}
		if v, ok := strings.CutPrefix(l, key+":"); ok {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func skillByName(name string) error {
	all, err := listSkills()
	if err != nil {
		return err
	}
	var names []string
	for _, s := range all {
		if s.Name == name {
			return nil
		}
		names = append(names, s.Name)
	}
	return fmt.Errorf("no skill %q in this yyt (have: %s)", name, strings.Join(names, ", "))
}

// skillTarget is where one agent looks for skills.
type skillTarget struct {
	Agent string // claude, codex, dir
	Root  string // the skills directory
}

// agentSkillRoots: Claude Code reads ~/.claude/skills (CLAUDE_CONFIG_DIR
// moves ~/.claude), Codex reads ~/.codex/skills (CODEX_HOME moves ~/.codex).
func agentSkillRoots() (map[string]string, error) {
	claude, codex := os.Getenv("CLAUDE_CONFIG_DIR"), os.Getenv("CODEX_HOME")
	if claude == "" || codex == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		if claude == "" {
			claude = filepath.Join(home, ".claude")
		}
		if codex == "" {
			codex = filepath.Join(home, ".codex")
		}
	}
	return map[string]string{"claude": filepath.Join(claude, "skills"), "codex": filepath.Join(codex, "skills")}, nil
}

func skillTargets(target, dir string) ([]skillTarget, error) {
	if dir != "" {
		if target != "" {
			return nil, errors.New("--dir and --target are exclusive")
		}
		return []skillTarget{{Agent: "dir", Root: dir}}, nil
	}
	roots, err := agentSkillRoots()
	if err != nil {
		return nil, err
	}
	switch target {
	case "claude", "codex":
		return []skillTarget{{Agent: target, Root: roots[target]}}, nil
	case "all":
		return []skillTarget{{"claude", roots["claude"]}, {"codex", roots["codex"]}}, nil
	case "":
		// Every agent that is set up here (its config directory exists).
		var out []skillTarget
		for _, agent := range []string{"claude", "codex"} {
			if st, err := os.Stat(filepath.Dir(roots[agent])); err == nil && st.IsDir() {
				out = append(out, skillTarget{agent, roots[agent]})
			}
		}
		if len(out) == 0 {
			return nil, fmt.Errorf("neither %s nor %s exists; pass --target claude|codex|all or --dir <skills dir>",
				filepath.Dir(roots["claude"]), filepath.Dir(roots["codex"]))
		}
		return out, nil
	}
	return nil, fmt.Errorf("--target %q: want claude, codex or all", target)
}

type skillInstall struct {
	Agent  string `json:"agent"`
	Path   string `json:"path"`
	Status string `json:"status"` // installed, updated, unchanged
}

// installSkill copies every file of the embedded skill into root/<name>/,
// each through a temp file and a rename. An existing symlink (the old
// `ln -s` install) is replaced only with force; a file the skill no longer
// ships is left alone.
func installSkill(name string, t skillTarget, force bool) (skillInstall, error) {
	dst := filepath.Join(t.Root, name)
	res := skillInstall{Agent: t.Agent, Path: dst}
	if st, err := os.Lstat(dst); err == nil {
		switch {
		case st.Mode()&os.ModeSymlink != 0:
			if !force {
				return res, fmt.Errorf("%s is a symlink (an earlier manual install); rerun with --force to replace it with a copy", dst)
			}
			if err := os.Remove(dst); err != nil {
				return res, err
			}
		case !st.IsDir():
			return res, fmt.Errorf("%s exists and is not a directory", dst)
		}
	}
	existed := false
	if _, err := os.Stat(dst); err == nil {
		existed = true
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return res, err
	}
	changed := false
	err := fs.WalkDir(skillsFS(), name, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(p, name), "/")
		out := filepath.Join(dst, filepath.FromSlash(rel))
		if d.IsDir() {
			// A symlinked subdirectory would carry the writes outside dst.
			if st, err := os.Lstat(out); err == nil && st.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("%s is a symlink; remove it and rerun", out)
			}
			return os.MkdirAll(out, 0o755)
		}
		want, err := fs.ReadFile(skillsFS(), p)
		if err != nil {
			return err
		}
		if have, err := os.ReadFile(out); err == nil && bytes.Equal(have, want) {
			return nil
		}
		changed = true
		return writeFileAtomic(out, want)
	})
	if err != nil {
		return res, err
	}
	switch {
	case !existed:
		res.Status = "installed"
	case changed:
		res.Status = "updated"
	default:
		res.Status = "unchanged"
	}
	return res, nil
}

func newSkill(a *App) *cobra.Command {
	c := group(&cobra.Command{
		Use:   "skill",
		Short: "Agent skills shipped with yyt (list, show, install into Claude Code / Codex)",
		Long: "yyt carries agent skills that teach a coding agent (Claude Code, Codex, …) a yyt workflow, e.g. `tracer-debug` " +
			"for reading what a debug build sent to tracer. The copy matches this yyt version; after `yyt self update`, run " +
			"`yyt skill install` again to refresh it. Agents without a skill system can read one with `yyt skill show <name>`.",
	})

	c.AddCommand(&cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the skills this yyt carries",
		Example: "  yyt skill list\n  yyt skill list --json",
		Annotations: map[string]string{
			OutputAnnotation: "table NAME DESCRIPTION; --json: {skills:[{name,description}]}",
		},
		Args: cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			all, err := listSkills()
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"skills": all})
			}
			rows := make([][]string, 0, len(all))
			for _, s := range all {
				rows = append(rows, []string{s.Name, s.Description})
			}
			return a.printer().Table([]string{"NAME", "DESCRIPTION"}, rows)
		},
	})

	c.AddCommand(&cobra.Command{
		Use:     "show <name>",
		Short:   "Print a skill's SKILL.md (for an agent without a skill system)",
		Example: "  yyt skill show tracer-debug",
		Annotations: map[string]string{
			OutputAnnotation: "the SKILL.md text verbatim (markdown with a YAML frontmatter); --json: {name,description,text}",
		},
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if err := skillByName(args[0]); err != nil {
				return err
			}
			b, err := fs.ReadFile(skillsFS(), path.Join(args[0], "SKILL.md"))
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"name": args[0], "description": frontmatter(b, "description"), "text": string(b)})
			}
			_, err = a.Out.Write(b)
			return err
		},
	})

	var target, dir string
	var force bool
	install := &cobra.Command{
		Use:   "install <name>",
		Short: "Install a skill for Claude Code and/or Codex (a copy, refreshed by running it again)",
		Long: "Writes the skill's files to <skills dir>/<name>/. Without --target or --dir it installs for every agent set up " +
			"on this machine: Claude Code (~/.claude/skills, or $CLAUDE_CONFIG_DIR/skills) and Codex (~/.codex/skills, or " +
			"$CODEX_HOME/skills), whichever config directory exists. Running it again after `yyt self update` refreshes the " +
			"copy. An existing symlink at that path (an earlier `ln -s` install) is replaced only with --force. Restart the " +
			"agent session to pick up a new skill.",
		Example: "  yyt skill install tracer-debug\n  yyt skill install tracer-debug --target codex\n" +
			"  yyt skill install tracer-debug --dir ./.claude/skills\n  yyt skill install tracer-debug --force",
		Annotations: map[string]string{
			OutputAnnotation: "one line per target \"<status> <agent> <path>\" (status installed, updated or unchanged); " +
				"--json: {skill,targets:[{agent,path,status}]}",
		},
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			name := args[0]
			if err := skillByName(name); err != nil {
				return err
			}
			targets, err := skillTargets(target, dir)
			if err != nil {
				return err
			}
			var done []skillInstall
			for _, t := range targets {
				r, err := installSkill(name, t, force)
				if err != nil {
					return err
				}
				done = append(done, r)
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"skill": name, "targets": done})
			}
			for _, r := range done {
				fmt.Fprintf(a.Out, "%s %s %s\n", r.Status, r.Agent, r.Path)
			}
			return nil
		},
	}
	install.Flags().StringVar(&target, "target", "", "claude, codex or all (default: every agent whose config directory exists)")
	install.Flags().StringVar(&dir, "dir", "", "install into this skills directory instead (e.g. a project's .claude/skills)")
	install.Flags().BoolVar(&force, "force", false, "replace a symlink left by an earlier manual install")
	c.AddCommand(install)
	return c
}
