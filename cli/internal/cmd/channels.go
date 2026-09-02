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
	TeamID       *string           `json:"teamId"`
	TeamName     *string           `json:"teamName"`
	ProjectID    *string           `json:"projectId"`
	ProjectName  *string           `json:"projectName"`
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
	// `q` only: Redis names derived from the channel id. They must match the
	// participant's tslib configuration and their scoped ACL exactly, so the
	// CLI prints them verbatim rather than reformatting them.
	Redis *channelRedis `json:"redis,omitempty"`
	// Only present on create / rotate-secret.
	Secret string `json:"secret,omitempty"`
	APIKey string `json:"apiKey,omitempty"`
}

// channelRedis mirrors console's `gatewayRedis` for `q` channels.
type channelRedis struct {
	EventKeyPrefix    string `json:"eventKeyPrefix"`
	QueueKeyPrefix    string `json:"queueKeyPrefix"`
	LockKeyPrefix     string `json:"lockKeyPrefix"`
	AwaiterKeyPrefix  string `json:"awaiterKeyPrefix"`
	ChannelPrefix     string `json:"channelPrefix"`
	ACLKeyPattern     string `json:"aclKeyPattern"`
	ACLChannelPattern string `json:"aclChannelPattern"`
	ACLUsername       string `json:"aclUsername"`
}

// redisUser mirrors console's `/channels/{id}/redis-user`: the whole block a
// participant pastes into their own Lambda. Password is present on issue only.
type redisUser struct {
	ChannelID        string `json:"channelId"`
	Host             string `json:"host"`
	Port             int    `json:"port"`
	Username         string `json:"username"`
	Password         string `json:"password,omitempty"`
	EventKeyPrefix   string `json:"eventKeyPrefix"`
	QueueKeyPrefix   string `json:"queueKeyPrefix"`
	LockKeyPrefix    string `json:"lockKeyPrefix"`
	AwaiterKeyPrefix string `json:"awaiterKeyPrefix"`
	ChannelPrefix    string `json:"channelPrefix"`
	// Absent on issue (it just became true); absent on read when the stage has
	// no issuer account, in which case `Configured` is false.
	Issued     *bool `json:"issued,omitempty"`
	Configured *bool `json:"configured,omitempty"`
	// Present on issue and only when false: the account is live but missing
	// from Redis' ACL file, so it dies at the next restart.
	Persisted *bool `json:"persisted,omitempty"`
	// Absent on issue/show; `revoke` reports whether anything was removed.
	Revoked *bool `json:"revoked,omitempty"`
}

// docKey mirrors console's `/channels/{id}/doc-key`: the state service's
// server credential, on the auth channel that owns the document namespace.
// APIKey is present on issue only.
type docKey struct {
	ChannelID string `json:"channelId"`
	DocURL    string `json:"docUrl"`
	WritePath string `json:"writePath"`
	APIKey    string `json:"apiKey,omitempty"`
	// Absent on issue (it just became true).
	Issued *bool `json:"issued,omitempty"`
	// Absent when the console has no handle on the document table.
	Documents *int `json:"documents,omitempty"`
	// Present on read and only when false: this stage has no state stack.
	Configured *bool `json:"configured,omitempty"`
	// Absent on issue/show; `revoke` reports whether anything was removed.
	Revoked *bool `json:"revoked,omitempty"`
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
	// lobby
	capPos      bool
	capSay      []string
	capParty    bool
	capEvent    bool
	capDebug    bool
	flushMs     int
	maxMove     int
	rateLimit   int
	partyMax    int
	defaultZone string
	mapURL      string
	maxPeers    int
	aoiRange    int
}

// lobbyObjectFlags are the flags that land inside a nested lobby config
// object; `update` merges them one level deeper than the rest.
var lobbyObjectFlags = map[string]string{"aoi-range": "aoi"}

