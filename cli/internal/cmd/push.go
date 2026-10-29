package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Push notifications (docs/decisions.md "Push notifications (Android, FCM)").
// A push channel is a channel of kind `push`, so its create/list/get/update/
// rotate/delete are the `yyt channels` commands with the kind fixed
// (`addChannelCommands`); this file adds what only that kind has: the
// google-services.json download, the team sender key and the admin's pool.
// Campaigns (templates, jobs, the broadcast) are in push_campaign.go.
//
// `push send` and the apiKey job routes use a channel apiKey the user stored
// with `push key set` (push_key.go, push_send.go); everything else takes the
// console token.

// googleServicesFile is the name Android's build expects in `app/`.
const googleServicesFile = "google-services.json"

// serviceAccountMax bounds what `--service-account` reads: a key file is
// about 2.4 KiB, and a wrong path must not post an arbitrary file.
const serviceAccountMax = 16 << 10

// pushPool mirrors console's `GET /admin/push/pool`. A slot is a label
// (`p1`, `p2`, …), never a Firebase project id.
type pushPool struct {
	Configured bool           `json:"configured"`
	Slots      []pushPoolSlot `json:"slots"`
	// iOS apps waiting for the owner's upload of the team's APNs certificate.
	APNsPending []pushAPNsPending `json:"apnsPending"`
}

type pushPoolSlot struct {
	Slot string `json:"slot"`
	// False for a slot the database remembers but the stage no longer holds.
	Provisioned   bool    `json:"provisioned"`
	Closed        bool    `json:"closed"`
	ClosedBy      *string `json:"closedBy"`
	ClosedByLogin *string `json:"closedByLogin"`
	ClosedAt      *int64  `json:"closedAt"`
	Apps          int     `json:"apps"`
	Capacity      int     `json:"capacity"`
}

// readServiceAccount reads a Firebase service-account key from a file, or
// from stdin for `-`, and checks only that it is a JSON object: the server
// validates the fields. No error quotes the content.
func readServiceAccount(src string, in io.Reader) (string, error) {
	var r io.Reader
	if src == "-" {
		if in == nil {
			in = os.Stdin
		}
		r = in
	} else {
		f, err := os.Open(src)
		if err != nil {
			return "", fmt.Errorf("--service-account: %w", err)
		}
		defer f.Close()
		r = f
	}
	b, err := io.ReadAll(io.LimitReader(r, serviceAccountMax+1))
	if err != nil {
		return "", fmt.Errorf("--service-account: %w", err)
	}
	if len(b) > serviceAccountMax {
		return "", fmt.Errorf("--service-account: larger than %d bytes, not a service-account key", serviceAccountMax)
	}
	b = bytes.TrimSpace(bytes.TrimPrefix(b, []byte("\xef\xbb\xbf")))
	var obj map[string]json.RawMessage
	if json.Unmarshal(b, &obj) != nil || obj == nil {
		return "", errors.New("--service-account: not a JSON object (pass the key file Firebase downloaded)")
	}
	return string(b), nil
}

// teamScopeFlag is the ` --team …` a limit hint carries so the request it
// names lands in the team the refused create belonged to.
func (a *App) teamScopeFlag(r resolved) string {
	switch {
	case a.teamFlag != "":
		return " --team " + a.teamFlag
	case r.TeamID != "":
		return " --team " + r.TeamID
	}
	return ""
}

// pushHints says what to do about a refusal a push route explains with
// `details.reason`.
var pushHints = map[string]string{
	"package_taken":        "another push channel on this stage holds that package; an application id belongs to one platform-sender channel (--sender team with your own Firebase project is not bound by it)",
	"package_refused":      "Firebase refused the package name; use the app's own applicationId",
	"push_not_configured":  "this stage has no push sender yet; a platform admin provisions it",
	"push_pool_full":       "every registration slot is full or closed; a platform admin adds or opens one (yyt push pool)",
	"firebase_unavailable": "Firebase did not answer; try again shortly",
	"not_registered":       "no platform registration: a team-sender channel takes google-services.json from its own Firebase project",
	"registration_missing": "the registration is gone from Firebase; delete the channel and create it again",
	"service_account":      "pass the service-account key file Firebase downloaded, unedited",
	"bundle_taken":         "another push channel on this stage holds that bundle id; a bundle id belongs to one platform-sender channel",
	"bundle_refused":       "Firebase refused the bundle id; use the app's own bundle identifier",
	"ios_immutable":        "the channel already holds an iOS app and its bundle id cannot change; make a new push channel for another one",
	"push_slot_full":       "the channel's registration slot has no room for an iOS app, and a channel never moves; a platform admin frees room (yyt push pool)",
}

