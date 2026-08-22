# Manual Verification

- After tests pass, deploy the touched stack to `dev` (`scripts/deploy.sh <service> dev`) and exercise the real path: curl for httpApi, `wscat -c <wss> -s bearer -s <jwt>` for WebSocket, `scripts/smoke/callback-echo.mjs` as a matchmaker callback sink.
- `serverless-offline` is not used (poor WebSocket fidelity); `dev` on AWS is the controllable target. Cost is negligible at this traffic.
- Debug-only hooks (active only when `STAGE=dev` and `DEBUG_HOOKS=1`): seed a channel with a known secret, mint a test JWT (`POST /debug/token`), force-expire a topic, trigger `tryMatch`/`expire` on demand. They must be absent from `prod` deployments (guard at handler registration, not just at runtime).
- Record the exact commands used in the task's todo doc so the next session can repeat them.
- Stage prerequisites (per stage, once): MySQL/Redis accounts from `yyt-stateful` in `local/env/*.{stage}.env`, then `scripts/bootstrap-ssm.sh <stage>` (SSM `/yyt-service/{stage}/{service}/*`, `debug-key` on dev, `auth/debug-mysql-*` on dev). `serverless.yml` fails loudly on missing params by design. The S3 bucket `yyt-service-{stage}` remains for posters/backups (07).
- Opt-in integration tests hit the real dev instances: `YYT_IT=1 pnpm test` (skipped when `local/env/*.dev.env` is absent). Run them before deploying a storage change.
- auth smoke: `scripts/deploy.sh auth dev --param debugHooks=1` then `scripts/smoke/auth.mjs https://auth-dev.yyt.life "$(cat local/deploy/debug-key.dev)"`.
