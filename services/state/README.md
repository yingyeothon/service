# @yyt/service-state

`doc.yyt.life` (`doc-dev.yyt.life` on dev) — the **doc** storage shape: one versioned JSON document per `(auth channel, ownerId)`, with compare-and-set enforced on every write. Contract: `docs/decisions.md` §state service.

The name is `doc`, not `state`, because the `state` name is already taken by an existing record (see the private ops repo `yyt-stateful`).

- `src/app.ts` — the three routes, the `ownerId` grammar, the `If-Match` rules and the caps.
- `src/channels.ts` — a bearer token → the caller it proves; no cache, because an auth channel row carries secrets (`rules/data.md`).
- `src/handler.ts` — the only place that reads `process.env`. One Prisma client per container; no Redis at all.

The platform never parses a document beyond proving it is JSON — the body is the game's own schema, stored and returned byte for byte.

## Credentials (`Authorization: Bearer …`)

| Bearer                                                  | May                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| the auth channel's **doc apiKey** (`yds.{channelId}.…`) | read, write and delete any owner's document                       |
| a player's **channel JWT** (the one auth issues)        | read the single document named by its own `sub`, and nothing else |

The apiKey is issued from the console (`POST /channels/{id}/doc-key`, `yyt channels doc-key issue`, or the channel's "Document storage" card) and shown once. It names its own channel because these routes carry no channel segment. Anything that does not verify — a wrong key, a token signed with another secret, a channel that is expired, disabled or deleted — is one indistinguishable `401`.

## Routes

| Route                 | Auth   | Result                                                                                  |
| --------------------- | ------ | --------------------------------------------------------------------------------------- |
| `GET /s/{ownerId}`    | either | `200` + the document, `ETag: "{version}"`, `Cache-Control: no-store`; `404` when absent |
| `PUT /s/{ownerId}`    | apiKey | `201` (created) / `204` (updated) + the new `ETag`; **requires `If-Match`**             |
| `DELETE /s/{ownerId}` | apiKey | `204`; `If-Match` optional                                                              |

`ownerId` is either a player — the 32 lowercase hex of `deriveUserId`, exactly what a token's `sub` holds — or a non-user owner written `{kind}:{id}` (`party:…`, `guild:…`) for state a game keeps per group. A player id can never contain `:`, so the two spaces cannot collide.

There is no list route: enumerating a channel's owners is a server capability, and a route a client could reach with its own token would hand it one.

## Versions

`If-Match` carries the version the caller read; `"0"` means "no row yet" and creates. `"3"`, `W/"3"` and a bare `3` all mean version 3.

| Situation                        | Answer                                           |
| -------------------------------- | ------------------------------------------------ |
| no `If-Match` on a `PUT`         | `428` — there is no unconditional write          |
| `If-Match: *`                    | `400` naming the fix: send the version you read  |
| the version has moved on         | `409` + `ETag` of the winner + `details.current` |
| creating over an existing row    | `409` + the current `ETag`                       |
| updating a row that is not there | `409` + `details.current: null`                  |

Two dungeon results landing on one inventory is the failure this shape exists to prevent, so a losing write is refused rather than merged, and the response says what it lost to.

## Caps

64 KB per document, 10000 documents per channel, both refusals rather than truncation. The document cap is measured on the bytes **as sent**, because those are the bytes stored: the request is parsed only to prove it is JSON, never re-encoded — `JSON.stringify(JSON.parse(x))` would rewrite an integer past 2^53, collapse duplicate keys and reorder integer-like ones, and the platform promises to carry a game's schema opaquely.

## Operating

- No Redis, no schema of its own. Console owns every migration (`state_docs`, migration `5_state_docs`) and this stack's MySQL account may only `SELECT` on `channels` and read/write `state_docs`.
- Deploy console before state when a change spans both.
- A stage without a state account simply has no state stack; console then omits `docUrl` from auth channel views instead of advertising a host that does not resolve.
- Documents die with their channel — deletion, not expiry, since extending revives an expired channel.
- CORS is open (`*`) with `ETag` exposed: the credential is an explicit header, not a cookie, and a browser cannot do a conditional write without reading the version first.
- Verify on dev: `scripts/smoke/state.mjs https://doc-dev.yyt.life $(cat local/deploy/debug-key.dev) https://auth-dev.yyt.life https://console-dev.yyt.life`.
