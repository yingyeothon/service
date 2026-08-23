package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

// channel mirrors console's channelView; kind-specific fields are optional.
type channel struct {
	ID           string            `json:"id"`
	Kind         string            `json:"kind"`
	Name         string            `json:"name"`
	OwnerID      string            `json:"ownerId"`
	Config       json.RawMessage   `json:"config"`
	CreatedAt    int64             `json:"createdAt"`
	ExpiresAt    int64             `json:"expiresAt"`
	DisabledAt   *int64            `json:"disabledAt"`
	Status       string            `json:"status"`
	Issuer       string            `json:"issuer,omitempty"`
	StartURL     string            `json:"startUrl,omitempty"`
	CallbackURLs map[string]string `json:"callbackUrls,omitempty"`
	APIBase      string            `json:"apiBase,omitempty"`
	WsURL        string            `json:"wsUrl,omitempty"`
	// Only present on create / rotate-secret.
	Secret string `json:"secret,omitempty"`
	APIKey string `json:"apiKey,omitempty"`
}

// configFlags collects the kind-specific convenience flags; `--config` (JSON
// string or @file) wins when given.
type configFlags struct {
	raw string
	// auth
	audience     string
	tokenTTL     int
	allowlist    []string
	githubID     string
	githubSecret string
	googleID     string
	googleSecret string
	// topic/match
	authChannel string
	// match
	partySize   int
	waitTimeout int
	onTimeout   string
	callbackURL string
}

func (f *configFlags) bind(c *cobra.Command) {
	fl := c.Flags()
	fl.StringVar(&f.raw, "config", "", "full config as JSON (or @file); overrides the convenience flags")
	fl.StringVar(&f.audience, "audience", "", "auth: JWT audience")
	fl.IntVar(&f.tokenTTL, "token-ttl", 0, "auth: JWT lifetime in seconds (default 86400)")
	fl.StringArrayVar(&f.allowlist, "redirect", nil, "auth: allowed redirect URL (repeatable)")
	fl.StringVar(&f.githubID, "github-client-id", "", "auth: GitHub OAuth app client id")
	fl.StringVar(&f.githubSecret, "github-client-secret", "", "auth: GitHub OAuth app client secret (or GITHUB_CLIENT_SECRET env)")
	fl.StringVar(&f.googleID, "google-client-id", "", "auth: Google OAuth client id")
	fl.StringVar(&f.googleSecret, "google-client-secret", "", "auth: Google OAuth client secret (or GOOGLE_CLIENT_SECRET env)")
	fl.StringVar(&f.authChannel, "auth-channel", "", "topic/match: id of the auth channel whose JWTs are accepted")
	fl.IntVar(&f.partySize, "party-size", 0, "match: players per match (2..16)")
	fl.IntVar(&f.waitTimeout, "wait-timeout", 0, "match: seconds to wait before onTimeout (default 60)")
	fl.StringVar(&f.onTimeout, "on-timeout", "", "match: partial|fail (default fail)")
	fl.StringVar(&f.callbackURL, "callback-url", "", "match: URL called with the matched party")
}

