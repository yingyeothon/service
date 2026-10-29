package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

// The iOS app of a push channel (docs/decisions.md "Console app and push on
// iOS" #8): one per channel beside the Android app, added at creation
// (`--ios-bundle-id`) or later (`push channel ios add`), immutable once set.

// googleServiceInfoFile is the name an iOS build expects in its app target.
const googleServiceInfoFile = "GoogleService-Info.plist"

// iosBundleIDRe and iosBundleIDMax mirror console's PUSH_BUNDLE_ID and
// PUSH_BUNDLE_ID_MAX (hyphens allowed, Apple's 155).
var iosBundleIDRe = regexp.MustCompile(`^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$`)

const iosBundleIDMax = 155

// checkIOSBundleID refuses locally what the console would refuse with a 400.
func checkIOSBundleID(id string) error {
	switch {
	case len(id) > iosBundleIDMax:
		return fmt.Errorf("longer than %d characters", iosBundleIDMax)
	case !iosBundleIDRe.MatchString(id):
		return fmt.Errorf("%q is not an iOS bundle id such as com.example.game (letters, digits and hyphens, in two or more dot-separated parts)", id)
	}
	return nil
}

// looksLikePlist is the shape check a plist download gets in place of the
// JSON decode the Android file has: a wrong --api answering HTML must not
// land in the app target or on a terminal.
func looksLikePlist(b []byte) bool {
	b = bytes.TrimLeft(bytes.TrimPrefix(b, []byte("\xef\xbb\xbf")), " \t\r\n")
	return bytes.HasPrefix(b, []byte("<?xml")) || bytes.HasPrefix(b, []byte("<plist"))
}

// pushIOSAddHints: on `PUT /channels/{id}/push/ios` `not_registered` is the
// Android registration that has not finished.
var pushIOSAddHints = map[string]string{
	"not_registered": "the channel's Firebase registration is not finished; retry in a minute, and delete and re-create the channel if `registered` is still false tomorrow",
}

// pushPlistHints: the plist route's `not_registered`.
var pushPlistHints = map[string]string{
	"not_registered": "no platform iOS registration: a team-sender channel takes " + googleServiceInfoFile + " from its own Firebase project, and a channel without an iOS app gains one with `yyt push channel ios add <channel> <bundleId>`",
}

// pushAPNsHints are the admin route's refusals.
var pushAPNsHints = map[string]string{
	"ios_not_registered": "the channel has no iOS app",
	"team_sender":        "a team-sender channel's APNs credential lives in the team's own Firebase project; there is nothing to mark",
}

// pushIOSPairs is what `channel get` prints about the iOS app; nothing for
// a channel without one.
func pushIOSPairs(ch channel) [][2]string {
	var c struct {
		IOSBundleID string `json:"iosBundleId"`
		Sender      string `json:"sender"`
	}
	if ch.Kind != "push" || json.Unmarshal(ch.Config, &c) != nil || c.IOSBundleID == "" {
		return nil
	}
	ios := c.IOSBundleID
	switch {
	case ch.IOSRegistered != nil && *ch.IOSRegistered:
		ios += " (yyt push channel config " + ch.ID + " --ios)"
	case c.Sender == "team":
		ios += " (team sender: " + googleServiceInfoFile + " comes from your own Firebase project)"
	case ch.IOSRegistered != nil:
		ios += " (registration not finished)"
	}
	pairs := [][2]string{{"ios", ios}}
	if ch.APNsState != "" {
		apns := ch.APNsState
		switch ch.APNsState {
		case "pending":
			apns += " (the platform owner has yet to upload the team's APNs certificate (.p12), handed over out of band, never through the console; iOS devices receive nothing until ready)"
		case "team":
			apns += " (the team uploads its own APNs credential in its Firebase project)"
		}
		pairs = append(pairs, [2]string{"apns", apns})
	}
	return pairs
}

