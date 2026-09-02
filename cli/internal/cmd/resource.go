package cmd

import (
	"fmt"
	"net/http"

	"github.com/spf13/cobra"

	"github.com/yingyeothon/service/cli/internal/api"
)

// Bundles and sites are addressed the same way (`/<base>/{id}`, one detail
// row, a name + optional description) so their get/update/delete commands are
// built here; the wrapper in each file supplies the words and the printer.

// newResourceGet is `<use> <arg>` → GET base/{id} → print.
func newResourceGet[T any](resolve idResolver, use, short, base string, print func(T) error) *cobra.Command {
	return &cobra.Command{
		Use:   use,
		Short: short,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := resolve(cmd, args[0], false)
			if err != nil {
				return err
			}
			var v T
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, base+"/"+api.PathID(id), nil, &v); err != nil {
				return err
			}
			return print(v)
		},
	}
}

// newResourceUpdate is `update <arg> [--name] [--description]` → PATCH; an
// explicit empty --description clears it (JSON null). The flags are checked
// before the argument is resolved, so a call with nothing to do costs no request.
func newResourceUpdate[T any](resolve idResolver, use, short, nameHelp, base string, print func(T) error) *cobra.Command {
	var name, description string
	c := &cobra.Command{
		Use:   use,
		Short: short,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			if cmd.Flags().Changed("name") {
				body["name"] = name
			}
			nullableDesc(cmd, "description", description, body, "description")
			if len(body) == 0 {
				return fmt.Errorf("nothing to update: pass --name and/or --description")
			}
			cc, id, err := resolve(cmd, args[0], true)
			if err != nil {
				return err
			}
			var v T
			if err := cc.cl.Do(cmd.Context(), http.MethodPatch, base+"/"+api.PathID(id), body, &v); err != nil {
				return err
			}
			return print(v)
		},
	}
	f := c.Flags()
	f.StringVar(&name, "name", "", nameHelp)
	f.StringVar(&description, "description", "", "new description (empty clears it)")
	return c
}

// newResourceDelete is `delete <arg>` → DELETE base/{id} → `deleted <arg>`.
func newResourceDelete(a *App, resolve idResolver, use, short, base string) *cobra.Command {
	return &cobra.Command{
		Use:     use,
		Aliases: []string{"rm", "remove"},
		Short:   short,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := resolve(cmd, args[0], true)
			if err != nil {
				return err
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodDelete, base+"/"+api.PathID(id), nil, nil); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "deleted %s\n", args[0])
			return nil
		},
	}
}