// pushUpdateHints replaces a hint whose reason means something else on
// `PATCH /channels/{id}`: there `not_registered` is a platform registration
// that has not finished, not a channel without one.
var pushUpdateHints = map[string]string{
	"not_registered": "the channel's Firebase registration is not finished, so its config cannot change yet; retry in a minute (--name alone is not refused), and delete and re-create the channel if `registered` is still false tomorrow",
}

// serviceAccountFields names what `details.field` of a `service_account`
// refusal points at (`ServiceAccountFailure` on the server). The value of the
// field is never part of the refusal.
var serviceAccountFields = map[string]string{
	"too_large":      "the file is larger than a key file",
	"not_json":       "the file is not JSON",
	"not_object":     "the file is not a JSON object",
	"project_id":     "project_id is missing or malformed",
	"client_email":   "client_email is missing or malformed",
	"token_uri":      "token_uri is not Google's token endpoint",
	"private_key_id": "private_key_id is malformed",
	"private_key":    "private_key is missing or not a usable RSA key",
}

// withPushHint adds the next step to a push refusal: the limit request for
// `push.appsPerTeam` (as `project create` does for `team.projects`), the
// write slot's 429, or the hint of its `details.reason`. `over` holds the
// hints of the calling command that differ from `pushHints`.
func withPushHint(err error, scopeFlag string, over ...map[string]string) error {
	var ae *api.Error
	if !errors.As(err, &ae) {
		return err
	}
	if hinted := withLimitHint(err, scopeFlag); hinted != err {
		return hinted
	}
	// The per-member write slot: a create, a sender-key write and every
	// google-services.json download (a Firebase call) take it.
	if ae.Status == http.StatusTooManyRequests {
		return fmt.Errorf("%w (the console takes two writes a second per member, and a config download counts as one; run it again)", err)
	}
	var d struct {
		Reason string `json:"reason"`
		Field  string `json:"field"`
	}
	if json.Unmarshal(ae.Details, &d) != nil {
		return err
	}
	for _, m := range over {
		if hint, ok := m[d.Reason]; ok {
			return fmt.Errorf("%w (%s)", err, hint)
		}
	}
	if hint, ok := pushHints[d.Reason]; ok {
		if what, known := serviceAccountFields[d.Field]; known && d.Reason == "service_account" {
			hint = what + "; " + hint
		}
		return fmt.Errorf("%w (%s)", err, hint)
	}
	return err
}

func newPush(a *App) *cobra.Command {
	c := &cobra.Command{
		Use:   "push",
		Short: "Push notifications (FCM, Android and iOS): push channels, their client config and sender key, campaigns and broadcasts",
		Long: "Push notifications (FCM, Android and iOS).\n\n" +
			"A push channel registers one Android application id with the platform's\n" +
			"Firebase sender and yields the google-services.json the app embeds; an iOS\n" +
			"app beside it (`push channel ios add`) yields GoogleService-Info.plist\n" +
			"(`push channel config --ios`). The app\n" +
			"registers its FCM token with a player JWT of the channel's auth channel, and\n" +
			"a game server sends with the channel apiKey; both go to the `apiBase` that\n" +
			"`channel get` prints (PUT|DELETE /push/{channel}/token, POST /push/{channel}/send).\n" +
			"`push send` makes that send with an apiKey stored by `push key set` (stdin).\n\n" +
			"Campaigns run on the console and take the console token: `template` holds\n" +
			"the messages, `job submit` sends one to the users a CSV lists (`--dry-run`\n" +
			"first), `broadcast` sends one public message to every subscribed install\n" +
			"(anyone holding the app can subscribe: no secret belongs in it). A game server\n" +
			"runs the same job routes with the channel apiKey as Bearer under\n" +
			"/push-api/{channelId}/… on the console API host.",
	}
	ch := &cobra.Command{
		Use:     "channel",
		Aliases: []string{"channels"},
		Short:   "Manage push channels (the `push` kind of `yyt channels`)",
		Long: "Manage push channels: `yyt channels` with the kind fixed, plus the commands\n" +
			"only a push channel has.\n\n" +
			"<channel> is an id (push_…) or a name looked up among the push channels of\n" +
			"the project context. A `push_…` argument is always an id: a channel name\n" +
			"may not have that shape.\n" +
			"Apps on the platform sender are a team limit (`yyt limit list --scope team`,\n" +
			"push.appsPerTeam).",
	}
	a.addChannelCommands(ch, "push")
	resolve := a.channelResolver("push")
	ch.AddCommand(a.pushConfigCmd(resolve), a.pushIOSCmd(resolve), a.pushSenderKeyCmd(resolve), a.pushStatsCmd(resolve))
	c.AddCommand(a.pushKeyCmd(resolve), a.pushSendCmd(resolve), a.pushUploadCmd(resolve))
	c.AddCommand(group(ch), a.pushPoolCmd())
	a.addPushCampaignCommands(c, resolve)
	return group(c)
}

