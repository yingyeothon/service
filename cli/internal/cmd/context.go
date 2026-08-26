package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/config"
)

// Team/project context (docs/decisions.md "CLI"): --team/--project >
// YYT_TEAM/YYT_PROJECT > .yyt.json found by upward search > profile defaults
// (`yyt team use` / `yyt project use`) > auto-select when unique, for read
// commands only. Each field is layered independently. Write commands refuse
// to auto-select: a non-interactive script must not start failing with
// "ambiguous" the day its author joins a second team.

// ContextFile is the per-directory context file name. Team and project ids
// are not secrets (docs/secrets.md), so the file may be committed.
const ContextFile = ".yyt.json"

// idLike mirrors console's ID_LIKE: a string in `{prefix}_…` shape is an id,
// never a name (names in that shape are rejected server-side).
var idLike = regexp.MustCompile(`^(?i)(team|prj|ver|iss|dsc|cmt|lnk|ca|ab|art|af|auth|topic|match|lobby|q|m|tok|dbg|up)_`)

// IsID reports whether s is addressed as an id rather than a name.
func IsID(s string) bool { return idLike.MatchString(s) }

// ctxSpec is what the user named, before any API lookup.
type ctxSpec struct {
	Team, Project             string
	TeamSource, ProjectSource string // "flag" | "env" | ".yyt.json" | "profile" | ""
}

// Explicit reports whether the given field came from the user rather than
// auto-selection (which is what an empty value would turn into).
func (s ctxSpec) explicitTeam() bool    { return s.Team != "" }
func (s ctxSpec) explicitProject() bool { return s.Project != "" }

// contextFile is the .yyt.json document.
type contextFile struct {
	Team    string `json:"team"`
	Project string `json:"project"`
}

// findContextFile walks up from start looking for .yyt.json; it checks $HOME
// and a git root (a directory holding `.git`) but does not go above them.
// Unreadable or malformed files are skipped, not fatal.
func findContextFile(start string) (contextFile, string) {
	dir, err := filepath.Abs(start)
	if err != nil {
		return contextFile{}, ""
	}
	if st, err := os.Stat(dir); err == nil && !st.IsDir() {
		dir = filepath.Dir(dir)
	}
	home, _ := os.UserHomeDir()
	for {
		p := filepath.Join(dir, ContextFile)
		// A world-writable directory (/tmp on a shared host) is not a place
		// to take a deploy target from: anyone could have planted the file.
		if st, err := os.Stat(dir); err == nil && st.Mode().Perm()&0o002 != 0 {
			return contextFile{}, ""
		}
		if b, err := os.ReadFile(p); err == nil {
			var cf contextFile
			if json.Unmarshal(b, &cf) == nil && (cf.Team != "" || cf.Project != "") {
				return cf, p
			}
		}
		if dir == home {
			return contextFile{}, ""
		}
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return contextFile{}, ""
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return contextFile{}, ""
		}
		dir = parent
	}
}

// contextSpec layers the sources. `start` is where the .yyt.json search
// begins (the command's --project-path when it has one, else the cwd).
func (a *App) contextSpec(start string, cfg config.Config) ctxSpec {
	s := ctxSpec{}
	pick := func(field *string, src *string, val, from string) {
		if *field == "" && val != "" {
			*field, *src = val, from
		}
	}
	pick(&s.Team, &s.TeamSource, a.teamFlag, "flag")
	pick(&s.Project, &s.ProjectSource, a.projectFlag, "flag")
	pick(&s.Team, &s.TeamSource, os.Getenv("YYT_TEAM"), "env")
	pick(&s.Project, &s.ProjectSource, os.Getenv("YYT_PROJECT"), "env")
	if cf, p := findContextFile(start); p != "" {
		pick(&s.Team, &s.TeamSource, cf.Team, p)
		pick(&s.Project, &s.ProjectSource, cf.Project, p)
	}
	pick(&s.Team, &s.TeamSource, cfg.Team, "profile")
	pick(&s.Project, &s.ProjectSource, cfg.Project, "profile")
	// A project named at a lower layer than the team is dropped: a profile's
	// `prj_…` pin under a `--team other` would otherwise satisfy the explicit
	// context and land the write in the pinned team's project.
	if s.Project != "" && layerRank(s.ProjectSource) > layerRank(s.TeamSource) {
		s.Project, s.ProjectSource = "", ""
	}
	return s
}

