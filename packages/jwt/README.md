# @yyt/jwt

Auth-channel JWTs (HS256 via `jose`) and callback HMAC signatures. Claims follow `docs/auth-game-contract.md`.

## Public API

- `signChannelToken({secret, channelId, audience, userId, ttlSec, clock?})` → `{token, exp, iat}` — claims `iss=yyt-auth/{channelId}`, `aud`, `sub=userId`, `iat`, `exp` only.
- `verifyChannelToken(token, {secret, channelId, audience, clock?, clockToleranceSec=5})` → `ChannelClaims`; throws `AppError("unauthorized")` without echoing the token.
- `channelIssuer(channelId)`, `deriveUserId(channelId, provider, providerUserId)` — first 32 hex of `sha256(...)`.
- `hmacSign(body, key)`, `hmacVerify(body, key, signature)`, `SIGNATURE_HEADER = "x-yyt-signature"`.
- Secrets shorter than 32 bytes are refused on sign and verify.