// lobbyCapFlags are the flags that land inside the nested `capabilities`
// object; `update` has to merge them one level deeper than the rest.
var lobbyCapFlags = map[string]string{
	"cap-pos":   "pos",
	"cap-say":   "say",
	"cap-party": "party",
	"cap-event": "event",
	"cap-debug": "debug",
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
	fl.BoolVar(&f.capPos, "cap-pos", true, "lobby: enable the positional relay (--cap-pos=false disables zones entirely)")
	fl.StringArrayVar(&f.capSay, "cap-say", nil, "lobby: permitted chat scope zone|party|user, or none to disable chat (repeatable; default zone)")
	fl.BoolVar(&f.capParty, "cap-party", true, "lobby: enable the party primitive")
	fl.BoolVar(&f.capEvent, "cap-event", true, "lobby: enable the opaque game-defined relay")
	fl.BoolVar(&f.capDebug, "cap-debug", false, "lobby: enable admin/cheat commands")
	fl.IntVar(&f.flushMs, "flush-interval-ms", 0, "lobby: relay coalescing interval, also the hello tick (default 200)")
	fl.IntVar(&f.maxMove, "max-move-delta", 0, "lobby: largest tile delta one pos may carry (default 4)")
	fl.IntVar(&f.rateLimit, "rate-limit", 0, "lobby: inbound messages per second per connection (default 30)")
	fl.IntVar(&f.partyMax, "party-size-max", 0, "lobby: largest party (default 4)")
	fl.StringVar(&f.defaultZone, "zone", "", "lobby: zone announced in hello (default lobby)")
	fl.StringVar(&f.mapURL, "map-url", "", "lobby: immutable map asset URL announced in hello")
	fl.IntVar(&f.maxPeers, "max-peers", 0, "lobby: nearest peers a player sees, 1..256, always applied (default 64)")
	fl.IntVar(&f.maxPeers, "aoi-max-peers", 0, "lobby: deprecated alias of --max-peers")
	_ = fl.MarkDeprecated("aoi-max-peers", "use --max-peers; the cap applies with or without a view range")
	fl.IntVar(&f.aoiRange, "aoi-range", 0, "lobby: area-of-interest view range in tiles on both axes, 1..256 (default none = whole zone; 0 on update removes it)")
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
	case "lobby":
		if set("auth-channel") {
			m["authChannelId"] = f.authChannel
		}
		caps := map[string]any{}
		if set("cap-pos") {
			caps["pos"] = f.capPos
		}
		if set("cap-say") {
			// `none` is the only way to express an empty list: a repeated string
			// flag cannot carry one, and without it `--cap-pos=false` is
			// unusable (the server defaults say to ["zone"], which then needs
			// positions and is rejected).
			scopes := f.capSay
			for _, sc := range scopes {
				if sc != "none" {
					continue
				}
				if len(scopes) != 1 {
					return nil, errors.New("--cap-say none cannot be combined with other scopes")
				}
				scopes = []string{}
			}
			caps["say"] = scopes
		}
		if set("cap-party") {
			caps["party"] = f.capParty
		}
		if set("cap-event") {
			caps["event"] = f.capEvent
		}
		if set("cap-debug") {
			caps["debug"] = f.capDebug
		}
		if len(caps) > 0 {
			m["capabilities"] = caps
		}
		if set("flush-interval-ms") {
			m["flushIntervalMs"] = f.flushMs
		}
		if set("max-move-delta") {
			m["maxMoveDelta"] = f.maxMove
		}
		if set("rate-limit") {
			m["rateLimit"] = f.rateLimit
		}
		if set("party-size-max") {
			m["partySizeMax"] = f.partyMax
		}
		if set("zone") {
			m["defaultZone"] = f.defaultZone
		}
		if set("map-url") {
			m["mapUrl"] = f.mapURL
		}
		if set("max-peers") || set("aoi-max-peers") {
			if set("max-peers") && set("aoi-max-peers") {
				return nil, errors.New("--aoi-max-peers is an alias of --max-peers; give one")
			}
			if f.maxPeers <= 0 {
				return nil, errors.New("--max-peers must be positive")
			}
			m["maxPeers"] = f.maxPeers
		}
		if set("aoi-range") {
			switch {
			case f.aoiRange == 0 && patch:
				// An untyped nil removes the object on update (`merged`
				// drops nil keys); a typed nil map would survive the check.
				m["aoi"] = nil
			case f.aoiRange <= 0:
				return nil, errors.New("--aoi-range must be positive")
			default:
				m["aoi"] = map[string]any{"range": f.aoiRange}
			}
		}
		if !patch && m["authChannelId"] == nil {
			return nil, errors.New("--auth-channel is required for lobby channels")
		}
	case "q":
		if set("auth-channel") {
			m["authChannelId"] = f.authChannel
		}
		// Everything else a q channel needs (the three Redis prefixes) is
		// derived from the channel id server-side; there is nothing to pass.
		if !patch && m["authChannelId"] == nil {
			return nil, errors.New("--auth-channel is required for q channels")
		}
	default:
		return nil, fmt.Errorf("unknown kind %q (auth|topic|match|lobby|q)", kind)
	}
	return m, nil
}