// build turns the flags into the JSON `config` for the given kind. For PATCH
// only the flags that were set are emitted; for create, defaults apply server-side.
func (f *configFlags) build(c *cobra.Command, kind string, patch bool) (map[string]any, error) {
	if f.raw != "" {
		var m map[string]any
		src := f.raw
		if strings.HasPrefix(src, "@") {
			b, err := os.ReadFile(src[1:])
			if err != nil {
				return nil, err
			}
			src = string(b)
		}
		if err := json.Unmarshal([]byte(src), &m); err != nil {
			return nil, fmt.Errorf("--config: %w", err)
		}
		return m, nil
	}
	set := func(n string) bool { return c.Flags().Changed(n) }
	m := map[string]any{}
	switch kind {
	case "auth":
		if set("audience") {
			m["audience"] = f.audience
		}
		if set("token-ttl") {
			m["tokenTtlSec"] = f.tokenTTL
		}
		if set("redirect") {
			m["redirectAllowlist"] = f.allowlist
		}
		providers := map[string]any{}
		if set("github-client-secret") && !set("github-client-id") {
			return nil, errors.New("--github-client-secret needs --github-client-id (the pair is replaced together)")
		}
		if set("google-client-secret") && !set("google-client-id") {
			return nil, errors.New("--google-client-secret needs --google-client-id (the pair is replaced together)")
		}
		if set("github-client-id") {
			sec := f.githubSecret
			if sec == "" {
				sec = os.Getenv("GITHUB_CLIENT_SECRET")
			}
			p := map[string]any{"clientId": f.githubID}
			if sec != "" {
				p["clientSecret"] = sec
			} else if !patch {
				return nil, errors.New("--github-client-secret (or GITHUB_CLIENT_SECRET) is required with --github-client-id")
			}
			providers["github"] = p
		}
		if set("google-client-id") {
			sec := f.googleSecret
			if sec == "" {
				sec = os.Getenv("GOOGLE_CLIENT_SECRET")
			}
			p := map[string]any{"clientId": f.googleID}
			if sec != "" {
				p["clientSecret"] = sec
			} else if !patch {
				return nil, errors.New("--google-client-secret (or GOOGLE_CLIENT_SECRET) is required with --google-client-id")
			}
			providers["google"] = p
		}
		if len(providers) > 0 {
			m["providers"] = providers
		}
		if !patch && m["audience"] == nil {
			return nil, errors.New("--audience is required for auth channels")
		}
	case "topic":
		if set("auth-channel") {
			m["authChannelId"] = f.authChannel
		}
		if !patch && m["authChannelId"] == nil {
			return nil, errors.New("--auth-channel is required for topic channels")
		}
	case "match":
		if set("auth-channel") {
			m["authChannelId"] = f.authChannel
		}
		if set("party-size") {
			m["partySize"] = f.partySize
		}
		if set("wait-timeout") {
			m["waitTimeoutSec"] = f.waitTimeout
		}
		if set("on-timeout") {
			m["onTimeout"] = f.onTimeout
		}
		if set("callback-url") {
			m["callbackUrl"] = f.callbackURL
		}
		if !patch {
			for k, fl := range map[string]string{"authChannelId": "--auth-channel", "partySize": "--party-size", "callbackUrl": "--callback-url"} {
				if m[k] == nil {
					return nil, fmt.Errorf("%s is required for match channels", fl)
				}
			}
		}
	default:
		return nil, fmt.Errorf("unknown kind %q (auth|topic|match)", kind)
	}
	return m, nil
}

func newChannels(a *App) *cobra.Command {
	c := &cobra.Command{Use: "channels", Short: "Manage auth/topic/match channels"}

	var kind, scope string
	list := &cobra.Command{
		Use:   "list",
		Short: "List your channels (admins: --scope all)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if kind != "" && kind != "auth" && kind != "topic" && kind != "match" {
				return fmt.Errorf("--kind must be auth|topic|match (got %q)", kind)
			}
			cl, err := a.client()
			if err != nil {
				return err
			}
			qv := url.Values{}
			if kind != "" {
				qv.Set("kind", kind)
			}
			if scope != "" {
				qv.Set("scope", scope)
			}
			q := ""
			if len(qv) > 0 {
				q = "?" + qv.Encode()
			}
			var res struct {
				Channels []channel `json:"channels"`
			}
			if err := cl.Do(cmd.Context(), http.MethodGet, "/channels"+q, nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Channels))
			for _, ch := range res.Channels {
				rows = append(rows, []string{ch.ID, ch.Kind, ch.Name, ch.Status, output.Time(ch.ExpiresAt), ch.OwnerID})
			}
			return a.printer().Table([]string{"ID", "KIND", "NAME", "STATUS", "EXPIRES", "OWNER"}, rows)
		},
	}
	list.Flags().StringVar(&kind, "kind", "", "filter: auth|topic|match")
	list.Flags().StringVar(&scope, "scope", "", "mine (default) | all (admin)")
	c.AddCommand(list)

	var cf configFlags
	var ckind, cname string
	create := &cobra.Command{
		Use:   "create --kind <auth|topic|match> --name <name> [config flags]",
		Short: "Create a channel; the secret/apiKey is printed once",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := cf.build(cmd, ckind, false)
			if err != nil {
				return err
			}
			cl, err := a.client()
			if err != nil {
				return err
			}
			var ch channel
			body := map[string]any{"kind": ckind, "name": cname, "config": cfg}
			if err := cl.Do(cmd.Context(), http.MethodPost, "/channels", body, &ch); err != nil {
				return err
			}
			return a.showChannel(ch, true)
		},
	}
	create.Flags().StringVar(&ckind, "kind", "", "auth|topic|match")
	create.Flags().StringVar(&cname, "name", "", "display name")
	_ = create.MarkFlagRequired("kind")
	_ = create.MarkFlagRequired("name")
	cf.bind(create)
	c.AddCommand(create)

	c.AddCommand(&cobra.Command{
		Use:   "get <channel-id>",
		Short: "Show a channel (secrets are never returned)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			var ch channel
			if err := cl.Do(cmd.Context(), http.MethodGet, "/channels/"+api.PathID(args[0]), nil, &ch); err != nil {
				return err
			}
			return a.showChannel(ch, false)
		},
	})

	var pf configFlags
	var pname string
	update := &cobra.Command{
		Use:   "update <channel-id> [--name ...] [config flags]",
		Short: "Update name and/or config (owner only); only the given flags change",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			body := map[string]any{}
			if cmd.Flags().Changed("name") {
				body["name"] = pname
			}
			// Kind is needed to interpret the flags: fetch unless --config is given.
			anyCfg := pf.raw != ""
			for _, n := range []string{"audience", "token-ttl", "redirect", "github-client-id", "github-client-secret", "google-client-id", "google-client-secret", "auth-channel", "party-size", "wait-timeout", "on-timeout", "callback-url"} {
				anyCfg = anyCfg || cmd.Flags().Changed(n)
			}
			if anyCfg {
				var cur channel
				if err := cl.Do(cmd.Context(), http.MethodGet, "/channels/"+api.PathID(args[0]), nil, &cur); err != nil {
					return err
				}
				cfg, err := pf.build(cmd, cur.Kind, true)
				if err != nil {
					return err
				}
				// auth PATCH is a partial merge server-side; topic/match PATCH
				// replaces the whole config, so overlay the flags on the current one.
				if cur.Kind != "auth" && pf.raw == "" {
					merged := map[string]any{}
					if err := json.Unmarshal(cur.Config, &merged); err != nil {
						return fmt.Errorf("current config: %w", err)
					}
					for k, v := range cfg {
						merged[k] = v
					}
					cfg = merged
				}
				body["config"] = cfg
			}
			if len(body) == 0 {
				return errors.New("nothing to update")
			}
			var ch channel
			if err := cl.Do(cmd.Context(), http.MethodPatch, "/channels/"+api.PathID(args[0]), body, &ch); err != nil {
				return err
			}
			return a.showChannel(ch, false)
		},
	}
	update.Flags().StringVar(&pname, "name", "", "new display name")
	pf.bind(update)
	c.AddCommand(update)

	c.AddCommand(&cobra.Command{
		Use:   "extend <channel-id>",
		Short: "Extend expiry by 7 days (max 28 days ahead); revives a disabled channel",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			var ch channel
			if err := cl.Do(cmd.Context(), http.MethodPost, "/channels/"+api.PathID(args[0])+"/extend", nil, &ch); err != nil {
				return err
			}
			return a.showChannel(ch, false)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:   "rotate-secret <channel-id>",
		Short: "Replace the channel secret/apiKey (owner only); the new value is printed once",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			var ch channel
			if err := cl.Do(cmd.Context(), http.MethodPost, "/channels/"+api.PathID(args[0])+"/rotate-secret", nil, &ch); err != nil {
				return err
			}
			return a.showChannel(ch, true)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:   "delete <channel-id>",
		Short: "Delete a channel (soft delete; secrets are dropped immediately)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			if err := cl.Do(cmd.Context(), http.MethodDelete, "/channels/"+api.PathID(args[0]), nil, nil); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"id": args[0], "deleted": true})
			}
			fmt.Fprintf(a.Out, "deleted %s\n", args[0])
			return nil
		},
	})
	return c
}