// pushConfigCmd downloads the channel's google-services.json, or with
// --ios its GoogleService-Info.plist. Both are the app's public client
// config (they ship inside the APK / IPA), so `-o -` may print them.
func (a *App) pushConfigCmd(resolve channelResolver) *cobra.Command {
	var out string
	var force, ios bool
	c := &cobra.Command{
		Use:   "config <channel> [--ios]",
		Short: "Download the channel's " + googleServicesFile + " (the Android app embeds it), or with --ios its " + googleServiceInfoFile,
		Example: "  yyt push channel config alerts -o app/" + googleServicesFile + " --force\n" +
			"  yyt push channel config alerts --ios -o ios/Runner/" + googleServiceInfoFile + "\n" +
			"  yyt push channel config push_0123abcd -o -",
		Annotations: map[string]string{OutputAnnotation: "writes the file and \"wrote <file> (<n> bytes)\" on stderr; -o - prints the file itself on stdout; --json does not apply"},
		Args:        cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := googleServicesFile
			if ios {
				name = googleServiceInfoFile
			}
			dst := out
			if dst == "" {
				dst = name
			}
			// Before any request: an existing file is the app's current config.
			if dst != "-" && !force {
				if _, err := os.Lstat(dst); err == nil {
					return fmt.Errorf("%s exists: pass --force to replace it, or -o <file>", dst)
				}
			}
			cc, id, err := resolve(cmd, args[0], false)
			if err != nil {
				return err
			}
			var raw []byte
			if ios {
				// A plist, not JSON: the body is written as it came.
				raw, err = cc.cl.DoRaw(cmd.Context(), http.MethodGet, "/channels/"+api.PathID(id)+"/"+googleServiceInfoFile, nil, "application/x-plist")
				if err != nil {
					return withPushHint(err, "", pushPlistHints)
				}
				if len(bytes.TrimSpace(raw)) > 0 && !looksLikePlist(raw) {
					return errors.New("the console did not answer with a plist (is --api the console base URL?)")
				}
			} else {
				var j json.RawMessage
				if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/channels/"+api.PathID(id)+"/"+googleServicesFile, nil, &j); err != nil {
					return withPushHint(err, "")
				}
				raw = j
			}
			if len(bytes.TrimSpace(raw)) == 0 {
				return errors.New("the console answered with an empty " + name)
			}
			body := append(bytes.TrimRight(raw, "\n"), '\n')
			if dst == "-" {
				_, err := a.Out.Write(body)
				return err
			}
			if err := writeFileAtomic(dst, body); err != nil {
				return err
			}
			fmt.Fprintf(a.Err, "wrote %s (%d bytes)\n", dst, len(body))
			return nil
		},
	}
	c.Flags().StringVarP(&out, "output", "o", "", "where to write (default: ./"+googleServicesFile+", with --ios ./"+googleServiceInfoFile+"; - is stdout)")
	c.Flags().BoolVar(&ios, "ios", false, "download the iOS app's "+googleServiceInfoFile+" (the channel needs an iOS app: `push channel ios add`)")
	c.Flags().BoolVar(&force, "force", false, "replace an existing file")
	return c
}

