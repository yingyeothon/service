package cmd

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/config"
)

type me struct {
	ID    string `json:"id"`
	Login string `json:"login"`
	Role  string `json:"role"`
	Via   string `json:"via"`
}

func newLogin(a *App) *cobra.Command {
	c := &cobra.Command{
		Use:   "login [--token <API token>] [--api <url>]",
		Short: "Verify an API token against the console and store it in the config file",
		Long: `Reads the token from --token, YYT_TOKEN, or stdin (prompted on a terminal),
checks it against GET /me and stores it with the console URL in the config file.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			token := a.tokFlag
			if token == "" {
				token = os.Getenv("YYT_TOKEN")
			}
			apiBase := a.apiFlag
			if apiBase == "" {
				apiBase = os.Getenv("YYT_API")
			}
			if token == "" {
				// Read from stdin so the token stays out of shell history and `ps`.
				token, _ = readToken(cmd.InOrStdin(), a.Err)
			}
			if token == "" {
				return errors.New("token required: pass --token, set YYT_TOKEN, or pipe it on stdin (console > account > API tokens)")
			}
			if apiBase == "" {
				apiBase = config.DefaultAPI
			}
			apiBase = strings.TrimRight(apiBase, "/")
			if err := config.CheckAPI(apiBase); err != nil {
				return err
			}
			cfg := config.Config{API: apiBase, Token: token}
			cl := api.New(cfg.API, cfg.Token)
			if a.NewClient != nil {
				cl = a.NewClient(cfg)
			}
			var m me
			if err := cl.Do(cmd.Context(), http.MethodGet, "/me", nil, &m); err != nil {
				return fmt.Errorf("token rejected: %w", err)
			}
			if err := config.Save(cfg); err != nil {
				return err
			}
			p, _ := config.Path()
			if m.Role == "pending" {
				fmt.Fprintln(a.Err, "note: your account is pending; commands return 403 until an admin approves it")
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"api": cfg.API, "id": m.ID, "login": m.Login, "role": m.Role, "config": p})
			}
			fmt.Fprintf(a.Out, "logged in as %s (%s) at %s\nconfig: %s\n", m.Login, m.Role, cfg.API, p)
			return nil
		},
	}
	return c
}

// readToken reads one line from stdin; prompts when stdin is a terminal.
func readToken(in io.Reader, prompt io.Writer) (string, error) {
	if f, ok := in.(*os.File); ok {
		if st, err := f.Stat(); err == nil && st.Mode()&os.ModeCharDevice != 0 {
			fmt.Fprint(prompt, "API token: ")
		}
	}
	line, err := bufio.NewReader(in).ReadString('\n')
	return strings.TrimSpace(line), err
}

func newLogout(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Remove the stored token (the token itself stays valid until revoked)",
		RunE: func(_ *cobra.Command, _ []string) error {
			if err := config.Remove(); err != nil {
				return err
			}
			if a.jsonOut {
				p, _ := config.Path()
				return a.printer().JSONValue(map[string]any{"loggedOut": true, "config": p})
			}
			fmt.Fprintln(a.Out, "logged out; revoke the token with `yyt tokens revoke <id>` if it should no longer work")
			return nil
		},
	}
}

func newWhoami(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "Show the member behind the current token",
		RunE: func(cmd *cobra.Command, _ []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			var m me
			if err := cl.Do(cmd.Context(), http.MethodGet, "/me", nil, &m); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(m)
			}
			return a.printer().KV([][2]string{{"id", m.ID}, {"login", m.Login}, {"role", m.Role}, {"api", cl.Base}})
		},
	}
}
