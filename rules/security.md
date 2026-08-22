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

- This repo is **public** on GitHub. Secrets stay local only (`services/*/.env.{stage}`, gitignored) and reach Lambda via SSM; CI gets them via GitHub environment secrets, never via files in the repo. If `.env` files need version control, use a separate private repo — do not make this repo private (Actions/Release limits).
- Do not write infra identifiers (hostnames, DB names, account names) of the self-hosted MySQL/Redis into docs, rules, or examples; refer to the private `yyt-stateful` ops repo instead.
- Before every `git push`, grep the commit range for values from `services/*/.env.*` and confirm with the user.
