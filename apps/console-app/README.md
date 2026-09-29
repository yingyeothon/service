# 잉여톤 — yyt console companion app (`life.yyt.console`)

Android app with three tabs: **앱** lists catalog apps and installs their APKs
directly from the public CDN (the original installer role), **프로젝트** lists
the member's teams and projects, **둘러보기** lists the catalog listings the
caller may read (`GET /catalog/listings?platform=android`). A project opens with three tabs: **이슈**
(read, file, comment on, close and reopen issues), **사이트** and **채널**
(view, create, edit and delete the project's static sites and channels, and
extend a channel by 7 days) — the console's project page on a phone. It talks
only to the console API.

- Sign in: **QR, or the web → app handoff**. The console SPA's _App login_ page mints an API token
  and renders `{"type":"yyt_api_key","apiKey":"yyt_…","server":"<origin>"}`;
  the app scans it, probes the key with `GET /me` (pending members are
  refused) and saves it as a **profile** (server + key + login) in secure
  storage. Several profiles (dev/prod, several accounts) can coexist; the
  app-bar avatar switches, adds (scan another QR) or removes them. The app
  ships no server address at all — the QR carries it. A 401 drops the
  active profile (the token was revoked).
- Handoff (2026-09-29, `todo/49`): the SPA's **Open app** button (Home
  installer card, App login) launches this package through a Chrome
  `intent://` URL whose target is `https://<console>/app-open?code=hoff_…`
  (`android/app/src/main/AndroidManifest.xml`, `autoVerify` against the
  console's `/.well-known/assetlinks.json`). `lib/auth/app_handoff.dart`
  re-validates the URL (allowlisted hosts only — the activity is exported),
  `main.dart` asks before continuing (the host is named), then
  `POST /auth/app-handoff/exchange` turns the 120 s single-use code into a
  `yyt_` token and `AuthState.addProfile` takes it from there. Needs Flutter ≥ 3.44 / Dart ≥ 3.12 (`app_links`). On-device
  checks: Chrome and Samsung Internet, cold and warm start, one task in
  Recents, the Installer fallback with the app uninstalled,
  `adb shell pm get-app-links life.yyt.console` once the fingerprint is in SSM.
- Apps: one request, `GET /catalog/apps?artifacts=summary&platform=android`
  (2026-09-27): every app of every team the caller is seated in, each with
  its newest Android artifact and `applicationIds`, plus `teams` — the
  caller's seat per team, which the detail screen's issues button needs.
  It used to be `GET /teams` and then one request per team in parallel, and
  on Lambda every concurrent request needs a container of its own: a 4-team
  launch waited on two waves of cold containers (7.4 s on dev). One request
  also means one failure answers for all teams — a 5xx shows the retry card
  instead of a partial list. Against an older console that ignores the
  query (no `teams`) the app lists per team, as builds up to 1.5.3 do. Requests time
  out after 20 s. The detail screen still lists artifacts by app id.
  Permission is team membership only, so the app has no permission screen.
- Times: the API sends UTC unix seconds; every screen formats them in the
  device time zone through `lib/format_time.dart`.
- The app detail hero has a `team › project 이슈` button that opens the
  app's project on its issues tab (team/project come from the app view's
  breadcrumb fields; the button is hidden when they are absent).
- Apps tab layout: a grid of small cards (name, description, version, state,
  install button) — 2 columns, 4 on near-square screens at least 600dp wide
  (`appGridColumns`). The detail hero is titled `description (name)`.
- Install verification (`lib/download_install_launch.dart`): after the system
  installer hands control back (`resumed` following a `paused`/`inactive`),
  the package may change for `returnGrace` (30 s) more; then the attempt ends
  as "not completed" instead of staying in progress when the user cancelled,
  missed the prompt, denied the unknown-sources permission or the installer
  failed. Waiting for the installer to return at all is capped at 10 min.
- Projects tab: one accordion per team. Inside: the team discussions (`GET|POST
  /teams/{id}/discussions`, `GET …/{did}` with comments, `POST …/{did}/comments`;
  latest 3 inline, the rest behind "전체 보기"), the team's 5 most recently
  touched issues across every project (`GET /teams/{id}/issues?limit=5`;
  `updatedAt` moves on edit, status change and new comment; "더보기" opens the
  full team list with an open/closed filter), then the plain project list.
  The first team (by name) starts open, the rest closed; toggles are kept in
  secure storage (`projects_expanded_teams`) and restored on the next launch.
