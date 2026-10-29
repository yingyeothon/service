package cmd

import (
	"fmt"
	"strings"
)

// EnvVar is one environment variable the CLI reads.
type EnvVar struct {
	Name    string `json:"name"`
	Meaning string `json:"meaning"`
}

// EnvVars lists every YYT_* variable the CLI reads; a test greps the source
// so a new one cannot be added without a row here.
var EnvVars = []EnvVar{
	{"YYT_API", "console base URL (below --api, above the profile)"},
	{"YYT_TOKEN", "API token (below --token, above the profile; the profile's team/project defaults still apply)"},
	{"YYT_PROFILE", "config profile (below --profile, above the config file's default)"},
	{"YYT_TEAM", "team context, name or id (below --team)"},
	{"YYT_PROJECT", "project context, name or id (below --project)"},
	{"YYT_CONFIG", "config file path (default: the user config dir + yyt/config.json, mode 0600; holds profiles and push apiKeys)"},
	{"YYT_CACHE", "cache dir for resumable uploads (default: the user cache dir + yyt)"},
	{"YYT_NO_RETRY", "any value but empty/0/false: never wait out a rate_limited refusal (as --no-retry)"},
}

func envVarHelp() string {
	var b strings.Builder
	for _, e := range EnvVars {
		fmt.Fprintf(&b, "  %-13s %s\n", e.Name, e.Meaning)
	}
	return b.String()
}

// rootLong is `yyt --help`'s description: the contract a script or an agent
// needs before any subcommand (`yyt help agents` has the long form).
func rootLong() string {
	return "CLI for the yingyeothon service console: teams, projects, channels, push,\n" +
		"catalog, assets, sites, kv, leaderboards, events and shows. Every resource\n" +
		"command maps to one console API route.\n\n" +
		"Credentials: --token > YYT_TOKEN > the profile's token (--profile >\n" +
		"YYT_PROFILE > the config file's default). `yyt login` stores one.\n\n" +
		"Context: a resource named by id (auth_…, ca_…, ab_…) needs none; a name is\n" +
		"looked up in the team/project context: --team/--project > YYT_TEAM/\n" +
		"YYT_PROJECT > " + ContextFile + " (searched upward) > `yyt team|project use` >\n" +
		"the only team/project you have (read commands only; a write never guesses).\n\n" +
		"Output: tables and key/value lines on stdout; --json prints JSON instead\n" +
		"(`yyt help --json` names each command's shape). Notes, progress and retries\n" +
		"go to stderr, so stdout stays parseable.\n\n" +
		"Errors: `error: <code>: <message> <details>` on stderr, sometimes followed by\n" +
		"`hint: …`. A rate_limited refusal with a retryAfterMs hint is waited out up\n" +
		"to 3 times (5 s in total) unless --no-retry or YYT_NO_RETRY is set.\n\n" +
		"Exit codes (stable; changing one is a major version):\n" + exitCodeHelp() + "\n" +
		"Environment:\n" + envVarHelp() + "\n" +
		"More: `yyt help agents` (non-interactive use), `yyt help --json` (the whole\n" +
		"command tree as JSON), cli/README.md."
}
