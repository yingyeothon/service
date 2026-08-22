# Deployment

## Decision flow

1. Decide whether the change needs only a `dev` redeploy (default for every task) or a `prod` release.
2. `prod` is deployed only when the user asks; confirm which stacks are affected before running.
3. CLI releases: tag `cli/vX.Y.Z` → GitHub Actions + goreleaser build the GitHub Release. Decide patch vs minor bump with the user when not obvious.
4. After deploying, run the smoke commands from the area's todo doc and verify the uploaded artifact/endpoint.

## Conventions

- Region `ap-northeast-2`, `AWS_PROFILE=yyt`, stages `dev`/`prod`, domains `{auth,console,topic,match}.yyt.life` (dev: `-dev` suffix) via `serverless-domain-manager`.
- Secrets come from SSM `/yyt-service/{stage}/*` (per-service MySQL/Redis values uploaded from `local/env/*.env` by `scripts/bootstrap-ssm.sh` — see `todo/09-storage-migration.md`). `scripts/get-env.sh <stage>` rebuilds `local/env/` from SSM on a new machine. Rotation order: update `local/env` via `yyt-stateful` → `bootstrap-ssm.sh <stage>` → redeploy every stack of that stage (SSM values are baked into Lambda env at deploy time) → revoke the old credentials. `bootstrap-ssm.sh dev` keeps the existing `debug-key` unless `DEBUG_KEY` is exported. Never commit `.env*` or anything under `local/`.
- Lambda: `nodejs22.x`, arm64, `serverless-esbuild` (no layers), built-in prune keep 5, log retention 14 days.
- Infra changes (ACM, Route53, CloudFront, buckets) are listed in `todo/07-infra.md`; record what was created manually there.
