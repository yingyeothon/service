# Security

- Identity only from verified sources: console cookie session / API token hash lookup; auth-channel JWT (HS256, channel secret, `iss`/`aud`/`exp` pinned). Headers like `x-user-id` are never trusted.
- WebSocket tokens travel in `Sec-WebSocket-Protocol: bearer, <token>`; never in the query string. Authorizer cache TTL 0. Never enable `$context.authorizer.*` in access logs.
- Never log tokens, OAuth codes, `state`, secrets, or full request events. Log ids and outcomes only.
- Secrets are shown once on create/rotate; list/get responses must omit them. API tokens are stored hashed (sha256).
- OAuth `redirect` must match the channel's allowlist; `state` is single-use with a 10-minute TTL.
- Matchmaker callbacks carry `X-Yyt-Signature: hmac-sha256(apiKey, body)`; provide the verify helper in `packages/jwt` and use it in `examples/sample-dungeon`.
- Console roles: `pending` can only read public data, propose, and vote; channel mutation requires `member`; member management requires `admin`. Enforce in one middleware, test the matrix.
- S3 buckets private (SSE-KMS); poster images served only via CloudFront.
- Debug hooks must be registered only on `dev` (see `manual-verification.md`).
- `@yyt/jwt` refuses HS256 secrets under 32 bytes on sign _and_ verify; generate channel secrets with `randomHex(32)` (64 hex chars). `@yyt/http` refuses `cors: {origins:["*"], credentials:true}`.
- Never let `decodeURIComponent` throw out of a handler: malformed percent-encoding in paths/cookies must become a 4xx (router treats it as no-match) instead of an unhandled Lambda error.
- OAuth login-CSRF: bind `state` to the browser with a `__Host-` nonce cookie set on `/start` and checked on `/callback`; store only the nonce hash server-side. Single-use state alone does not stop an attacker from finishing _their_ login in the victim's browser.
- GitHub access tokens carry no audience: always validate them with `POST /applications/{clientId}/token` (Basic `clientId:clientSecret`) so a token granted to another OAuth app cannot mint a JWT on this channel. Google id_tokens are pinned via `aud`.
- Redirect allowlists compare parsed origin + path prefix at a `/` boundary, never raw `startsWith`; return the normalized `url.href`, and reject control characters (WHATWG `URL` silently strips `\t\n\r`).
- Client-supplied strings that go into outbound headers (bearer tokens) must be restricted to printable ASCII at validation time, or undici throws a TypeError that echoes the value into logs.
- Compare shared keys (debug key, API tokens) with `timingSafeEqual` over fixed-length hashes.

## Public repository

- This repo is **public** on GitHub and stays public (Actions/Release allowances). Treat every commit as world-readable.
- Secrets exist only in gitignored `local/` (`local/env/<service>.<stage>.env`, `local/deploy/`), reach Lambda through SSM `/yyt-service/{stage}/{service}/*`, and reach CI (when needed) through GitHub environment secrets. Versioning of secret files, if ever needed, goes to a separate private repo.
- Never write infra identifiers into source, docs, examples, tests, or commit messages: stateful hostnames, database names, MySQL/Redis account names, bucket-internal keys that embed them. Say "see the private `yyt-stateful` ops repo" instead. Test fixtures use the obvious `0123456789abcdef…` value only.
- Defenses (all required, none optional): `.gitignore` (`local/*`, `.env*`, `.envrc`), `scripts/git-hooks/pre-commit` (path block + identifier grep + `gitleaks protect --staged`), `scripts/git-hooks/pre-push` (tracked-path check + identifier grep + `gitleaks detect` over the pushed range), CI `secrets-scan` job (full history). `pnpm install` sets `core.hooksPath`; `gitleaks` must be installed locally. Never use `--no-verify`.
- When adding a new kind of secret, extend the `yyt-env-credential` rule / identifier grep in `.gitleaks.toml` and the hooks in the same commit, and prove the hook blocks it with a throwaway staged file before relying on it.
- If something leaks anyway: rotate the credential first (via `yyt-stateful`), then rewrite history; rotation is the only real fix.
