# `yyt` — CLI for the yingyeothon service console

Single Go binary that drives the console API (`https://console.yyt.life`): teams and projects, auth/topic/match/lobby/q channels, the binary catalog, game asset bundles, members, API tokens, hackathon events, plus WebSocket smoke helpers for the match and topic services.

## Install

Prebuilt binaries (linux/darwin/windows × amd64/arm64) are attached to GitHub Releases tagged `cli/v*`:

```sh
curl -fsSL https://raw.githubusercontent.com/yingyeothon/service/main/cli/install.sh | sh
# or: go install github.com/yingyeothon/service/cli/cmd/yyt@latest   (pin: YYT_VERSION=v1.2.0 for the script)
```

`yyt self version` prints the installed version; `yyt self update` fetches the newest `cli/v*` GitHub release for this OS/arch, verifies it against the release's `checksums.txt`, and swaps the running binary in place (Windows: the running `yyt.exe` is moved to `yyt.exe.old` first and removed on the next run). `--check` only reports and exits **7** when an update exists (0 = up to date), `--version 1.2.0` pins a release even if older, `--json` prints `{current, latest, updateAvailable}`. A `dev` build or a `go install …@main` pseudo-version counts as older than every release (`go install …@latest` carries the release version and compares normally); the file that gets replaced is the resolved executable path, so a package-manager install should be updated through that manager instead. Set `GITHUB_TOKEN`/`GH_TOKEN` when the unauthenticated GitHub API rate limit (60/h per address) bites. Neither command touches the console API or the config file.

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

## Teams, projects and the context

Every channel, catalog app and asset bundle belongs to a **project**, and a project to a **team**; team membership is the whole permission model (owner/member write, a pending seat only sees the team name, a platform admin reads). Resource names are unique within the team, so a resource is addressed either by its **id** (`auth_…`, `ca_…`, `ab_…` — never needs a context) or by its **name**, which is looked up in the project context:

1. `--team <name|id>` / `--project <name|id>` (global flags)
2. `YYT_TEAM` / `YYT_PROJECT`
3. `.yyt.json` — `{"team":"dooroo","project":"game"}` — found by walking up from the current directory (from `--project-path` for `catalog deploy|bump`), stopping at the git root, `$HOME`, or a world-writable directory. Team/project ids are not secrets; commit the file, preferably with ids (`{"team":"team_…","project":"prj_…"}`) — a team's name is also its join key.
4. the profile defaults set with `yyt team use <team>` / `yyt project use <project>` (`team use` clears the project default; both survive a `--token`/`YYT_TOKEN` override and a re-login)
5. **read commands only**: auto-select when you sit in exactly one team / it has exactly one project.

Each field is layered independently, with one guard: a project named at a *lower* layer than the team is dropped (a profile pin under `--team other` would otherwise satisfy the "explicit context" rule and land the write in the pinned team), and `--team`/`--project` given together must agree. `yyt whoami` prints the effective team/project and where each came from. **Write commands never auto-select** — `channels create`, `catalog app create`, `catalog deploy`, `artifact upload`, `asset create|upload|push`, `project create`, and every update/delete addressed by name fail with a hint when the context is not explicit, so a non-interactive script cannot start failing with "ambiguous" the day its author joins a second team. Reads by name (`catalog app get <name>`, `artifact list <name>`) *do* auto-select, which means a member of two teams needs the context for them as well. `--auth-channel` also takes the auth channel's name (same project). The resolved context is printed on stderr before `catalog deploy` creates anything.

**Catalog apps need only the team.** An app name is unique within the team, so `catalog app get|settings <name>`, `catalog artifact list|upload <name>` and `catalog deploy` look the name up across the team's projects (`GET /teams/{team}/catalog/apps`) — one `YYT_TEAM=dooroo` in a shared deploy script serves every repository, with no per-repository `.yyt.json`. A project context, when set, narrows the lookup to that project. Only a **new** app needs a project: `catalog deploy` puts it in the project context if there is one, otherwise in the project named after the `--project-path` directory (our repository convention; created when missing) — pass `--project` for the exceptions.