// layerRank orders the sources: lower is stronger. A .yyt.json path ranks
// between env and profile.
func layerRank(src string) int {
	switch src {
	case "":
		return 99 // unset: never outranks anything set
	case "argument", "flag":
		return 1
	case "env":
		return 2
	case "profile":
		return 4
	}
	return 3 // a file path
}

// contextStart is where the .yyt.json search begins for this command.
func contextStart(cmd *cobra.Command) string {
	if f := cmd.Flags().Lookup("project-path"); f != nil && f.Value.String() != "" {
		return f.Value.String()
	}
	return "."
}

// resolved is a team and (optionally) a project, both by id.
type resolved struct {
	TeamID, TeamName       string
	ProjectID, ProjectName string
}

func (r resolved) String() string {
	if r.ProjectID == "" {
		return "team " + r.TeamName
	}
	return "team " + r.TeamName + " / project " + r.ProjectName
}

// Views used by resolution (mirror services/console/src/team.ts).
type teamRow struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Role        string  `json:"role"`
	Description *string `json:"description"`
	AdminLocked bool    `json:"adminLocked"`
	CreatedBy   *string `json:"createdBy"`
	CreatedAt   int64   `json:"createdAt"`
	UpdatedAt   int64   `json:"updatedAt"`
	Counts      *struct {
		Owners   int `json:"owners"`
		Members  int `json:"members"`
		Pending  int `json:"pending"`
		Projects int `json:"projects"`
	} `json:"counts,omitempty"`
}