// pushIOSCmd is `push channel ios`: the channel's iOS app.
func (a *App) pushIOSCmd(resolve channelResolver) *cobra.Command {
	c := &cobra.Command{
		Use:   "ios",
		Short: "The push channel's iOS app (one per channel, beside the Android app)",
	}
	c.AddCommand(&cobra.Command{
		Use:   "add <channel> <bundleId>",
		Short: "Add an iOS app to a push channel (fixed once set; the same bundle id again is a no-op)",
		Example: "  yyt push channel ios add alerts com.example.game\n" +
			"  yyt push channel ios add push_0123abcd com.example.game --json",
		Annotations: map[string]string{OutputAnnotation: channelViewOutput + "; the ios and apns lines show the iOS app"},
		Long: "Add an iOS app to a push channel (fixed once set; the same bundle id again is a no-op).\n\n" +
			"A platform-sender channel registers the bundle id in its own slot's Firebase\n" +
			"project, and its APNs state is `pending` until the platform owner uploads\n" +
			"the team's per-app APNs certificate (.p12) and marks it ready. Hand the\n" +
			".p12 and its password to the owner out of band (in person or encrypted),\n" +
			"never through the console or a chat; it expires yearly, and its renewal is\n" +
			"a request to the owner. Then\n" +
			"`yyt push channel config <channel> --ios` downloads " + googleServiceInfoFile + ".\n" +
			"A team-sender channel registers nothing: the team adds the iOS app and its\n" +
			"APNs credential in its own Firebase project.",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			// Before resolving: a typo costs no request.
			if err := checkIOSBundleID(args[1]); err != nil {
				return fmt.Errorf("<bundleId>: %w", err)
			}
			cc, id, err := resolve(cmd, args[0], true)
			if err != nil {
				return err
			}
			var ch channel
			if err := cc.cl.Do(cmd.Context(), http.MethodPut, "/channels/"+api.PathID(id)+"/push/ios", map[string]any{"iosBundleId": args[1]}, &ch); err != nil {
				return withPushHint(err, "", pushIOSAddHints)
			}
			return a.showChannel(ch, false)
		},
	})
	return group(c)
}

// pushAPNsCmd is `push pool apns <push-id> ready|pending`: the platform
// admin marks a channel's iOS app once the team's APNs certificate is (or
// is no longer) in the slot's Firebase project. The admin need not be in the
// channel's team, so <channel> is an id (the `push pool` listing prints it).
func (a *App) pushAPNsCmd() *cobra.Command {
	return &cobra.Command{
		Use:         "apns <push-id> ready|pending",
		Short:       "Mark a channel's iOS app ready once its APNs certificate is uploaded, or pending again (platform admin)",
		Example:     "  yyt push pool apns push_0123abcd ready\n  yyt push pool apns push_0123abcd pending --json",
		Annotations: map[string]string{OutputAnnotation: "\"apns <state> on <id>\"; --json: {channelId,apnsState}"},
		Args:        cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, state := args[0], args[1]
			if state != "ready" && state != "pending" {
				return fmt.Errorf("the state must be ready|pending (got %q)", state)
			}
			if !IsID(id) || !strings.HasPrefix(strings.ToLower(id), "push_") {
				return errors.New("<channel> must be a push channel id (push_…, as `yyt push pool` lists it): an admin is not resolved into a team")
			}
			cl, err := a.client()
			if err != nil {
				return err
			}
			var res struct {
				ChannelID string `json:"channelId"`
				APNsState string `json:"apnsState"`
			}
			if err := cl.Do(cmd.Context(), http.MethodPost, "/admin/push/channels/"+api.PathID(id)+"/apns", map[string]any{"state": state}, &res); err != nil {
				return withPushHint(err, "", pushAPNsHints)
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			fmt.Fprintf(a.Out, "apns %s on %s\n", output.Clean(res.APNsState), output.Clean(res.ChannelID))
			return nil
		},
	}
}

// pushAPNsPending mirrors an entry of `apnsPending` in `GET /admin/push/pool`.
type pushAPNsPending struct {
	ChannelID   string `json:"channelId"`
	TeamID      string `json:"teamId"`
	IOSBundleID string `json:"iosBundleId"`
	Slot        string `json:"slot"`
}
