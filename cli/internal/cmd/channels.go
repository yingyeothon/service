package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	ID          string          `json:"id"`
	Kind        string          `json:"kind"`
	Name        string          `json:"name"`
	TeamID      *string         `json:"teamId"`
	TeamName    *string         `json:"teamName"`
	ProjectID   *string         `json:"projectId"`
	ProjectName *string         `json:"projectName"`
	Config      json.RawMessage `json:"config"`
	CreatedAt   int64           `json:"createdAt"`
	ExpiresAt   int64           `json:"expiresAt"`
	DisabledAt  *int64          `json:"disabledAt"`
	Status      string          `json:"status"`
	Issuer      string          `json:"issuer,omitempty"`
	// Auth only, and a pointer so "absent" (an older console) stays distinct
	// from "false" (a channel whose player ids can be traced back to the
	// provider account they came from).
	SaltedIDs    *bool             `json:"saltedIds,omitempty"`
	StartURL     string            `json:"startUrl,omitempty"`
	CallbackURLs map[string]string `json:"callbackUrls,omitempty"`
	APIBase      string            `json:"apiBase,omitempty"`
	WsURL        string            `json:"wsUrl,omitempty"`
	// A deferred `match` channel has no socket: its tickets are an HTTP
	// resource, and this is where (absent while the stage has no HTTP host).
	TicketURL string `json:"ticketUrl,omitempty"`
	// `push` only. Registered says the platform registration exists, so
	// `yyt push channel config` has a file to fetch; TeamProject is the
	// Firebase project of the team's own sender key, never the key.
	Registered  *bool  `json:"registered,omitempty"`
	TeamProject string `json:"teamProject,omitempty"`
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
	// Social profiles of this channel; absent means unknown, not zero. There
	// is deliberately no relation count -- an unbounded `COUNT(*)` has no
	// place on a read that backs the console's channel page.
	Profiles *int `json:"profiles,omitempty"`
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
	mode        string
	acceptTO    int
	resultTTL   int
	pushChannel string
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
	// push
	packageName    string
	sender         string
	serviceAccount string
	// app is where `--service-account -` finds stdin.
	app *App
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
	fl.IntVar(&f.waitTimeout, "wait-timeout", 0, "match: seconds to wait before onTimeout (live: 5..600, default 60; deferred: 30..7200, default 600)")
	fl.StringVar(&f.onTimeout, "on-timeout", "", "match: partial|fail (default fail)")
	fl.StringVar(&f.callbackURL, "callback-url", "", "match: URL called with the matched party (empty: no callback — members arrange the room themselves)")
	fl.StringVar(&f.mode, "mode", "", "match: live|deferred (default live; fixed at creation). live: players wait on a WebSocket; deferred: a ticket over HTTP that players accept later")
	fl.IntVar(&f.acceptTO, "accept-timeout", 0, "match, deferred: seconds every member has to accept a proposed match (30..600, default 120)")
	fl.IntVar(&f.resultTTL, "result-ttl", 0, "match, deferred: seconds a finished ticket stays readable (60..3600, default 600)")
	fl.StringVar(&f.pushChannel, "push-channel", "", "match, deferred: push channel (id or name) that wakes the players; an active one of this project on the same auth channel ('' on update removes it)")
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
	fl.StringVar(&f.packageName, "package", "", "push: Android application id, e.g. com.example.game (fixed at creation)")
	fl.StringVar(&f.sender, "sender", "", "push: platform|team (default platform; fixed at creation)")
	fl.StringVar(&f.serviceAccount, "service-account", "", "push: the team's Firebase service-account key file, or - for stdin (create with --sender team only)")
}