var channelKinds = map[string]bool{"auth": true, "topic": true, "match": true, "lobby": true, "q": true}

func newChannels(a *App) *cobra.Command {
	c := &cobra.Command{
		Use:   "channels",
		Short: "Manage auth/topic/match/lobby/q channels (a channel belongs to a project)",
		Long: "Manage auth/topic/match/lobby/q channels. A channel belongs to a project.\n\n" +
			"<channel> is an id (auth_…, match_…) or a name unique within the team; a name\n" +
			"is looked up in the project context (--project, YYT_PROJECT, " + ContextFile + ",\n" +
			"`yyt project use`). `create` needs an explicit project context.",
	}

	// channelID resolves <channel> (id or name). write=true refuses to
	// auto-select the project a name is looked up in.
	channelID := func(cmd *cobra.Command, arg string, write bool) (*ctxClient, string, error) {
		cc, err := a.ctxClient(cmd)
		if err != nil {
			return nil, "", err
		}
		id, err := cc.channel(cmd.Context(), arg, write)
		return cc, id, err
	}

	var kind, scope string
	list := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the channels of the project in context, or of every team you sit in (admins: --scope all)",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if kind != "" && !channelKinds[kind] {
				return fmt.Errorf("--kind must be auth|topic|match|lobby|q (got %q)", kind)
			}
			cc, err := a.ctxClient(cmd)
			if err != nil {
				return err
			}
			qv := url.Values{}
			if kind != "" {
				qv.Set("kind", kind)
			}
			// A named context narrows to one project; otherwise the flat list
			// across every seated team (and, for admins, --scope all).
			path := "/channels"
			if scope != "" {
				qv.Set("scope", scope)
			} else if cc.spec.explicitTeam() || cc.spec.explicitProject() {
				r, err := cc.project(cmd.Context(), false)
				if err != nil {
					return err
				}
				path = "/projects/" + api.PathID(r.ProjectID) + "/channels"
			}
			q := ""
			if len(qv) > 0 {
				q = "?" + qv.Encode()
			}
			var res struct {
				Channels []channel `json:"channels"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, path+q, nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Channels))
			for _, ch := range res.Channels {
				rows = append(rows, []string{ch.ID, ch.Kind, ch.Name, ch.Status, output.Time(ch.ExpiresAt), crumb(ch.TeamName, ch.ProjectName)})
			}
			return a.printer().Table([]string{"ID", "KIND", "NAME", "STATUS", "EXPIRES", "TEAM/PROJECT"}, rows)
		},
	}
	list.Flags().StringVar(&kind, "kind", "", "filter: auth|topic|match|lobby|q")
	list.Flags().StringVar(&scope, "scope", "", "mine (default) | all (admin; ignores the project context)")
	c.AddCommand(list)

	var cf configFlags
	var ckind, cname string
	create := &cobra.Command{
		Use:   "create --kind <auth|topic|match|lobby|q> --name <name> [config flags]",
		Short: "Create a channel in the project context (explicit); the secret/apiKey is printed once",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if cf.raw == "" && channelKinds[ckind] {
				if err := rejectForeignFlags(cmd, ckind); err != nil {
					return err
				}
			}
			cfg, err := cf.build(cmd, ckind, false)
			if err != nil {
				return err
			}
			cc, err := a.ctxClient(cmd)
			if err != nil {
				return err
			}
			r, err := cc.project(cmd.Context(), true)
			if err != nil {
				return err
			}
			if err := resolveAuthChannel(cmd, cc, cfg); err != nil {
				return err
			}
			var ch channel
			body := map[string]any{"kind": ckind, "name": cname, "config": cfg}
			if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/projects/"+api.PathID(r.ProjectID)+"/channels", body, &ch); err != nil {
				return err
			}
			return a.showChannel(ch, true)
		},
	}
	create.Flags().StringVar(&ckind, "kind", "", "auth|topic|match|lobby|q")
	create.Flags().StringVar(&cname, "name", "", "display name")
	_ = create.MarkFlagRequired("kind")
	_ = create.MarkFlagRequired("name")
	cf.bind(create)
	c.AddCommand(create)

	c.AddCommand(&cobra.Command{
		Use:   "get <channel>",
		Short: "Show a channel (secrets are never returned)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := channelID(cmd, args[0], false)
			if err != nil {
				return err
			}
			var ch channel
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/channels/"+api.PathID(id), nil, &ch); err != nil {
				return err
			}
			return a.showChannel(ch, false)
		},
	})

	var pf configFlags
	var pname string
	update := &cobra.Command{
		Use:   "update <channel> [--name ...] [config flags]",
		Short: "Update name and/or config; only the given flags change",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := channelID(cmd, args[0], true)
			if err != nil {
				return err
			}
			cl := cc.cl
			body := map[string]any{}
			if cmd.Flags().Changed("name") {
				body["name"] = pname
			}
			// Kind is needed to interpret the flags: fetch unless --config is given.
			anyCfg := pf.raw != ""
			for _, n := range configFlagNames {
				anyCfg = anyCfg || cmd.Flags().Changed(n)
			}
			if anyCfg {
				var cur channel
				if err := cl.Do(cmd.Context(), http.MethodGet, "/channels/"+api.PathID(id), nil, &cur); err != nil {
					return err
				}
				if err := rejectForeignFlags(cmd, cur.Kind); err != nil {
					return err
				}
				cfg, err := pf.build(cmd, cur.Kind, true)
				if err != nil {
					return err
				}
				if err := resolveAuthChannel(cmd, cc, cfg); err != nil {
					return err
				}
				// auth PATCH is a partial merge server-side; every other kind
				// replaces the whole config, so overlay the flags on the current one.
				if cur.Kind != "auth" && pf.raw == "" {
					merged := map[string]any{}
					if err := json.Unmarshal(cur.Config, &merged); err != nil {
						return fmt.Errorf("current config: %w", err)
					}
					for k, v := range cfg {
						if v == nil {
							// A flag that clears an optional object (`--aoi-range 0`).
							delete(merged, k)
							continue
						}
						// `capabilities` and `aoi` are nested objects: a top-level
						// overwrite would silently reset the flags not given.
						if k == "capabilities" || k == "aoi" {
							if cm, ok := mergeCapabilities(merged[k], v); ok {
								merged[k] = cm
								continue
							}
						}
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
			if err := cl.Do(cmd.Context(), http.MethodPatch, "/channels/"+api.PathID(id), body, &ch); err != nil {
				return err
			}
			return a.showChannel(ch, false)
		},
	}
	update.Flags().StringVar(&pname, "name", "", "new display name")
	pf.bind(update)
	c.AddCommand(update)

	c.AddCommand(&cobra.Command{
		Use:   "extend <channel>",
		Short: "Extend expiry by 7 days (max 28 days ahead); revives a disabled channel",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := channelID(cmd, args[0], true)
			if err != nil {
				return err
			}
			var ch channel
			if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/channels/"+api.PathID(id)+"/extend", nil, &ch); err != nil {
				return err
			}
			return a.showChannel(ch, false)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:   "rotate-secret <channel>",
		Short: "Replace the channel secret/apiKey (owner only); the new value is printed once",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := channelID(cmd, args[0], true)
			if err != nil {
				return err
			}
			var ch channel
			if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/channels/"+api.PathID(id)+"/rotate-secret", nil, &ch); err != nil {
				return err
			}
			return a.showChannel(ch, true)
		},
	})
	c.AddCommand(a.channelRedisUserCmd(channelID))
	c.AddCommand(a.channelDocKeyCmd(channelID))
	c.AddCommand(&cobra.Command{
		Use:     "delete <channel>",
		Aliases: []string{"rm"},
		Short:   "Delete a channel (soft delete; secrets are dropped immediately)",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := channelID(cmd, args[0], true)
			if err != nil {
				return err
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodDelete, "/channels/"+api.PathID(id), nil, nil); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"id": id, "deleted": true})
			}
			fmt.Fprintf(a.Out, "deleted %s\n", id)
			return nil
		},
	})
	return group(c)
}

// kindConfigFlags is the config flags each kind understands. `update` uses the
// union to decide whether it must fetch the channel, and the per-kind set to
// refuse a flag that would otherwise be accepted and silently do nothing.
var kindConfigFlags = func() map[string][]string {
	m := map[string][]string{
		"auth": {
			"audience", "token-ttl", "redirect",
			"github-client-id", "github-client-secret",
			"google-client-id", "google-client-secret",
		},
		"topic": {"auth-channel"},
		"match": {"auth-channel", "party-size", "wait-timeout", "on-timeout", "callback-url"},
		"lobby": {
			"auth-channel", "flush-interval-ms", "max-move-delta",
			"rate-limit", "party-size-max", "zone", "map-url",
			"max-peers", "aoi-max-peers",
		},
		"q": {"auth-channel"},
	}
	for n := range lobbyCapFlags {
		m["lobby"] = append(m["lobby"], n)
	}
	for n := range lobbyObjectFlags {
		m["lobby"] = append(m["lobby"], n)
	}
	for _, names := range m {
		sort.Strings(names)
	}
	return m
}()

// configFlagNames is the union: every flag `build` reads for any kind.
var configFlagNames = func() []string {
	seen := map[string]bool{}
	var names []string
	for _, per := range kindConfigFlags {
		for _, n := range per {
			if !seen[n] {
				seen[n] = true
				names = append(names, n)
			}
		}
	}
	sort.Strings(names)
	return names
}()

// rejectForeignFlags refuses a config flag that does not belong to this kind.
// Without it `yyt channels update <q-id> --cap-debug` PATCHes the config back
// unchanged and prints a success view.
func rejectForeignFlags(c *cobra.Command, kind string) error {
	allowed := map[string]bool{}
	for _, n := range kindConfigFlags[kind] {
		allowed[n] = true
	}
	for _, n := range configFlagNames {
		if c.Flags().Changed(n) && !allowed[n] {
			return fmt.Errorf("--%s does not apply to a %s channel", n, kind)
		}
	}
	return nil
}

// mergeCapabilities overlays the given capability flags onto the stored object
// instead of replacing it. Reports false when the stored value is not an
// object, in which case the caller replaces it wholesale.
func mergeCapabilities(current, incoming any) (map[string]any, bool) {
	cur, ok := current.(map[string]any)
	if !ok {
		return nil, false
	}
	in, ok := incoming.(map[string]any)
	if !ok {
		return nil, false
	}
	out := make(map[string]any, len(cur)+len(in))
	for k, v := range cur {
		out[k] = v
	}
	for k, v := range in {
		out[k] = v
	}
	return out, true
}

// channelRedisUserCmd manages the scoped Redis account a `q` channel's game
// Lambda logs in with. The account is not a channel secret — a `q` channel has
// none — so this lives beside `rotate-secret` rather than inside it.
// channelResolver turns <channel> into an id; write=true means the command mutates.
type channelResolver func(cmd *cobra.Command, arg string, write bool) (*ctxClient, string, error)

func (a *App) channelRedisUserCmd(channelID channelResolver) *cobra.Command {
	c := &cobra.Command{
		Use:     "redis-user",
		Aliases: []string{"redis"},
		Short:   "Scoped Redis account for a `q` channel's game Lambda (owner issues; admins may read)",
	}
	call := func(cmd *cobra.Command, method, arg string) (redisUser, error) {
		cc, id, err := channelID(cmd, arg, method != http.MethodGet)
		if err != nil {
			return redisUser{}, err
		}
		var u redisUser
		err = cc.cl.Do(cmd.Context(), method, "/channels/"+api.PathID(id)+"/redis-user", nil, &u)
		return u, err
	}
	c.AddCommand(&cobra.Command{
		Use:   "show <channel>",
		Short: "Show the connection block and whether an account has been issued",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			u, err := call(cmd, http.MethodGet, args[0])
			if err != nil {
				return err
			}
			return a.showRedisUser(u)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:     "issue <channel>",
		Aliases: []string{"rotate"},
		Short:   "Create or replace the account; the password is printed once",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			u, err := call(cmd, http.MethodPost, args[0])
			if err != nil {
				return err
			}
			fmt.Fprintln(a.Err, "store the password now; it is not shown again")
			if u.Persisted != nil && !*u.Persisted {
				// The account works right now but is not in Redis' ACL file.
				fmt.Fprintln(a.Err, "WARNING: not persisted — this account disappears if Redis restarts; issue again once the host is healthy")
			}
			return a.showRedisUser(u)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:     "revoke <channel>",
		Aliases: []string{"rm", "delete"},
		Short:   "Delete the account; the game Lambda stops being able to log in",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			u, err := call(cmd, http.MethodDelete, args[0])
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(u)
			}
			if u.Revoked != nil && *u.Revoked {
				fmt.Fprintf(a.Out, "revoked the redis account of %s\n", args[0])
			} else {
				fmt.Fprintf(a.Out, "%s had no redis account\n", args[0])
			}
			return nil
		},
	})
	return c
}

func (a *App) showRedisUser(u redisUser) error {
	if a.jsonOut {
		return a.printer().JSONValue(u)
	}
	// One block, pasted verbatim: the four key prefixes are tslib's
	// `handleActor` options and the account is scoped to exactly them, so a
	// value the participant retypes lands outside the ACL and fails NOPERM.
	pairs := [][2]string{
		{"channel", u.ChannelID},
		{"host", u.Host},
		{"port", fmt.Sprintf("%d", u.Port)},
		{"username", u.Username},
	}
	if u.Password != "" {
		pairs = append(pairs, [2]string{"password", u.Password})
	} else if u.Issued != nil {
		pairs = append(pairs, [2]string{"issued", fmt.Sprintf("%t", *u.Issued)})
	} else if u.Configured != nil && !*u.Configured {
		pairs = append(pairs, [2]string{"issued", "unknown (stage has no issuer account)"})
	}
	pairs = append(pairs,
		[2]string{"eventKeyPrefix", u.EventKeyPrefix},
		[2]string{"queueKeyPrefix", u.QueueKeyPrefix},
		[2]string{"lockKeyPrefix", u.LockKeyPrefix},
		[2]string{"awaiterKeyPrefix", u.AwaiterKeyPrefix},
		[2]string{"channelPrefix", u.ChannelPrefix},
	)
	return a.printer().KV(pairs)
}

// channelDocKeyCmd manages the state service's server credential. It hangs off
// the auth channel because the document namespace does — an `ownerId` only
// means anything inside the auth channel that derived it. Separate from
// `rotate-secret` because rotating the signing key must not invalidate this
// one, and the reverse.
func (a *App) channelDocKeyCmd(channelID channelResolver) *cobra.Command {
	c := &cobra.Command{
		Use:     "doc-key",
		Aliases: []string{"doc"},
		Short:   "Document API key for an `auth` channel (owner issues; admins may read)",
	}
	call := func(cmd *cobra.Command, method, arg string) (docKey, error) {
		cc, id, err := channelID(cmd, arg, method != http.MethodGet)
		if err != nil {
			return docKey{}, err
		}
		var k docKey
		err = cc.cl.Do(cmd.Context(), method, "/channels/"+api.PathID(id)+"/doc-key", nil, &k)
		return k, err
	}
	c.AddCommand(&cobra.Command{
		Use:   "show <channel>",
		Short: "Show the document endpoint and whether a key has been issued",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			k, err := call(cmd, http.MethodGet, args[0])
			if err != nil {
				return err
			}
			return a.showDocKey(k)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:     "issue <channel>",
		Aliases: []string{"rotate"},
		Short:   "Create or replace the key; it is printed once",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			k, err := call(cmd, http.MethodPost, args[0])
			if err != nil {
				return err
			}
			fmt.Fprintln(a.Err, "store the key now; it is not shown again")
			return a.showDocKey(k)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:     "revoke <channel>",
		Aliases: []string{"rm", "delete"},
		Short:   "Delete the key; documents are kept",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			k, err := call(cmd, http.MethodDelete, args[0])
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(k)
			}
			if k.Revoked != nil && *k.Revoked {
				fmt.Fprintf(a.Out, "revoked the document key of %s\n", args[0])
			} else {
				fmt.Fprintf(a.Out, "%s had no document key\n", args[0])
			}
			return nil
		},
	})
	return c
}

func (a *App) showDocKey(k docKey) error {
	if a.jsonOut {
		return a.printer().JSONValue(k)
	}
	pairs := [][2]string{
		{"channel", k.ChannelID},
		{"docUrl", k.DocURL},
		{"path", k.WritePath},
	}
	if k.APIKey != "" {
		pairs = append(pairs, [2]string{"apiKey", k.APIKey})
	} else if k.Issued != nil {
		pairs = append(pairs, [2]string{"issued", fmt.Sprintf("%t", *k.Issued)})
	}
	if k.Documents != nil {
		pairs = append(pairs, [2]string{"documents", fmt.Sprintf("%d", *k.Documents)})
	}
	if k.Configured != nil && !*k.Configured {
		pairs = append(pairs, [2]string{"configured", "false (no document service on this stage)"})
	}
	return a.printer().KV(pairs)
}

func (a *App) showChannel(ch channel, withSecret bool) error {
	// lobby/q channels have no secret at all, so the warning would be a lie.
	hasSecret := ch.Secret != "" || ch.APIKey != ""
	if withSecret && hasSecret {
		fmt.Fprintln(a.Err, "store the secret now; it is not shown again")
	}
	if a.jsonOut {
		return a.printer().JSONValue(ch)
	}
	pairs := [][2]string{
		{"id", ch.ID}, {"kind", ch.Kind}, {"name", ch.Name}, {"status", ch.Status},
		{"project", crumb(ch.TeamName, ch.ProjectName)},
		{"created", output.Time(ch.CreatedAt)}, {"expires", output.Time(ch.ExpiresAt)},
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
	if ch.Redis != nil {
		// One block, copied verbatim into the participant's tslib config. All
		// four key prefixes are here because `handleActor` needs all four and
		// the issued Redis account is scoped to aclKeyPattern: a prefix the
		// participant invents lands outside it (NOPERM), and one that merely
		// differs from the gateway's is a silent no-op.
		pairs = append(pairs,
			[2]string{"redis.eventKeyPrefix", ch.Redis.EventKeyPrefix},
			[2]string{"redis.queueKeyPrefix", ch.Redis.QueueKeyPrefix},
			[2]string{"redis.lockKeyPrefix", ch.Redis.LockKeyPrefix},
			[2]string{"redis.awaiterKeyPrefix", ch.Redis.AwaiterKeyPrefix},
			[2]string{"redis.channelPrefix", ch.Redis.ChannelPrefix},
			[2]string{"redis.aclKeyPattern", ch.Redis.ACLKeyPattern},
			[2]string{"redis.aclChannelPattern", ch.Redis.ACLChannelPattern},
			[2]string{"redis.aclUsername", ch.Redis.ACLUsername},
		)
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

// crumb renders the team/project breadcrumb; legacy rows not yet mapped to a
// project show "-".
func crumb(team, project *string) string {
	if team == nil || project == nil {
		return "-"
	}
	return *team + "/" + *project
}

// resolveAuthChannel lets --auth-channel take a name: the auth channel must
// live in the same project as the channel that references it, so the name
// resolves in the project context. Ids pass through untouched.
func resolveAuthChannel(cmd *cobra.Command, cc *ctxClient, cfg map[string]any) error {
	v, ok := cfg["authChannelId"].(string)
	if !ok || v == "" || IsID(v) {
		return nil
	}
	id, err := cc.channel(cmd.Context(), v, true)
	if err != nil {
		return fmt.Errorf("--auth-channel: %w", err)
	}
	cfg["authChannelId"] = id
	return nil
}
