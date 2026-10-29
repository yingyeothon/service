package cmd

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/config"
)

// Push channel apiKeys kept by the CLI (owner decision 2026-10-11, todo/62):
// stored in the config file (0600) per stage and channel id, entered on
// stdin only — never as an argument, an environment variable or a file flag,
// so a key reaches neither shell history nor `ps`. Nothing prints a stored
// key. CI keeps the config file itself as its secret (YYT_CONFIG).

// savePushKey stores a freshly issued push apiKey when --save was given and
// blanks it from the output. It never loses a key: when storing fails the
// key stays in the answer and is printed as without --save.
func (a *App) savePushKey(cc *ctxClient, ch *channel, save bool) error {
	if !save || ch.APIKey == "" {
		return nil
	}
	if err := config.SetPushKey(cc.api, ch.ID, ch.APIKey); err != nil {
		fmt.Fprintf(a.Err, "storing the apiKey failed (%v); it is printed below instead\n", err)
		return nil
	}
	ch.APIKey = ""
	p, _ := config.Path()
	fmt.Fprintf(a.Err, "apiKey of %s stored in %s\n", ch.ID, p)
	return nil
}

// checkSave refuses --save before anything is issued when the channel is not
// a push channel: the secret of another kind would otherwise be printed.
func checkSave(save bool, kind, id string) error {
	if save && kind != "push" && !strings.HasPrefix(id, "push_") {
		return errors.New("--save stores a push channel's apiKey; it does not apply to this channel")
	}
	return nil
}

// pushKeyOf returns the stored apiKey of a push channel or a hint to store one.
func pushKeyOf(cc *ctxClient, channelID string) (string, error) {
	k, ok, err := config.PushKey(cc.api, channelID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("no apiKey stored for %s on %s: `yyt push key set %s` (stdin), or `yyt push channel rotate %s --save`", channelID, cc.api, channelID, channelID)
	}
	return k, nil
}

func (a *App) pushKeyCmd(resolve channelResolver) *cobra.Command {
	c := &cobra.Command{
		Use:   "key",
		Short: "Store push channel apiKeys in the config file, for `push send` and the apiKey job routes",
		Long: "Push channel apiKeys the CLI keeps, per stage (console URL) and channel id,\n" +
			"in the config file (mode 0600; YYT_CONFIG overrides its path). `set` reads\n" +
			"the key from stdin only — never an argument — so it stays out of shell\n" +
			"history; `ls` prints channel ids, never keys. In CI, keep the config file\n" +
			"as the secret.",
	}
	c.AddCommand(&cobra.Command{
		Use:   "set <channel>",
		Short: "Store a push channel's apiKey, read from stdin (prompted on a terminal)",
		Example: "  printf %s \"$PUSH_API_KEY\" | yyt push key set alerts\n" +
			"  yyt push key set push_0123abcd",
		Annotations: map[string]string{OutputAnnotation: "\"stored the apiKey of <id>\"; --json: {channelId,stored:true}"},
		Args:        cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := resolve(cmd, args[0], false)
			if err != nil {
				return err
			}
			key, rerr := readSecretLine(a.In, a.Err, "push apiKey: ")
			if key == "" {
				if rerr != nil && !errors.Is(rerr, io.EOF) {
					return fmt.Errorf("read the key: %w", rerr)
				}
				return errors.New("no key on stdin: pipe it in or type it at the prompt")
			}
			if len(key) > 256 || strings.IndexFunc(key, func(r rune) bool { return r < 0x21 || r > 0x7e }) >= 0 {
				return errors.New("that does not look like a channel apiKey (printable ASCII, at most 256 characters); copy it again from `create`/`rotate` output")
			}
			if err := config.SetPushKey(cc.api, id, key); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"channelId": id, "stored": true})
			}
			fmt.Fprintf(a.Out, "stored the apiKey of %s\n", id)
			return nil
		},
	})
	c.AddCommand(&cobra.Command{
		Use:         "rm <channel>",
		Aliases:     []string{"remove"},
		Short:       "Forget a stored apiKey (the key itself stays valid; rotate it to revoke)",
		Example:     "  yyt push key rm alerts\n  yyt push key rm push_0123abcd --json",
		Annotations: map[string]string{OutputAnnotation: "\"forgot the apiKey of <id>\"; --json: {channelId,removed:true}"},
		Args:        cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Resolve(a.profFlag, a.apiFlag, a.tokFlag)
			if err != nil {
				return err
			}
			// A `push_…` id needs no lookup, so a key of a deleted channel can go.
			id := args[0]
			if !strings.HasPrefix(id, "push_") {
				_, id, err = resolve(cmd, args[0], false)
				if err != nil {
					return err
				}
			}
			gone, err := config.RemovePushKey(cfg.API, id)
			if err != nil {
				return err
			}
			if !gone {
				return fmt.Errorf("no apiKey stored for %s on %s", id, cfg.API)
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"channelId": id, "removed": true})
			}
			fmt.Fprintf(a.Out, "forgot the apiKey of %s\n", id)
			return nil
		},
	})
	c.AddCommand(&cobra.Command{
		Use:         "ls",
		Aliases:     []string{"list"},
		Short:       "List the push channels with a stored apiKey on this stage (ids only)",
		Example:     "  yyt push key ls\n  yyt push key ls --json",
		Annotations: map[string]string{OutputAnnotation: "one channel id per line, never a key; --json: {api,channels:[<id>]}"},
		Args:        cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Resolve(a.profFlag, a.apiFlag, a.tokFlag)
			if err != nil {
				return err
			}
			ids, err := config.PushKeyChannels(cfg.API)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"api": cfg.API, "channels": ids})
			}
			for _, id := range ids {
				fmt.Fprintln(a.Out, id)
			}
			return nil
		},
	})
	return group(c)
}