// bindPush registers only what a push channel takes (`yyt push channel
// create|update`); `build` reads the same fields either way. `--auth` is the
// short spelling of the generic `--auth-channel`.
func (f *configFlags) bindPush(c *cobra.Command, create bool) {
	fl := c.Flags()
	fl.StringVar(&f.authChannel, "auth", "", "the auth channel (id or name) whose player JWTs may register tokens")
	fl.StringVar(&f.authChannel, "auth-channel", "", "same as --auth")
	_ = fl.MarkHidden("auth-channel")
	if !create {
		return
	}
	fl.StringVar(&f.packageName, "package", "", "Android application id, e.g. com.example.game (fixed at creation)")
	fl.StringVar(&f.sender, "sender", "", "platform|team (default platform; fixed at creation)")
	fl.StringVar(&f.serviceAccount, "service-account", "", "the team's Firebase service-account key file, or - for stdin (--sender team only)")
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
			switch {
			case f.callbackURL != "":
				m["callbackUrl"] = f.callbackURL
			case patch:
				// Untyped nil, so `update`'s merge loop deletes the key from the
				// fetched config instead of PATCHing `""` (which the server
				// refuses as a URL). This is how a channel is turned into the
				// members-only mode; on create an empty flag just means "none".
				m["callbackUrl"] = nil
			}
		}
		if set("mode") {
			if f.mode != "live" && f.mode != "deferred" {
				return nil, fmt.Errorf("--mode must be live|deferred (got %q)", f.mode)
			}
			m["mode"] = f.mode
		}
		if set("accept-timeout") {
			m["acceptTimeoutSec"] = f.acceptTO
		}
		if set("result-ttl") {
			m["resultTtlSec"] = f.resultTTL
		}
		if set("push-channel") {
			switch {
			case f.pushChannel != "":
				m["pushChannelId"] = f.pushChannel
			case patch:
				// Untyped nil: dropped from the overlaid config, as --callback-url.
				m["pushChannelId"] = nil
			}
		}
		// On update the mode is the stored one, known only after the fetch:
		// `checkMatchMode` judges the same flags there.
		if !patch {
			if err := checkMatchMode(c, f.mode); err != nil {
				return nil, err
			}
		}
		if !patch {
			for k, fl := range map[string]string{"authChannelId": "--auth-channel", "partySize": "--party-size"} {
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
	case "push":
		if set("auth") && set("auth-channel") {
			return nil, errors.New("--auth-channel is an alias of --auth; give one")
		}
		if set("auth-channel") || set("auth") {
			m["authChannelId"] = f.authChannel
		}
		if patch {
			// The registration and every stored token are bound to both.
			if set("package") || set("sender") {
				return nil, errors.New("--package and --sender are fixed at creation: make a new push channel")
			}
			if set("service-account") {
				return nil, errors.New("--service-account is for create: use `yyt push channel sender-key set <channel> --service-account <file>`")
			}
			break
		}
		if set("package") {
			m["packageName"] = f.packageName
		}
		if set("sender") {
			if f.sender != "platform" && f.sender != "team" {
				return nil, fmt.Errorf("--sender must be platform|team (got %q)", f.sender)
			}
			m["sender"] = f.sender
		}
		for k, fl := range map[string]string{"authChannelId": "--auth-channel", "packageName": "--package"} {
			if m[k] == nil {
				return nil, fmt.Errorf("%s is required for push channels", fl)
			}
		}
		switch {
		case f.sender == "team" && !set("service-account"):
			return nil, errors.New("--sender team needs --service-account <file|-> (the key of your own Firebase project)")
		case f.sender != "team" && set("service-account"):
			return nil, errors.New("--service-account needs --sender team (a platform channel gains a key with `yyt push channel sender-key set`)")
		case set("service-account"):
			var in io.Reader
			if f.app != nil {
				in = f.app.In
			}
			key, err := readServiceAccount(f.serviceAccount, in)
			if err != nil {
				return nil, err
			}
			m["teamServiceAccount"] = key
		}
	default:
		return nil, fmt.Errorf("unknown kind %q (%s)", kind, channelKindList)
	}
	return m, nil
}

var channelKinds = map[string]bool{"auth": true, "topic": true, "match": true, "lobby": true, "q": true, "push": true}

const channelKindList = "auth|topic|match|lobby|q|push"

