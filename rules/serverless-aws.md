# Serverless / AWS

- WebSocket APIs: REQUEST authorizer on `$connect` only, identity source `route.request.header.Sec-WebSocket-Protocol`, cache TTL 0. `$connect` must echo the chosen subprotocol (`Sec-WebSocket-Protocol: bearer`) or browsers drop the connection.
- A WebSocket connection cannot be posted to from inside its own `$connect` handler (410 until the handshake completes). Work that must reach the new socket is handed to a second function via `lambda:InvokeFunction` `InvocationType: Event` (match `worker`), which polls `GetConnection` (≤3s) before posting. Periodic work goes to EventBridge schedules (`rate(1 minute)` for match timeouts, daily for expiry/backup).
- Do not `DeleteConnection` right after `PostToConnection`: on dev the close overtook the buffered frame and clients never saw `matched`. Send the terminal message and let the client close (10-minute idle timeout cleans up). The same race hit tslib's game-end path (`result` lost in 1 of 2 runs) → `runGameAllTogether.endDropDelayMillis` (default 1 s) before dropping.
- API Gateway cannot map an HTTP API and a WebSocket API onto the same custom domain. A stack that needs both (topic) uses two hostnames (`topic.yyt.life` + `topic-ws.yyt.life`) via `customDomain: {http: {...}, websocket: {...}}` in serverless-domain-manager; the HTTP response carries the `wsUrl` so clients never hard-code the WS host.
- A 410 on `PostToConnection` is ambiguous: API Gateway also answers 410 for a socket whose `$connect` has not returned yet. When a broadcast can race a concurrent `$connect` (topic), record the registration time and only prune sockets older than a grace period (`PENDING_GRACE_SEC` = 10s); `$disconnect` cleans up the rest.
- The custom WebSocket domain answers `400 Bad Request` (`server: awselb/2.0`) for a minute or two after the first deploy while the mapping propagates; retry before debugging.
- Bound every loop by the Lambda deadline: handlers pass `context.getRemainingTimeInMillis()` down and the matcher stops starting new dispatches when less than one dispatch's worth of time remains, logging `deadline reached`/`tick incomplete`. Lock TTLs must exceed the longest holder path. Async-invoked functions set `maximumRetryAttempts: 0` unless a retry is genuinely idempotent.
- Alarm on Lambda `Throttles` for every function with a small `reservedConcurrency` (topic `ws`/`http`): throttled invocations are not `Errors`, and a WebSocket `$default` has no route response, so clients lose messages silently. Also alarm on `Errors` of the authorizer function itself — a cold-start throw (bad env) never reaches the "authorize error" log metric.
- The authorizer must never throw (API Gateway turns that into 500s); since every failure becomes a Deny, alarm on a log metric filter (`"m":"authorize error"`) instead of Lambda Errors.
- `postToConnection` 410 `GoneException` → remove the connection from Redis and continue; never let one dead socket fail a broadcast.
- Lobby-started actors: persist the `GameActorStartEvent` (with the game-lifetime TTL) in the callback handler **before** the async `InvokeCommand`, otherwise a fast client's `$connect` finds no start event and gets 400. `handleActor` re-saves it harmlessly.
- Dev-only HTTP routes on a WebSocket stack: give the function `events: ${self:custom.debugEvents.${param:debugHooks, "0"}}` with `"1": [{httpApi: "*"}]` / `"0": []`, so prod has no HTTP API at all. The HttpApi URL is a stack output (`HttpApiUrl`).
- Message cap 16KB; API Gateway WebSocket frame limit is 128KB, keep well under it.
- Cost guards: CloudWatch alarms on WebSocket message count and Lambda errors; (Redis/MariaDB limits are the host's problem — see `yyt-stateful`.) Traffic is near-zero except contest day, so prefer pay-per-use everything and no provisioned concurrency.
- No native modules: `mysql2` and `ioredis` are pure JS and bundle into the function, so no layers are needed. If a native dependency ever returns, it needs an arm64 prebuilt layer + esbuild `exclude` (the old `layers/better-sqlite3` recipe is in git history, commit `d7c34c0` and earlier).
- Keep cold starts small: one bundle per function, no AWS SDK v2, import only the SDK v3 clients needed.
- serverless-esbuild: `exclude: ["@aws-sdk/*"]`, `format: esm` + `outputFileExtension: .mjs` + a `createRequire` banner (mysql2/ioredis are CJS and need it). Sanity-check a bundle locally with plain esbuild (same externals) and `import()` it — it should fail only on missing env, not on module resolution.
- Debug hooks: gate on `STAGE=dev && DEBUG_HOOKS=1` at route registration, and if their config is bad _disable them and log_ instead of throwing from the module initializer — otherwise the real endpoints 500 too.
- Stage-scoped IAM: express per-stage action lists as `custom.<x>.{dev,prod}` maps and reference `${self:custom.x.${self:custom.stage}}`.
- Per-service secrets: `custom.ssm: /yyt-service/${stage}/<service>` and `${ssm:${self:custom.ssm}/mysql-host}` etc. Required keys have no default (deploy fails loudly); dev-only keys use `${ssm:..., ""}` so prod resolves to empty and the code disables the feature.
- Lambda reaches the stateful host over plain TCP from public Lambda IPs (no VPC). Source-IP restriction / TLS is tracked in `todo/07-infra.md`.

## S3 / presigned URLs

- CloudFormation "early validation" (`AWS::EarlyValidation::PropertyValidation`) reports only "Validation failed with N error(s)" through the CLI; bisect with `create-change-set` on the compiled template (`.serverless/cloudformation-template-update-stack.json`). Known trigger: duplicate entries in a bucket's `CorsRules.AllowedOrigins` (e.g. `${param:webUrl}` defaulting to the same host already listed).
- Inside `serverless.yml` use `${aws:accountId}`/`${aws:region}` rather than `!Sub "${AWS::AccountId}"` (the Framework's variable resolver rejects the latter), and `!Join`/`!GetAtt` instead of `!Sub "${Resource.Arn}"`.
- `getSignedUrl` (SDK v3) signs only `host` by default: pass `signableHeaders: new Set(["content-type", "content-length"])` so a presigned PUT actually pins type and size. Still re-check the object (`HeadObject`) in a commit step before binding it to a row — the client controls what it uploads.
- Buckets holding durable data get `DeletionPolicy`/`UpdateReplacePolicy: Retain`; keep account ids out of bucket names (they end up in every presigned URL).
- A Lambda role that signs URLs for an SSE-KMS bucket needs `kms:GenerateDataKey`/`kms:Decrypt` (scoped with `kms:ViaService: s3.<region>.amazonaws.com`); the browser acts as the signer, so it inherits exactly these permissions.

## Catalog uploads / sweeps (2026-08-24)

- Synchronous `CopyObject` in a request Lambda bounds the artifact size: 1GB cap with a 25s function timeout (API GW allows ~29s). Bigger files need an async commit design, not a bigger cap.
- Any outbound HTTP call inside a request handler needs a timeout that fits the _remaining_ Lambda budget (Slack notify: 3s inside the commit route); a webhook timeout equal to the function timeout turns a committed mutation into a client-visible 5xx.
- `ListObjectsV2` must be paginated even in "small" sweeps: an unpaginated call re-lists the same lexicographic first page forever once a backlog passes 1000 keys. Bound the pages (e.g. 10) and let later runs take the rest.
- Commit flows with deterministic ids: on an insert conflict, check whether the same logical operation already succeeded and heal (mark complete, return the row) instead of rolling back S3 objects the winner now references.
- Interactive cleanup deletes the DB row even when the S3 delete fails (user asked; retry is idempotent); the daily sweep does the opposite (keep the row, retry the object tomorrow).

## Retiring a stack (2026-08-24)

- `sls remove` re-resolves the whole config, so any `${aws:ssm:...}` variable whose parameter was already deleted makes removal impossible. Retire in this order: stack first, shared SSM/secrets last. If the config is already unresolvable, bypass the Framework: `aws cloudformation delete-stack` (a serverless stack normally owns no bucket/domain, so this is equivalent).
- An API Gateway custom domain with a base-path mapping blocks stage deletion (`DELETE_FAILED` on the stage): delete the custom domain (which drops the mapping) before deleting the stack. Then clean Route53 alias + ACM validation CNAME, and finally the now-unused regional ACM certificate.
- Re-running `delete-stack` on a `DELETE_FAILED` stack resumes from the failed resource.
