// Package cmd wires the cobra command tree. Every resource command maps 1:1
// to a console API route (docs/decisions.md "CLI").
package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/config"
	"github.com/yingyeothon/service/cli/internal/output"
)

// App holds the per-invocation state so tests can inject stdout and a fake API.
type App struct {
	Out      io.Writer
	Err      io.Writer
	jsonOut  bool
	apiFlag  string
	tokFlag  string
	profFlag string
	// NewClient lets tests replace the HTTP client; nil → real client.
	NewClient func(cfg config.Config) *api.Client
}

func (a *App) printer() output.Printer { return output.Printer{W: a.Out, JSON: a.jsonOut} }

func (a *App) client() (*api.Client, error) {
	cfg, err := config.Resolve(a.profFlag, a.apiFlag, a.tokFlag)
	if err != nil {
		return nil, err
	}
	if cfg.Token == "" {
		return nil, errors.New("not logged in: run `yyt login --token <API token>` (console > account > API tokens) or set YYT_TOKEN")
	}
	if a.NewClient != nil {
		return a.NewClient(cfg), nil
	}
	return api.New(cfg.API, cfg.Token), nil
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
		Short:         "CLI for the yingyeothon service console (channels, tokens, members, events)",
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

	root.AddCommand(
		newLogin(a), newLogout(a), newWhoami(a),
		newProfile(a),
		newMembers(a), newTokens(a), newChannels(a), newEvents(a), newCatalog(a), newSmoke(a),
	)
	return root
}

// Execute runs the CLI and returns the process exit code.
func Execute() int {
	a := &App{}
	root := NewRoot(a)
	if err := root.ExecuteContext(context.Background()); err != nil {
		fmt.Fprintln(a.Err, "error:", err)
		var ae *api.Error
		if errors.As(err, &ae) {
			switch ae.Status {
			case 401:
				fmt.Fprintln(a.Err, "hint: the token is missing, revoked, or for another stage; run `yyt login`")
				return 3
			case 403:
				fmt.Fprintln(a.Err, "hint: your account may still be pending (an admin runs `yyt members approve <id>`) or the action needs admin")
				return 4
			case 404:
				return 5
			}
			return 2
		}
		return 1
	}
	return 0
}
