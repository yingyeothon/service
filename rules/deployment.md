# Deployment

## Decision flow
1. Decide whether the change needs only a `dev` redeploy (default for every task) or a `prod` release.
2. `prod` is deployed only when the user asks; confirm which stacks are affected before running.
3. CLI releases: tag `cli/vX.Y.Z` → GitHub Actions + goreleaser build the GitHub Release. Decide patch vs minor bump with the user when not obvious.
4. After deploying, run the smoke commands from the area's todo doc and verify the uploaded artifact/endpoint.

## Conventions
- Region `ap-northeast-2`, `AWS_PROFILE=yyt`, stages `dev`/`prod`, domains `{auth,console,topic,match}.yyt.life` (dev: `-dev` suffix) via `serverless-domain-manager`.
- Secrets come from SSM `/yyt-service/{stage}/*`; local `.envrc` is stored in SSM via `scripts/put-envrc.sh`. Never commit `.env*`.
- Lambda: `nodejs22.x`, arm64, `serverless-esbuild` with `better-sqlite3` external + layer, `serverless-prune-plugin` keep 5, log retention 14 days.
- Infra changes (ACM, Route53, CloudFront, buckets) are listed in `todo/07-infra.md`; record what was created manually there.
