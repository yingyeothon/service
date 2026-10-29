package cmd

import (
	"fmt"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"github.com/yingyeothon/service/cli"
	"github.com/yingyeothon/service/cli/internal/api"
)

// OutputAnnotation is the cobra annotation a runnable command uses to say
// what it prints (`help --json` → `output`); every runnable leaf has one.
const OutputAnnotation = "output"

// helpSchemaVersion versions the `yyt help --json` document. It is a stable
// contract (docs/decisions.md "CLI"): adding a field is compatible, renaming
// or removing one is a major version of the CLI.
const helpSchemaVersion = 1

type helpDoc struct {
	Schema    int        `json:"schema"`
	Version   string     `json:"version"`
	ExitCodes []ExitCode `json:"exitCodes"`
	Env       []EnvVar   `json:"env"`
	Commands  []helpCmd  `json:"commands"`
}

type helpCmd struct {
	Path     string     `json:"path"`
	Use      string     `json:"use"`
	Short    string     `json:"short"`
	Long     string     `json:"long,omitempty"`
	Aliases  []string   `json:"aliases,omitempty"`
	Example  string     `json:"example,omitempty"`
	Output   string     `json:"output,omitempty"`
	Runnable bool       `json:"runnable"`
	Flags    []helpFlag `json:"flags,omitempty"`
}

type helpFlag struct {
	Name      string `json:"name"`
	Shorthand string `json:"shorthand,omitempty"`
	Type      string `json:"type"`
	Default   string `json:"default,omitempty"`
	Usage     string `json:"usage"`
	Required  bool   `json:"required,omitempty"`
}

// helpTree walks c and its visible descendants in command-path order.
func helpTree(c *cobra.Command) []helpCmd {
	var out []helpCmd
	var walk func(*cobra.Command)
	walk = func(c *cobra.Command) {
		if c.Hidden || c.Name() == "completion" {
			return
		}
		out = append(out, helpEntry(c))
		subs := c.Commands()
		sort.Slice(subs, func(i, j int) bool { return subs[i].Name() < subs[j].Name() })
		for _, s := range subs {
			walk(s)
		}
	}
	walk(c)
	return out
}

func helpEntry(c *cobra.Command) helpCmd {
	h := helpCmd{
		Path:     c.CommandPath(),
		Use:      c.Use,
		Short:    c.Short,
		Long:     c.Long,
		Aliases:  c.Aliases,
		Example:  c.Example,
		Output:   c.Annotations[OutputAnnotation],
		Runnable: isLeaf(c),
	}
	// Local flags only: the persistent ones are the root's, listed once there.
	c.LocalNonPersistentFlags().VisitAll(func(f *pflag.Flag) {
		if f.Hidden {
			return
		}
		h.Flags = append(h.Flags, flagEntry(f))
	})
	if !c.HasParent() {
		c.PersistentFlags().VisitAll(func(f *pflag.Flag) { h.Flags = append(h.Flags, flagEntry(f)) })
	}
	return h
}

func flagEntry(f *pflag.Flag) helpFlag {
	_, required := f.Annotations[cobra.BashCompOneRequiredFlag]
	def := f.DefValue
	if def == "[]" || (f.Value.Type() == "bool" && def == "false") {
		def = ""
	}
	return helpFlag{
		Name: f.Name, Shorthand: f.Shorthand, Type: f.Value.Type(),
		Default: def, Usage: f.Usage, Required: required,
	}
}

// isLeaf is a command that does something itself: runnable, not a `group`
// (which only prints its help when bare) and not a help topic. A command may
// run and have subcommands too (`catalog artifact upload`).
func isLeaf(c *cobra.Command) bool {
	return c.Runnable() && c.Annotations["group"] == "" && c.Annotations["topic"] == ""
}

// newHelp replaces cobra's help command: `yyt help [command]` as before, plus
// `--json` for the tree as data, and help topics (`yyt help agents`).
func newHelp(a *App, root *cobra.Command) *cobra.Command {
	return &cobra.Command{
		Use:   "help [command]",
		Short: "Help about any command; --json prints the command tree as data",
		Long: "Help about any command.\n\n" +
			"With --json it prints the whole tree below [command] (default: everything)\n" +
			"as one JSON document: schema, CLI version, exit codes, environment\n" +
			"variables, and per command its path, usage, aliases, example, output,\n" +
			"whether it runs, and its flags (name, type, default, usage, required).",
		Example: "  yyt help catalog artifact upload\n  yyt help --json > yyt-commands.json\n  yyt help --json push | jq '.commands[].path'\n  yyt help agents",
		Annotations: map[string]string{
			OutputAnnotation: "the command's help text; --json: {schema, version, exitCodes[], env[], commands[]}",
		},
		ValidArgsFunction: func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
			return nil, cobra.ShellCompDirectiveNoFileComp
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			target, rest, err := root.Find(args)
			if err != nil || target == nil {
				return fmt.Errorf("unknown command %q for %q", strings.Join(args, " "), root.CommandPath())
			}
			// Find stops at the deepest match; words left over name nothing.
			for _, w := range rest {
				if !strings.HasPrefix(w, "-") {
					return fmt.Errorf("unknown command %q for %q", w, target.CommandPath())
				}
			}
			if !a.jsonOut {
				return target.Help()
			}
			return a.printer().JSONValue(helpDoc{
				Schema:    helpSchemaVersion,
				Version:   api.Version,
				ExitCodes: ExitCodes,
				Env:       EnvVars,
				Commands:  helpTree(target),
			})
		},
	}
}

// newAgentsTopic is `yyt help agents`: the embedded agent guide. It has no
// Run, so cobra lists it under "Additional help topics".
func newAgentsTopic() *cobra.Command {
	return &cobra.Command{
		Use:         "agents",
		Short:       "Using yyt from scripts and LLM agents: non-interactive login, --json, exit codes, retries",
		Long:        strings.TrimRight(cli.AgentGuide, "\n"),
		Annotations: map[string]string{"topic": "true"},
	}
}
