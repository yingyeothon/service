# yyt for scripts and agents

`yyt` is the CLI of the yingyeothon service console. This guide is for
non-interactive use: CI jobs, shell scripts and LLM agents. It ships with
the binary (`yyt help agents`) and in every release archive, so it always
matches the installed version.

## Discover before you act

- `yyt help --json` prints the whole command tree as one JSON document:
  `schema`, `version`, `exitCodes`, `env`, and per command `path`, `use`,
  `short`, `long`, `aliases`, `example`, `output`, `runnable` and `flags`
  (`name`, `type`, `default`, `usage`, `required`). `yyt help --json <command>`
  limits it to one subtree. Schema 1 is a stable contract: fields are only
  added.
- `yyt <command> --help` shows the same for one command, with examples.

## Credentials and profiles

- Never type a token into an interactive prompt from an agent. Pass it as the
  environment: `YYT_TOKEN=<token> yyt whoami`, or store it once with
  `yyt login --token "$YYT_TOKEN"` (a profile in the config file, mode 0600).
- Name the stage explicitly in automation: `--profile dev` / `--profile prod`
  (or `YYT_PROFILE`). `yyt whoami` prints the active profile and API, never
  the token.
- Precedence: `--token` > `YYT_TOKEN` > the profile's token; `--api` >
  `YYT_API` > the profile's API; `--profile` > `YYT_PROFILE` > the config
  file's default.

## Team and project context

A resource named by id (`auth_…`, `ca_…`, `ab_…`) needs no context. A name
is looked up in the context: `--team`/`--project` > `YYT_TEAM`/`YYT_PROJECT`
> `.yyt.json` (searched upward from the working directory) >
`yyt team|project use` > the only team/project you have. That last step is
for read commands only: a write never guesses, and exits 6 when the context
is missing or ambiguous. In automation, pass `--team` and `--project` (or
commit a `.yyt.json`; ids are not secrets).

## Output

- `--json` on any command prints JSON on stdout; the `output` field of
  `yyt help --json` says which shape. Without it, stdout is a table or
  key/value lines meant for people.
- Progress, notes, retries and hints go to stderr. Parse stdout only.
- Secrets are printed once: an issued API key or channel secret appears only
  in the answer of the command that created it (`create`, `rotate-secret`,
  `doc-key issue`, `redis-user issue`). Capture it then; it cannot be read
  back. `push channel create|rotate-secret --save` stores a push apiKey in the
  config file instead of printing it.

## Errors and exit codes

Errors are one line on stderr — `error: <code>: <message> <details>` —
sometimes followed by `hint: …`. Branch on the exit code, not the text:

<!-- exit-codes:begin -->
- `0` ok
- `1` local error (bad flag or argument, file I/O, smoke failure or timeout)
- `2` API error not listed below (incl. rate_limited after its retries)
- `3` unauthorized: token missing, revoked or for another stage
- `4` forbidden: pending platform member or team seat, or the action needs an owner/admin
- `5` not found (incl. a team/project/resource name that does not resolve)
- `6` team/project context missing or ambiguous (no request was made)
- `7` `self update --check` found a newer release
<!-- exit-codes:end -->

The codes are a stable contract: changing one is a major version.

## Retries

- The console allows each member about two recorded writes a second. A write
  refused for that answers `rate_limited` with a `retryAfterMs` hint before
  anything is written, so `yyt` waits and repeats it: up to 3 times, 5 s in
  total, one `rate_limited: retrying in …` line on stderr per wait.
  `--no-retry` or `YYT_NO_RETRY=1` turns that off.
- Nothing else is repeated for you: another 429 (a daily cap, a cooldown), a
  409 or a 5xx comes back as exit 2. Re-running a create after a 5xx may
  create twice; read first (`get`/`ls`) when in doubt.
- Bulk work (`asset sync`, push campaigns) paces itself and retries what is
  safe; let it.

## Environment

| Variable | Meaning |
| --- | --- |
| `YYT_API` | console base URL |
| `YYT_TOKEN` | API token |
| `YYT_PROFILE` | config profile |
| `YYT_TEAM` | team context, name or id |
| `YYT_PROJECT` | project context, name or id |
| `YYT_CONFIG` | config file path (profiles and push apiKeys; mode 0600) |
| `YYT_CACHE` | cache dir for resumable uploads |
| `YYT_NO_RETRY` | never wait out a `rate_limited` refusal |

## Recipes

```sh
# Who am I, on which stage?
yyt --profile dev whoami

# Upload an Android build and print the artifact as JSON.
yyt --profile dev --team dooroo catalog artifact upload android my-game app-release.apk \
  --version 1.2.3+45 --application-id life.yyt.mygame --build-type release --json

# An expiring install link for testers (the URL is printed once).
yyt --profile dev catalog share create my-game --days 7 --kind android-release

# List channels of the project and pick one id with jq.
yyt --profile dev --team dooroo --project game channels ls --json | jq -r '.channels[] | select(.kind=="auth") | .id'

# Fail a CI job when the CLI is outdated (exit 7), not on other errors.
yyt self update --check; [ $? -ne 7 ]
```

Keep this file in step with `cli/internal/cmd/exitcodes.go` and
`help_text.go`; a test compares the exit-code block and the variable names.
