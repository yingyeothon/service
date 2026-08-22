# Manual Verification

- After tests pass, deploy the touched stack to `dev` (`scripts/deploy.sh <service> dev`) and exercise the real path: curl for httpApi, `wscat -c <wss> -s bearer -s <jwt>` for WebSocket, `scripts/smoke/callback-echo.mjs` as a matchmaker callback sink.
- `serverless-offline` is not used (poor WebSocket fidelity); `dev` on AWS is the controllable target. Cost is negligible at this traffic.
- Debug-only hooks (active only when `STAGE=dev` and `DEBUG_HOOKS=1`): seed a channel with a known secret, mint a test JWT (`POST /debug/token`), force-expire a topic, trigger `tryMatch`/`expire` on demand. They must be absent from `prod` deployments (guard at handler registration, not just at runtime).
- Record the exact commands used in the task's todo doc so the next session can repeat them.
