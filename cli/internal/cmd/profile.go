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
		Use:   "list",
		Short: "List stored profiles (the active one is marked)",
		Args:  cobra.NoArgs,
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

	c.AddCommand(&cobra.Command{
		Use:   "use <name>",
		Short: "Make a stored profile the default",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if err := config.SetDefault(args[0]); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"default": args[0]})
			}
			fmt.Fprintf(a.Out, "default profile is now %s\n", args[0])
			return nil
		},
	})

	c.AddCommand(&cobra.Command{
		Use:   "remove <name>",
		Short: "Delete a stored profile (the token itself stays valid until revoked)",
		Args:  cobra.ExactArgs(1),
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
