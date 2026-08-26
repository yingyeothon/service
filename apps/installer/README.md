# 잉여톤 — yyt console companion app (`life.yyt.catalog`)

Android app with two tabs: **앱** lists catalog apps and installs their APKs
directly from the public CDN (the original installer role), **프로젝트** lists
the member's teams and projects and lets them read, file, comment on, close
and reopen project issues — the console's issue tracker on a phone. It talks
only to the console API.

- Sign in: GitHub device flow (`/auth/device/*`) or an API-key QR
  (`{"type":"yyt_api_key","apiKey":"yyt_…","server":"https://console.yyt.life"}`);
  tokens are probed with `GET /me`.
- Apps: `GET /teams` then `GET /teams/{id}/catalog/apps` for every seated
  team (pending seats are skipped), deduplicated by app id; artifacts by app
  id (`/catalog/apps/{id}/artifacts`). Permission is team membership only, so
  the app has no permission screen. The flattened `GET /catalog/apps` is no
  longer used (todo/17 P10 may drop it).
- Projects: `GET /teams/{id}/projects`, `GET|POST /projects/{id}/issues`,
  `GET /projects/{id}/issues/{n}` (with comments), `POST …/{n}/close|reopen`,
  `POST …/{n}/comments`. Writes need a seat (`owner`/`member`); an unseated
  platform admin reads only.
- Server URL: enter the console host (e.g. `console.yyt.life`).
- The legacy build under the old vendor package name is abandoned; users
  install this package fresh (different applicationId + signing key). The
  launcher icon is `assets/icon.png` (`dart run flutter_launcher_icons`).

## Build

```sh
flutter pub get
flutter test
flutter build apk --release
```

Release signing reads `android/key.properties` (gitignored). Copy it from the
private secrets folder (`installer-key.properties`, see `todo/12-catalog.md`
§H); without it the release build falls back to the debug key for local checks.

## Distribute

The installer is distributed through the catalog itself:

```sh
yyt --team platform --project installer catalog artifact upload installer \
  build/app/outputs/flutter-apk/app-release.apk \
  --platform android --version <pubspec version> \
  --tag build_type=release --tag application_id=life.yyt.catalog
```
