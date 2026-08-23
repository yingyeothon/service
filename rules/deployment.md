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
- Console stack needs stage-wide SSM keys `github-client-id`, `github-client-secret`, `admin-github-logins` (`GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… ADMIN_GITHUB_LOGINS=… scripts/bootstrap-ssm.sh <stage>`); `bootstrap-ssm.sh prod` refuses an empty admin list. `--param webUrl=` points post-login redirects at the SPA host once CloudFront exists. Scheduled functions use a fixed `cron(...)` (console `expire`: 18:00 UTC) and get their own Errors alarm.

- The console stack owns the poster bucket `yyt-console-posters-{stage}` (`DeletionPolicy: Retain`): `sls remove` leaves it behind, and a re-created stack adopts it only if the name is unchanged (delete or rename the bucket first otherwise). Uncommitted presigned uploads (`posters/{eventId}/…` never bound by `commit`) are not swept yet; empty them by hand if they matter.
