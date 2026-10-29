// Package cmd wires the cobra command tree. Every resource command maps 1:1
// to a console API route (docs/decisions.md "CLI").
package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/config"
	"github.com/yingyeothon/service/cli/internal/output"
	"github.com/yingyeothon/service/cli/internal/selfupdate"
)

// App holds the per-invocation state so tests can inject stdout and a fake API.
type App struct {
	Out io.Writer
	Err io.Writer
	// In is stdin for the commands that read a payload from it (`kv entry
	// put`); nil → os.Stdin. Tests hand in a buffer.
	In       io.Reader
	jsonOut  bool
	apiFlag  string
	tokFlag  string
	profFlag string
	// Team/project context flags (see context.go).
	teamFlag    string
	projectFlag string
	// noRetry turns off the client's `rate_limited` retry (`--no-retry`,
	// YYT_NO_RETRY).
	noRetry bool
	// NewClient lets tests replace the HTTP client; nil → real client.
	NewClient func(cfg config.Config) *api.Client
	// Updater lets tests point `self update` at a fake GitHub; nil → real.
	Updater *selfupdate.Updater
}

func (a *App) printer() output.Printer { return output.Printer{W: a.Out, JSON: a.jsonOut} }

func (a *App) client() (*api.Client, error) {
	_, cl, err := a.resolveClient()
	return cl, err
}

// resolveClient resolves the profile/flag configuration and the API client it
// yields; context-aware commands need both, plain ones only the client.
func (a *App) resolveClient() (config.Config, *api.Client, error) {
	cfg, err := config.Resolve(a.profFlag, a.apiFlag, a.tokFlag)
	if err != nil {
		return cfg, nil, err
	}
	cl, err := a.clientFor(cfg)
	return cfg, cl, err
}

// readClient is client for a route that also answers without a session
// (`GET /events…`): with no token it is an anonymous client, not an error.
func (a *App) readClient() (*api.Client, error) {
	cfg, err := config.Resolve(a.profFlag, a.apiFlag, a.tokFlag)
	if err != nil {
		return nil, err
	}
	if cfg.Token != "" {
		return a.clientFor(cfg)
	}
	var cl *api.Client
	if a.NewClient != nil {
		cl = a.NewClient(cfg)
	} else {
		cl = api.New(cfg.API, "")
	}
	a.withRateLimitRetry(cl)
	return cl, nil
}

func (a *App) clientFor(cfg config.Config) (*api.Client, error) {
	if cfg.Token == "" {
		return nil, errors.New("not logged in: run `yyt login --token <API token>` (console > account > API tokens) or set YYT_TOKEN")
	}
	var cl *api.Client
	if a.NewClient != nil {
		cl = a.NewClient(cfg)
	} else {
		cl = api.New(cfg.API, cfg.Token)
	}
	a.withRateLimitRetry(cl)
	return cl, nil
}

// withRateLimitRetry gives cl the CLI's `rate_limited` retry unless it was
// turned off; each wait is one stderr line, so stdout stays parseable.
func (a *App) withRateLimitRetry(cl *api.Client) {
	if a.noRetry || retryDisabledByEnv() {
		cl.RateLimitRetries = 0
		return
	}
	cl.RateLimitRetries = api.DefaultRateLimitRetries
	cl.Sleep = func(ctx context.Context, d time.Duration) error { return sleepFor(ctx, d) }
	cl.OnRateLimitRetry = func(attempt int, wait time.Duration) {
		fmt.Fprintf(a.Err, "rate_limited: retrying in %s (%d/%d)\n", wait, attempt, api.DefaultRateLimitRetries)
	}
}

// retryDisabledByEnv: YYT_NO_RETRY set to anything but "", "0" or "false".
func retryDisabledByEnv() bool {
	v := strings.TrimSpace(os.Getenv("YYT_NO_RETRY"))
	return v != "" && v != "0" && !strings.EqualFold(v, "false")
}

// group marks a command that only groups subcommands: it prints its help when
// called bare and fails on an unknown subcommand instead of printing help and
// exiting 0 (a script still calling a removed `catalog group …` must notice).
func group(c *cobra.Command) *cobra.Command {
	if c.Annotations == nil {
		c.Annotations = map[string]string{}
	}
	c.Annotations["group"] = "true"
	c.Args = cobra.ArbitraryArgs
	c.RunE = func(cmd *cobra.Command, args []string) error {
		if len(args) > 0 {
			return fmt.Errorf("unknown command %q for %q", args[0], cmd.CommandPath())
		}
		return cmd.Help()
	}
	return c
}

// NewRoot builds the command tree.
func NewRoot(a *App) *cobra.Command {
	if a.Out == nil {
		a.Out = os.Stdout
	}
	if a.Err == nil {
		a.Err = os.Stderr
	}
	root := &cobra.Command{
		Use:           "yyt",
		Short:         "CLI for the yingyeothon service console (teams, projects, channels, push, catalog, assets, sites, events)",
		Long:          rootLong(),
		Version:       api.Version,
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.SetOut(a.Out)
	root.SetErr(a.Err)
	pf := root.PersistentFlags()
	pf.BoolVar(&a.jsonOut, "json", false, "print raw JSON instead of tables")
	pf.StringVar(&a.apiFlag, "api", "", "console base URL (default from config, YYT_API, or "+config.DefaultAPI+")")
	pf.StringVar(&a.tokFlag, "token", "", "API token (overrides config and YYT_TOKEN)")
	pf.StringVar(&a.profFlag, "profile", "", "config profile (default from YYT_PROFILE or the config file)")
	pf.StringVar(&a.teamFlag, "team", "", "team context by name or id (default: YYT_TEAM, "+ContextFile+", or 'yyt team use')")
	pf.BoolVar(&a.noRetry, "no-retry", false, "do not wait out and repeat a rate_limited refusal (also YYT_NO_RETRY=1)")
	pf.StringVar(&a.projectFlag, "project", "", "project context by name or id (default: YYT_PROJECT, "+ContextFile+", or 'yyt project use')")

	root.AddCommand(
		newLogin(a), newLogout(a), newWhoami(a),
		newProfile(a),
		newTeam(a), newProject(a),
		newMembers(a), newTokens(a), newChannels(a), newEvents(a), newShows(a), newCatalog(a), newAssets(a), newSites(a), newKvStore(a), newLeaderboard(a), newPush(a), newLimits(a), newAudit(a), newSmoke(a),
		newSelf(a, a.Updater),
		newAgentsTopic(),
	)
	root.SetHelpCommand(newHelp(a, root))
	return root
}

// Execute runs the CLI and returns the process exit code.
func Execute() int {
	a := &App{}
	root := NewRoot(a)
	selfupdate.RemoveStale()
	if err := root.ExecuteContext(context.Background()); err != nil {
		if errors.Is(err, ErrUpdateAvailable) {
			return ExitUpdateAvailable
		}
		fmt.Fprintln(a.Err, "error:", err)
		var ce *ContextError
		if errors.As(err, &ce) {
			return ExitContext
		}
		var ae *api.Error
		if errors.As(err, &ae) {
			switch ae.Status {
			case 401:
				fmt.Fprintln(a.Err, "hint: the token is missing, revoked, or for another stage; run `yyt login`")
				return ExitUnauthorized
			case 403:
				fmt.Fprintln(a.Err, "hint: your account may still be pending (an admin runs `yyt members approve <id>`), your team seat is pending, or the action needs a team owner/admin")
				return ExitForbidden
			case 404:
				return ExitNotFound
			}
			return ExitAPI
		}
		return ExitLocal
	}
	return ExitOK
}
