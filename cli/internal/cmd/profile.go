package cmd

import (
	"fmt"
	"sort"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/config"
)

// newProfile manages named logins in the config file. Tokens are never printed.
func newProfile(a *App) *cobra.Command {
	c := &cobra.Command{Use: "profile", Short: "Manage config profiles (per-stage console logins)"}

	c.AddCommand(&cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List stored profiles (the active one is marked)",
		Args:    cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			f, err := config.LoadFile()
			if err != nil {
				return err
			}
			active, _ := config.ProfileName(a.profFlag, f)
			names := make([]string, 0, len(f.Profiles))
			for n := range f.Profiles {
				names = append(names, n)
			}
			sort.Strings(names)
			if a.jsonOut {
				rows := make([]map[string]any, 0, len(names))
				for _, n := range names {
					rows = append(rows, map[string]any{
						"name": n, "api": f.Profiles[n].API,
						"default": n == f.Default, "active": n == active,
					})
				}
				return a.printer().JSONValue(map[string]any{"profiles": rows})
			}
			table := make([][]string, 0, len(names))
			for _, n := range names {
				mark := ""
				if n == active {
					mark = "*"
				}
				def := ""
				if n == f.Default {
					def = "yes"
				}
				table = append(table, []string{mark, n, f.Profiles[n].API, def})
			}
			return a.printer().Table([]string{"", "NAME", "API", "DEFAULT"}, table)
		},
	})

	{
		var device bool
		var tokenName string
		add := &cobra.Command{
			Use:   "add <name>",
			Short: "Log in and store the result as a named profile (same as `yyt login --profile <name>`)",
			Long: `Verifies a token (--token, YYT_TOKEN, or stdin) or runs the GitHub device
flow (--device) against --api and stores the login under the given profile
name. The first stored profile becomes the default.`,
			Args: cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				prev := a.profFlag
				a.profFlag = args[0]
				defer func() { a.profFlag = prev }()
				return doLogin(cmd, a, device, tokenName)
			},
		}
		add.Flags().BoolVar(&device, "device", false, "sign in with the GitHub device flow (no pre-existing token needed)")
		add.Flags().StringVar(&tokenName, "name", "", "name for the minted API token (default: device login)")
		c.AddCommand(add)
	}

	setDefault := func(_ *cobra.Command, args []string) error {
		if err := config.SetDefault(args[0]); err != nil {
			return err
		}
		if a.jsonOut {
			return a.printer().JSONValue(map[string]any{"default": args[0]})
		}
		fmt.Fprintf(a.Out, "default profile is now %s\n", args[0])
		return nil
	}
	c.AddCommand(&cobra.Command{
		Use:   "use <name>",
		Short: "Make a stored profile the default",
		Args:  cobra.ExactArgs(1),
		RunE:  setDefault,
	})

	c.AddCommand(&cobra.Command{
		Use:   "default <name>",
		Short: "Make a stored profile the default (same as `yyt profile use`)",
		Args:  cobra.ExactArgs(1),
		RunE:  setDefault,
	})

	c.AddCommand(&cobra.Command{
		Use:   "rename <old> <new>",
		Short: "Rename a stored profile (the default marker moves with it)",
		Args:  cobra.ExactArgs(2),
		RunE: func(_ *cobra.Command, args []string) error {
			if err := config.RenameProfile(args[0], args[1]); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"from": args[0], "to": args[1]})
			}
			fmt.Fprintf(a.Out, "renamed profile %s -> %s\n", args[0], args[1])
			return nil
		},
	})

	c.AddCommand(&cobra.Command{
		Use:     "remove <name>",
		Aliases: []string{"rm"},
		Short:   "Delete a stored profile (the token itself stays valid until revoked)",
		Args:    cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if err := config.RemoveProfile(args[0]); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"removed": args[0]})
			}
			fmt.Fprintf(a.Out, "removed profile %s\n", args[0])
			return nil
		},
	})
	return c
}
