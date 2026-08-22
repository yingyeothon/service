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
