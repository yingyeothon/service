package cmd

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

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

// loginProfile picks the profile a login/logout should target:
// --profile > YYT_PROFILE > config default > "default". It also returns the
// profile's stored API so a token refresh without --api keeps pointing at the
// same stage instead of silently falling back to prod.
func loginProfile(a *App) (name, storedAPI string, err error) {
	f, err := config.LoadFile()
	if err != nil {
		return "", "", err
	}
	name, _ = config.ProfileName(a.profFlag, f)
	return name, f.Profiles[name].API, nil
}

func newLogin(a *App) *cobra.Command {
	var device bool
	var tokenName string
	c := &cobra.Command{
		Use:   "login [--token <API token>] [--device] [--api <url>]",
		Short: "Verify an API token against the console and store it in the config file",
		Long: `Reads the token from --token, YYT_TOKEN, or stdin (prompted on a terminal),
checks it against GET /me and stores it with the console URL in the config file.
With --device, signs in through the GitHub device flow instead: the console
mints a fresh API token once you approve the code on github.com.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if device {
				return deviceLogin(cmd, a, tokenName)
			}
			if tokenName != "" {
				return errors.New("--name only applies with --device (it names the minted token)")
			}
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
			prof, storedAPI, err := loginProfile(a)
			if err != nil {
				return err
			}
			if apiBase == "" {
				apiBase = storedAPI // keep the profile's stage on token refresh
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
			if err := config.SaveProfile(prof, config.Profile{API: apiBase, Token: token}); err != nil {
				return err
			}
			p, _ := config.Path()
			if m.Role == "pending" {
				fmt.Fprintln(a.Err, "note: your account is pending; commands return 403 until an admin approves it")
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"api": cfg.API, "id": m.ID, "login": m.Login, "role": m.Role, "profile": prof, "config": p})
			}
			fmt.Fprintf(a.Out, "logged in as %s (%s) at %s [profile %s]\nconfig: %s\n", m.Login, m.Role, cfg.API, prof, p)
			return nil
		},
	}
	c.Flags().BoolVar(&device, "device", false, "sign in with the GitHub device flow (no pre-existing token needed)")
	c.Flags().StringVar(&tokenName, "name", "", "name for the minted API token (default: device login)")
	return c
}

// deviceLogin drives the console's GitHub device flow and stores the minted token.
func deviceLogin(cmd *cobra.Command, a *App, tokenName string) error {
	apiBase := a.apiFlag
	if apiBase == "" {
		apiBase = os.Getenv("YYT_API")
	}
	prof, storedAPI, err := loginProfile(a)
	if err != nil {
		return err
	}
	if apiBase == "" {
		apiBase = storedAPI // keep the profile's stage on re-login
	}
	if apiBase == "" {
		apiBase = config.DefaultAPI
	}
	apiBase = strings.TrimRight(apiBase, "/")
	if err := config.CheckAPI(apiBase); err != nil {
		return err
	}
	cl := api.New(apiBase, "")
	if a.NewClient != nil {
		cl = a.NewClient(config.Config{API: apiBase})
	}
	var start struct {
		Handle          string `json:"handle"`
		UserCode        string `json:"userCode"`
		VerificationURI string `json:"verificationUri"`
		IntervalSec     int    `json:"intervalSec"`
		ExpiresInSec    int    `json:"expiresInSec"`
	}
	if err := cl.Do(cmd.Context(), http.MethodPost, "/auth/device/start", map[string]any{}, &start); err != nil {
		return fmt.Errorf("device login unavailable: %w", err)
	}
	fmt.Fprintf(a.Err, "Open %s and enter the code: %s\n", start.VerificationURI, start.UserCode)
	fmt.Fprintln(a.Err, "Waiting for approval…")
	interval := start.IntervalSec
	if interval < 1 {
		interval = 5
	}
	body := map[string]any{"handle": start.Handle}
	if tokenName != "" {
		body["tokenName"] = tokenName
	}
	deadline := time.Now().Add(time.Duration(start.ExpiresInSec) * time.Second)
	for {
		if time.Now().After(deadline) {
			return errors.New("device login expired; run `yyt login --device` again")
		}
		select {
		case <-cmd.Context().Done():
			return cmd.Context().Err()
		case <-time.After(time.Duration(interval) * time.Second):
		}
		var res struct {
			Status string `json:"status"`
			Token  string `json:"token"`
			Member struct {
				ID    string `json:"id"`
				Login string `json:"login"`
				Role  string `json:"role"`
			} `json:"member"`
		}
		err := cl.Do(cmd.Context(), http.MethodPost, "/auth/device/token", body, &res)
		if err != nil {
			var ae *api.Error
			if errors.As(err, &ae) {
				if ae.Status == 429 { // slow_down or local gate: widen the interval
					var d struct {
						IntervalSec int `json:"intervalSec"`
					}
					if json.Unmarshal(ae.Details, &d) == nil && d.IntervalSec > interval {
						interval = d.IntervalSec
					}
					continue
				}
			}
			return err
		}
		if res.Status != "ok" { // 202 pending
			continue
		}
		if err := config.SaveProfile(prof, config.Profile{API: apiBase, Token: res.Token}); err != nil {
			return err
		}
		p, _ := config.Path()
		if res.Member.Role == "pending" {
			fmt.Fprintln(a.Err, "note: your account is pending; commands return 403 until an admin approves it")
		}
		if a.jsonOut {
			return a.printer().JSONValue(map[string]any{"api": apiBase, "id": res.Member.ID, "login": res.Member.Login, "role": res.Member.Role, "profile": prof, "config": p})
		}
		fmt.Fprintf(a.Out, "logged in as %s (%s) at %s [profile %s]\nconfig: %s\n", res.Member.Login, res.Member.Role, apiBase, prof, p)
		return nil
	}
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
		Short: "Remove the stored token for the selected profile (the token itself stays valid until revoked)",
		RunE: func(_ *cobra.Command, _ []string) error {
			prof, _, err := loginProfile(a)
			if err != nil {
				return err
			}
			if err := config.RemoveProfile(prof); err != nil {
				return err
			}
			if a.jsonOut {
				p, _ := config.Path()
				return a.printer().JSONValue(map[string]any{"loggedOut": true, "profile": prof, "config": p})
			}
			fmt.Fprintf(a.Out, "logged out of profile %s; revoke the token with `yyt tokens revoke <id>` if it should no longer work\n", prof)
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
			cfg, err := config.Resolve(a.profFlag, a.apiFlag, a.tokFlag)
			if err != nil {
				return err
			}
			if a.jsonOut {
				out := map[string]any{"id": m.ID, "login": m.Login, "role": m.Role, "via": m.Via, "api": cl.Base}
				if cfg.Profile != "" {
					out["profile"] = cfg.Profile
				}
				return a.printer().JSONValue(out)
			}
			prof := cfg.Profile
			if prof == "" {
				prof = "(token from flag/env)"
			}
			return a.printer().KV([][2]string{{"id", m.ID}, {"login", m.Login}, {"role", m.Role}, {"profile", prof}, {"api", cl.Base}})
		},
	}
}
