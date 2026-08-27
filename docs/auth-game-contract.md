# Auth contract between the service layer and game stacks

Owned by the **service layer**. tslib (`@yingyeothon/*`) only provides the verification slot; who signs what is decided here.

## Decisions

| Item            | Decision                                                                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity source | Claims of the JWT issued by the auth/lobby service. `x-member-id` headers are never trusted.                                                                                                                                                  |
| Signature       | HS256 symmetric key; one secret per participant channel.                                                                                                                                                                                      |
| Where verified  | API Gateway **REQUEST authorizer** on `$connect` only; `$default` does not re-verify.                                                                                                                                                         |
| Key delivery    | Game Lambda env `JWT_SECRET_KEY`. One stack per participant, so a single secret suffices.                                                                                                                                                     |
| Token transport | `Sec-WebSocket-Protocol: bearer, <token>`. Never the query string (it lands in access logs).                                                                                                                                                  |
| Lifetime        | At least match time + **60 min** — covers a 15-min dungeon, lobby wait, and mobile reconnects. With the yyt auth service the token is the channel's `tokenTtlSec` (default 24 h) and is **reused as-is** by the game; no re-signing on match. |
| Reconnect       | Reuse the same token; no refresh endpoint.                                                                                                                                                                                                    |
| Anonymity       | Game-agnostic; the lobby decides what `sub` means (account or device id).                                                                                                                                                                     |

## Claims

| Claim    | Value                                       | Verified | Why                                                                                                        |
| -------- | ------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `sub`    | `memberId`                                  | required | The identity. Must equal `GameActorStartEvent.members[].memberId` byte-for-byte; missing `sub` → rejected. |
| `iss`    | channel issuer, e.g. `yyt-auth/ch_a1b2c3`   | required | A valid signature only proves "someone with this secret"; `iss` pins the channel.                          |
| `aud`    | deployment id, e.g. `instant-dungeon-teamA` | required | Stops a token for deployment A working on B.                                                               |
| `exp`    | match time + 60 min                         | required | Tokens without `exp` are rejected (`requireExpiry` default `true`).                                        |
| `iat`    | issued at                                   | auto     |                                                                                                            |
| `jti`    | unique id                                   | optional | Unused now; handle for revocation lists later.                                                             |
| `gameId` | match id                                    | optional | To bind a token to one match (see "Later").                                                                |

**Never include PII** (`name`, `email`). Claims flow into the authorizer context, and API Gateway can log `$context.authorizer.*` — anything in a claim may end up in logs. The default context is `{ memberId }` only (also the policy `principalId`); the raw token is never put in the context.

## Game Lambda configuration

| Env              | Example                 | Use                    |
| ---------------- | ----------------------- | ---------------------- |
| `JWT_SECRET_KEY` | (channel secret)        | HS256 verification key |
| `JWT_ISSUER`     | `yyt-auth/ch_a1b2c3`    | expected `iss`         |
| `JWT_AUDIENCE`   | `instant-dungeon-teamA` | expected `aud`         |

Read `process.env` in the service handler only; tslib library code never reads env.

```ts
// authorizer.ts — API Gateway REQUEST authorizer
import { createJwtRequestAuthorizer } from "@yingyeothon/lambda-authorizer-jwt";

export const handler = createJwtRequestAuthorizer({
  jwtSecret: process.env.JWT_SECRET_KEY!,
  verifyOptions: {
    issuer: process.env.JWT_ISSUER!,
    audience: process.env.JWT_AUDIENCE!,
  },
});
```

API Gateway settings: type **REQUEST** (WebSocket APIs do not support TOKEN), attached to **`$connect` only**, identity source `route.request.header.Sec-WebSocket-Protocol`, **cache TTL 0**. With caching off, API Gateway does not inspect the identity source; with caching on, every declared source must be present or the request is 401 before the Lambda runs — declaring both a header and the subprotocol would block every browser handshake. If caching is ever enabled, declare only the one source clients actually send.

```ts
// connect.ts
import { handleConnect } from "@yingyeothon/lambda-gamebase";

export const handler = (event) =>
  handleConnect({
    event,
    ...prefixes,
    context: gamebaseContext,
    resolveMemberId: (e) => {
      const memberId = e.requestContext.authorizer?.memberId;
      return typeof memberId === "string" ? memberId : undefined;
    },
    selectSubprotocol: (offered) =>
      offered.includes("bearer") ? "bearer" : undefined,
  });
```

- `resolveMemberId` returning `undefined` closes with 400 (fail closed).
- Without `selectSubprotocol` the browser handshake fails: the server must echo the chosen subprotocol.
- `x-member-id` is ignored entirely. The only client-chosen value is `x-game-id`, filtered by the start event's membership check.

## Reusing the auth service token (verified 2026-08-23)

The auth service's JWT (`iss = yyt-auth/{channelId}`, `aud = channel.audience`, `sub = userId`) passes `createJwtRequestAuthorizer` unchanged, so the lobby step "sign JWT" disappears: the match callback returns `{wsUrl, gameId}` without a `token`, and the client connects to the game with the JWT it already used for the match socket. The game stack's `JWT_SECRET_KEY`/`JWT_ISSUER`/`JWT_AUDIENCE` are the auth channel's secret, `yyt-auth/{channelId}` and audience. `exp` is then the channel TTL rather than "match + 60 min" — longer, never shorter, which is the only direction the contract cares about. Reference implementation: `examples/sample-dungeon`.

## Handshake

