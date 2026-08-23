package cmd

import (
	"fmt"
	"net/http"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

type token struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	CreatedAt  int64  `json:"createdAt"`
	LastUsedAt *int64 `json:"lastUsedAt"`
}

func newTokens(a *App) *cobra.Command {
	c := &cobra.Command{Use: "tokens", Short: "Manage your API tokens"}
	c.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List your API tokens (plaintext is never shown)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			var res struct {
				Tokens []token `json:"tokens"`
			}
			if err := cl.Do(cmd.Context(), http.MethodGet, "/tokens", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Tokens))
			for _, t := range res.Tokens {
				rows = append(rows, []string{t.ID, t.Name, output.Time(t.CreatedAt), output.TimePtr(t.LastUsedAt)})
			}
			return a.printer().Table([]string{"ID", "NAME", "CREATED", "LAST_USED"}, rows)
		},
	})
	var name string
	create := &cobra.Command{
		Use:   "create --name <name>",
		Short: "Create an API token; the plaintext is printed once",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			var res struct {
				token
				Token string `json:"token"`
			}
			if err := cl.Do(cmd.Context(), http.MethodPost, "/tokens", map[string]string{"name": name}, &res); err != nil {
				return err
			}
			fmt.Fprintln(a.Err, "store this token now; it is not shown again")
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			return a.printer().KV([][2]string{{"id", res.ID}, {"name", res.Name}, {"token", res.Token}})
		},
	}
	create.Flags().StringVar(&name, "name", "", "token label")
	_ = create.MarkFlagRequired("name")
	c.AddCommand(create)
	c.AddCommand(&cobra.Command{
		Use:   "revoke <token-id>",
		Short: "Revoke an API token",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			if err := cl.Do(cmd.Context(), http.MethodDelete, "/tokens/"+api.PathID(args[0]), nil, nil); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"id": args[0], "revoked": true})
			}
			fmt.Fprintf(a.Out, "revoked %s\n", args[0])
			return nil
		},
	})
	return c
}
