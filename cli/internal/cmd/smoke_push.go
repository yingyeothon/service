package cmd

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
)

// jwtSubject reads the `sub` claim of a JWT without verifying it: the smoke
// only needs to address the send to the player whose token registered.
func jwtSubject(jwt string) (string, error) {
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		return "", errors.New("--jwt is not a JWT")
	}
	b, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", errors.New("--jwt payload is not base64url")
	}
	var c struct {
		Sub string `json:"sub"`
	}
	if err := json.Unmarshal(b, &c); err != nil || c.Sub == "" {
		return "", errors.New("--jwt has no sub")
	}
	return c.Sub, nil
}

// readFirstLine reads a one-line secret file (an FCM token, a JWT).
func readFirstLine(path, flag string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("--%s: %w", flag, err)
	}
	line, _, _ := strings.Cut(strings.TrimSpace(string(b)), "\n")
	if line = strings.TrimSpace(line); line == "" {
		return "", fmt.Errorf("--%s: empty file", flag)
	}
	return line, nil
}

func newSmokePush(a *App) *cobra.Command {
	var jwt, jwtFile, tokenFile, project, title string
	var keep bool
	c := &cobra.Command{
		Use:   "push <channel> (--jwt-file <f> | --jwt <t>) --token-file <file> [--project <firebase project id>] [--title t] [--keep]",
		Short: "Register a device token with a player JWT, send it one message with the stored apiKey, then remove the token",
		Example: "  yyt smoke push alerts --jwt-file player.jwt --token-file fcm-token.txt\n" +
			"  yyt smoke push alerts --jwt-file player.jwt --token-file fcm-token.txt --title \"hello\" --keep",
		Annotations: map[string]string{OutputAnnotation: "table USER STATUS REASON and \"sent <n> · no-token <n> · failed <n>\"; " +
			"\"registered a token for <sub>\" / \"removed the token\" on stderr; --json: {results:[{userId,status,reason}],sent,noToken,failed}"},
		Long: "The device half and the server half of a push channel in one run, against\n" +
			"the channel's apiBase: PUT /push/{channel}/token with the player JWT (its\n" +
			"auth channel must be the push channel's), POST /push/{channel}/send to the\n" +
			"JWT's sub with the apiKey `yyt push key set` stored, then DELETE the token\n" +
			"(--keep leaves it). The FCM token comes from a file (an app's log, say) and\n" +
			"neither it, the JWT nor the key is printed. `sent` means FCM accepted the\n" +
			"message; look at the device for the notification. Exit 1 unless sent.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if (jwt == "") == (jwtFile == "") {
				return errors.New("give one of --jwt and --jwt-file")
			}
			if jwtFile != "" {
				var err error
				if jwt, err = readFirstLine(jwtFile, "jwt-file"); err != nil {
					return err
				}
			}
			sub, err := jwtSubject(jwt)
			if err != nil {
				return err
			}
			token, err := readFirstLine(tokenFile, "token-file")
			if err != nil {
				return err
			}
			cc, id, err := a.channelResolver("push")(cmd, args[0], false)
			if err != nil {
				return err
			}
			key, err := pushKeyOf(cc, id)
			if err != nil {
				return err
			}
			var ch channel
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, "/channels/"+api.PathID(id), nil, &ch); err != nil {
				return err
			}
			if ch.APIBase == "" {
				return errors.New("this stage has no state stack (the channel shows no apiBase)")
			}
			ctx := cmd.Context()
			player, err := a.dataClient(ch.APIBase, jwt)
			if err != nil {
				return err
			}
			path := "/push/" + api.PathID(id) + "/token"
			reg := map[string]any{"token": token}
			if project != "" {
				reg["project"] = project
			}
			if err := player.Do(ctx, http.MethodPut, path, reg, nil); err != nil {
				return fmt.Errorf("register the token: %w", jwtErr(err))
			}
			fmt.Fprintf(a.Err, "registered a token for %s\n", sub)
			if !keep {
				defer func() {
					if err := player.Do(ctx, http.MethodDelete, path, map[string]any{"token": token}, nil); err != nil {
						fmt.Fprintf(a.Err, "remove the token: %v\n", err)
						return
					}
					fmt.Fprintln(a.Err, "removed the token")
				}()
			}
			req := map[string]any{
				"userIds":      []string{sub},
				"notification": map[string]string{"title": title, "body": "yyt smoke push"},
				"data":         map[string]string{"kind": "yyt-smoke"},
			}
			var ans pushSendAnswer
			st, err := a.dataClient(ch.APIBase, key)
			if err != nil {
				return err
			}
			if err := sendThrottled.do(ctx, func() error {
				return st.Do(ctx, http.MethodPost, "/push/"+api.PathID(id)+"/send", req, &ans)
			}); err != nil {
				return dataPlaneErr(err)
			}
			if err := a.printSendAnswer(ans); err != nil {
				return err
			}
			if ans.Sent != 1 {
				return errors.New("the message was not sent")
			}
			return nil
		},
	}
	f := c.Flags()
	f.StringVar(&jwt, "jwt", "", "player JWT of the push channel's auth channel (prefer --jwt-file: an argument lands in shell history)")
	f.StringVar(&jwtFile, "jwt-file", "", "file holding the player JWT (keeps it out of shell history)")
	f.StringVar(&tokenFile, "token-file", "", "file holding the device's FCM registration token")
	f.StringVar(&project, "project", "", "project_info.project_id of the app's google-services.json (required once the channel accepts two projects)")
	f.StringVar(&title, "title", "yyt smoke", "notification title")
	f.BoolVar(&keep, "keep", false, "leave the token registered")
	_ = c.MarkFlagRequired("token-file")
	return c
}