func newChannels(a *App) *cobra.Command {
	c := &cobra.Command{
		Use:   "channels",
		Short: "Manage auth/topic/match/lobby/q/push channels (a channel belongs to a project)",
		Long: "Manage auth/topic/match/lobby/q/push channels. A channel belongs to a project.\n\n" +
			"<channel> is an id (auth_…, match_…) or a name unique within the team; a name\n" +
			"is looked up in the project context (--project, YYT_PROJECT, " + ContextFile + ",\n" +
			"`yyt project use`). `create` needs an explicit project context.\n\n" +
			"A push channel is the same resource under `yyt push channel …`, which adds\n" +
			"what only that kind has (google-services.json, the team sender key).",
	}
	a.addChannelCommands(c, "")
	return group(c)
}

// channelResolver resolves <channel> (id or name), of one kind when `kind` is
// set. write=true refuses to auto-select the project a name is looked up in.
func (a *App) channelResolver(kind string) channelResolver {
	return func(cmd *cobra.Command, arg string, write bool) (*ctxClient, string, error) {
		cc, err := a.ctxClient(cmd)
		if err != nil {
			return nil, "", err
		}
		id, err := cc.channelOfKind(cmd.Context(), arg, kind, write)
		return cc, id, err
	}
}

// addChannelCommands hangs the channel verbs on `c`. `fixedKind` is "" for
// `yyt channels` and a kind for a family that manages one (`yyt push
// channel`): the same routes and the same code, minus `--kind` and the flags
// of the other kinds.
func (a *App) addChannelCommands(c *cobra.Command, fixedKind string) {
	channelID := a.channelResolver(fixedKind)

	var kind, scope string
	var chList *listOpts
	list := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the channels of the project in context, or of every team you sit in (admins: --scope all)",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if fixedKind != "" {
				kind = fixedKind
			}
			if kind != "" && !channelKinds[kind] {
				return fmt.Errorf("--kind must be %s (got %q)", channelKindList, kind)
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
			q, err := chList.query(qv)
			if err != nil {
				return err
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
			// MODE is a match channel's (`-` for the other kinds) and sits last,
			// so the columns scripts already read by position stay put. A
			// one-kind family (`yyt push channel list`) has no use for it.
			head := []string{"ID", "KIND", "NAME", "STATUS", "EXPIRES", "TEAM/PROJECT"}
			if fixedKind == "" {
				head = append(head, "MODE")
			}
			rows := make([][]string, 0, len(res.Channels))
			for _, ch := range res.Channels {
				row := []string{ch.ID, ch.Kind, ch.Name, ch.Status, expiryText(ch.ExpiresAt), crumb(ch.TeamName, ch.ProjectName)}
				if fixedKind == "" {
					mode := "-"
					if ch.Kind == "match" {
						mode = matchModeOf(ch.Config)
					}
					row = append(row, mode)
				}
				rows = append(rows, row)
			}
			return a.printer().Table(head, rows)
		},
	}
	if fixedKind == "" {
		list.Flags().StringVar(&kind, "kind", "", "filter: "+channelKindList)
	}
	list.Flags().StringVar(&scope, "scope", "", "mine (default) | all (admin; ignores the project context)")
	chList = addListFlags(list, channelSortKeys, "channel or project name")
	c.AddCommand(list)

	cf := configFlags{app: a}
	var ckind, cname string
	create := &cobra.Command{
		Use:   "create --kind <" + channelKindList + "> --name <name> [config flags]",
		Short: "Create a channel in the project context (explicit); the secret/apiKey is printed once",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if fixedKind != "" {
				ckind = fixedKind
			}
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
			if ckind == "match" {
				if err := resolvePushChannel(cmd, cc, cfg); err != nil {
					return err
				}
			}
			var ch channel
			body := map[string]any{"kind": ckind, "name": cname, "config": cfg}
			if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/projects/"+api.PathID(r.ProjectID)+"/channels", body, &ch); err != nil {
				if ckind == "push" {
					return withPushHint(err, a.teamScopeFlag(r))
				}
				if ckind == "match" {
					return withMatchHint(err)
				}
				return err
			}
			return a.showChannel(ch, true)
		},
	}
	create.Flags().StringVar(&cname, "name", "", "display name")
	_ = create.MarkFlagRequired("name")
	if fixedKind == "push" {
		create.Use = "create --name <name> --auth <auth channel> --package <com.example.app> [--sender platform|team] [--service-account <file|->]"
		create.Short = "Create a push channel in the project context (explicit); the apiKey is printed once"
		cf.bindPush(create, true)
	} else {
		create.Flags().StringVar(&ckind, "kind", "", channelKindList)
		_ = create.MarkFlagRequired("kind")
		cf.bind(create)
	}
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

	pf := configFlags{app: a}
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
				if cur.Kind == "match" {
					// Before any write: the mode is fixed, and the deferred
					// flags mean nothing on a live channel.
					if pf.raw == "" {
						if err := checkMatchMode(cmd, matchModeOf(cur.Config)); err != nil {
							return err
						}
					}
					if err := resolvePushChannel(cmd, cc, cfg); err != nil {
						return err
					}
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
				// A push id says its kind (`newChannelId`), so no read is needed.
				if fixedKind == "push" || strings.HasPrefix(id, "push_") {
					return withPushHint(err, "", pushUpdateHints)
				}
				if strings.HasPrefix(id, "match_") {
					return withMatchHint(err)
				}
				return err
			}
			return a.showChannel(ch, false)
		},
	}
	update.Flags().StringVar(&pname, "name", "", "new display name")
	if fixedKind == "push" {
		update.Use = "update <channel> [--name ...] [--auth <auth channel>]"
		update.Short = "Update the name and/or the auth channel (the package and the sender are fixed at creation)"
		pf.bindPush(update, false)
	} else {
		pf.bind(update)
	}
	c.AddCommand(update)

	// postAction is a bodiless POST on the channel that answers with the channel.
	postAction := func(use, short, suffix string, withSecret bool) *cobra.Command {
		return &cobra.Command{
			Use:   use,
			Short: short,
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				cc, id, err := channelID(cmd, args[0], true)
				if err != nil {
					return err
				}
				var ch channel
				if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/channels/"+api.PathID(id)+suffix, nil, &ch); err != nil {
					return err
				}
				return a.showChannel(ch, withSecret)
			},
		}
	}
	c.AddCommand(postAction("extend <channel>", "Extend expiry by 7 days (max 28 days ahead); revives a disabled channel. A channel with no expiry (`yyt limit request channel.lifetime unlimited`) refuses", "/extend", false))
	rotate := postAction("rotate-secret <channel>", "Replace the channel secret/apiKey (owner only); the new value is printed once", "/rotate-secret", true)
	rotate.Aliases = []string{"rotate"}
	c.AddCommand(rotate)
	if fixedKind == "" {
		c.AddCommand(a.channelRedisUserCmd(channelID))
		c.AddCommand(a.channelDocKeyCmd(channelID))
	}
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
		"match": {
			"auth-channel", "party-size", "wait-timeout", "on-timeout", "callback-url",
			"mode", "accept-timeout", "result-ttl", "push-channel",
		},
		"lobby": {
			"auth-channel", "flush-interval-ms", "max-move-delta",
			"rate-limit", "party-size-max", "zone", "map-url",
			"max-peers", "aoi-max-peers",
		},
		"q": {"auth-channel"},
		// `auth` exists only under `yyt push channel` (bindPush).
		"push": {"auth", "auth-channel", "package", "sender", "service-account"},
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

