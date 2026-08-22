# services/auth — `auth.yyt.life`

Per-channel OAuth (GitHub/Google) login issuing HS256 channel JWTs. Contract: `docs/decisions.md` §auth; game-side verification: `docs/auth-game-contract.md`.

## Endpoints

| Route                                                 | Description                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /c/{ch}/.well-known/config`                      | Public config (`issuer`, `audience`, `providers`, `callbackUrls`, `startUrl`, `tokenTtlSec`) |
| `GET /c/{ch}/start?provider=github\|google&redirect=` | Issues `state`, 302 to the provider. `redirect` must match the channel allowlist             |
| `GET /c/{ch}/{provider}/callback?code&state`          | Exchanges the code → JWT → `302 {redirect}#token=&userId=&exp=`                              |
| `POST /c/{ch}/token {provider, accessToken\|idToken}` | Manual issue → `{jwt, userId, exp}`                                                          |
| `GET /c/{ch}/verify` (Bearer)                         | `{userId, exp, channelId}` or 401                                                            |

Unknown channel → 404; expired/disabled → 410. Browser routes (`/start`, `/callback`) render minimal HTML on error.

- `/start` sets a `__Host-yyt_auth_nonce` cookie (10 min) and stores its hash in `state`; `/callback` requires the same browser's cookie (login-CSRF protection). `state` is single-use.
- `redirect` allowlist: exact origin + path-prefix at a `/` boundary; entries must be absolute URLs.
- GitHub tokens are checked with `POST /applications/{clientId}/token` so only tokens issued to this channel's OAuth app are accepted; Google id_tokens are pinned via `aud = clientId`.

## Data

- Channels: read from the console MySQL database with auth's **SELECT-only** account through `@yyt/console-db` (one SELECT per request). No Redis cache — rows contain secrets.
- Redis (`auth:{stage}:`, one `@yyt/redis` connection per container): `state:{state}` TTL 600 s, `issued:{channelId}:{yyyymmdd}` counters (40 days).

## Environment (`serverless.yml`)

`STAGE`, `PUBLIC_BASE_URL`, `MYSQL_*`/`REDIS_*` (SSM `/yyt-service/{stage}/auth/*`, uploaded by `scripts/bootstrap-ssm.sh` from `local/env/auth.{stage}.env`), `DEBUG_HOOKS` (`--param debugHooks=1`, dev only), `DEBUG_KEY` (SSM `debug-key`), `DEBUG_MYSQL_*` (console's dev writer account, SSM `auth/debug-mysql-user|password`, injected only with `debugHooks=1`; hooks are disabled when absent). See `docs/secrets.md`.

## Debug hooks (registered only on dev with `DEBUG_HOOKS=1`)

- `POST /debug/channels` (`x-debug-key`) `{id?, audience?, tokenTtlSec?, redirectAllowlist?, providers?}` → `{channelId, secret, …}` — seeds a channel in the console DB.
- `POST /debug/token` (`x-debug-key`) `{channelId, userId}` → `{jwt, userId, exp}`.

## Deploy / verify

```bash
scripts/bootstrap-ssm.sh dev   # local/env/*.dev.env → SSM (once; rerun after rotation)
scripts/deploy.sh auth dev --param debugHooks=1
scripts/smoke/auth.mjs https://auth-dev.yyt.life "$(cat local/deploy/debug-key.dev)"
```
