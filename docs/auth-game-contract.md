# Auth contract between the service layer and game stacks

Owned by the **service layer**. tslib (`@yingyeothon/*`) only provides the verification slot; who signs what is decided here.

## Decisions

| Item            | Decision                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------- |
| Identity source | Claims of the JWT issued by the auth/lobby service. `x-member-id` headers are never trusted. |
| Signature       | HS256 symmetric key; one secret per participant channel.                                     |
| Where verified  | API Gateway **REQUEST authorizer** on `$connect` only; `$default` does not re-verify.        |
| Key delivery    | Game Lambda env `JWT_SECRET_KEY`. One stack per participant, so a single secret suffices.    |
| Token transport | `Sec-WebSocket-Protocol: bearer, <token>`. Never the query string (it lands in access logs). |
| Lifetime        | Match time + **60 min** — covers a 15-min dungeon, lobby wait, and mobile reconnects.        |
| Reconnect       | Reuse the same token; no refresh endpoint.                                                   |
| Anonymity       | Game-agnostic; the lobby decides what `sub` means (account or device id).                    |

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

## Accepted costs

1. Game Lambdas can sign; per-channel secrets bound the damage to one participant.
2. Secrets move (lobby → participant → Lambda env); rotation means redeploy.
3. No revocation: tokens are valid until `exp` (60 min). Post-connect eviction is the game loop's job (`Transport.drop`).
4. The `memberId` contract is documentary: mismatch between `sub` and `GameActorStartEvent.members[].memberId` silently yields 400. Fill both from the same variable.
5. Auth only decides _who_. Multiple sockets per member and stale connections sending on `$default` until TTL are handled by rate limits and sequence numbers, not auth.

## Later

- Bind tokens to one match via a `gameId` claim, compared with `x-game-id` before `handleConnect`.
- Multi-tenant game Lambda: resolve keys by `iss` or `kid`; needs a key-resolver callback in tslib `verifyBearer`.
- Asymmetric keys (RS256/EdDSA) + JWKS remove costs 1–2; do it together with multi-tenancy.
- Self-hosted gateway: the gateway verifies `iss`/`aud`/`exp` itself; the token contract survives unchanged, which is why this doc is written around the token, not the authorizer.

## Checklist

- [ ] lobby: channel issue API (`issuerId`/`secret`/`audience` create/get/revoke)
- [ ] lobby: sign JWT on party confirm; `sub` from the same variable as the start event
- [ ] lobby: `exp = confirm + 60 min`
- [ ] game: `authorizer.ts` with `createJwtRequestAuthorizer`, pinned `iss`/`aud`
- [ ] game: REQUEST authorizer on `$connect`, identity source `route.request.header.Sec-WebSocket-Protocol`, cache TTL 0
- [ ] game: `$connect` handler with `resolveMemberId` + `selectSubprotocol`
- [ ] client: `new WebSocket(wsUrl + "?x-game-id=" + gameId, ["bearer", token])`; reuse the token on reconnect, return to lobby near `exp`
- [ ] access logs do not include `$context.authorizer.*`
- [ ] decide how secrets reach participants (one-time console display vs parameter store)
