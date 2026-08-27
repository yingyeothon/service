# 잉여톤 — yyt console companion app (`life.yyt.console`)

Android app with two tabs: **앱** lists catalog apps and installs their APKs
directly from the public CDN (the original installer role), **프로젝트** lists
the member's teams and projects and lets them read, file, comment on, close
and reopen project issues — the console's issue tracker on a phone. It talks
only to the console API.

- Sign in: **QR only**. The console SPA's _App login_ page mints an API token
  and renders `{"type":"yyt_api_key","apiKey":"yyt_…","server":"<origin>"}`;
  the app scans it, probes the key with `GET /me` (pending members are
  refused) and saves it as a **profile** (server + key + login) in secure
  storage. Several profiles (dev/prod, several accounts) can coexist; the
  app-bar avatar switches, adds (scan another QR) or removes them. The app
  ships no server address at all — the QR carries it. A 401 drops the
  active profile (the token was revoked).
- Apps: `GET /teams` then
  `GET /teams/{id}/catalog/apps?artifacts=summary&platform=android` for every
  seated team (pending seats are skipped), deduplicated by app id. The summary
  embeds each app's newest Android artifact and its `applicationIds`, so the
  list needs one request per team, not one per app (the per-app
  `/catalog/apps/{id}/artifacts` walk made the first load take seconds); the
  detail screen still lists artifacts by app id. Permission is team membership
  only, so the app has no permission screen. The flattened `GET /catalog/apps`
  is no longer used (todo/17 P10 may drop it).
- Times: the API sends UTC unix seconds; every screen formats them in the
  device time zone through `lib/format_time.dart`.
- The app detail hero has a `team › project 이슈` button that opens the
  app's project issues directly (team/project come from the app view's
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
- Projects: `GET /teams/{id}/projects`, `GET|POST /projects/{id}/issues`,
  `GET /projects/{id}/issues/{n}` (with comments), `POST …/{n}/close|reopen`,
  `POST …/{n}/comments`. Writes need a seat (`owner`/`member`); an unseated
  platform admin reads only.
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

At launch the signed-in app asks `GET /catalog/installer/downloads` for the
highest-versioned Android build whose `applicationId` is the running package
(a `.debug` build is never offered the release APK; rows without the id, from
an older console, are accepted) and, when that is newer than
`package_info_plus` reports (`lib/self_update_check.dart`, build suffix aware,
unparseable versions hidden), shows a banner above both tabs with an *업데이트*
button that runs the normal install flow (`lib/self_update_banner.dart`). Any
failure of the route (no installer configured, team not admin-locked, pending
seat, offline) just hides the banner; dismiss lasts until the next launch.

## Distribute

The installer is distributed through the catalog itself:

```sh
yyt --team platform --project console catalog artifact upload console \
  build/app/outputs/flutter-apk/app-release.apk \
  --platform android --version <pubspec version> \
  --tag build_type=release --tag application_id=life.yyt.console --tag title=잉여톤
```
