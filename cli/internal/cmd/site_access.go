package cmd

import (
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
)

type siteAccess struct {
	Mode      string  `json:"mode"`
	Username  *string `json:"username"`
	Suspended bool    `json:"suspended"`
	Sync      string  `json:"sync"`
	Available bool    `json:"available"`
}

func newSiteAuth(a *App, resolve siteResolver) *cobra.Command {
	c := &cobra.Command{Use: "auth", Short: "Approved Basic Auth: enable, change credentials, make public, or retry synchronization", Long: "Request site.basicAuth=1 with yyt limit request and obtain admin approval first.\nProtected sites serve only on their independent host. Changes propagate asynchronously.\nPasswords must be 16-128 printable ASCII characters; never pass passwords in arguments."}
	var username string
	var stdin bool
	set := &cobra.Command{Use: "set <site> --username <id> --password-stdin", Short: "Enable Basic Auth or replace its credentials", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		if !stdin || username == "" {
			return fmt.Errorf("--username and --password-stdin are required")
		}
		raw, err := io.ReadAll(io.LimitReader(a.In, 1025))
		if err != nil {
			return fmt.Errorf("cannot read password input")
		}
		password := strings.TrimSuffix(strings.TrimSuffix(string(raw), "\n"), "\r")
		if len(password) < 16 || len(password) > 128 {
			return fmt.Errorf("password must be 16-128 printable ASCII characters")
		}
		for _, c := range password {
			if c < 32 || c > 126 {
				return fmt.Errorf("password must contain printable ASCII characters only")
			}
		}
		cc, id, err := resolve(cmd, args[0], true)
		if err != nil {
			return err
		}
		var result site
		if err = cc.cl.Do(cmd.Context(), http.MethodPut, "/sites/"+api.PathID(id)+"/auth", map[string]any{"mode": "basic", "username": username, "password": password}, &result); err != nil {
			return err
		}
		return a.printSite(result)
	}}
	set.Flags().StringVar(&username, "username", "", "shared viewer ID (no colon or spaces)")
	set.Flags().BoolVar(&stdin, "password-stdin", false, "read the password from standard input; never stored in configuration")
	var confirm bool
	clear := &cobra.Command{Use: "clear <site> --confirm-public", Short: "Make the site's files public without credentials", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		if !confirm {
			return fmt.Errorf("--confirm-public is required: anyone will be able to view the files")
		}
		cc, id, err := resolve(cmd, args[0], true)
		if err != nil {
			return err
		}
		var result site
		if err = cc.cl.Do(cmd.Context(), http.MethodPut, "/sites/"+api.PathID(id)+"/auth", map[string]any{"mode": "public"}, &result); err != nil {
			return err
		}
		return a.printSite(result)
	}}
	clear.Flags().BoolVar(&confirm, "confirm-public", false, "explicitly publish the site without authentication")
	sync := &cobra.Command{Use: "sync <site>", Short: "Retry pending edge policy synchronization", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		cc, id, err := resolve(cmd, args[0], true)
		if err != nil {
			return err
		}
		var result site
		if err = cc.cl.Do(cmd.Context(), http.MethodPost, "/sites/"+api.PathID(id)+"/access-sync", map[string]any{}, &result); err != nil {
			return err
		}
		return a.printSite(result)
	}}
	c.AddCommand(set, clear, sync)
	return group(c)
}
func newSiteSuspension(a *App, resolve siteResolver, suspended bool) *cobra.Command {
	verb := "suspend"
	if !suspended {
		verb = "resume"
	}
	var reason string
	c := &cobra.Command{Use: verb + " <site> --reason <text>", Short: "Platform admin: " + verb + " both site addresses without changing credentials", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		if strings.TrimSpace(reason) == "" {
			return fmt.Errorf("--reason is required")
		}
		cc, id, err := resolve(cmd, args[0], false)
		if err != nil {
			return err
		}
		var result site
		if err = cc.cl.Do(cmd.Context(), http.MethodPut, "/admin/sites/"+api.PathID(id)+"/suspension", map[string]any{"suspended": suspended, "reason": reason}, &result); err != nil {
			return err
		}
		return a.printSite(result)
	}}
	c.Flags().StringVar(&reason, "reason", "", "audit reason (required)")
	return c
}
