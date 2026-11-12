# `yyt` — CLI for the yingyeothon service console

Single Go binary that drives the console API (`https://console.yyt.life`): teams and projects, auth/topic/match/lobby/q/push channels, the binary catalog, game asset bundles, members, API tokens, hackathon events, plus WebSocket smoke helpers for the match and topic services.

## Install

Prebuilt binaries (linux/darwin/windows × amd64/arm64) are attached to GitHub Releases tagged `cli/v*`; both install scripts verify the archive against the release's `checksums.txt`.

```sh
# macOS / Linux: /usr/local/bin when writable, else ~/.local/bin (BINDIR overrides)
curl -fsSL https://raw.githubusercontent.com/yingyeothon/service/main/cli/install.sh | sh
```

```powershell
# Windows (PowerShell 5.1+ / pwsh): %LOCALAPPDATA%\Programs\yyt, added to the user PATH (YYT_BINDIR overrides)
irm https://raw.githubusercontent.com/yingyeothon/service/main/cli/install.ps1 | iex
```

`YYT_VERSION=v1.2.0` (PowerShell: `$env:YYT_VERSION = 'v1.2.0'`) pins a release for either script. Alternatives: `go install github.com/yingyeothon/service/cli/cmd/yyt@latest`, or unpack `yyt_<ver>_<os>_<arch>.tar.gz|zip` from the [releases page](https://github.com/yingyeothon/service/releases?q=cli%2Fv&expanded=true) and put `yyt` on your PATH yourself.

Per-OS notes:

- **macOS**: the binaries are ad-hoc signed by the Go toolchain, not notarized. `curl`/`install.sh` downloads carry no quarantine flag; an archive saved by a browser does, and Gatekeeper then refuses the binary until `xattr -d com.apple.quarantine yyt`.
- **Windows**: `install.ps1` and `yyt self update` move a running `yyt.exe` to `yyt.exe.old` before replacing it (removed on the next run). A browser-downloaded `.exe` may trip SmartScreen (unsigned); the script path does not. Git Bash users run the PowerShell line — `install.sh` refuses `mingw*`/`msys*` and says so.
- **Linux**: nothing special; `install.sh` needs `curl`, `tar` and `sha256sum` (or `shasum`).

Files the CLI writes (`YYT_CONFIG` / `YYT_CACHE` relocate them; `yyt login` and `yyt whoami` print the config path):

| OS      | config (tokens, profiles)                   | cache (upload resume state, encryption digests) |
| ------- | ------------------------------------------- | ----------------------------------------------- |
| Linux   | `~/.config/yyt/config.json`                 | `~/.cache/yyt`                                  |
| macOS   | `~/Library/Application Support/yyt/config.json` | `~/Library/Caches/yyt`                      |
| Windows | `%AppData%\yyt\config.json`                  | `%LocalAppData%\yyt`                            |

The config file is written with mode 0600 (its directory 0700) where the OS has permission bits; on Windows it relies on the user profile's default ACL.

`yyt self version` prints the installed version; `yyt self update` fetches the newest `cli/v*` GitHub release for this OS/arch, verifies it against the release's `checksums.txt`, and swaps the running binary in place (Windows: the running `yyt.exe` is moved to `yyt.exe.old` first and removed on the next run). `--check` only reports and exits **7** when an update exists (0 = up to date), `--version 1.2.0` pins a release even if older, `--json` prints `{current, latest, updateAvailable}`. A `dev` build or a `go install …@main` pseudo-version counts as older than every release (`go install …@latest` carries the release version and compares normally); the file that gets replaced is the resolved executable path, so a package-manager install should be updated through that manager instead. Set `GITHUB_TOKEN`/`GH_TOKEN` when the unauthenticated GitHub API rate limit (60/h per address) bites. Neither command touches the console API or the config file.

## Login

1. Sign in to the console with GitHub, go to _account > API tokens_, create a token (`yyt_…`; shown once).
2. `yyt login` (token on stdin: `yyt login < token.txt` or an interactive prompt) or `yyt login --token yyt_…` verifies it against `/me` and stores it in the config file (`~/.config/yyt/config.json` on Linux; see the table under _Install_ for macOS and Windows). `--api https://console-dev.yyt.life` targets another stage.
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

`whoami` prints the active profile and API; tokens are never printed. `profile default` is a synonym of `profile use` (handy after removing the default profile); `rename` moves the default marker with the profile. `list` commands take the alias `ls`, and most `delete`/`remove` commands take `rm`; where a group has a separate command of a similar name (`asset rm-version`, `asset delete` for the whole bundle), each `--help` names its own aliases.

## Teams, projects and the context

Every channel, catalog app and asset bundle belongs to a **project**, and a project to a **team**; team membership is the whole permission model (owner/member write, a pending seat only sees the team name, a platform admin reads). Resource names are unique within the team, so a resource is addressed either by its **id** (`auth_…`, `ca_…`, `ab_…` — never needs a context) or by its **name**, which is looked up in the project context:

1. `--team <name|id>` / `--project <name|id>` (global flags)
2. `YYT_TEAM` / `YYT_PROJECT`
3. `.yyt.json` — `{"team":"dooroo","project":"game"}` — found by walking up from the current directory (from `--project-path` for `catalog deploy|bump`), stopping at the git root, `$HOME`, or a world-writable directory. Team/project ids are not secrets; commit the file, preferably with ids (`{"team":"team_…","project":"prj_…"}`) — a team's name is also its join key.
4. the profile defaults set with `yyt team use <team>` / `yyt project use <project>` (`team use` clears the project default; both survive a `--token`/`YYT_TOKEN` override and a re-login)
5. **read commands only**: auto-select when you sit in exactly one team / it has exactly one project.

Each field is layered independently, with one guard: a project named at a _lower_ layer than the team is dropped (a profile pin under `--team other` would otherwise satisfy the "explicit context" rule and land the write in the pinned team), and `--team`/`--project` given together must agree. `yyt whoami` prints the effective team/project and where each came from. **Write commands never auto-select** — `channels create`, `catalog app create`, `catalog deploy`, `artifact upload`, `asset create|upload|push`, `project create`, and every update/delete addressed by name fail with a hint when the context is not explicit, so a non-interactive script cannot start failing with "ambiguous" the day its author joins a second team. Reads by name (`catalog app get <name>`, `artifact list <name>`) _do_ auto-select, which means a member of two teams needs the context for them as well. `--auth-channel` also takes the auth channel's name (same project). The resolved context is printed on stderr before `catalog deploy` creates anything.

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
yyt project issue ls [--status open|closed] [--version v] | create <title> [--body …] [--version v] | get|update|close|reopen <n>
  # issue --version: id or name (`+build` stripped by create, update and ls alike); create makes a missing name (`created version …` on stderr), ls refuses it
  # version get: TARGET names the app/version/abi/build or `bundle @ v`; ID keeps the raw `art_…`/`ab_…@v` for scripts; --json links carry `artifact`/`bundleName`
yyt project issue comment add <n> --body … | update <n> <cid> --body … | rm <n> <cid>
```

`members kick` and `members leave` print the channels whose credentials the departed member still knows — nothing is rotated automatically (that would kill a running game); rotate them with `channels rotate-secret` / `redis-user issue` / `doc-key issue`.

## Commands

`team|project|channels|events list` take `--sort`/`--order` and `--q`, the console's list parameters (2026-09-02, `docs/team-project.md` _List parameters_); `show list` takes `--q` only, because it is cursor-paged and the cursor pins the order. A value outside the route's vocabulary is refused before the request, and the vocabulary is in each command's `--help`; so is `--order` with no `--sort`, which the routes ignore and which would otherwise print the default order while looking as if it had done something. Without any of them a list prints the server's default order, which is what **name resolution** relies on: `yyt` resolves a name to an id from the whole, unfiltered list, so these flags are for what you read, never for what the CLI looks up.

Every resource command maps 1:1 to a console route; `--json` prints JSON instead of a table / key-value view: for most commands the route's response as decoded into the CLI's own struct (a field the CLI does not know is dropped, so a newer console can carry more than an older `yyt` prints), for `login`, `logout`, `revoke`, `delete` a small synthesized object. `yyt help --json` names each command's output. Secrets are printed only by `create` and `rotate-secret` (a push channel's apiKey not even there with `--save`, which stores it instead); `lobby`/`q` channels have none, so those commands print nothing extra and `rotate-secret` refuses them.

```
yyt members list | approve <id> | promote <id> | demote <id>        # admin
yyt tokens list | create --name <n> | revoke <id>
yyt channels list [--kind auth|topic|match|lobby|q|push] [--scope all]   # project context → that project; none → every team you sit in
yyt channels get|extend|rotate-secret|delete <channel>               # id or name (name → project context); `rotate` = `rotate-secret`
yyt channels create --kind auth  --name n --audience aud [--token-ttl 86400] [--redirect https://…]… \
                    [--github-client-id id --github-client-secret s] [--google-client-id id --google-client-secret s]
yyt channels create --kind topic --name n --auth-channel <auth-id|name>
yyt channels create --kind match --name n --auth-channel <auth-id|name> --party-size 4 \
                    [--callback-url https://…]   # omit it and a match is announced to its own sockets only \
                    [--wait-timeout 60] [--on-timeout partial|fail]
yyt channels create --kind match --name n --auth-channel <auth-id|name> --party-size 4 --mode deferred \
                    [--wait-timeout 600] [--accept-timeout 120] [--result-ttl 600] \
                    [--push-channel <push-id|name>]   # tickets over HTTP; see "Match modes" below
yyt channels update <match> --callback-url ''      # drop the callback (members-only mode)
yyt channels update <match> --push-channel ''      # deferred: drop the push channel (clients poll)
yyt channels create --kind lobby --name n --auth-channel <auth-id> \
                    [--cap-say zone --cap-say party --cap-say user] [--cap-party=false] \
                    [--cap-pos=false --cap-say user]   # no positions means no zones, so drop zone chat \
                    [--cap-event=false] [--cap-debug] [--zone town] [--map-url https://…] \
                    [--flush-interval-ms 200] [--max-move-delta 4] [--rate-limit 30] [--party-size-max 4]
yyt channels create --kind q     --name n --auth-channel <auth-id>   # prefixes are derived; `get` prints them
yyt channels update <channel> [--name n] [same config flags; only the given ones change — --config replaces the whole config]
yyt channels create … --config '{…}' | --config @file.json        # raw config instead of flags
yyt channels create --kind push  --name n --auth-channel <auth-id|name> --package com.example.game   # same as `yyt push channel create`

yyt push channel create --name n --auth <auth-id|name> --package com.example.game \
                        [--ios-bundle-id com.example.game] \
                        [--sender platform|team] [--service-account <file|->]   # apiKey printed once; the key file only with --sender team
yyt push channel ls | get|extend|rotate [--save]|delete <channel>   # `yyt channels …` with the kind fixed
yyt push channel update <channel> [--name n] [--auth <auth-id|name>]   # the package and the sender are fixed at creation
yyt push channel config <channel> [-o <file>|-] [--force]        # google-services.json; default ./google-services.json, kept unless --force
yyt push channel config <channel> --ios [-o <file>|-] [--force]  # GoogleService-Info.plist; default ./GoogleService-Info.plist
yyt push channel ios add <channel> <bundleId>                    # add the iOS app later; fixed once set
yyt push channel sender-key set <channel> --service-account <file|->   # the team's own Firebase project as a second sender
yyt push channel sender-key rm <channel>                         # refused on a --sender team channel
yyt push pool [ls] | close <slot> | open <slot>                  # platform admin: registration slots (p1, p2, …)
yyt push pool sweep                                              # platform admin: what the last daily sweep found per slot
yyt push pool apns <push-id> ready|pending                       # platform admin: the team's APNs certificate is (not) uploaded
yyt push channel stats <channel> [--days 14]                     # device tokens against push.tokensPerChannel, sends per UTC day
yyt push upload ls <channel> | rm <channel> <upload>             # recipient CSVs; rm frees one of the 20 pending places (--as-server too)
yyt push template ls <channel> | get|rm <channel> <template>      # <template>: id (pt_…) or name; get prints the variables = CSV columns
yyt push template create <channel> --name n [--title t] [--body b] [--data k=v …] [--file template.json]
yyt push template update <channel> <template> [--name n] [--title t] [--body b] [--data k=v … | --clear-data] [--file template.json]
yyt push job submit <channel> --template <id|name> --csv users.csv [--dry-run] [--wait [--timeout 30m]] \
                    [--idempotency-key K] [--priority high|normal] [--ttl sec] [--collapse-key s]
yyt push job ls <channel> [--limit n] [--cursor c] | get|cancel <channel> <job>
yyt push job report <channel> <job> [-o <file>|-] [--force] [--url]   # default ./push-report-<job>.csv, kept unless --force
yyt push broadcast <channel> (--template <id|name> | --title t [--body b] [--data k=v …]) [--idempotency-key K] [--wait]
                                                                 # job submit|ls|get|cancel|report and broadcast take --as-server (the apiKey routes)
yyt push key set <channel>  < key.txt                            # store the channel apiKey (stdin only; also `create|rotate --save`)
yyt push key ls | rm <channel>                                   # ids only; rm forgets the key, it stays valid
yyt push send <channel> --user <id>[,<id>…] [--data k=v …] [--title t [--body b]] [--priority high|normal] [--ttl sec] [--collapse-key k]

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
    [--build n --commit h --min-sdk n --target-sdk n --abi a --version-code n --stage s --changelog c]
yyt catalog artifact upload ios <app> <file> --version v --bundle-id id --build-number n \
    [--distribution-method ad-hoc|app-store|development --minimum-os-version 12.0 --url-scheme s --stage s --changelog c]
yyt catalog bump [--bump major|minor|patch] [--project-path .]          # pubspec only; git stays with your script
yyt catalog deploy [--name n] [--project-path .] [--build-profile debug|release|appbundle|aab|all]… \   # explicit team required
    [--description d] \
    [--variant v | --flavor f --name n --application-id id] [--dart-define KEY[=VALUE]]… [--dart-define-from-file path]… \
    [--no-upload] [--no-create] [--version-code-offset n] [--version-tag full|marketing] \
    [--split-per-abi] [--target-platform android-arm64] [--stage s] [--note changelog|auto [--note-skip regexp]…] \
    [--build n] [--commit h|auto] [--min-sdk n] [--target-sdk n] [--abi a] [--tag k=v]… \
    [--require-clean] [--no-drift-check] [--prebuild script | --no-prebuild] [--require-flutter x.y.z] [--print-config] \
    [--do-bump [--bump patch]] [--no-verify] [-- <flutter build args>]
yyt catalog installer                                   # newest installer build per platform; INSTALL = an iOS build's itms-services link
yyt catalog publish <app> --title t --audience public|members [--summary s] [--tag t]…   # publish the newest artifact per platform; replaces the listing whole
yyt catalog unpublish <app>
yyt catalog listing <app>                               # how the app is published (takenDown shows an admin's takedown)
yyt catalog viewer add|rm|ls <app> [<github-login>]     # the members a `members` listing names (a read, never a seat)
yyt catalog listings [--q s] [--tag t] [--platform p] [--sort publishedAt|title] [--order asc|desc]   # browse what you may read
yyt catalog share create <app> [--days 1|7|30] [--label text]   # an expiring install page link; the URL is printed once
                        [--kind android-release|android-debug|ios-ad-hoc] [--title t] [--summary text|@file]
                        [--reason text]                          # --reason: a platform admin with no seat on the team
yyt catalog share ls <app>                              # token links (live/expired/revoked) and the public link, if any
yyt catalog share rm <app> <id>                         # revoke a token link
yyt catalog share public <app>                          # the permanent link of a public listing
# A platform admin's list of every listing and its takedown/restore are console-web only (`/ui/listings` signed in as admin).
```

`deploy` reads `pubspec.yaml` / `build.gradle(.kts)`, resolves the team (and project, if set) context (printing `deploying <app> to team …`), finds the app by name in the team or creates it (project: the context's, else the `--project-path` directory name, created when missing), removes stale outputs, builds with `flutter`, uploads each output as an `android` artifact (per-ABI files each get their `abi` tag with `--split-per-abi`), then verifies that every uploaded artifact id is visible in the artifact list (5 retries). The console links each committed artifact to the project version its `version` tag names (`+build` stripped), creating the version when missing: an upload whose tag names a version prints `linked to version <name> (<id>)` on stderr, preceded by `created version …` when the commit made it, and the commit's JSON carries it as `version` (`null` when the tag is not a version name). Note: because `upload android|ios` are subcommands, an app literally named `android` or `ios` cannot be targeted by the generic `upload` form.

**Flavors, variants and defines.** An app that ships several editions from one source tree (Gradle product flavors, one catalog app and one applicationId each) declares them once in `.yyt.json` next to `pubspec.yaml`:

```json
{
  "team": "team_…",
  "variants": {
    "lite": { "flavor": "lite", "app": "sample", "applicationId": "com.example.sample" },
    "pro": { "flavor": "pro", "app": "sample-pro", "applicationId": "com.example.sample.pro" }
  }
}
```

```sh
# debug APK of the pro edition; the DSN comes from the environment and is never printed
TRACER_DSN="$(yyt tracer dsn sample-debug)" yyt catalog deploy --variant pro --build-profile debug \
  --split-per-abi --target-platform android-arm64 --dart-define TRACER_DSN --dart-define GIT_SHA="$(git rev-parse --short HEAD)" --stage debug
yyt catalog deploy --variant pro --build-profile appbundle --stage prod
# build only (no login, nothing uploaded); prints the output paths
yyt catalog deploy --variant lite --build-profile debug --no-upload --dart-define-from-file defines.json
```

- `--variant v` sets `--flavor`, `--name` and `--application-id` from the preset; a flag that disagrees with the preset is an error. `applicationId` is the **release** id of the flavor, `app` is a catalog app **name** (never an id), and two variants cannot share an app. Without presets, pass `--flavor`, `--name` and `--application-id` yourself: a flavored upload refuses to guess the app name or the id.
- Presets are read from the `.yyt.json` **in `--project-path`** only (the team/project search walks up; this one does not, so a repository-level file never forces variants on a sibling app). A file whose `variants` cannot be read is an error. A project that declares variants refuses a build that names neither `--variant` nor `--flavor`, and a bare `--flavor` that one preset describes is treated as that variant.
- After an APK build, `deploy` reads the applicationId Gradle packaged (`build/app/outputs/apk/[<flavor>/]<mode>/output-metadata.json`) and stops unless it equals the expected id; a debug build may also carry `.debug` (a project with another debug suffix passes its full debug id as `--application-id`). A flavored APK without that file is read with `aapt2` instead and refused when that is missing too; a flavorless one is then uploaded with a note. The packaged id is what the `application_id` tag carries, so a debug artifact is tagged `….debug` — for flavorless projects too, where it used to be the `build.gradle` id. A bundle (`.aab`) has no such metadata: with `aapt2` installed its id is read from the bundle and checked the same way, without it the bundle is tagged with the expected id **unchecked** (a note says so).
- **What the built file says.** `deploy` reads each output back: Gradle's metadata for an APK, and `aapt2` for APKs and bundles when one is found — `AAPT2`, else the newest `build-tools/*/aapt2` under the project's `android/local.properties` `sdk.dir`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Android/Sdk`, `~/Library/Android/sdk` or `%LOCALAPPDATA%\Android\Sdk`. A set `AAPT2` that is not a file, or does not run, is an error before anything is built; an SDK `aapt2` that does not run (an x86_64 binary on an arm64 host) is a note and the deploy goes on without it. The packaged versionCode becomes the `version_code` tag, and `min_sdk`/`target_sdk` are filled from the file unless you pass `--min-sdk`/`--target-sdk`. When both sources describe an APK they must agree, and a working `aapt2` that fails on a file stops the deploy. `--tag application_id=…` and `--tag version_code=…` are refused: those two come from the file. **The console must know the `version_code` tag** (console deployed on or after 2026-11-12): an older one answers 400 `tag "version_code" is not allowed` to the first upload, after the build.
- `--version-code-offset n` requires **every** output to carry versionCode `n` + the pubspec build number (`1.2.3+45` with offset 2000 → 2045) and stops before the upload otherwise. A value nothing can read — a bundle without `aapt2` — fails the check instead of passing it, and so does a pubspec version without `+build`. With `--split-per-abi` Flutter adds `abi × 1000` to each split unless `android/gradle.properties` sets `force-version-code-ignoring-abi=true`; the check has no per-ABI allowance.
- `--version-tag marketing` tags `version` as `x.y.z` instead of the pubspec's `x.y.z+n` (the default, `full`); the CDN file name keeps the full value. Two builds of one `x.y.z` are then the same version to everything that compares the `version` tag — retention, `artifact list --filter version=` and the console app's update check; `version_code` is only a tag you can read.
- `--no-create` fails with exit 5 **before the build** when the app does not exist, instead of creating it.
- **Git is read, never written.** `--commit auto` tags the short hash of `HEAD`; `--note auto` uses the subject of the newest commit that no `--note-skip <regexp>` matches (e.g. `--note-skip '^Bump version to '`), so a build made right after a bump commit is described by the change before it (control characters removed, cut to the 500-byte tag limit). Both need a git repository with a commit. Inside a repository, a **drift guard** records `HEAD` and the tracked changes of the whole repository (submodule content included) after a `--do-bump` and refuses the upload (and the `--no-upload` result) when either differs once the builds are done, or when `HEAD` moved between the start of the run and the build — `pubspec.lock`, which the build itself rewrites, and untracked files do not count, and files marked skip-worktree or assume-unchanged are invisible to git and so to the guard. A git that fails inside a checkout (not installed, "dubious ownership" on a CI mount) stops the deploy rather than switching the guard off; `--no-drift-check` turns the guard off on purpose. `--require-clean` refuses to start when a tracked file other than `pubspec.lock` is modified. `deploy` never pulls, commits or pushes, and its git calls do not refresh the index (`--no-optional-locks`): that stays in your script.
- Every profile is built and checked before a missing app is created or anything is uploaded, so a mismatch leaves the console untouched. A `--do-bump` has already rewritten `pubspec.yaml` by then and is not rolled back.
- `--dart-define KEY=VALUE` passes the pair; `--dart-define KEY` reads the value from the environment. An empty value is refused in both forms, and the key must be a plain name (`MY_KEY`). `--dart-define-from-file` (relative to the current directory) fails when the file is missing — flutter itself ignores that. Flag defines apply to **every** `--build-profile` of the run; a define that must stay out of release goes in `.yyt.json` `build.android.profiles.<p>.dartDefines` (below). Only define keys are printed, but a `--dart-define` value is visible in the process list while flutter runs; use the file for anything sensitive.
- Arguments after `--` go to `flutter build` unchanged (`-- --target lib/main_dev.dart --obfuscate --split-debug-info=symbols`). As a guard against mistakes, `--flavor`, `--debug|--release|--profile`, `--[no-]split-per-abi`, `--target-platform`, `--dart-define*`, `--build-name`, `--build-number`, `-P…`/`--android-project-arg` and `-v`/`--verbose` (it prints the defines) are refused there.
- `--no-upload` needs no login and no team; it prints `<path> <build_type> [abi]` per file (`--json`: `outputs[]`, with `applicationId` and `versionCode` only where they were read back from the file, and `commit` when one was given) and says which upload-only flags it ignored. `--do-bump`, `--version-code-offset` and the drift guard still apply. Use it when a check of your own must run on the built file before the upload: `deploy --no-upload`, your check, then `catalog artifact upload android`.
- **Project build defaults: `.yyt.json` `build`.** What a deploy script used to carry lives next to `pubspec.yaml`, so the script shrinks to `git sync → yyt catalog deploy --variant <v> --build-profile <p> → git follow-up`:

  ```json
  {
    "variants": { "pro": { "flavor": "pro", "app": "sample-pro", "applicationId": "com.example.sample.pro" } },
    "build": {
      "requireFlutter": "3.47.8",
      "prebuild": "tool/prebuild.sh",
      "create": false,
      "versionTag": "marketing",
      "commit": "auto",
      "note": "auto",
      "noteSkip": ["^Bump version to ", "^Update pubspec\\.lock"],
      "android": {
        "splitPerAbi": true,
        "targetPlatform": "android-arm64",
        "versionCodeOffset": 2000,
        "profiles": {
          "debug": { "stage": "debug", "dartDefines": ["TRACER_DSN", "GIT_SHA"] },
          "release": { "stage": "prod", "dartDefines": ["SENTRY_DSN"] },
          "appbundle": { "stage": "prod", "splitPerAbi": false }
        }
      }
    }
  }
  ```

  | Key | Flag that overrides it | Meaning |
  | --- | --- | --- |
  | `requireFlutter` | `--require-flutter` | `flutter --version` must be exactly this, checked before anything is bumped or built |
  | `prebuild` | `--prebuild`, `--no-prebuild` | a script **inside the project** (no absolute path, no `..`, no symlink out of it; executable, and neither it nor its directory world-writable), run directly (no shell, no arguments) from the project root with your environment, **once per run** after a `--do-bump` and before the first build; a non-zero exit stops the deploy with exit 1 (the script's own code is in the message), and so does a script that changed the pubspec version — a `--do-bump` written before it is not rolled back. On Windows it must be something the OS can start itself (`.exe`, `.bat`), not a `#!` script. Never run by `catalog bump` |
  | `create` | `--no-create[=false]` | `false` = a missing app is an error (exit 5) instead of being created |
  | `versionTag` (also under `android`) | `--version-tag` | `full` or `marketing` |
  | `commit`, `note` | `--commit`, `--note` (`--commit ""` clears it) | only `"auto"` is accepted in the file; it needs a git checkout, for `--no-upload` too |
  | `noteSkip` | `--note-skip` (replaces the list; `--note-skip ""` empties it) | subjects `--note auto` walks past |
  | `android.splitPerAbi`, `android.targetPlatform` (also per profile) | `--split-per-abi[=false]`, `--target-platform` | build shape; a profile's value beats the platform's, and a profile's `"targetPlatform": ""` clears it (a store bundle should not inherit the APK's `android-arm64`) |
  | `android.versionCodeOffset` | `--version-code-offset` | turns the versionCode check on (a flag can change the offset, not switch the check off) |
  | `android.profiles.<debug\|release\|appbundle>.stage` | `--stage` (all profiles) | the `stage` tag of that profile |
  | `android.profiles.<p>.dartDefines` | `--dart-define` (added to every profile) | **key names only**; each value is read from the environment and a missing one fails before anything runs. A key also given as `--dart-define` takes the flag's value. `YYT_*` names are refused: a define is compiled into the uploaded artifact |
  | `android.profiles.<p>.dartDefineFiles` | `--dart-define-from-file` (added) | files inside the project (same path rules as `prebuild`), which must exist before the prebuild script runs; a flag may name any file |

  Order: built-in default < `build` < `build.android` < `profiles.<p>` < flag. The file is read from `--project-path` only (like `variants`), a `build` that cannot be read as written — an unknown key, a key in another letter case, a key given twice, a wrong type, a value where a key name belongs, a file that exists but cannot be read — is an error rather than "no config", and it is refused in a world-writable project directory (only that directory's bit, the script and the script's directory are checked). Because defines are per profile, one run of `--build-profile debug --build-profile release` keeps a debug-only define out of the release build. `yyt catalog deploy … --print-config` prints the merged settings and each `flutter` command line with the define values masked (`***`, or `<unset>` for a key the environment lacks; `--json` too) and exits without running git, flutter, the prebuild script or a console request — compare it with what your script runs before switching over. **Trust:** `catalog deploy` runs project code — the prebuild script, then Gradle — with your whole environment, token included; the path rules above guard against mistakes and are not a sandbox. On a checkout you did not write, run only `--print-config`. **What may be committed in this file:** define key names, flavors, app names and application ids; never define values, tokens or keys (`docs/secrets.md`).

  Moving from a shell script with an `android/build.env`: the app name and release id go to `variants.<v>.app`/`applicationId` (or `--name`/`--application-id` for an app without flavors), the debug/release stage names to `profiles.<p>.stage`, a `2000 + build` rule to `versionCodeOffset`, define lists to `profiles.<p>.dartDefines` with the values exported by the caller (a define file written to a temporary path stays a `--dart-define-from-file` flag), and the changelog a CI job passes as a parameter to `--note "$CHANGELOG"`. What stays in the script is git: pull, submodules, and committing `pubspec.lock` or the bump.
- The app label (`title` tag) is the `app_name` string of the source set Gradle would pick: `src/<flavor><Mode>`, `src/<mode>`, `src/<flavor>`, `src/main` (default `values/` only).
- Coming from a script that called `catalog artifact upload` itself: `deploy` tags `version` with the full pubspec value (`1.2.3+45`, not `1.2.3` — retention and `artifact list --filter version=` treat them as different versions; the project version link strips `+build` either way), names the CDN file `<app>-<version>-<profile>[-<abi>]`, sets `build`/`commit`/`changelog` only from the flags you pass (`--note` is the changelog; `--commit auto` and `--note auto` read git), and **creates** a missing app unless `--no-create` is set — check the preset's `app` before the first prod run. `--version-tag marketing` keeps the `x.y.z` tag such a script used.

`yyt cata …` is accepted as an alias of `yyt catalog …`. Migrating from the legacy `cata` CLI: `cata login` → `yyt login --device`, `cata auth me` → `yyt whoami`, `cata app deploy --profile p` → `yyt catalog deploy --build-profile p` (`--profile` now selects the config profile; build profile `aab` still accepted), `cata app bump` → `yyt catalog bump` (commit/push moved to your script), `cata artifact upload android|ios` → `yyt catalog artifact upload android|ios`, `cata artifact list --filter` → `yyt catalog artifact list --filter`, `cata apikey` → `yyt tokens`, inline `--slack-*`/`--keep-recent-versions` deploy flags → `yyt catalog app settings`. `cata artifact upload-status` is gone (commits are synchronous). Since the team model (2026-08-26) `catalog group|permission`, `--group` and `--debug-only` are gone too — access is team membership — and every deploy script needs a team context: export `YYT_TEAM` (or add `.yyt.json` next to `pubspec.yaml`).

### Game assets

```sh
yyt asset list                                         # project context → that project; none → every team you sit in
yyt asset create <name> [--description d]              # in the project context (explicit)
yyt asset get|update|delete <bundle>                   # id or name; update: [--name n] [--description d]
yyt asset files <bundle> [<version>] [--json]          # public URLs of one version, or a live bundle's files (follows every page)
yyt asset upload <bundle> <version> <file> [--path inside/the/bundle.json]
yyt asset push <bundle> <version> <dir>                # a whole directory as one version
yyt asset sync <bundle> <dir> [--version v] [--mutable <glob>...] [--prune[=now]] [--dry-run]
yyt asset download <bundle> <path> [-o file] [--range a-b]
yyt asset rm <bundle> <path...>                        # live bundle files
yyt asset rm-version <bundle> <version>
```

`asset create --mode live` makes a live bundle (one namespace, files compared by
SHA-256, `--mutable` manifests replaced in place); `sync` mirrors a directory
into it. A file over 64 MiB goes up in 32 MiB parts and a `sync` that dies is
resumed by the next one (the upload id is kept under `$YYT_CACHE`, default the
OS cache directory — `~/.cache/yyt` on Linux, see _Install_ — for the day S3
holds the upload); `upload` and `push` take such
files too but start over.

### Key-value collections

```sh
yyt kv list                                            # the project context's collections (name, scopes, encrypted, entries)
yyt kv create <name> --read <scope> --write <scope> [--encrypted] [--description d] [--max-entries N] [--max-entries-per-owner N]
                                                       # scope: team | server | project | user; scopes and encryption are fixed for good
yyt kv get|update|delete <kv>                          # id (kv_…) or name; update: [--name n] [--description d] [--max-entries N] [--max-entries-per-owner N]
yyt kv entries <kv> [--prefix p] [--owner id] [--limit n] [--cursor c | --all]
yyt kv entry get <kv> <key> [--owner id]               # the value byte for byte (pipe it); --json = the whole entry
yyt kv entry put <kv> <key> [--owner id] (--value '{…}' | --file v.json | stdin) [--ttl s] [--if-version v]
yyt kv entry delete <kv> <key> [--owner id]            # allowed on an encrypted collection too
yyt kv entry clear <kv> [--owner <id>]                 # every entry of one player, or of the shared namespace
```

`get` prints the collection's KV API paths (`apiBase`, `apiMeta`, `apiName`, `apiEntries`, `apiOwner`; `{col}` in every KV API route takes the id or the name): a game server calls them with the project's document API key (`yyt channels doc-key …` on an auth channel), a player with the channel JWT it holds. `--owner` names a player's namespace and only makes sense on a per-owner collection — **either** scope being `user` makes one; a shared collection refuses it. `server` is the doc apiKey and the console: a player's JWT is refused a `server` scope, which is what an announcement a cron writes or telemetry only the server reads needs. `user`-read + `project`-write is the mail shape: any player may create (never overwrite) a row in another owner's namespace, under a key starting with its own id, and the `FROM` column appears in `yyt kv entries` once a row carries that stamp. An encrypted collection's values can be written and read only through the KV API, so `entries`/`entry get` show keys, sizes and times for it (`entry get` then prints the entry's shape instead of a value and is not JSON — use `--json` in scripts) and `entry put` is refused. Values are JSON text stored as sent, at most 16 KiB; `--ttl 0` clears an expiry and an omitted `--ttl` keeps whatever the row has.

### Game kit config

```sh
yyt project kit-config [project] [--auth <id|name>] [--lobby <id|name>] [--match <id|name>] [--push <id|name>]
```

Prints the block a game pastes into its own config so the client kit knows which channels, collections and boards the project owns (`docs/game-kit-design.md`). **Everything in it is public** — ids, names and the stage's own hosts — so it is safe in a repository; there is no secret in it and none will be added. A section whose stack the stage does not have, or whose channel the project does not hold, is **absent** rather than empty, because a kit module with no config fails on first use instead of connecting to nowhere. For a deferred match channel the `match` section is `{mode: "deferred", apiBase, ticketUrl, channelId}` with no `url`: it has no socket. The `push` section is `{channelId, apiBase, topic}` — the state base of the token routes and the broadcast topic — and never the channel apiKey. With several channels of a kind it refuses to guess and asks for `--auth`/`--lobby`/`--match`/`--push`: a wrong guess would be a *working* config pointing at the wrong channel, which surfaces as an empty lobby rather than as an error.

### Leaderboards

```sh
yyt lb list                                            # the project context's boards (name, submit, rule, order, periods, max)
yyt lb create <name> --submit server|owner [--rule best|latest|sum] [--order desc|asc]
                     [--periods alltime,daily,weekly] [--description d] [--max-entries N] [--retain-periods N]
                                                       # submit, rule, order and periods are fixed for good
yyt lb get|update|delete <lb>                          # id (lb_…) or name; update: [--name n] [--description d] [--max-entries N] [--retain-periods N]
yyt lb top <lb> [--period alltime|daily|weekly|<key>] [--limit n] [--offset n]
yyt lb score get <lb> <ownerId> [--period p]           # one owner's score and rank in that bucket
yyt lb score delete <lb> <ownerId>                     # every period of the board at once
yyt lb clear <lb> <period>                             # empty one bucket (a period name, or a key like 2026-09-10)
```

`yyt project get` counts leaderboards beside the other resources, because a project delete is refused while one exists — the CLI dropped that field until 2026-09-10, so a refused delete had no visible cause there.

**There is no `lb score put`.** The console never writes a score (`docs/decisions.md` _Serverless clients_ #2): every row arrives through the LB API on the state stack, which is what makes each one name the credential that wrote it. A game server submits with the project's document API key (`yyt channels doc-key …` on an auth channel), a player with the channel JWT it holds and the path `…/scores/me`; `get` prints those paths (`apiBase`, `apiMeta`, `apiName`, `apiTop`, `apiScore`).

`--period` names a period (`alltime`, `daily`, `weekly`) for the live bucket or a key (`2026-09-10`, `2026-W37`) for a past one; omitted, it is the board's first period at its live key. Keys are computed by the platform in `Asia/Seoul`, never by the client, and `lb top` prints which bucket answered on **stderr** so a piped table stays a table. `rank` is `1 + count(better)`, so equal scores share one. Scores are safe integers; an optional `meta` is JSON text stored byte for byte (at most 1 KiB) and belongs to the accepted score — `best` keeps the better one, `latest` the newest, `sum` adds and saturates.

`push` searches `.yyt.json` from the current directory, not from `<dir>` (the directory is a payload, not a project). It keeps every file's path relative to `<dir>` (dot-files and symlinks are skipped), so the relative references inside a map JSON keep resolving once the bundle is on the CDN. Objects are public, cached forever and never overwritten: a fix is a **new version** plus `yyt channels update <lobby-id> --map-url <new URL>`. Deleting a version a channel still points at breaks the game's load outright, so re-point first. Allowed extensions: `.json .png .jpg .jpeg .webp .gif .bmp .ogg .mp3 .wav .txt .csv`. Sizes and counts are limits (`yyt limit list --bundle <bundle>`): 2 MiB per file and 20 MiB per bundle unless a platform admin granted more; a refused upload names the limit to ask for.

Exit codes — a stable contract (`docs/decisions.md` _CLI_; changing one is a major version), also in `yyt --help`, `yyt help --json` and `yyt help agents`:

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

**Scripts and agents.** `yyt help agents` prints the guide for non-interactive use (also `agent-guide.md` in each release archive). `yyt help --json [command]` prints the command tree as one JSON document — a stable contract, `schema: 1`, fields only ever added:

```
{ "schema": 1, "version": "0.19.0",
  "exitCodes": [{"code": 0, "meaning": "ok"}, …],
  "env": [{"name": "YYT_API", "meaning": "…"}, …],
  "commands": [{ "path": "yyt catalog share create", "use": "create <app> …", "short": "…", "long": "…",
                 "aliases": ["…"], "example": "  yyt catalog share create my-game …",
                 "output": "the URL on stdout …; --json: …", "runnable": true,
                 "flags": [{"name": "days", "type": "int", "default": "7", "usage": "…", "required": false}] }, …] }
```

The root entry lists the global flags; every other entry its own. Every runnable command has an `example` and an `output` line (a test enforces it). A `rate_limited` refusal with a `retryAfterMs` hint — the per-member write slot, raised before anything is written — is waited out up to 3 times (5 s in total, one stderr line each); `--no-retry` or `YYT_NO_RETRY=1` turns that off, and nothing else is retried for you.

### Debug collector (tracer)

Read what debug builds sent to tracer (`docs/tracer.md`). Reads go to the tracer host with your API token; the console only resolves `<res>` (a `trc_…` id or a name in the project context) and hands out the host (dev and prod both run tracer; "tracer is not configured on this stage" means a wrong `--profile`/`--api`). Pick the profile from the build's DSN host: `trace-dev…` is dev. For a coding agent, install the debugging loop as a skill: `yyt skill install tracer-debug` (below).

```sh
yyt tracer issues <res> [--since 2h] [--level error] [--text t] [--release r] [--limit n]
yyt tracer issues <res> --group <groupKey> [--since 7d]   # one group's tag-value spread (releases, devices, features)
yyt tracer events <res> [--since 10m] [--until …] [--level l] [--release r] [--device d] [--trace-id t] [--type event|feedback] [--group g] [--tag k:v] [--text t] [--with-attachments] [--limit n] [--cursor c]
yyt tracer event <res> <event_id>                      # exception + frames, breadcrumbs, tags, contexts, attachments
yyt tracer timeline <res> <event_id> [--window 2m]     # breadcrumbs, logs, events, transactions around it (device time)
yyt tracer logs <res> [--since 15m] [--until …] [--level l] [--device d] [--trace-id t] [--attribute k:v] [--text t] [--limit n] [--cursor c]
yyt tracer attachment <res> <attachment_id> -o file    # streamed, kept only if the sha256 matches
yyt tracer drops|usage <res> [--days 7]

yyt tracer list                                        # the project's resources (console)
yyt tracer create <name> [--description d]             # prints the write key and the DSN
yyt tracer get <res>
yyt tracer update <res> [--name n] [--description d]   # or: yyt tracer rename <res> <new-name>
yyt tracer rotate-key <res>                            # old DSNs stop being accepted
yyt tracer delete <res>                                # tracer purges the data after 7 days; no backup
yyt tracer dsn <res>                                   # the DSN alone, for a build script: TRACER_DSN="$(yyt tracer dsn app-debug --profile dev)"
```

`--local http://127.0.0.1:8095` (or `YYT_TRACER_LOCAL`) reads a local `tracer serve` with `YYT_TRACER_LOCAL_TOKEN` (its `tracer.json` readToken) and needs the `trc_` id; plain http is accepted only for a loopback host. A refused token exits 1 with a tracer-specific message (the console login is not at fault); a missing resource or event exits 5. Device text in tables is stripped of control characters; `--json` keeps it escaped. The management commands always go to the console (they refuse `--local` and ignore `YYT_TRACER_LOCAL`); `dsn` prints only a DSN of the minted shape (`https://<this key>@<host>/<this id>`) and fails, printing nothing, otherwise or before the stage has a tracer.

### Agent skills

`yyt` carries agent skills — instructions that teach a coding agent (Claude Code, Codex) a yyt workflow; today `tracer-debug`, the debug-build loop over `yyt tracer`. The copy is embedded in the binary, so it always matches the installed version.

```sh
yyt skill list                               # NAME DESCRIPTION
yyt skill show tracer-debug                  # the SKILL.md, for an agent without a skill system
yyt skill install tracer-debug               # ~/.claude/skills and/or ~/.codex/skills, whichever agent is set up
yyt skill install tracer-debug --target all  # both, creating the directories; --target claude|codex for one
yyt skill install tracer-debug --dir ./.claude/skills   # a project-local copy
```

Rerun `install` after `yyt self update` to refresh the copy (`unchanged`, `updated` or `installed` per target). `CLAUDE_CONFIG_DIR` and `CODEX_HOME` move the default directories. A symlink left by an earlier manual install is replaced only with `--force`. Restart the agent session to load a new skill.

### Push notifications

A push channel is a channel of kind `push`: `yyt push channel create|ls|get|update|extend|rotate|delete` are the `yyt channels` commands with the kind fixed (same routes, same output), and `yyt push channel` adds what only that kind has. It registers one Android application id with the platform's Firebase sender; `config` downloads the `google-services.json` the app embeds (`registered: true` in `get` says there is one). `create` and `rotate` print the `apiKey` once. `get` prints `apiBase`: the app registers its FCM token there with a player JWT of the channel's auth channel (`PUT|DELETE /push/{channel}/token`) and a game server sends with the apiKey (`POST /push/{channel}/send`).

**apiKey.** `push send`, `smoke push` and `--as-server` need the channel apiKey. The CLI keeps it in its config file (mode 0600, `YYT_CONFIG` overrides the path), filed under the console URL (the stage) and the channel id: `create --save` and `rotate --save` store the new key instead of printing it, and `push key set <channel>` reads one from stdin — there is no argument, environment variable or file flag for a key, so it stays out of shell history and `ps`. `push key ls` prints channel ids, never keys; `push key rm` forgets one (rotate to revoke). In CI, keep the config file itself as the secret.

**Targeted send.** `yyt push send <channel> --user u1,u2 --title "Party" --body "join" --data kind=invite` calls `POST {apiBase}/push/{channel}/send` with the stored key and prints one line per user (`sent`, `no-token`, `failed` with `budget|unavailable|rejected|unregistered`); it exits 1 when any user failed. The route is not idempotent: only a throttled call — a 503/429 without an error body, which never ran — is retried with a backoff. Resend only the users that failed with `budget` or `unavailable`. At most 500 users per call; duplicates fold.

`--sender team` makes the team's own Firebase project the only sender (the service-account key file is required and the channel has no platform registration, so `config` refuses); `sender-key set` adds such a key to a platform channel as a second sender. The key is read from a file or stdin (`-`), is never printed, and no route returns it — `get` shows only `teamProject`.

A `push_…` argument is always an id: a channel name may not have that shape. A refused create says what to do: `package_taken` (the application id belongs to another platform-sender channel on the stage; `--sender team` is not bound by it), `service_account` (which field of the key file failed), `push.appsPerTeam` (the limit request to make), `push_pool_full` / `push_not_configured` (a platform admin's `yyt push pool`), `firebase_unavailable` (retry). `update` with `--auth` answers `not_registered` while a platform registration is unfinished (`--name` alone is not refused), and `create`, `sender-key` and every `config` download take the per-member write slot (429: run it again).

**Upkeep.** `push channel stats` prints the channel's device tokens against `push.tokensPerChannel` (soft 10,000, hard 100,000; a new token past it is refused 409, a refresh never is — `yyt limit request push.tokensPerChannel <n> --channel …`) and, per UTC day of the last 14 (`--days` up to 30), the targeted sends. `push upload ls` lists the recipient CSVs with their state (`pending` and `in use` hold one of the 20 places, `free` no longer does) and `push upload rm` removes one no running job reads. `push pool sweep` (platform admin) shows the last daily sweep: stale tokens, claims released or kept, and per slot the reconciliation's orphans, missing and foreign apps, apps restored after a failed restore, claims released because their app was purged (`LOST`, with a note on stderr: those channels must be recreated) and any auto-close.

`yyt push pool close <slot>` on a slot the platform closed itself (`CLOSED BY auto:firebase-limit`) takes the closure over: it prints `closed`, and the daily sweep no longer reopens the slot.

**iOS** (`docs/decisions.md` _Console app and push on iOS_ #8). A push channel may hold one iOS app beside the Android one: `--ios-bundle-id` on `create`, or `push channel ios add <channel> <bundleId>` later (the same id again is a no-op; another is `ios_immutable`). The bundle id is checked locally (`^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$`, at most 155 characters) and, like the package, is unique per stage among platform-sender channels (`bundle_taken`). Both apps live in the channel's slot and each counts toward its 20; a slot without room for the iOS app answers 503 `push_slot_full`, and the channel never moves. `get` prints `ios` (the bundle id and how to fetch its config) and `apns`: on the platform sender `pending` until the platform owner uploads the team's per-app APNs certificate (`.p12`) to the slot's iOS app, then `ready` — hand the `.p12` and its password to the owner out of band (in person or encrypted), never through the console; it expires yearly and renewal is a request to the owner; `team` on a team sender, whose own Firebase project holds the iOS app and its APNs credential (so `config --ios` refuses with `not_registered`). `push pool` adds an APNs pending table (channel, team, bundle id, slot) when there is one; `push pool apns <push-id> ready|pending` takes the channel id, as an admin is not resolved into the channel's team.

**Campaigns** (`docs/push.md` _Campaigns_). A template is a message with `{{variables}}` in its title, body and data values (`--file` takes `{name, title, body, data}`, e.g. an edited `template get --json`; flags beside it win; `--data` replaces the whole data set). `job submit` sends one template to the users a recipient CSV lists — a `userId` column plus one column per variable:

```sh
yyt push template create alerts --name welcome --title "Hi {{name}}" --body "Season 2 is open" --data screen=season
yyt push job submit alerts --template welcome --csv users.csv --dry-run --wait   # counts only, sends nothing
yyt push job submit alerts --template welcome --csv users.csv --wait             # exit 1 when the job failed
yyt push job report alerts pj_…                                                  # userId,status,reason per row, for 7 days
```

- Before any request `submit` reads the CSV header and refuses a file without `userId`, with a column that reads like a device token (`token`, `fcm_token`, `registrationId`, …), with an invalid or repeated column name, or without a column for a variable of the template. Rows are judged by the job; the server's reader is the one that counts.
- **Idempotency.** Without `--idempotency-key`, the key is `cli-<hash of the template id and the file's SHA-256>-send|-dry`, printed on stderr. Running the same command again answers the job it made the first time and submits nothing twice (stderr says `replayed`); that holds for a dry run too, whose numbers are then the earlier ones. To run the same file again pass a new `--idempotency-key`. The options are not part of the derived key: the same file with another `--priority`/`--ttl`/`--collapse-key` is refused (`idempotency_key_reused`). The job a key holds is read by the key (`GET …/push/jobs?idempotencyKey=`) and asked for again with that job's own upload, so nothing is uploaded. Every upload declares the file's SHA-256, which the bucket enforces: under a held key the same bytes uploaded anew replay the job, and a different file is `idempotency_key_reused`.
- A dry run and the job after it share one upload of the same file (a channel holds 20 pending uploads; one stops counting when its jobs have finished, and each is removed two days after it was made). An upload whose submit was refused before a job existed, or whose PUT failed, is deleted again (best effort). The upload URL is never printed.
- `--wait` polls every 3 s until `done` or `failed`, prints progress on stderr and the job on stdout, and fails when the job failed; `--timeout` (30 m) ends the wait, not the job. `job get` on a failed job says why (`csv_invalid` with the line, `recipients_over_limit` with the limit request to make, …). A `job cancel` that arrives during the last batch stops nothing: the job ends `done`, shown as `done (finished before the cancel took effect)`.
- `job ls` shows resolved users in `SENT` for a dry run. `job report --url` prints the five-minute download link instead of fetching it; nothing else prints it. A report row's `status` is `sent`, `no-token`, `unregistered`, `failed` (`unavailable` or `rejected`), `skipped` or, in a dry run, `resolved`. A skipped row's `reason` is `duplicate`, `missing-variable`, `invalid-user`, `too-large` or `invalid-value` (the row's value would put a control character into the message); the last three make up the job's `invalid` count.
- `broadcast` sends one literal message (or a template without variables) to every app install subscribed to the channel's topic. **It does not ask for confirmation** — no `yyt` command prompts. Its derived key covers the message, the options and the UTC day, so the same broadcast run twice on one day is sent once; a new `--idempotency-key` sends it again. It is a job (`job get|ls`), counts against `push.jobsPerDay`, and has no dry run and no report. **A broadcast is not confidential**: anyone who holds the app can subscribe to the topic, so it carries no secret, no personal data and nothing that grants something (a code, a reward). Private content goes through a campaign (`job submit`), which addresses the users a CSV lists.
- Limits are the channel's: `yyt limit list --channel <channel>` shows `push.recipientsPerJob` (rows per file) and `push.jobsPerDay` (jobs per UTC day; dry runs are not counted and have a daily cap of their own, which the refusal names). A refused submit prints the request to make, e.g. `yyt limit request push.jobsPerDay <value> --channel push_… --reason "…"`.
- A game server runs the same job routes (not the templates) with the channel apiKey as Bearer under `/push-api/{channelId}/…` on the console API host. There a channel id that does not exist answers 401, like a wrong key (not 404), and an expired or disabled channel 410. `--as-server` on `job submit|ls|get|cancel|report` and `broadcast` runs the same command on those routes with the stored key, as a game server would. It is a flag, not automatic on a stored key, so the same command never changes its principal (and its errors: an unknown channel answers 401 there) from one machine to the next. Template names are still looked up with the console token, so `--as-server` still needs a login.

### Limits

```sh
yyt limit list [--bundle b | --channel c | --collection k | --site s | --tracer t | --scope team]   # usage, effective, soft, hard, override; no flag = the project in context
yyt limit request <limit> <value|unlimited|+N> [--bundle b | --channel c | --collection k | --site s | --tracer t] --reason "…"
yyt limit request kv.maxEntries 50000 --collection saves --reason "…"   # a collection's cap ceiling; its usage is the cap set now
                                                       # sizes in binary units (256MiB, 3GiB); channel.lifetime takes only `unlimited`
yyt limit request team.projects +5 --reason "…"        # a `team.` limit is the team in context; +5 once usage reaches the limit
yyt limit request tracer.dailyBytes +50MiB --tracer app-debug --reason "…"   # a size limit's +N takes the unit
yyt limit request push.jobsPerDay 30 --channel alerts --reason "…"   # push.jobsPerDay and push.recipientsPerJob need --channel (a push channel)
yyt limit requests [--status s] [--cursor c] [--limit n]   # the team's requests, newest first
yyt limit get <request-id>                             # reason, and once decided the grant and the admin's note
yyt limit cancel <request-id>                          # the requester or a team owner; counts as a refusal for 7 days
# platform admin
yyt limit requests --all [--status pending]            # every team's; stderr says how many are pending
yyt limit approve <request-id> [--value v] [--note n]
yyt limit reject <request-id> --note "…"
yyt limit set <limit> <value|unlimited> [--bundle b | --channel c | --scope team] [--expires 7d] --note "…"
yyt limit revoke <limit> [--bundle b | --channel c | --scope team] --note "…"   # channel.lifetime: back to 28 days
```

Every limit has a soft value every scope gets and a hard ceiling (`docs/decisions.md` _Limit requests_). One request per limit and scope may be pending, ten per team; a refused or cancelled one blocks the same limit for 7 days (exit 2, the error says when). A channel granted no expiry prints `expires: no expiry`, and `channels extend` refuses it. `push.appsPerTeam` (2 per team, ceiling 5, step 1) is a team limit like `team.projects` and is asked for as `+1`; `push channel create` at the limit prints the request to make. `team.projects` (20 per team, ceiling 1,000) is stepped: `list --scope team` says when it may be asked for, `+5` sends the server's next step (any other `+N` is `effective + N`, and the server refuses it), and `project create` at the limit prints the request to make. `+N` is a whole count and applies to count limits only; sizes take an absolute value.

## Match modes

A match channel is `live` (the default) or `deferred`, chosen with `--mode` at creation and fixed afterwards (`docs/decisions.md` _Match: deferred mode_; client contract in `services/match/README.md`).

| | `live` | `deferred` |
| --- | --- | --- |
| Players wait | on a WebSocket (`wsUrl`), app open | with a ticket over HTTP (`ticketUrl`), accepting the match later |
| `--wait-timeout` | 5..600 s, default 60 | 30..7200 s, default 600 |
| `--accept-timeout` | — | 30..600 s, default 120: every member must accept a proposed match within it |
| `--result-ttl` | — | 60..3600 s, default 600: how long a finished ticket stays readable |
| `--push-channel` | — | optional: an active push channel (id or name) of the same project on the same auth channel; it wakes the players. Without one, clients poll |
| `--notify-proposed\|confirmed\|expired <title>` and `--notify-<state>-body <body>` | — | optional: makes that state's push a visible notification (title ≤ 100, body ≤ 240); `''` removes one state, `--notify-clear` all |

- `channels get` prints `mode` for every match channel and, for a deferred one, `acceptTimeoutSec`, `resultTtlSec`, `pushChannel`, `ticketUrl` (`POST`/`GET`/`DELETE`), `acceptUrl` and `declineUrl` (`POST`), all called with a player JWT as Bearer. `ticketUrl` reads `none (…)` on a stage whose match service has no HTTP host. Clients should poll `GET` no faster than every few seconds (the ticket API is throttled at 5 requests/s per stage; `get` prints this as `polling`), and `POST …/ticket` can answer 429 `cooldown` with `details.retryAfter` after a decline or an unanswered proposal. `channels list` has a `MODE` column (`-` for the other kinds). `--json` stays the console's response: the mode is `config.mode`, absent on a live channel.
- `channels update <match>` reads the channel and sends its whole config back with the given flags on top, so the mode and every deferred field are kept. `--push-channel ''` removes the link.
- Refused before any write: `--mode` other than the channel's own, and `--accept-timeout`/`--result-ttl`/`--push-channel` on a live channel. A push channel the console cannot use (expired, another project, another auth channel) comes back as its 400 with the next step.
- `yyt smoke match --deferred --url <ticketUrl>` drives the deferred mode (_Smoke helpers_).

## Smoke helpers

```sh
# one socket per JWT (JWTs minted by the auth channel, e.g. POST /c/{ch}/token)
yyt smoke match --url "$(yyt channels get match_… --json | jq -r .wsUrl)" --jwt-file players.txt
yyt smoke topic --url 'wss://topic-ws.yyt.life/?topic=<topicId>' --jwt <t1> --jwt <t2> --wait 5s
# deferred match: submit, accept, wait for confirmed (polls at most 4 requests/s)
yyt smoke match --deferred --url "$(yyt channels get match_… --json | jq -r .ticketUrl)" --jwt-file players.txt
# push: register a device token with a player JWT, send it one message with the stored apiKey, remove the token
yyt smoke push <push channel> --jwt-file player.txt --token-file fcm-token.txt [--project <firebase project id>] [--keep]
```

`smoke match` connects (which enqueues each player) and waits (`--timeout`, default 90s) for `matched`/`failed` on every socket; `smoke topic` sends one `msg` per member and prints every frame received during `--wait`. With `--json` each event is one NDJSON line. All exit non-zero on failure frames or timeout and never print the tokens. `smoke match --deferred` deletes the players' tickets when a run fails. `smoke push` prints the send's per-user line; `sent` means FCM accepted the message, so look at the device.

## Development

```sh
cd cli && go test ./... && go build ./cmd/yyt
go test ./internal/cmd -update   # refresh golden files after an intentional output change
```

Release: tag `cli/vX.Y.Z` on `main`; `.github/workflows/cli-release.yml` runs `cli/scripts/build-release.sh` and publishes the archives + `checksums.txt` (creating the release, or uploading into one already created from the GitHub web UI for that tag). CI runs `go test` on ubuntu, macOS and Windows runners, so a permission-bit or path-separator assumption fails before it ships; `.yyt.json`'s world-writable-directory guard is Unix-only (Windows reports `0777` for every directory), so on a shared Windows host do not run mutating commands from a directory tree other users can write to, or pass `--team`/`--project` (they layer above the file; `yyt whoami` prints where the context came from).
