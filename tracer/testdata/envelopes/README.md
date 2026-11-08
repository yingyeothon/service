# Golden envelopes

Real envelopes as tracer received them, scrubbed, stored **decompressed**. `<name>.meta.json` keeps the sender's headers (`Content-Encoding`, `User-Agent`, `X-Sentry-Auth` with the fixture key) and the request path; tests gzip the body again when the meta says the sender did.

| Directory        | Sender                                                                                          | Captured                                       |
| ---------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `sentry-android` | `sentry.java.android.flutter/8.56.0` (sentry_flutter 9.30.1, UI isolate, `FileSystemTransport`) | 2026-11-08, Android 15 emulator (`todo/85` P2) |
| `sentry-dart`    | `sentry.dart/9.30.1` (`HttpTransport`, background isolate)                                      | 2026-11-08, same run                           |
| `yyt-dart`       | `yyt-dart/0.2.0` (flutterlib `yingyeothon_tracer_client`)                                       | 2026-11-08, generated, not captured            |

Every capture is from the throwaway app in `capture/main.dart` (chessrigado's debug options, synthetic data only), never from a real device or user.

`yyt-dart/report.envelope` is the one fixture of a yyt library (_Wire contract for client libraries_ in `docs/tracer.md`): the report envelope (event with breadcrumbs, tags, contexts and an exception with frames; the buffered log container with typed attributes; a 1×1 PNG screenshot; a view-hierarchy JSON) written by flutterlib's `packages/yingyeothon_tracer_client/test/golden_test.dart` with a fixed clock and fixed ids, byte-identical to `test/golden/report.envelope` there. That test pins its bytes and checks the fields tracer stores; here `internal/ingest` and `tracer dev seed` count its rows; the read goldens (`testdata/read/`, `internal/query`) seed only the captured `sentry-*` envelopes, so a client release never rewrites the read contract. When the library changes its output, regenerate it there (`UPDATE_GOLDEN=1`) and copy it here unchanged. It carries the fixture values below and no device data. Its `meta.json` is written by hand from the headers the library sends.

## Fixture values

- Resource `trc_fixture01`, write key `fixturewritekeyfixturewritekey00`, DSN `https://fixturewritekeyfixturewritekey00@trace.invalid/trc_fixture01` (envelope header `dsn` and `trace.public_key`).
- `user.id`, `contexts.device.id`, session `did`: zeros; `contexts.device.name`: `fixture-device`; `boot_time` and time zones fixed. `user.ip_address` removed from JSON items.
- Every original identifier the scrubber learns (from all dumps of the run) is also replaced byte-for-byte with a same-length value in **every** payload, binary ones included — `replay_video` is msgpack holding a `replay_event` with the device id.
- Item `length` values are recomputed after scrubbing.

## Adding a capture

1. `flutter create` a scratch app outside the repo, `flutter pub add sentry_flutter`, copy `capture/main.dart`, and add `android:usesCleartextTraffic="true"` to its `<application>` (Android 9+ refuses plain http otherwise; scratch app only).
2. Start a local tracer with a dump dir: `TRACER_DATA_DIR=$(mktemp -d) TRACER_LOCAL_CONFIG=<tracer.json with trc_capture01> TRACER_DUMP_DIR=<dir> tracer serve`.
3. Use your own emulator (`emulator -avd <avd> -port 5560 -no-window -read-only`), `adb -s emulator-5560 reverse tcp:8095 tcp:8095`, build with `--dart-define=DEBUG_SENTRY_DSN=http://<key>@127.0.0.1:8095/trc_capture01`, install, start, wait for `CAPTURE: done` in logcat.
4. `python3 -I capture/scrub.py <dump-dir>/<base> <sender>/<name>.envelope <every other dump base of the run>`, then `grep -a` the results for the **values** (not key names) of the capture key, the installation id, the boot time and your time zone, and for `127.0.0.1`, before committing; the commit hooks run gitleaks too.
