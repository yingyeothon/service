# Serverless / AWS

- WebSocket APIs: REQUEST authorizer on `$connect` only, identity source `route.request.header.Sec-WebSocket-Protocol`, cache TTL 0. `$connect` must echo the chosen subprotocol (`Sec-WebSocket-Protocol: bearer`) or browsers drop the connection.
- Lambda cannot fire-and-forget; awaiting `tryMatch` inside `$connect` is fine (10s timeout). Long/periodic work goes to EventBridge schedules (`rate(1 minute)` for match timeouts, daily for expiry/backup).
- `postToConnection` 410 `GoneException` → remove the connection from Redis and continue; never let one dead socket fail a broadcast.
- Message cap 16KB; API Gateway WebSocket frame limit is 128KB, keep well under it.
- Cost guards: CloudWatch alarms on WebSocket message count and Lambda errors; Upstash daily command alarm. Traffic is near-zero except contest day, so prefer pay-per-use everything and no provisioned concurrency.
- `better-sqlite3` must be an esbuild external and provided by the arm64 layer built in `layers/better-sqlite3`; rebuild the layer when Node runtime or the package version changes.
- Keep cold starts small: one bundle per function, no AWS SDK v2, import only the SDK v3 clients needed.
- `layers/better-sqlite3/build.sh` uses `prebuild-install` with `--arch arm64 --platform linux --target 22.12.0` (ABI 127) — no Docker, and this machine has no arm64 binfmt anyway. Check the downloaded tarball name contains `node-v127-linux-arm64`; a `node-v137` (Node 24) binary will fail to load on `nodejs22.x`.