```
1. client → lobby      : login / identify
2. lobby               : party confirmed → store GameActorStartEvent (Redis)
                         → sign JWT (sub=memberId, iss=channel, aud=deployment, exp=now+60m)
3. lobby → client      : { wsUrl, gameId, token }
4. client              : new WebSocket(`${wsUrl}?x-game-id=${gameId}`, ["bearer", token])
5. API Gateway         : REQUEST authorizer → verify → context { memberId }
6. $connect            : handleConnect → membership check → conn:{connectionId} = gameId
                         → actor queue { type:"enter", connectionId, memberId }
                         → 200 + Sec-WebSocket-Protocol: bearer
7. drop → reconnect    : repeat from 4 with the same token; processEnter rebinds the slot
```

`gameId` travels in the query string: browsers cannot add headers to the WS handshake and `gameId` is not secret. Only the token is secret, and only it goes in the subprotocol. 60 minutes because a token expiring mid-match locks the player out permanently (401 on reconnect).

## Shared lobby + per-participant channels

Channel = `{ issuerId, secret, audience }`.

```
register : participant → lobby      : team sign-up
issue    : lobby → participant      : { issuerId, secret, audience }
deploy   : participant              : set JWT_SECRET_KEY / JWT_ISSUER / JWT_AUDIENCE on the game stack
run      : user → lobby → game      : lobby signs with that channel's secret; the game accepts only its channel
```

One deployment per participant makes a single env var sufficient; no key lookup (Redis/SSM) on the auth path. Per-participant channels limit the **blast radius**: HS256 gives the game Lambda the signing key, so a compromised game can forge only its own channel's users.

## Platform gateway path (added 2026-08-25)

The self-hosted WebSocket gateway (`docs/realtime-gateway-design.md`, `docs/decisions.md` _Realtime gateway_) replaces the API Gateway authorizer for `lobby` and `q` channels. The **token contract is unchanged** — that is the whole point of writing this doc around the token rather than the authorizer — but three things differ:

- **Verification is a call, not a key.** The gateway is platform-operated and serves every participant's channels, so it must never hold a channel secret. It verifies with `GET /c/{authChannelId}/verify` (Bearer) and caches the answer keyed by a hash of the token until the JWT's `exp`. `authChannelId` comes from the gateway channel's config, not from the client: `verifyChannelToken` pins `channelId`, so a token signed for one auth channel is rejected everywhere else.
- **One token, both sockets.** A player uses the same JWT for the lobby socket and the dungeon (`q`) socket, because both channels point at the same auth channel. Nothing is re-signed at any point, exactly as in the match path above. Consequence: the verify cache has a high hit rate, which is why it is load-bearing — auth's `reservedConcurrency` is 10 and an 8-player dungeon start would otherwise burst 8 verifies.
- **A participant's game Lambda still verifies locally** with `createJwtRequestAuthorizer` where it exposes its own HTTP/WS endpoints. Only the platform gateway uses the verify endpoint.

**One provider per channel.** `userId` is `sha256(channelId + ":" + provider + ":" + providerUserId)` — `provider` is part of the hash, so a channel that enables both GitHub and Google hands **one human two identities**, with two characters, two inventories and two party memberships. No account linking is built and none is planned. A game picks a single provider when its auth channel is created; enabling a second one later silently forks every existing player.

## Accepted costs

1. Game Lambdas can sign; per-channel secrets bound the damage to one participant.
2. Secrets move (lobby → participant → Lambda env); rotation means redeploy.
3. No revocation: tokens are valid until `exp` (60 min). Post-connect eviction is the game loop's job (`Transport.drop`).
4. The `memberId` contract is documentary: mismatch between `sub` and `GameActorStartEvent.members[].memberId` silently yields 400. Fill both from the same variable.
5. The matchmaker callback is signed but not replay-protected (no timestamp/nonce): a captured body can be re-posted until the channel apiKey rotates. The apiKey travels only to the callback owner, so this is accepted for contest use; add an `issuedAt` check if a lobby ever becomes multi-tenant.
6. Auth only decides _who_. Multiple sockets per member and stale connections sending on `$default` until TTL are handled by rate limits and sequence numbers, not auth.

## Later

- Bind tokens to one match via a `gameId` claim, compared with `x-game-id` before `handleConnect`.
- Multi-tenant game Lambda: resolve keys by `iss` or `kid`; needs a key-resolver callback in tslib `verifyBearer`.
- Asymmetric keys (RS256/EdDSA) + JWKS remove costs 1–2; do it together with multi-tenancy.
- ~~Self-hosted gateway~~ — decided 2026-08-25 and specified above (_Platform gateway path_). The token contract survived unchanged, as predicted; the gateway calls `GET /c/{ch}/verify` instead of verifying `iss`/`aud`/`exp` with a local key, because a platform-operated process must not hold participants' secrets.

## Checklist

- [x] lobby: channel issue API — console `channels` (auth channel = issuer/secret/audience)
- [x] lobby: token on party confirm — the auth token is reused; `sub` and `members[].memberId` are the same `userId` (`examples/sample-dungeon/src/lobby.ts`)
- [x] lobby: `exp` ≥ confirm + 60 min (channel `tokenTtlSec`)
- [x] game: `authorizer.ts` with `createJwtRequestAuthorizer`, pinned `iss`/`aud`
- [x] game: REQUEST authorizer on `$connect`, identity source `route.request.header.Sec-WebSocket-Protocol`; `resultTtlInSeconds: 0` declared (API Gateway v2 ignores the TTL for WebSocket authorizers — they only run on `$connect` anyway)
- [x] game: `$connect` handler with `resolveMemberId` + `selectSubprotocol`
- [x] client: `new WebSocket(wsUrl + "?x-game-id=" + gameId, ["bearer", token])`; reuse the token on reconnect (`scripts/smoke/dungeon.mjs`)
- [x] access logs do not include `$context.authorizer.*` (sample stack has no access logging)
- [x] secrets reach participants through the console's one-time display (`secret`/`apiKey` on create and rotate)
