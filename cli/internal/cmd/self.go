package cmd

import (
	"errors"
	"fmt"
	"runtime"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/selfupdate"
)

// ErrUpdateAvailable is what `self update --check` returns when a newer
// release exists (exit 7), so scripts need not parse the output.
var ErrUpdateAvailable = errors.New("update available")

// newSelf manages the CLI binary itself; nothing here touches the console API
// or the config file.
func newSelf(a *App, up *selfupdate.Updater) *cobra.Command {
	c := group(&cobra.Command{Use: "self", Short: "Manage the yyt binary (version, update)"})
	if up == nil {
		up = selfupdate.New()
	}

	c.AddCommand(&cobra.Command{
		Use:   "version",
		Short: "Print the installed yyt version",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{
					"version": api.Version, "os": runtime.GOOS, "arch": runtime.GOARCH, "go": runtime.Version(),
				})
			}
			fmt.Fprintf(a.Out, "yyt %s (%s/%s, %s)\n", api.Version, runtime.GOOS, runtime.GOARCH, runtime.Version())
			return nil
		},
	})

	var check bool
	var pin string
	update := &cobra.Command{
		Use:   "update",
		Short: "Install the newest GitHub release of yyt over this binary",
		Long: "Looks up the newest `cli/v*` release of " + selfupdate.Repo + ", verifies the archive against its checksums.txt, " +
			"and replaces the running executable. `--check` only reports; `--version` installs a specific release even if it is older.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			var rel selfupdate.Release
			if pin != "" {
				var err error
				if rel, err = selfupdate.ParseRelease(pin); err != nil {
					return err
				}
			} else {
				var err error
				if rel, err = up.Latest(ctx); err != nil {
					return err
				}
			}
			cmp := selfupdate.Compare(rel.Version, api.Version)
			if check {
				if a.jsonOut {
					if err := a.printer().JSONValue(map[string]any{
						"current": api.Version, "latest": rel.Version, "updateAvailable": cmp > 0,
					}); err != nil {
						return err
					}
				} else if cmp > 0 {
					fmt.Fprintf(a.Out, "yyt %s → %s available; run `yyt self update`\n", api.Version, rel.Version)
				} else if pin != "" {
					fmt.Fprintf(a.Out, "yyt %s; `--version %s` would install a %s release\n", api.Version, rel.Version, map[bool]string{true: "same", false: "downgraded"}[cmp == 0])
				} else {
					fmt.Fprintf(a.Out, "yyt %s is up to date (latest release %s)\n", api.Version, rel.Version)
				}
				if cmp > 0 {
					return ErrUpdateAvailable
				}
				return nil
			}
			if pin == "" && cmp <= 0 {
				if a.jsonOut {
					return a.printer().JSONValue(map[string]any{"current": api.Version, "latest": rel.Version, "updateAvailable": false, "installed": nil})
				}
				fmt.Fprintf(a.Out, "yyt %s is up to date (latest release %s)\n", api.Version, rel.Version)
				return nil
			}
			exe, err := selfupdate.ExecutablePath()
			if err != nil {
				return err
			}
			fmt.Fprintf(a.Err, "downloading yyt %s (%s/%s) → %s\n", rel.Version, up.OS, up.Arch, exe)
			bin, err := up.Download(ctx, rel)
			if err != nil {
				return err
			}
			if err := selfupdate.Replace(exe, bin); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"previous": api.Version, "installed": rel.Version, "path": exe})
			}
			fmt.Fprintf(a.Out, "updated %s: %s → %s\n", exe, api.Version, rel.Version)
			return nil
		},
	}
	update.Flags().BoolVar(&check, "check", false, "only report whether a newer release exists")
	update.Flags().StringVar(&pin, "version", "", "install this release (e.g. 1.2.0) instead of the newest")
	c.AddCommand(update)
	return c
}
