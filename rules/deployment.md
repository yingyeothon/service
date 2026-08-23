# Deployment

## Decision flow

1. Decide whether the change needs only a `dev` redeploy (default for every task) or a `prod` release.
2. `prod` is deployed only when the user asks; confirm which stacks are affected before running.
3. CLI releases: tag `cli/vX.Y.Z` → GitHub Actions + goreleaser build the GitHub Release. Decide patch vs minor bump with the user when not obvious.
4. After deploying, run the smoke commands from the area's todo doc and verify the uploaded artifact/endpoint.

## Conventions

- Region `ap-northeast-2`, `AWS_PROFILE=yyt`, stages `dev`/`prod`, domains `{auth,console,topic,match}.yyt.life` plus `topic-ws.yyt.life` (dev: `-dev` suffix) via `serverless-domain-manager`.
- Secrets come from SSM `/yyt-service/{stage}/*` (per-service MySQL/Redis values uploaded from `local/env/*.env` by `scripts/bootstrap-ssm.sh` — see `todo/09-storage-migration.md`). `scripts/get-env.sh <stage>` rebuilds `local/env/` from SSM on a new machine. Rotation order: update `local/env` via `yyt-stateful` → `bootstrap-ssm.sh <stage>` → redeploy every stack of that stage (SSM values are baked into Lambda env at deploy time) → revoke the old credentials. `bootstrap-ssm.sh dev` keeps the existing `debug-key` unless `DEBUG_KEY` is exported. Never commit `.env*` or anything under `local/`.
- Lambda: `nodejs22.x`, arm64, `serverless-esbuild` (no layers), built-in prune keep 5, log retention 14 days.
- Infra changes (ACM, Route53, CloudFront, buckets) are listed in `todo/07-infra.md`; record what was created manually there.
- Console stack needs stage-wide SSM keys `github-client-id`, `github-client-secret`, `admin-github-logins`, `cloudfront-cert-arn` (us-east-1 ACM cert for `*.yyt.life`, looked up by `bootstrap-ssm.sh`) (`scripts/bootstrap-ssm.sh <stage>` reads them from `local/env/console.<stage>.env`; shell env vars override); `bootstrap-ssm.sh prod` refuses an empty admin list. `--param webUrl=` points post-login redirects at the SPA host once CloudFront exists. Scheduled functions use a fixed `cron(...)` (console `expire`: 18:00 UTC) and get their own Errors alarm.

- The console stack owns the poster bucket `yyt-console-posters-{stage}` (`DeletionPolicy: Retain`): `sls remove` leaves it behind, and a re-created stack adopts it only if the name is unchanged (delete or rename the bucket first otherwise). Uncommitted presigned uploads (`posters/{eventId}/…` never bound by `commit`) are not swept yet; empty them by hand if they matter.

## Console domain = CloudFront

- `console{-dev}.yyt.life` is **not** an API Gateway custom domain: the console stack owns a CloudFront distribution (`/ui`, `/ui/*` → S3 `yyt-console-web-{stage}` with OAC + a viewer-request Function that rewrites extension-less paths to `/ui/index.html`; default `*` → the HTTP API's execute-api endpoint with `CachingDisabled` + `AllViewerExceptHostHeader`) plus Route53 A/AAAA alias records. The us-east-1 cert ARN comes from SSM `cloudfront-cert-arn`.
- Order for a stage: `scripts/deploy.sh console <stage>` (CloudFront creation/updates take 5–15 minutes) → `scripts/deploy-web.sh <stage>` (builds the SPA, syncs `dist/assets` as `immutable`, `index.html` as `no-cache`, invalidates `/ui*`). The SPA is not part of `sls deploy`; redeploy it whenever `apps/console-web` changes.
- Migrating a stage that still has the old API Gateway custom domain: delete the API GW domain name and its Route53 A (and any AAAA) record **before** deploying, otherwise the `WebDnsA` RecordSet fails with "already exists". `serverless delete_domain` needs the plugin, which console no longer installs — run it from a checkout of the previous commit, or use `aws apigatewayv2 delete-domain-name` + `aws route53 change-resource-record-sets`. The host is unreachable until the CloudFront create finishes (5–15 minutes); for prod, deploy once without the two RecordSets, then swap DNS, to shrink the gap to the DNS TTL.
- `WebBucket` is rebuildable and has no Retain policy, but CloudFormation refuses to delete a non-empty bucket: empty `yyt-console-web-<stage>` before `sls remove`.
- The execute-api default endpoint stays enabled (it is the CloudFront origin). It carries no `__Host-` cookie for that host, so direct hits are unauthenticated API calls, same as any other origin.

## Alarms

- Every stack's CloudWatch alarms take `AlarmActions` from the optional stage-wide SSM `alarm-topic-arn` (CloudFormation condition `HasAlarmTopic`); without it the alarms exist but notify nobody. `scripts/bootstrap-alarms.sh <stage> <email>` creates `yyt-service-<stage>-alarms`, subscribes the address (confirm the email) and stores the ARN; then redeploy all four stacks of that stage.