func (a *App) showChannel(ch channel, withSecret bool) error {
	if withSecret {
		fmt.Fprintln(a.Err, "store the secret now; it is not shown again")
	}
	if a.jsonOut {
		return a.printer().JSONValue(ch)
	}
	pairs := [][2]string{
		{"id", ch.ID}, {"kind", ch.Kind}, {"name", ch.Name}, {"status", ch.Status},
		{"owner", ch.OwnerID}, {"created", output.Time(ch.CreatedAt)}, {"expires", output.Time(ch.ExpiresAt)},
	}
	if ch.DisabledAt != nil {
		pairs = append(pairs, [2]string{"disabled", output.Time(*ch.DisabledAt)})
	}
	if ch.Issuer != "" {
		pairs = append(pairs, [2]string{"issuer", ch.Issuer})
	}
	if ch.StartURL != "" {
		pairs = append(pairs, [2]string{"startUrl", ch.StartURL})
	}
	provs := make([]string, 0, len(ch.CallbackURLs))
	for p := range ch.CallbackURLs {
		provs = append(provs, p)
	}
	sort.Strings(provs)
	for _, p := range provs {
		pairs = append(pairs, [2]string{"callback." + p, ch.CallbackURLs[p]})
	}
	if ch.APIBase != "" {
		pairs = append(pairs, [2]string{"apiBase", ch.APIBase})
	}
	if ch.WsURL != "" {
		pairs = append(pairs, [2]string{"wsUrl", ch.WsURL})
	}
	if len(ch.Config) > 0 {
		pairs = append(pairs, [2]string{"config", string(ch.Config)})
	}
	if withSecret {
		if ch.Secret != "" {
			pairs = append(pairs, [2]string{"secret", ch.Secret})
		}
		if ch.APIKey != "" {
			pairs = append(pairs, [2]string{"apiKey", ch.APIKey})
		}
	}
	return a.printer().KV(pairs)
}