type channelResolver = idResolver

// credentialSpec is what tells the two per-channel credential subtrees apart:
// the route segment, the nouns in the messages, and how the value is shown.
type credentialSpec[T revocable] struct {
	use, short  string
	aliases     []string
	segment     string
	noun        string
	showShort   string
	issueShort  string
	revokeShort string
	stored      string
	show        func(T) error
	// afterIssue runs between the "store it now" line and the block, when set.
	afterIssue func(T)
}

type revocable interface{ revoked() *bool }

func (u redisUser) revoked() *bool { return u.Revoked }
func (k docKey) revoked() *bool    { return k.Revoked }

// credentialCmd builds `show|issue|revoke <channel>` for one credential kind.
// Only `issue`/`revoke` resolve with write=true; `show` is a read an admin may do.
func credentialCmd[T revocable](a *App, channelID channelResolver, sp credentialSpec[T]) *cobra.Command {
	c := &cobra.Command{Use: sp.use, Aliases: sp.aliases, Short: sp.short}
	call := func(cmd *cobra.Command, method, arg string) (T, error) {
		var v T
		cc, id, err := channelID(cmd, arg, method != http.MethodGet)
		if err != nil {
			return v, err
		}
		err = cc.cl.Do(cmd.Context(), method, "/channels/"+api.PathID(id)+"/"+sp.segment, nil, &v)
		return v, err
	}
	c.AddCommand(&cobra.Command{
		Use:   "show <channel>",
		Short: sp.showShort,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			v, err := call(cmd, http.MethodGet, args[0])
			if err != nil {
				return err
			}
			return sp.show(v)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:     "issue <channel>",
		Aliases: []string{"rotate"},
		Short:   sp.issueShort,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			v, err := call(cmd, http.MethodPost, args[0])
			if err != nil {
				return err
			}
			fmt.Fprintln(a.Err, sp.stored)
			if sp.afterIssue != nil {
				sp.afterIssue(v)
			}
			return sp.show(v)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:     "revoke <channel>",
		Aliases: []string{"rm", "delete"},
		Short:   sp.revokeShort,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			v, err := call(cmd, http.MethodDelete, args[0])
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(v)
			}
			if r := v.revoked(); r != nil && *r {
				fmt.Fprintf(a.Out, "revoked the %s of %s\n", sp.noun, args[0])
			} else {
				fmt.Fprintf(a.Out, "%s had no %s\n", args[0], sp.noun)
			}
			return nil
		},
	})
	return c
}

