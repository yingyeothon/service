# `yyt` — CLI for the yingyeothon service console

Single Go binary that drives the console API (`https://console.yyt.life`): members, API tokens, auth/topic/match channels, hackathon events, plus WebSocket smoke helpers for the match and topic services.

## Install

Prebuilt binaries (linux/darwin/windows × amd64/arm64) are attached to GitHub Releases tagged `cli/v*`:

```sh
curl -fsSL https://raw.githubusercontent.com/yingyeothon/service/main/cli/install.sh | sh
# or: go install github.com/yingyeothon/service/cli/cmd/yyt@latest   (pin: YYT_VERSION=v1.2.0 for the script)
```

## Login

1. Sign in to the console with GitHub, go to *account > API tokens*, create a token (`yyt_…`; shown once).
2. `yyt login` (token on stdin: `yyt login < token.txt` or an interactive prompt) or `yyt login --token yyt_…` verifies it against `/me` and stores it in `~/.config/yyt/config.json` (mode 0600). `--api https://console-dev.yyt.life` targets another stage.
3. `yyt whoami`, `yyt logout` (the token stays valid until `yyt tokens revoke <id>`).

`YYT_TOKEN` / `YYT_API` environment variables and the `--token` / `--api` flags override the file (useful in CI). `YYT_CONFIG` relocates the file.

## Commands

Every resource command maps 1:1 to a console route; `--json` prints the response as JSON (for `login`, `logout`, `revoke`, `delete` a small synthesized object), otherwise a table / key-value view. Secrets are printed only by `create` and `rotate-secret`.

```
yyt members list | approve <id> | promote <id> | demote <id>        # admin
yyt tokens list | create --name <n> | revoke <id>
yyt channels list [--kind auth|topic|match] [--scope all]
yyt channels get|extend|rotate-secret|delete <id>
yyt channels create --kind auth  --name n --audience aud [--token-ttl 86400] [--redirect https://…]… \
                    [--github-client-id id --github-client-secret s] [--google-client-id id --google-client-secret s]
yyt channels create --kind topic --name n --auth-channel <auth-id>
yyt channels create --kind match --name n --auth-channel <auth-id> --party-size 4 --callback-url https://… \
                    [--wait-timeout 60] [--on-timeout partial|fail]
yyt channels update <id> [--name n] [same config flags; only the given ones change — --config replaces the whole config]
yyt channels create … --config '{…}' | --config @file.json        # raw config instead of flags

yyt events list | get <id>                                       # anonymous: published/closed only
yyt events create <title> [--body @file.md] | update <id> [--title t] [--body …]   # admin
yyt events transition <id> proposing|voting|decided|published|closed               # admin, in order
yyt events decide <id> <proposal-id>                                               # admin, while decided
yyt events proposals list|create <event-id> <title> [--body …]|update|delete
yyt events vote <event-id> <proposal-id> | unvote <event-id>                        # while voting
yyt events poster upload <event-id> poster.png|jpg | delete <event-id>             # admin, ≤5MB
```

OAuth client secrets may come from `GITHUB_CLIENT_SECRET` / `GOOGLE_CLIENT_SECRET` to keep them out of shell history.

Exit codes: `0` ok, `1` local error (incl. smoke failures/timeouts), `2` API error, `3` unauthorized (bad/expired token), `4` forbidden (pending member or not admin), `5` not found.

## Smoke helpers

```sh
# one socket per JWT (JWTs minted by the auth channel, e.g. POST /c/{ch}/token)
yyt smoke match --url "$(yyt channels get match_… --json | jq -r .wsUrl)" --jwt-file players.txt
yyt smoke topic --url wss://topic-ws.yyt.life/<topicId> --jwt <t1> --jwt <t2> --wait 5s
```

`smoke match` connects (which enqueues each player) and waits (`--timeout`, default 90s) for `matched`/`failed` on every socket; `smoke topic` sends one `msg` per member and prints every frame received during `--wait`. With `--json` each event is one NDJSON line. Both exit non-zero on failure frames or timeout and never print the tokens.

## Development

```sh
cd cli && go test ./... && go build ./cmd/yyt
go test ./internal/cmd -update   # refresh golden files after an intentional output change
```

Release: tag `cli/vX.Y.Z` on `main`; `.github/workflows/cli-release.yml` runs `cli/scripts/build-release.sh` and publishes the archives + `checksums.txt` with `gh release create`.
