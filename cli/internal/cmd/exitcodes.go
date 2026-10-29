package cmd

import (
	"fmt"
	"strings"
)

// Exit codes are a stable contract (docs/decisions.md "CLI"): changing one
// is a major version. `Execute`, the root help, `help --json`, the agent
// guide and cli/README.md all read or are tested against this table.
const (
	ExitOK              = 0
	ExitLocal           = 1
	ExitAPI             = 2
	ExitUnauthorized    = 3
	ExitForbidden       = 4
	ExitNotFound        = 5
	ExitContext         = 6
	ExitUpdateAvailable = 7
)

// ExitCode is one row of the exit-code table.
type ExitCode struct {
	Code    int    `json:"code"`
	Meaning string `json:"meaning"`
}

// ExitCodes lists every code `Execute` returns, in order.
var ExitCodes = []ExitCode{
	{ExitOK, "ok"},
	{ExitLocal, "local error (bad flag or argument, file I/O, smoke failure or timeout)"},
	{ExitAPI, "API error not listed below (incl. rate_limited after its retries)"},
	{ExitUnauthorized, "unauthorized: token missing, revoked or for another stage"},
	{ExitForbidden, "forbidden: pending platform member or team seat, or the action needs an owner/admin"},
	{ExitNotFound, "not found (incl. a team/project/resource name that does not resolve)"},
	{ExitContext, "team/project context missing or ambiguous (no request was made)"},
	{ExitUpdateAvailable, "`self update --check` found a newer release"},
}

// exitCodeHelp renders the table for help text.
func exitCodeHelp() string {
	var b strings.Builder
	for _, e := range ExitCodes {
		fmt.Fprintf(&b, "  %d  %s\n", e.Code, e.Meaning)
	}
	return b.String()
}
