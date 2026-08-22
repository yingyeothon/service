# services/console — `console.yyt.life`

Operator console API: GitHub sign-in, member roles, API tokens, channel CRUD for the auth/topic/match stacks, and the daily expiry sweep. Contract: `docs/decisions.md` §"Console permission model". The console account is the only writer of the console database and runs `migrateConsoleDb` at cold start.

## Endpoints

Auth: httpOnly cookie `__Host-yyt_console_sess` (SPA) **or** `Authorization: Bearer yyt_…` (CLI). Bearer wins when both are present. Roles: `admin` > `member` > `pending`.

| Route                                                         | Min role | Description                                                                                                          |
| ------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /auth/github/start?next=/path`                           | –        | 302 to GitHub (operator-wide OAuth app). Sets `__Host-yyt_console_nonce` (10 min); `next` must be a relative path    |
| `GET /auth/github/callback?code&state`                        | –        | Upserts the member (`ADMIN_GITHUB_LOGINS` → `admin`, else `pending`), creates a 7-day session, 302 to `WEB_URL+next` |
| `GET /me`                                                     | pending  | `{id, login, role, via}`                                                                                             |
| `POST /logout`                                                | pending  | Destroys the session, clears the cookie                                                                              |
| `GET /members`                                                | admin    | All members (no GitHub ids)                                                                                          |
| `POST /members/{id}/approve\|promote\|demote`                 | admin    | pending→member / any→admin / admin→member. You cannot demote yourself                                                |
| `GET /tokens`, `POST /tokens {name}`, `DELETE /tokens/{id}`   | pending  | Create returns the plaintext **once** (201); stored as sha256. Max 20 live tokens per member                         |
| `GET /channels?kind=&scope=mine\|all`                         | member   | Own channels; `scope=all` is admin-only. Never returns secrets                                                       |
| `POST /channels {kind, name, config}`                         | member   | 201 with the channel view plus `secret` (auth) or `apiKey` (topic/match) — shown once                                |
| `GET /channels/{id}`, `PATCH /channels/{id} {name?, config?}` | member   | Owner or admin; others get 404                                                                                       |
| `POST /channels/{id}/extend`                                  | member   | +7 days from `max(expiresAt, now)`, capped at now+28 days; 410 when disabled, 409 at the cap                         |
| `POST /channels/{id}/rotate-secret`                           | member   | New `secret` / `apiKey`, returned once                                                                               |
| `DELETE /channels/{id}`                                       | member   | Soft delete; `secret_json` is wiped immediately                                                                      |

Channel `config` by kind (validated with zod; unknown keys rejected):

- `auth`: `{audience, tokenTtlSec=86400, redirectAllowlist[], providers:{github?:{clientId, clientSecret}, google?:{…}}}`. Allowlist entries must be absolute `https` URLs (`http` only for localhost), stored normalized. Stored as `config_json` (public part) + `secret_json` (`secret`, provider client secrets) in the shape `services/auth` reads. `PATCH` keeps a provider's stored `clientSecret` when omitted; `providers.github: null` removes it. Response adds `issuer`, `startUrl`, `callbackUrls`.
- `topic`: `{authChannelId}` → response adds `apiBase`, `wsUrl`.
- `match`: `{authChannelId, partySize 2–16, waitTimeoutSec=60, onTimeout="fail", callbackUrl}` → response adds `wsUrl`. PATCH replaces the whole config.

Every mutation writes `audit_log` (best effort: a failed audit insert is logged, not surfaced).

## Expiry (`expire` function, EventBridge `rate(1 day)`)

`expires_at < now` → `disabled_at = now`; `disabled_at + 30d < now` → `deleted_at = now`, `secret_json = '{}'`. One `channel.expire` audit row per sweep that changed something.

## Data

- MySQL (console's read/write account): `members`, `api_tokens`, `channels`, `audit_log` via `@yyt/console-db`. Schema migrations run once per container at cold start (`GET_LOCK`-serialized).
- Redis (`console:{stage}:`): `sess:{sha256(sessionId)}` TTL 7 d, `oauth:{state}` TTL 10 min.

## Environment (`serverless.yml`)

`STAGE`, `PUBLIC_BASE_URL`, `WEB_URL` (`--param webUrl=`; defaults to the API host until CloudFront exists), `AUTH_BASE_URL`/`TOPIC_BASE_URL`/`MATCH_BASE_URL`, `MYSQL_*`/`REDIS_*` (SSM `/yyt-service/{stage}/console/*`), `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`/`ADMIN_GITHUB_LOGINS` (stage-wide SSM `/yyt-service/{stage}/github-client-id|github-client-secret|admin-github-logins`, uploaded by `GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… ADMIN_GITHUB_LOGINS=… scripts/bootstrap-ssm.sh <stage>`), `DEBUG_HOOKS` (`--param debugHooks=1`, dev only), `DEBUG_KEY`.

The GitHub OAuth app's callback must be `https://console{-dev}.yyt.life/auth/github/callback`.

## Debug hook (dev + `DEBUG_HOOKS=1` only)

`POST /debug/login {login, githubId<0, role}` with `x-debug-key` → creates/updates a synthetic member (`dbg_{login}`) and returns a session cookie, so the API can be exercised without GitHub.

## Verification

```
scripts/deploy.sh console dev --param debugHooks=1
scripts/smoke/console.mjs https://console-dev.yyt.life "$(cat local/deploy/debug-key.dev)" https://auth-dev.yyt.life
aws lambda invoke --function-name yyt-console-dev-expire /dev/stdout
```