- Project screen (`lib/projects/project_screen.dart`): tabs 이슈 / 사이트 /
  채널, opened from a project row (or the app detail's issues button) on the
  issues tab. The screen owns one `ProjectsApi` — server and token captured
  together when it opens — and hands it to every tab and every screen pushed
  from them. Tabs are kept alive (each loads once; pull to refresh), each has
  its own create button, and a banner says when the caller is read-only.
- Permissions: writes need a seat (`owner`/`member`, `Team.canWrite`). An
  unseated platform admin (team role `admin`) reads everything and may also
  extend or delete a channel, as the server allows
  (`Team.canManageChannelLifecycle`); nothing else.
- Issues: `GET /teams/{id}/projects`, `GET|POST /projects/{id}/issues`,
  `GET /projects/{id}/issues/{n}` (with comments), `POST …/{n}/close|reopen`,
  `POST …/{n}/comments`.
- Sites: `GET|POST /projects/{id}/sites`, `GET|PATCH|DELETE /sites/{id}`. A
  row shows the name, the primary link (`domain != null ? (hostUrl ??
  publicUrl) : publicUrl`, docs/decisions.md _Site domains_ §10) and a state
  (배포 중 / 이동 중 / 라이브 / 비어 있음). The create form shows the
  shared-origin warning (`siteSharedOriginWarning`, byte-identical to the
  console's); the detail shows the server's `warning` verbatim, both
  addresses with copy, the name, the current deploy and the last 20 deploys
  (a move deploy reads "이름 이동 → name"). While the site is `busy` it
  re-reads `GET /sites/{id}` every 3 s until it settles (a failed read keeps
  trying), stops on a 404 (the site is gone) and when the screen closes.
  Uploads stay in the web console and `yyt site deploy`; the app never
  uploads.
- Site names (docs/decisions.md _Site domains_): the edit form has a name
  field, sent as `domain` only when changed (blank = `null`, back to a random
  slug), trimmed and lower-cased, with the grammar checked locally as a hint
  (3–32, `[a-z0-9-]`, no leading/trailing or doubled `-`). With a name host
  (`hostSuffix`) the field shows `.{hostSuffix}`; without one it shows the
  path it will take (`g.yyt.life/<name>/`). `PATCH` 200 = saved, 202 = a move
  was queued (the detail then polls). While the site is busy the field is
  locked and `domain` never sent: a busy site's 409 comes after the team's
  one-per-second name slot is spent. The help says a `/{slug}/` build must be
  rebuilt after a rename (`./` works on both hosts, `/` only on the site's
  own). A 409 with `details.reason` `domain_taken`, `domain_cap` (listing
  the team's counted `details.names`) or `domain_cleaning` and a 400 on
  `domain` are shown under the field; a busy-site 409 and a 429 are a
  SnackBar. A server
  without these fields (`domain`, `hostUrl`, `hostSuffix`, `movingTo`, a
  deploy's `moveTo`) reads them as null.
- Channels: `GET|POST /projects/{id}/channels` (`?kind=auth` for the auth
  channel picker), `GET|PATCH|DELETE /channels/{id}`,
  `POST /channels/{id}/extend`. The form (`channel_config_form.dart`, pure
  Dart) is a port of the SPA's `channelForm.ts`: same fields, defaults and
  checks, and the config is always rebuilt from the form because the server
  schemas are strict. An edit sends `name` only when it changed and `config`
  only when a config field changed; an auth provider left on with a blank
  client secret sends `{clientId}` so the stored secret is kept, a provider
  switched off sends `null`. A non-auth kind cannot be created until the
  project has an auth channel. Rotate-secret, the q Redis account and the auth
  doc key stay in the web console.
- One-time credentials: a create that returns one (auth `secret`, topic/match
  `apiKey`; lobby/q have none and open the detail directly) shows it on
  `SecretOnceScreen`. It awaits `FLAG_SECURE` (MethodChannel
  `life.yyt.console/window` in `MainActivity.kt`) before the first frame that
  renders the value and clears it on dispose — the flag covers the whole
  single-activity app. The value is plain text; copy marks the clip sensitive
  and `MainActivity` clears it after 60 s if the primary clip still carries
  that copy's unique label (a timer on the main looper: from Android 10 a
  backgrounded app cannot read the clip's text, so a Dart timer comparing
  it never cleared anything; without the channel the Dart fallback does
  exactly that); leaving asks
  first and replaces the screen with the channel detail, so the value leaves
  the navigation stack. It is never stored or logged: `CreatedChannel` redacts
  its `toString`, and the diagnostics logger redacts 64-hex strings and the
  values of `secret`/`apiKey`/`clientSecret`.
- Listings (docs/decisions.md _Catalog listings_, 1.5.6): the detail screen
  of an app the caller's team owns (`home != null`, not `shared`) carries a
  **게시** panel (`lib/listing/`): `GET /catalog/apps/{id}/listing` (404 =
  not published), `PUT` (publish 201 / edit 200 — the body replaces title,
  summary, tags and audience whole), `DELETE` (unpublish; the viewers go with
  it), `GET|POST …/listing/viewers`, `DELETE …/viewers/{login}`. The form
  checks the server's grammar first (title 1–100 without control characters,
  summary ≤ 2000, tags `[a-z0-9-]{1,32}` × 10, typed as free text split on
  commas/spaces) and puts a 400 under its field; a takedown's 409
  `taken_down` and a 429 (one recorded write per member per 500 ms) are a
  SnackBar. Writes need `Team.canWrite`; a reader sees the panel without
  controls. A shared app (read through someone else's listing) has no panel.
- Errors: the console's `{error:{code,message,details}}` becomes an
  `ApiException` with `details`, `reason` (`details.reason`) and
  `fieldErrors` (a 400's `[{path,message}]`); the Korean message is chosen by
  reason, then code, then status.
- Pre-release builds (`life.yyt.catalog`, the legacy vendor id before it) are
  abandoned; install this package fresh. The launcher icon is
  `assets/icon.png` (`dart run flutter_launcher_icons`).

## Release ("배포")

1. Bump the patch version in `pubspec.yaml` (`version: x.y.z+build`, both
   numbers).
2. `flutter analyze && flutter test && flutter build apk --release`
   (`android/key.properties` must be present — the release keystore lives with
   the operator, outside the repo).
3. Upload with the repo-built CLI, to dev then prod:

   ```sh
   (cd ../../cli && go build -o yyt ./cmd/yyt)
   ../../cli/yyt --team platform --project console catalog artifact upload console \
     build/app/outputs/flutter-apk/app-release.apk --platform android \
     --version <pubspec version> --tag build_type=release \
     --tag application_id=life.yyt.console --tag title=잉여톤
   ../../cli/yyt --profile prod --team platform --project console catalog artifact upload console \
     build/app/outputs/flutter-apk/app-release.apk --platform android \
     --version <pubspec version> --tag build_type=release \
     --tag application_id=life.yyt.console --tag title=잉여톤
   ```

4. Confirm `GET /catalog/installer/downloads` lists the new version first on
   both stages; devices running the previous build show the update banner.

## Build

```sh
flutter pub get
flutter test
flutter build apk --release
```

Release signing reads `android/key.properties` (gitignored); the release
keystore and that file live outside the repo with the operator. Without it the
release build falls back to the debug key for local checks.

## Self-update

Once the first list load has ended (loaded or failed; at most 30 s after
launch) the signed-in app asks `GET /catalog/installer/downloads` for the
highest-versioned Android build whose `applicationId` is the running package
(a `.debug` build is never offered the release APK; rows without the id, from
an older console, are accepted) and, when that is newer than
`package_info_plus` reports (`lib/self_update_check.dart`, build suffix aware,
unparseable versions hidden), shows a banner above both tabs with an *업데이트*
button that runs the normal install flow (`lib/self_update_banner.dart`). Any
failure of the route (no installer configured, team not admin-locked, pending
seat, offline) just hides the banner; dismiss lasts until the next launch.
The check waits for the list so a launch sends one request at a time (a
concurrent one would need a second, cold, Lambda container), and it shares
the list's HTTP client, so it rides the same connection. The banner keeps
one widget tree whether it shows or not: swapping the tab body for a
`Column` rebuilt the app list, and with it the list load.

## Distribute

The installer is distributed through the catalog itself:

```sh
yyt --team platform --project console catalog artifact upload console \
  build/app/outputs/flutter-apk/app-release.apk \
  --platform android --version <pubspec version> \
  --tag build_type=release --tag application_id=life.yyt.console --tag title=잉여톤
```