// writeFileAtomic writes through a temp file and a rename, so an interrupted
// write never leaves a half file under the final name.
func writeFileAtomic(dst string, body []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(dst), "."+filepath.Base(dst)+".*.part")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op once renamed
	_, err = tmp.Write(body)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp.Name(), 0o644)
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}

// pushSenderKeyCmd manages the team's own Firebase sender on a channel. The
// key is write-only: no route returns it and nothing here prints it.
func (a *App) pushSenderKeyCmd(resolve channelResolver) *cobra.Command {
	c := &cobra.Command{
		Use:   "sender-key",
		Short: "The team's own Firebase service-account key on a push channel (write-only)",
	}
	var file string
	set := &cobra.Command{
		Use:   "set <channel> --service-account <file|->",
		Short: "Register or replace the team's sender key; the channel then also accepts tokens of that Firebase project",
		Example: "  yyt push channel sender-key set alerts --service-account sa.json\n" +
			"  yyt push channel sender-key set alerts --service-account - < sa.json",
		Annotations: map[string]string{OutputAnnotation: channelViewOutput + " (never the key)"},
		Args:        cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			// Read before resolving, so a bad file costs no request.
			key, err := readServiceAccount(file, a.In)
			if err != nil {
				return err
			}
			cc, id, err := resolve(cmd, args[0], true)
			if err != nil {
				return err
			}
			var ch channel
			if err := cc.cl.Do(cmd.Context(), http.MethodPut, "/channels/"+api.PathID(id)+"/sender-key", map[string]any{"serviceAccount": key}, &ch); err != nil {
				return withPushHint(err, "")
			}
			return a.showChannel(ch, false)
		},
	}
	set.Flags().StringVar(&file, "service-account", "", "the service-account key file, or - for stdin (never printed)")
	_ = set.MarkFlagRequired("service-account")
	c.AddCommand(set)

	c.AddCommand(&cobra.Command{
		Use:         "rm <channel>",
		Aliases:     []string{"remove", "delete"},
		Short:       "Remove the team's sender key from a platform-sender channel (a team-sender channel refuses: it has no other sender)",
		Example:     "  yyt push channel sender-key rm alerts\n  yyt push channel sender-key rm push_0123abcd --json",
		Annotations: map[string]string{OutputAnnotation: "\"removed the sender key of <id>\" or \"<id> had no sender key\"; --json: {removed}"},
		Args:        cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := resolve(cmd, args[0], true)
			if err != nil {
				return err
			}
			var res struct {
				Removed bool `json:"removed"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodDelete, "/channels/"+api.PathID(id)+"/sender-key", nil, &res); err != nil {
				return withPushHint(err, "")
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			if res.Removed {
				fmt.Fprintf(a.Out, "removed the sender key of %s\n", id)
			} else {
				fmt.Fprintf(a.Out, "%s had no sender key\n", id)
			}
			return nil
		},
	})
	return group(c)
}

// pushPoolCmd is the platform admin's view of the stage's Firebase projects.
// There is no `yyt admin` family: admin verbs live under their noun (`limit
// set`, `team admin-lock`, `audit`), so the pool lives under `push`.
func (a *App) pushPoolCmd() *cobra.Command {
	list := func(cmd *cobra.Command) error {
		cl, err := a.client()
		if err != nil {
			return err
		}
		var res pushPool
		if err := cl.Do(cmd.Context(), http.MethodGet, "/admin/push/pool", nil, &res); err != nil {
			return err
		}
		if a.jsonOut {
			return a.printer().JSONValue(res)
		}
		if !res.Configured {
			fmt.Fprintln(a.Err, "note: this stage has no push sender configured; platform-sender channels cannot be created")
		}
		rows := make([][]string, 0, len(res.Slots))
		for _, s := range res.Slots {
			state := "open"
			switch {
			case !s.Provisioned:
				state = "unprovisioned"
			case s.Closed:
				state = "closed"
			}
			by := output.Str(s.ClosedByLogin)
			if s.ClosedByLogin == nil && s.ClosedBy != nil {
				by = *s.ClosedBy
			}
			rows = append(rows, []string{
				s.Slot, state, strconv.Itoa(s.Apps) + "/" + strconv.Itoa(s.Capacity), by, output.TimePtr(s.ClosedAt),
			})
		}
		if err := a.printer().Table([]string{"SLOT", "STATE", "APPS", "CLOSED BY", "CLOSED AT"}, rows); err != nil {
			return err
		}
		if len(res.APNsPending) == 0 {
			return nil
		}
		// A second table only when there is something to do, so the slot
		// table alone stays what it was.
		fmt.Fprintln(a.Out, "\nAPNs pending (upload the team's .p12 to the slot's iOS app, then `yyt push pool apns <push-id> ready`):")
		pending := make([][]string, 0, len(res.APNsPending))
		for _, p := range res.APNsPending {
			pending = append(pending, []string{p.ChannelID, p.TeamID, p.IOSBundleID, p.Slot})
		}
		return a.printer().Table([]string{"CHANNEL", "TEAM", "BUNDLE ID", "SLOT"}, pending)
	}
	const listOutput = "table SLOT STATE APPS CLOSED BY CLOSED AT, then table CHANNEL TEAM BUNDLE ID SLOT when iOS apps wait for APNs; " +
		"--json: {configured,slots:[{slot,provisioned,closed,closedBy,closedAt,apps,capacity}],apnsPending:[{channelId,teamId,iosBundleId,slot}]}"
	c := &cobra.Command{
		Use:   "pool",
		Short: "The stage's push registration slots (platform admin)",
		Long: "The stage's push registration slots (platform admin).\n\n" +
			"A slot is one Firebase project of the platform, named by a label (p1, p2, …).\n" +
			"New push channels go to the first open slot with room; a closed slot keeps\n" +
			"serving its channels and takes no new one. Bare `pool` lists.\n\n" +
			"The platform closes a slot itself when its Firebase project nears the app\n" +
			"limit (CLOSED BY auto:firebase-limit) and reopens it once there is room.\n" +
			"`pool close` on such a slot takes the closure over: it reports `closed`, and\n" +
			"the slot then stays closed until `pool open`.\n\n" +
			"APNS PENDING lists the platform channels whose iOS app waits for the team's\n" +
			"APNs certificate; `pool apns <push-id> ready` marks one once it is uploaded.",
		Example:     "  yyt push pool\n  yyt push pool --json",
		Annotations: map[string]string{OutputAnnotation: listOutput},
		Args:        cobra.NoArgs,
		RunE:        func(cmd *cobra.Command, _ []string) error { return list(cmd) },
	}
	c.AddCommand(&cobra.Command{
		Use:         "list",
		Aliases:     []string{"ls"},
		Short:       "List the slots: state, apps registered out of the capacity, and who closed one",
		Example:     "  yyt push pool list\n  yyt push pool ls --json",
		Annotations: map[string]string{OutputAnnotation: listOutput},
		Args:        cobra.NoArgs,
		RunE:        func(cmd *cobra.Command, _ []string) error { return list(cmd) },
	})
	toggle := func(verb, short, done string) *cobra.Command {
		return &cobra.Command{
			Use:     verb + " <slot>",
			Short:   short,
			Example: "  yyt push pool " + verb + " p2\n  yyt push pool " + verb + " p2 --json",
			Annotations: map[string]string{OutputAnnotation: "\"" + done + " <slot>\" or \"<slot> was already " + done +
				"\"; --json: {slot,closed,changed}"},
			Args: cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				cl, err := a.client()
				if err != nil {
					return err
				}
				var res struct {
					Slot    string `json:"slot"`
					Closed  bool   `json:"closed"`
					Changed bool   `json:"changed"`
				}
				if err := cl.Do(cmd.Context(), http.MethodPost, "/admin/push/pool/"+api.PathID(args[0])+"/"+verb, nil, &res); err != nil {
					return err
				}
				if a.jsonOut {
					return a.printer().JSONValue(res)
				}
				if res.Changed {
					fmt.Fprintf(a.Out, "%s %s\n", done, output.Clean(res.Slot))
				} else {
					fmt.Fprintf(a.Out, "%s was already %s\n", output.Clean(res.Slot), done)
				}
				return nil
			},
		}
	}
	c.AddCommand(
		toggle("close", "Stop placing new push channels in a slot (its channels keep working); on a slot the platform closed, keep it closed", "closed"),
		toggle("open", "Let a closed slot take new push channels again", "open"),
		a.pushSweepCmd(),
		a.pushAPNsCmd(),
	)
	return c
}
