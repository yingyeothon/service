# yyt catalog installer (`life.yyt.catalog`)

Android app that lists catalog apps and installs their APKs directly from the
public CDN. Ported from the legacy catalog installer (docs/decisions.md
"Binary catalog"); it talks only to the console API.

- Sign in: GitHub device flow (`/auth/device/*`) or an API-key QR
  (`{"type":"yyt_api_key","apiKey":"yyt_…","server":"https://console.yyt.life"}`);
  tokens are probed with `GET /me`.
- Apps: `GET /catalog/apps` (flattened over every team the user is seated in;
  a compatibility route kept for one release), artifacts by app id
  (`/catalog/apps/{id}/artifacts`). Permission is team membership only, so
  the app has no permission screen.
- Server URL: enter the console host (e.g. `console.yyt.life`).
- The legacy `me.hoppipolla.catalog` build is abandoned; users install this
  package fresh (different applicationId + signing key).

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
