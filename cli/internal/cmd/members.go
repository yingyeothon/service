package cmd

import (
	"net/http"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

type member struct {
	ID         string  `json:"id"`
	Login      string  `json:"login"`
	Role       string  `json:"role"`
	CreatedAt  int64   `json:"createdAt"`
	ApprovedAt *int64  `json:"approvedAt"`
	ApprovedBy *string `json:"approvedBy"`
}

func newMembers(a *App) *cobra.Command {
	c := &cobra.Command{Use: "members", Short: "Manage console members (admin)"}
	c.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List members",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cl, err := a.client()
			if err != nil {
				return err
			}
			var res struct {
				Members []member `json:"members"`
			}
			if err := cl.Do(cmd.Context(), http.MethodGet, "/members", nil, &res); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Members))
			for _, m := range res.Members {
				rows = append(rows, []string{m.ID, m.Login, m.Role, output.Time(m.CreatedAt), output.TimePtr(m.ApprovedAt), output.Str(m.ApprovedBy)})
			}
			return a.printer().Table([]string{"ID", "LOGIN", "ROLE", "CREATED", "APPROVED", "APPROVED_BY"}, rows)
		},
	})
	for _, action := range []struct{ name, short string }{
		{"approve", "Approve a pending member (→ member)"},
		{"promote", "Promote a member to admin"},
		{"demote", "Demote an admin to member"},
	} {
		action := action
		c.AddCommand(&cobra.Command{
			Use:   action.name + " <member-id>",
			Short: action.short,
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				cl, err := a.client()
				if err != nil {
					return err
				}
				var res struct {
					ID    string `json:"id"`
					Login string `json:"login"`
					Role  string `json:"role"`
				}
				if err := cl.Do(cmd.Context(), http.MethodPost, "/members/"+api.PathID(args[0])+"/"+action.name, nil, &res); err != nil {
					return err
				}
				if a.jsonOut {
					return a.printer().JSONValue(res)
				}
				return a.printer().KV([][2]string{{"id", res.ID}, {"login", res.Login}, {"role", res.Role}})
			},
		})
	}
	return c
}