// channelRedisUserCmd manages the scoped Redis account a `q` channel's game
// Lambda logs in with. The account is not a channel secret — a `q` channel has
// none — so this lives beside `rotate-secret` rather than inside it.
func (a *App) channelRedisUserCmd(channelID channelResolver) *cobra.Command {
	return credentialCmd(a, channelID, credentialSpec[redisUser]{
		use:         "redis-user",
		aliases:     []string{"redis"},
		short:       "Scoped Redis account for a `q` channel's game Lambda (owner issues; admins may read)",
		segment:     "redis-user",
		noun:        "redis account",
		showShort:   "Show the connection block and whether an account has been issued",
		issueShort:  "Create or replace the account; the password is printed once",
		revokeShort: "Delete the account; the game Lambda stops being able to log in",
		stored:      "store the password now; it is not shown again",
		show:        a.showRedisUser,
		afterIssue: func(u redisUser) {
			if u.Persisted != nil && !*u.Persisted {
				// The account works right now but is not in Redis' ACL file.
				fmt.Fprintln(a.Err, "WARNING: not persisted — this account disappears if Redis restarts; issue again once the host is healthy")
			}
		},
	})
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
	return credentialCmd(a, channelID, credentialSpec[docKey]{
		use:         "doc-key",
		aliases:     []string{"doc"},
		short:       "Document API key for an `auth` channel (owner issues; admins may read)",
		segment:     "doc-key",
		noun:        "document key",
		showShort:   "Show the document endpoint and whether a key has been issued",
		issueShort:  "Create or replace the key; it is printed once",
		revokeShort: "Delete the key; documents are kept",
		stored:      "store the key now; it is not shown again",
		show:        a.showDocKey,
	})
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
	if k.Profiles != nil {
		pairs = append(pairs, [2]string{"profiles", fmt.Sprintf("%d", *k.Profiles)})
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
		{"created", output.Time(ch.CreatedAt)}, {"expires", expiryText(ch.ExpiresAt)},
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
	// Printed only when it is bad news: a salted channel is the norm, and a row
	// that says so on every read trains people to skip the line.
	if ch.SaltedIDs != nil && !*ch.SaltedIDs {
		pairs = append(pairs, [2]string{
			"playerIds",
			"not salted (traceable to the provider account; make a new channel for unlinkable ids)",
		})
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
	if ch.Kind == "match" {
		pairs = append(pairs, matchPairs(ch)...)
	}
	if ch.Registered != nil {
		reg := "true (yyt push channel config " + ch.ID + ")"
		if !*ch.Registered {
			reg = "false (no platform registration: google-services.json comes from your own Firebase project)"
		}
		pairs = append(pairs, [2]string{"registered", reg})
	}
	if ch.TeamProject != "" {
		pairs = append(pairs, [2]string{"teamProject", ch.TeamProject})
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

// matchConfig is the part of a match channel's config the text view spells
// out; the whole object is still printed as `config`.
type matchConfig struct {
	Mode             string `json:"mode"`
	AcceptTimeoutSec *int   `json:"acceptTimeoutSec"`
	ResultTTLSec     *int   `json:"resultTtlSec"`
	PushChannelID    string `json:"pushChannelId"`
}

// matchModeOf reads the mode out of a match config. A live channel is stored
// without the key, so absent (and unreadable) is live.
func matchModeOf(config json.RawMessage) string {
	var c matchConfig
	if json.Unmarshal(config, &c) != nil || c.Mode == "" {
		return "live"
	}
	return c.Mode
}

// matchPairs is the text view of a match channel's mode: the mode itself and,
// for a deferred channel, its own fields and the ticket routes -- what the
// console's channel page shows in place of the WebSocket URL.
func matchPairs(ch channel) [][2]string {
	var c matchConfig
	_ = json.Unmarshal(ch.Config, &c)
	mode := matchModeOf(ch.Config)
	pairs := [][2]string{{"mode", mode}}
	if mode != "deferred" {
		return pairs
	}
	if c.AcceptTimeoutSec != nil {
		pairs = append(pairs, [2]string{"acceptTimeoutSec", fmt.Sprintf("%d", *c.AcceptTimeoutSec)})
	}
	if c.ResultTTLSec != nil {
		pairs = append(pairs, [2]string{"resultTtlSec", fmt.Sprintf("%d", *c.ResultTTLSec)})
	}
	push := c.PushChannelID
	if push == "" {
		push = "none (clients poll their ticket)"
	}
	pairs = append(pairs, [2]string{"pushChannel", push})
	if ch.TicketURL == "" {
		return append(pairs, [2]string{"ticketUrl", "none (the match service has no HTTP host on this stage)"})
	}
	// Bare URLs, so each can be copied: POST|GET|DELETE the ticket, POST the
	// other two, all with a player JWT as Bearer.
	pairs = append(pairs, [2]string{"ticketUrl", ch.TicketURL})
	if base, ok := strings.CutSuffix(ch.TicketURL, "/ticket"); ok {
		pairs = append(pairs,
			[2]string{"acceptUrl", base + "/accept"},
			[2]string{"declineUrl", base + "/decline"},
		)
	}
	// The two limits a client meets first (`services/match/README.md`).
	return append(pairs, [2]string{"polling", matchPollingNote})
}

// matchPollingNote is the one line of the ticket API's limits `get` prints.
const matchPollingNote = "GET the ticket no faster than every few seconds (the ticket API is throttled at 5 requests/s per stage); " +
	"POST …/ticket can answer 429 `cooldown` with details.retryAfter after a decline or an unanswered proposal"

// deferredFlags are the match flags only a deferred channel takes.
var deferredFlags = []string{"accept-timeout", "result-ttl", "push-channel"}

// checkMatchMode refuses, before any write, what the console would: a mode
// other than the stored one (`mode` is the channel's on update, the flag's on
// create), and a deferred-only flag on a live channel. Clearing the push
// channel of a live channel is a no-op the server takes, so `--push-channel
// ”` passes.
func checkMatchMode(c *cobra.Command, mode string) error {
	if mode == "" {
		mode = "live"
	}
	fl := c.Flags()
	if want, _ := fl.GetString("mode"); fl.Changed("mode") && want != mode {
		return fmt.Errorf("--mode %s: this is a %s channel and the mode is fixed at creation; create a new match channel with --mode %s", want, mode, want)
	}
	if mode == "deferred" {
		return nil
	}
	for _, n := range deferredFlags {
		if !fl.Changed(n) {
			continue
		}
		if v, _ := fl.GetString(n); n == "push-channel" && v == "" {
			continue
		}
		return fmt.Errorf("--%s belongs to a deferred match channel (--mode deferred, at creation only)", n)
	}
	return nil
}

// resolvePushChannel lets --push-channel take a name, as --auth-channel does:
// a deferred match channel's push channel lives in the same project, so the
// name resolves among the project's push channels. An id of another kind is
// refused before any request.
func resolvePushChannel(cmd *cobra.Command, cc *ctxClient, cfg map[string]any) error {
	v, ok := cfg["pushChannelId"].(string)
	if !ok || v == "" {
		return nil
	}
	if IsID(v) {
		if !strings.HasPrefix(strings.ToLower(v), "push_") {
			return fmt.Errorf("--push-channel: %s is not a push channel", v)
		}
		return nil
	}
	id, err := cc.channelOfKind(cmd.Context(), v, "push", true)
	if err != nil {
		return fmt.Errorf("--push-channel: %w", err)
	}
	cfg["pushChannelId"] = id
	return nil
}

// matchRefusalReason is `details.reason` of a match refusal. The message is
// read only when the server sent no reason at all (one deployed before the
// reasons existed).
func matchRefusalReason(ae *api.Error) string {
	var d struct {
		Reason string `json:"reason"`
	}
	if json.Unmarshal(ae.Details, &d) == nil && d.Reason != "" {
		return d.Reason
	}
	switch {
	case strings.HasPrefix(ae.Message, "mode cannot be changed"):
		return "mode_fixed"
	case strings.HasPrefix(ae.Message, "pushChannelId is not an active push channel"):
		return "push_channel_unusable"
	}
	return ""
}

// withMatchHint adds the next step to a match create/update refusal the
// console words for its own schema: the fixed mode, a deferred-only field on
// a live channel, a range that belongs to the other mode, and a push channel
// it cannot use.
func withMatchHint(err error) error {
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Status != http.StatusBadRequest {
		return err
	}
	switch matchRefusalReason(ae) {
	case "mode_fixed":
		return fmt.Errorf("%w (the mode is fixed at creation: create a new match channel with --mode live|deferred)", err)
	case "push_channel_unusable":
		return fmt.Errorf("%w (--push-channel takes an active push channel of the same project whose auth channel is this channel's: `yyt push channel list`; --push-channel '' removes the link)", err)
	}
	var issues []struct {
		Path    string `json:"path"`
		Message string `json:"message"`
	}
	if json.Unmarshal(ae.Details, &issues) != nil {
		return err
	}
	for _, i := range issues {
		switch {
		case strings.HasSuffix(i.Message, "belongs to a deferred channel"):
			return fmt.Errorf("%w (--accept-timeout, --result-ttl and --push-channel need a deferred channel: --mode deferred, at creation only)", err)
		case i.Path == "waitTimeoutSec":
			return fmt.Errorf("%w (--wait-timeout is 5..600 on a live channel and 30..7200 on a deferred one)", err)
		}
	}
	return err
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

// channelNoExpirySec is `expires_at` of a channel granted no expiry
// (9999-12-31T23:59:59Z, docs/decisions.md "Limit requests" #7).
const channelNoExpirySec = 253402300799

// expiryText prints a channel's expiry, or `no expiry` for the sentinel.
func expiryText(sec int64) string {
	if sec >= channelNoExpirySec {
		return "no expiry"
	}
	return output.Time(sec)
}
