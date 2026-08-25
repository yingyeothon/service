# `yyt` — CLI for the yingyeothon service console

Single Go binary that drives the console API (`https://console.yyt.life`): members, API tokens, auth/topic/match/lobby/q channels, hackathon events, plus WebSocket smoke helpers for the match and topic services.

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

Without a pre-made token, `yyt login --device [--name box]` signs in through the GitHub device flow and mints a fresh API token.

### Profiles

The config file stores one login per profile (`{"profiles":{"dev":{…},"prod":{…}},"default":"prod"}`); a legacy flat file is migrated to the `default` profile on first use. Select with the global `--profile <name>` flag or `YYT_PROFILE` (flag > env > config default).

```sh
yyt login --profile dev --api https://console-dev.yyt.life --device
yyt login --profile prod --device                # default API
yyt profile add <name> [--api …] [--device]      # same as login --profile <name>
yyt profile list | use <name> | default <name> | rename <old> <new> | remove <name>
yyt --profile dev catalog app list
yyt --profile dev logout                         # removes only that profile
```

`whoami` prints the active profile and API; tokens are never printed. `profile default` is a synonym of `profile use` (handy after removing the default profile); `rename` moves the default marker with the profile. Across all commands, `ls` aliases `list` and `rm` aliases `remove`/`delete`.

## Commands

Every resource command maps 1:1 to a console route; `--json` prints the response as JSON (for `login`, `logout`, `revoke`, `delete` a small synthesized object), otherwise a table / key-value view. Secrets are printed only by `create` and `rotate-secret`; `lobby`/`q` channels have none, so those commands print nothing extra and `rotate-secret` refuses them.

```
yyt members list | approve <id> | promote <id> | demote <id>        # admin
yyt tokens list | create --name <n> | revoke <id>
yyt channels list [--kind auth|topic|match|lobby|q] [--scope all]
yyt channels get|extend|rotate-secret|delete <id>
yyt channels create --kind auth  --name n --audience aud [--token-ttl 86400] [--redirect https://…]… \
                    [--github-client-id id --github-client-secret s] [--google-client-id id --google-client-secret s]
yyt channels create --kind topic --name n --auth-channel <auth-id>
yyt channels create --kind match --name n --auth-channel <auth-id> --party-size 4 --callback-url https://… \
                    [--wait-timeout 60] [--on-timeout partial|fail]
yyt channels create --kind lobby --name n --auth-channel <auth-id> \
                    [--cap-say zone --cap-say party --cap-say user] [--cap-party=false] \
                    [--cap-pos=false --cap-say user]   # no positions means no zones, so drop zone chat \
                    [--cap-event=false] [--cap-debug] [--zone town] [--map-url https://…] \
                    [--flush-interval-ms 200] [--max-move-delta 4] [--rate-limit 30] [--party-size-max 4]
yyt channels create --kind q     --name n --auth-channel <auth-id>   # prefixes are derived; `get` prints them
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

### Binary catalog

```
yyt catalog app list | create <name> --path <applicationId> | get|update|delete <name>
yyt catalog app settings <name> [--slack-hook … --slack-channel … --template … --keep N]
yyt catalog app cleanup <name> [--dry-run]
yyt catalog group list|create|get|rename|delete|apps
yyt catalog permission list|grant|revoke --app <name>|--group <id>
yyt catalog artifact list <app> [--platform p] [--filter key=value]…   # tag filter is client-side
yyt catalog artifact get|delete <app> <id>
yyt catalog artifact upload <app> <file> --platform p --version v [--tag k=v]…
yyt catalog artifact upload android <app> <file> --version v --application-id id --build-type t \
    [--build n --commit h --min-sdk n --target-sdk n --abi a --stage s --changelog c]
yyt catalog artifact upload ios <app> <file> --version v --bundle-id id --build-number n \
    [--distribution-method ad-hoc --minimum-os-version 12.0 --stage s --changelog c]
yyt catalog bump [--bump major|minor|patch] [--project-path .]          # pubspec only; git stays with your script
yyt catalog deploy [--name n] [--project-path .] [--build-profile debug|release|appbundle|aab|all]… \
    [--split-per-abi] [--target-platform android-arm64] [--stage s] [--note changelog] \
    [--build n] [--commit h] [--min-sdk n] [--target-sdk n] [--abi a] [--tag k=v]… \
    [--do-bump [--bump patch]] [--no-verify]
yyt catalog installer
```

`deploy` reads `pubspec.yaml` / `build.gradle(.kts)`, removes stale outputs, builds with `flutter`, uploads each output as an `android` artifact (per-ABI files each get their `abi` tag with `--split-per-abi`), then verifies that every uploaded artifact id is visible in the artifact list (5 retries). Note: because `upload android|ios` are subcommands, an app literally named `android` or `ios` cannot be targeted by the generic `upload` form.

`yyt cata …` is accepted as an alias of `yyt catalog …`. Migrating from the legacy `cata` CLI: `cata login` → `yyt login --device`, `cata auth me` → `yyt whoami`, `cata app deploy --profile p` → `yyt catalog deploy --build-profile p` (`--profile` now selects the config profile; build profile `aab` still accepted), `cata app bump` → `yyt catalog bump` (commit/push moved to your script), `cata artifact upload android|ios` → `yyt catalog artifact upload android|ios`, `cata artifact list --filter` → `yyt catalog artifact list --filter`, `cata apikey` → `yyt tokens`, inline `--slack-*`/`--keep-recent-versions` deploy flags → `yyt catalog app settings`. `cata artifact upload-status` is gone (commits are synchronous).

### Game assets

```sh
yyt asset list|create <name> [--description d]|get <name>
yyt asset update <name> [--name n] [--description d] [--owner member-id]   # rename only while empty
yyt asset delete <name>
yyt asset files <name> <version>                       # public URLs of one version
yyt asset upload <name> <version> <file> [--path inside/the/bundle.json]
yyt asset push <name> <version> <dir>                  # a whole directory as one version
yyt asset rm-version <name> <version>
```

`push` keeps every file's path relative to `<dir>` (dot-files and symlinks are skipped), so the relative references inside a map JSON keep resolving once the bundle is on the CDN. Objects are public, cached forever and never overwritten: a fix is a **new version** plus `yyt channels update <lobby-id> --map-url <new URL>`. Deleting a version a channel still points at breaks the game's load outright, so re-point first. Allowed extensions: `.json .png .jpg .jpeg .webp .gif .bmp .ogg .mp3 .wav .txt .csv`, 2 MB per file and 20 MB per bundle.

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
