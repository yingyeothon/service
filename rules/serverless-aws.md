# Serverless / AWS

- WebSocket APIs: REQUEST authorizer on `$connect` only, identity source `route.request.header.Sec-WebSocket-Protocol`, cache TTL 0. `$connect` must echo the chosen subprotocol (`Sec-WebSocket-Protocol: bearer`) or browsers drop the connection.
- Lambda cannot fire-and-forget; awaiting `tryMatch` inside `$connect` is fine (10s timeout). Long/periodic work goes to EventBridge schedules (`rate(1 minute)` for match timeouts, daily for expiry/backup).
- `postToConnection` 410 `GoneException` → remove the connection from Redis and continue; never let one dead socket fail a broadcast.
- Message cap 16KB; API Gateway WebSocket frame limit is 128KB, keep well under it.
- Cost guards: CloudWatch alarms on WebSocket message count and Lambda errors; (Redis/MariaDB limits are the host's problem — see `yyt-stateful`.) Traffic is near-zero except contest day, so prefer pay-per-use everything and no provisioned concurrency.
- No native modules: `mysql2` and `ioredis` are pure JS and bundle into the function, so no layers are needed. If a native dependency ever returns, it needs an arm64 prebuilt layer + esbuild `exclude` (the old `layers/better-sqlite3` recipe is in git history, commit `d7c34c0` and earlier).
- Keep cold starts small: one bundle per function, no AWS SDK v2, import only the SDK v3 clients needed.
- serverless-esbuild: `exclude: ["@aws-sdk/*"]`, `format: esm` + `outputFileExtension: .mjs` + a `createRequire` banner (mysql2/ioredis are CJS and need it). Sanity-check a bundle locally with plain esbuild (same externals) and `import()` it — it should fail only on missing env, not on module resolution.
- Debug hooks: gate on `STAGE=dev && DEBUG_HOOKS=1` at route registration, and if their config is bad _disable them and log_ instead of throwing from the module initializer — otherwise the real endpoints 500 too.
- Stage-scoped IAM: express per-stage action lists as `custom.<x>.{dev,prod}` maps and reference `${self:custom.x.${self:custom.stage}}`.
- Per-service secrets: `custom.ssm: /yyt-service/${stage}/<service>` and `${ssm:${self:custom.ssm}/mysql-host}` etc. Required keys have no default (deploy fails loudly); dev-only keys use `${ssm:..., ""}` so prod resolves to empty and the code disables the feature.
- Lambda reaches the stateful host over plain TCP from public Lambda IPs (no VPC). Source-IP restriction / TLS is tracked in `todo/07-infra.md`.