```
yyt team ls [--scope all]                       # your seats and pending requests (admins: every team)
yyt team create <name> [--description md] | join <name>     # join asks by exact name; an owner approves
yyt team get|update|delete|history|admin-lock [team]        # [team] defaults to the context
yyt team use <team>
yyt team members ls | add <github-login> [--role owner|member] | approve|promote|demote|kick <member-id> | leave
yyt team discussion ls | create <title> --body md|@file | get|update|rm <id>
yyt team discussion comment add <id> --body … | update <id> <cid> --body … | rm <id> <cid>

yyt project ls | create <name> [--description md] | get|update|delete [project] | use <project>
yyt project version ls | create <name> [--note md|@file] | bump [patch|minor|major] | get|update|rm <version>
yyt project version link <version> --artifact <art-id> | --bundle <bundle> --asset-version <v>
yyt project version unlink <version> <link-id>
yyt project issue ls [--status open|closed] | create <title> [--body …] [--version v] | get|update|close|reopen <n>
yyt project issue comment add <n> --body … | update <n> <cid> --body … | rm <n> <cid>
```

`members kick` and `members leave` print the channels whose credentials the departed member still knows — nothing is rotated automatically (that would kill a running game); rotate them with `channels rotate-secret` / `redis-user issue` / `doc-key issue`.

## Commands

List commands print the server's default order. The console's `sort`/`order`/`q` list parameters (2026-09-02, `docs/team-project.md` _List parameters_) are not exposed here yet: name resolution needs the whole, unfiltered list, and a parameter-less call still returns exactly that.

Every resource command maps 1:1 to a console route; `--json` prints the response as JSON (for `login`, `logout`, `revoke`, `delete` a small synthesized object), otherwise a table / key-value view. Secrets are printed only by `create` and `rotate-secret`; `lobby`/`q` channels have none, so those commands print nothing extra and `rotate-secret` refuses them.

