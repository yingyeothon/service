# @yyt/jwt

auth 채널 JWT(HS256, `jose`)와 콜백 HMAC 서명. 클레임 규약은 `docs/auth-game-contract.md` 와 동일하다.

## Public API

- `signChannelToken({secret, channelId, audience, userId, ttlSec, clock?})` → `{token, exp, iat}` — `iss=yyt-auth/{channelId}`, `aud`, `sub=userId`, `iat`, `exp` 만 담는다.
- `verifyChannelToken(token, {secret, channelId, audience, clock?, clockToleranceSec=5})` → `ChannelClaims`; 실패 시 `AppError("unauthorized")`(토큰 원문은 메시지에 포함되지 않음).
- `channelIssuer(channelId)`, `deriveUserId(channelId, provider, providerUserId)` — `sha256(...)` 앞 32 hex.
- `hmacSign(body, key)`, `hmacVerify(body, key, signature)`, `SIGNATURE_HEADER = "x-yyt-signature"`.