type projectRow struct {
	ID          string  `json:"id"`
	TeamID      string  `json:"teamId"`
	TeamName    string  `json:"teamName"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	CreatedBy   *string `json:"createdBy"`
	CreatedAt   int64   `json:"createdAt"`
	UpdatedAt   int64   `json:"updatedAt"`
	Counts      *struct {
		Channels int `json:"channels"`
		Apps     int `json:"apps"`
		Bundles  int `json:"bundles"`
		Versions int `json:"versions"`
		Issues   int `json:"issues"`
	} `json:"counts,omitempty"`
}

// ContextError is a missing or ambiguous team/project context: a local
// resolution failure, not an API one, so scripts get their own exit code (6).
type ContextError struct{ Msg string }

func (e *ContextError) Error() string { return e.Msg }

func contextErrorf(format string, args ...any) error {
	return &ContextError{Msg: fmt.Sprintf(format, args...)}
}

// contextHint is appended to every "no context" error.
const contextHint = "pass --team/--project (or YYT_TEAM/YYT_PROJECT), add " + ContextFile +
	` {"team":"…","project":"…"} to the project directory, or run ` + "`yyt team use <name>` / `yyt project use <name>`"

// ctxClient bundles what resolution needs: the API client and the layered spec.
type ctxClient struct {
	a    *App
	cl   *api.Client
	spec ctxSpec
}

// ctxClient resolves the credential and the context spec together; the two
// are separate concerns but every context-aware command needs both.
func (a *App) ctxClient(cmd *cobra.Command) (*ctxClient, error) {
	cfg, err := config.Resolve(a.profFlag, a.apiFlag, a.tokFlag)
	if err != nil {
		return nil, err
	}
	cl, err := a.clientFor(cfg)
	if err != nil {
		return nil, err
	}
	return &ctxClient{a: a, cl: cl, spec: a.contextSpec(contextStart(cmd), cfg)}, nil
}

// seatedTeams lists the teams the caller may act in (pending requests are
// name-only views and cannot be selected).
func (c *ctxClient) seatedTeams(ctx context.Context) ([]teamRow, error) {
	teams, err := c.allTeams(ctx)
	if err != nil {
		return nil, err
	}
	out := teams[:0]
	for _, t := range teams {
		if t.Role != "pending" {
			out = append(out, t)
		}
	}
	return out, nil
}

func (c *ctxClient) allTeams(ctx context.Context) ([]teamRow, error) {
	var res struct {
		Teams []teamRow `json:"teams"`
	}
	if err := c.cl.Do(ctx, http.MethodGet, "/teams", nil, &res); err != nil {
		return nil, err
	}
	return res.Teams, nil
}

// team resolves the team context. write=true refuses auto-selection.
func (c *ctxClient) team(ctx context.Context, write bool) (resolved, error) {
	if name := c.spec.Team; name != "" {
		if IsID(name) {
			var t teamRow
			if err := c.cl.Do(ctx, http.MethodGet, "/teams/"+api.PathID(name), nil, &t); err != nil {
				return resolved{}, fmt.Errorf("team %s (from %s): %w", name, c.spec.TeamSource, err)
			}
			return resolved{TeamID: t.ID, TeamName: t.Name}, nil
		}
		teams, err := c.allTeams(ctx)
		if err != nil {
			return resolved{}, err
		}
		for _, t := range teams {
			// A pending seat may be *read* by name (`team get`), never acted in.
			if strings.EqualFold(t.Name, name) && (!write || t.Role != "pending") {
				return resolved{TeamID: t.ID, TeamName: t.Name}, nil
			}
		}
		return resolved{}, &api.Error{Status: 404, Code: "not_found",
			Message: fmt.Sprintf("team %q not found among the teams you sit in (from %s; see `yyt team ls`)", name, c.spec.TeamSource)}
	}
	if write {
		return resolved{}, contextErrorf("no team context: %s", contextHint)
	}
	teams, err := c.seatedTeams(ctx)
	if err != nil {
		return resolved{}, err
	}
	switch len(teams) {
	case 0:
		return resolved{}, contextErrorf("you are in no team yet: `yyt team create <name>` or `yyt team join <name>`")
	case 1:
		return resolved{TeamID: teams[0].ID, TeamName: teams[0].Name}, nil
	}
	return resolved{}, contextErrorf("ambiguous team (%s): %s", teamNames(teams), contextHint)
}

func teamNames(teams []teamRow) string {
	names := make([]string, 0, len(teams))
	for _, t := range teams {
		names = append(names, t.Name)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// project resolves the project context (and its team). A `prj_` id needs no
// team at all. write=true refuses auto-selection of either.
func (c *ctxClient) project(ctx context.Context, write bool) (resolved, error) {
	if name := c.spec.Project; name != "" && IsID(name) {
		var p projectRow
		if err := c.cl.Do(ctx, http.MethodGet, "/projects/"+api.PathID(name), nil, &p); err != nil {
			return resolved{}, fmt.Errorf("project %s (from %s): %w", name, c.spec.ProjectSource, err)
		}
		if c.spec.Team != "" {
			// Both named at the same layer: they must agree.
			t, err := c.team(ctx, write)
			if err != nil {
				return resolved{}, err
			}
			if t.TeamID != p.TeamID {
				return resolved{}, fmt.Errorf("project %s belongs to team %s, not %s (from %s / %s)", p.Name, p.TeamName, t.TeamName, c.spec.ProjectSource, c.spec.TeamSource)
			}
		}
		return resolved{TeamID: p.TeamID, TeamName: p.TeamName, ProjectID: p.ID, ProjectName: p.Name}, nil
	}
	r, err := c.team(ctx, write)
	if err != nil {
		return resolved{}, err
	}
	var res struct {
		Projects []projectRow `json:"projects"`
	}
	if err := c.cl.Do(ctx, http.MethodGet, "/teams/"+api.PathID(r.TeamID)+"/projects", nil, &res); err != nil {
		return resolved{}, err
	}
	if name := c.spec.Project; name != "" {
		for _, p := range res.Projects {
			if strings.EqualFold(p.Name, name) {
				r.ProjectID, r.ProjectName = p.ID, p.Name
				return r, nil
			}
		}
		return resolved{}, &api.Error{Status: 404, Code: "not_found",
			Message: fmt.Sprintf("project %q not found in team %s (from %s; see `yyt project ls`)", name, r.TeamName, c.spec.ProjectSource)}
	}
	if write {
		return resolved{}, contextErrorf("no project context: %s", contextHint)
	}
	switch len(res.Projects) {
	case 0:
		return resolved{}, contextErrorf("team %s has no project yet: `yyt project create <name> --team %s`", r.TeamName, r.TeamName)
	case 1:
		r.ProjectID, r.ProjectName = res.Projects[0].ID, res.Projects[0].Name
		return r, nil
	}
	names := make([]string, 0, len(res.Projects))
	for _, p := range res.Projects {
		names = append(names, p.Name)
	}
	sort.Strings(names)
	return resolved{}, contextErrorf("ambiguous project in team %s (%s): %s", r.TeamName, strings.Join(names, ", "), contextHint)
}

// named is any project resource that has an id and a team-unique name.
type named struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// resource turns an id-or-name into an id. Ids pass through untouched and
// need no context; a name is looked up in the project's `listPath` (a route
// under /projects/{prj}/…) whose response holds the list under `key`.
func (c *ctxClient) resource(ctx context.Context, kind, listPath, key, arg string, write bool) (string, error) {
	if IsID(arg) {
		return arg, nil
	}
	r, err := c.project(ctx, write)
	if err != nil {
		return "", fmt.Errorf("%s %q is a name, which needs a project: %w", kind, arg, err)
	}
	var raw map[string]json.RawMessage
	if err := c.cl.Do(ctx, http.MethodGet, "/projects/"+api.PathID(r.ProjectID)+listPath, nil, &raw); err != nil {
		return "", err
	}
	var rows []named
	if b, ok := raw[key]; ok {
		if err := json.Unmarshal(b, &rows); err != nil {
			return "", fmt.Errorf("decode %s list: %w", kind, err)
		}
	}
	for _, row := range rows {
		if strings.EqualFold(row.Name, arg) {
			return row.ID, nil
		}
	}
	return "", &api.Error{Status: 404, Code: "not_found",
		Message: fmt.Sprintf("%s %q not found in %s", kind, arg, r)}
}

func (c *ctxClient) channel(ctx context.Context, arg string, write bool) (string, error) {
	return c.resource(ctx, "channel", "/channels", "channels", arg, write)
}

func (c *ctxClient) app(ctx context.Context, arg string, write bool) (string, error) {
	return c.resource(ctx, "app", "/catalog/apps", "apps", arg, write)
}

func (c *ctxClient) bundle(ctx context.Context, arg string, write bool) (string, error) {
	return c.resource(ctx, "bundle", "/assets/bundles", "bundles", arg, write)
}

// version turns a version id-or-name into an id inside the resolved project
// (the route takes ids only).
func (c *ctxClient) version(ctx context.Context, projectID, arg string) (string, error) {
	if IsID(arg) {
		return arg, nil
	}
	var res struct {
		Versions []named `json:"versions"`
	}
	if err := c.cl.Do(ctx, http.MethodGet, "/projects/"+api.PathID(projectID)+"/versions", nil, &res); err != nil {
		return "", err
	}
	for _, v := range res.Versions {
		if v.Name == arg { // byte-exact, like the server's utf8mb4_bin index
			return v.ID, nil
		}
	}
	return "", &api.Error{Status: 404, Code: "not_found", Message: fmt.Sprintf("version %q not found", arg)}
}