```
yyt members list | approve <id> | promote <id> | demote <id>        # admin
yyt tokens list | create --name <n> | revoke <id>
yyt channels list [--kind auth|topic|match|lobby|q] [--scope all]   # project context → that project; none → every team you sit in
yyt channels get|extend|rotate-secret|delete <channel>               # id or name (name → project context)
yyt channels create --kind auth  --name n --audience aud [--token-ttl 86400] [--redirect https://…]… \
                    [--github-client-id id --github-client-secret s] [--google-client-id id --google-client-secret s]
yyt channels create --kind topic --name n --auth-channel <auth-id|name>
yyt channels create --kind match --name n --auth-channel <auth-id|name> --party-size 4 --callback-url https://… \
                    [--wait-timeout 60] [--on-timeout partial|fail]
yyt channels create --kind lobby --name n --auth-channel <auth-id> \
                    [--cap-say zone --cap-say party --cap-say user] [--cap-party=false] \
                    [--cap-pos=false --cap-say user]   # no positions means no zones, so drop zone chat \
                    [--cap-event=false] [--cap-debug] [--zone town] [--map-url https://…] \
                    [--flush-interval-ms 200] [--max-move-delta 4] [--rate-limit 30] [--party-size-max 4]
yyt channels create --kind q     --name n --auth-channel <auth-id>   # prefixes are derived; `get` prints them
yyt channels update <channel> [--name n] [same config flags; only the given ones change — --config replaces the whole config]
yyt channels create … --config '{…}' | --config @file.json        # raw config instead of flags

yyt events list | get <id>                                       # anonymous: waiting/opened/closed; members: + voting/cancelled + own drafts
yyt events create <title> --place p [--place-url url] --hours N --vote-until <when> --option <when>... [--body @f]  # member draft (max 3)
yyt events update <id> [--title t] [--body …] [--place p] [--place-url u|--clear-place-url] [--hours N] [--vote-until w] [--option w]...
                                                                 # owner/admin; every edit is a revision; schedule flags only while draft
yyt events publish <id> | cancel <id> | delete <id>              # owner/admin (draft → voting; cancel before closed); delete = platform admin
yyt events vote <event-id> <option-id>... | unvote <event-id>    # while voting; pick every date you can make
yyt events close-vote <id> --reason why [--option <option-id>]   # platform admin; ends the vote now — --option overrides the tally
yyt events history <id> | diff <id> <rev-a> <rev-b>              # page revisions; unified diff (fields + body)
yyt events comments list|add <event-id> --body …|edit <event-id> <cid> --body …|delete <event-id> <cid>
yyt events poster upload <event-id> poster.png|jpg | delete <event-id> | history <event-id>   # owner/admin, any status before closed, ≤5MB
# <when>: RFC3339 (2026-09-12T14:00:00+09:00), local YYYY-MM-DDTHH:MM, or unix seconds

yyt show list [--state open|closed] [--cursor c] | get <show>    # a public show is readable signed out; member_only needs a seat
yyt show create <title> [--acl public|member_only] [--body @f]   # any non-pending member; audience is chosen here
yyt show update <show> [--title t] [--body …] [--acl a] [--reason why]
                                                                 # narrowing is always allowed; widening is refused once it has entries
yyt show close <show> | reopen <show> [--reason why]             # closed = read-only, and reversible
yyt show delete <show> --reason why                              # platform admin only; destroys other people's entries, so a reason is required
yyt show from-event <event>                                      # owner/admin, once the event is visible to the world
yyt show grants list <show> | add <show> <login> | rm <show> <login> [--reason why]
                                                                 # write access, one member at a time; there is no read grant
yyt show submittable <show>                                      # what you may still put up, from the teams you sit in
yyt show entries list <show> [--sort new|likes] [--cursor c] | get <show> <entry>
yyt show entries submit <show> <title> --app|--bundle|--site <name-or-id> [--body @f] [--screenshot a.png]...
                                                                 # submitting is publication: the target's name and link become visible
yyt show entries update <show> <entry> [--title t] [--body …] [--build ref] [--reason why]
                                                                 # --screenshot replaces the whole set (max 3); omitting keeps it;
                                                                 # --clear-screenshots empties it
yyt show entries delete <show> <entry> [--reason why]            # its author, the show owner, an admin, or anyone who can write the target
yyt show entries like <show> <entry> | unlike <show> <entry>     # idempotent
yyt show entries comments list|add <show> <entry> --body …|edit <show> <entry> <cid> --body …|delete <show> <entry> <cid>

yyt audit list [--action a|--action-prefix p] [--target id] [--actor login] [--from w] [--to w] [--cursor c|--all]
yyt audit get <id>                                               # the full detail; admin only, and never cached
```

OAuth client secrets may come from `GITHUB_CLIENT_SECRET` / `GOOGLE_CLIENT_SECRET` to keep them out of shell history.

### Binary catalog

```
yyt catalog app list                                    # project context → that project; team only → that team; none → every team you sit in
yyt catalog app create <name> --path <applicationId> [--description d]   # in the project context (explicit)
yyt catalog app get|update|delete <app>                 # id or name
yyt catalog app settings <app> [--slack-hook … --slack-channel … --template … --keep N]
yyt catalog app cleanup <app> [--dry-run]
yyt catalog artifact list <app> [--platform p] [--filter key=value]…   # tag filter is client-side
yyt catalog artifact get|delete <app> <id>
yyt catalog artifact upload <app> <file> --platform p --version v [--tag k=v]…
yyt catalog artifact upload android <app> <file> --version v --application-id id --build-type t \
    [--build n --commit h --min-sdk n --target-sdk n --abi a --stage s --changelog c]
yyt catalog artifact upload ios <app> <file> --version v --bundle-id id --build-number n \
    [--distribution-method ad-hoc --minimum-os-version 12.0 --stage s --changelog c]
yyt catalog bump [--bump major|minor|patch] [--project-path .]          # pubspec only; git stays with your script
yyt catalog deploy [--name n] [--project-path .] [--build-profile debug|release|appbundle|aab|all]… \   # explicit team required
    [--description d] \
    [--split-per-abi] [--target-platform android-arm64] [--stage s] [--note changelog] \
    [--build n] [--commit h] [--min-sdk n] [--target-sdk n] [--abi a] [--tag k=v]… \
    [--do-bump [--bump patch]] [--no-verify]
yyt catalog installer
```

`deploy` reads `pubspec.yaml` / `build.gradle(.kts)`, resolves the team (and project, if set) context (printing `deploying <app> to team …`), finds the app by name in the team or creates it (project: the context's, else the `--project-path` directory name, created when missing), removes stale outputs, builds with `flutter`, uploads each output as an `android` artifact (per-ABI files each get their `abi` tag with `--split-per-abi`), then verifies that every uploaded artifact id is visible in the artifact list (5 retries). Note: because `upload android|ios` are subcommands, an app literally named `android` or `ios` cannot be targeted by the generic `upload` form.

`yyt cata …` is accepted as an alias of `yyt catalog …`. Migrating from the legacy `cata` CLI: `cata login` → `yyt login --device`, `cata auth me` → `yyt whoami`, `cata app deploy --profile p` → `yyt catalog deploy --build-profile p` (`--profile` now selects the config profile; build profile `aab` still accepted), `cata app bump` → `yyt catalog bump` (commit/push moved to your script), `cata artifact upload android|ios` → `yyt catalog artifact upload android|ios`, `cata artifact list --filter` → `yyt catalog artifact list --filter`, `cata apikey` → `yyt tokens`, inline `--slack-*`/`--keep-recent-versions` deploy flags → `yyt catalog app settings`. `cata artifact upload-status` is gone (commits are synchronous). Since the team model (2026-08-26) `catalog group|permission`, `--group` and `--debug-only` are gone too — access is team membership — and every deploy script needs a team context: export `YYT_TEAM` (or add `.yyt.json` next to `pubspec.yaml`).

### Game assets

```sh
yyt asset list                                         # project context → that project; none → every team you sit in
yyt asset create <name> [--description d]              # in the project context (explicit)
yyt asset get|update|delete <bundle>                   # id or name; update: [--name n] [--description d]
yyt asset files <bundle> <version>                     # public URLs of one version
yyt asset upload <bundle> <version> <file> [--path inside/the/bundle.json]
yyt asset push <bundle> <version> <dir>                # a whole directory as one version
yyt asset rm-version <bundle> <version>
```

`push` searches `.yyt.json` from the current directory, not from `<dir>` (the directory is a payload, not a project). It keeps every file's path relative to `<dir>` (dot-files and symlinks are skipped), so the relative references inside a map JSON keep resolving once the bundle is on the CDN. Objects are public, cached forever and never overwritten: a fix is a **new version** plus `yyt channels update <lobby-id> --map-url <new URL>`. Deleting a version a channel still points at breaks the game's load outright, so re-point first. Allowed extensions: `.json .png .jpg .jpeg .webp .gif .bmp .ogg .mp3 .wav .txt .csv`, 2 MB per file and 20 MB per bundle.

Exit codes: `0` ok, `1` local error (incl. smoke failures/timeouts and a missing/ambiguous context), `2` API error, `3` unauthorized (bad/expired token), `4` forbidden (pending platform member or team seat, or the action needs an owner/admin), `5` not found (including a team/project/resource name that does not resolve), `6` context missing or ambiguous (no request was made).

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

Release: tag `cli/vX.Y.Z` on `main`; `.github/workflows/cli-release.yml` runs `cli/scripts/build-release.sh` and publishes the archives + `checksums.txt` (creating the release, or uploading into one already created from the GitHub web UI for that tag).
