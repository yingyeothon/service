# @yyt/service-state

`doc.yyt.life` (`doc-dev.yyt.life` on dev) — two storage shapes on one stack:

- **doc** (`/s/*`) — one versioned JSON document per `(auth channel, ownerId)`, with compare-and-set enforced on every write. Contract: `docs/decisions.md` §state service.
- **kv** (`/kv/*`) — per-project collections of JSON values addressed by key, each with a read and a write scope, optional TTL, optional CAS and optional encryption. Contract: `docs/decisions.md` §Key-value store (`kv`).

They share this stack because both resolve the same two credentials and the shared MariaDB host has no connection budget for a sixth one.

The name is `doc`, not `state`, because the `state` name is already taken by an existing record (see the private ops repo `yyt-stateful`).

- `src/app.ts` — the three doc routes and their caps; it assembles the kv routes beside its own.
- `src/kvstore.ts` — the KV API: which principal may touch which namespace, what a conditional header means, and where a plaintext may exist.
- `src/kvstore-crypto.ts` — envelope encryption for `encrypted` collections; knows nothing about rows or requests.
- `src/http.ts` — what both route tables share: the owner grammar, the version header codec, `no-store`.
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

Both list routes take `?prefix=`, `?cursor=`, `?limit=` (1–100, default 50), `?order=asc|desc` and `?values=1`, and answer `{entries: [{owner?, key, version, bytes, expiresAt, updatedAt, valueText?}], nextCursor?}`. `owner` appears only where owners are a namespace; `valueText` only with `?values=1`.

`ownerId` is either a player — the 32 lowercase hex of `deriveUserId`, exactly what a token's `sub` holds — or a non-user owner written `{kind}:{id}` (`party:…`, `guild:…`) for state a game keeps per group. A player id can never contain `:`, so the two spaces cannot collide.

There is no list route: enumerating a channel's owners is a server capability, and a route a client could reach with its own token would hand it one.

## KV routes

A **collection** (`kv_…`) is a project resource created in the console or with `yyt kv`; this stack only serves its entries. Both principals are bound to their auth channel's **project**: a collection of another project is the same `404` as one that does not exist.

| Route                               | Result                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `GET /kv/{col}`                     | the collection's shape: scopes, `encrypted`, both caps                    |
| `GET /kv/{col}/entries`             | the shared namespace, or every owner of a user namespace                  |
| `GET /kv/{col}/u/{ownerId}/entries` | one owner's namespace; a player may write `me`                            |
| `GET …/entries/{key}`               | `200` + the stored value, `ETag: "{version}"`, `X-KV-Expires-At`          |
| `PUT …/entries/{key}?ttl=`          | `201` created / `204` updated; `If-Match` and `If-None-Match: *` optional |
| `PATCH …/entries/{key}?ttl=`        | `{"incr": n}` → `{value, version}`; conditional headers are a `400`       |
| `DELETE …/entries/{key}`            | `204`; `If-Match` optional                                                |

- **Scopes decide everything.** `readScope`/`writeScope` are `team` (console and CLI only — the API answers 403), `project` (any credential of the project) or `user` (the server key on anyone's behalf, a player on its own). `writeScope: user` is what puts entries in `/u/{ownerId}/…`; using the wrong path is a `400` naming the one that works.
- **A conditional write needs the right to read** (`403` otherwise), and so does `PATCH {incr}`: each of them reveals what is stored. A write-only inbox takes a plain `PUT` and `DELETE` and nothing else, and those tell it nothing either — a caller without the read right gets `204` for both a create and an update, `204` for a delete of a key that was never there, and no `ETag`, because “did this key exist” and “how many times has it been written” are facts about stored data. No `409` body ever carries a value — only `details.current`, the live version, and only to a reader.
- **`PATCH` takes no conditional header.** It is already a compare-and-set over the value it just read, so `If-Match`/`If-None-Match` are a `400` rather than a header the route would have to ignore.
- **TTL** is `?ttl=` in seconds (1 s … 366 d); omitted on an update keeps the row's expiry, `0` clears it. An expired entry is invisible to every read, but its **version keeps climbing**, or a stale `If-Match` could land on the reborn key. `X-KV-Expires-At` comes back on a write only when _that_ write set the expiry; after a `keep` write the row's expiry is what a `GET` says.
- **Caps** are counted on create only, and on the rows the table actually **holds**: a client writing a fresh key with `ttl=1` each time is invisible to a live count a second later, so the create path reads the stored count first, and a collection whose stored rows reach a cap purges its own expired rows inline before judging the live ones. `maxEntries` bounds everyone, `maxEntriesPerOwner` bounds one player; the two `409`s carry `details.reason` `collection_full` or `owner_full`.
- **Encryption** is the collection's `encrypted` flag. Values are AES-256-GCM under a per-collection DEK, wrapped by the stage KEK (`KV_KEK`, SSM `kv-kek`) which only this stack holds; the collection, owner and key are the associated data, so a row moved into another slot does not open. A row whose form disagrees with its collection's flag, or that fails its tag, is `503 kv_value_unreadable` and never served as data. Without a usable `KV_KEK` every kv route is `503 kv_encryption_not_configured` — and `/s/*` keeps working, because it holds nothing encrypted.

### When kv answers 503

Both 503s are `AppError`s, so the **Lambda invocation succeeds** and the stack's `Errors` alarm never fires. The log group is the only signal:

| Line                                                    | Means                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `kv crypto ready` + `kekId`                             | one per cold start; the stage has a KEK, and this is which one                                |
| `kv crypto unavailable`                                 | `KV_KEK` was absent or not 64 hex — every kv route now answers `kv_encryption_not_configured` |
| `kv decrypt failed` + `collectionId`, `kekId`, `reason` | one row (or one collection) would not open                                                    |

`kekId` is 12 hex of `sha256(kek)`, and it is what separates “this stage has the wrong KEK” — every collection failing at once, and the id differing from the one in the ops repo — from “this one row is corrupt”. `reason` is `malformed`, `auth_failed` or `envelope`; it never reaches the caller, who gets one indistinguishable 503 either way. The debug lines `kv collection unavailable` and `kv refused` say which of the four causes produced a 404 and which scope produced a 403, since the request line carries only the route pattern and the channel.

## Document versions

These rules are the doc store's; a kv entry's conditional headers are optional and are described above.

`If-Match` carries the version the caller read; `"0"` means "no row yet" and creates. `"3"`, `W/"3"` and a bare `3` all mean version 3.

| Situation                        | Answer                                           |
| -------------------------------- | ------------------------------------------------ |
| no `If-Match` on a `PUT`         | `428` — there is no unconditional write          |
| `If-Match: *`                    | `400` naming the fix: send the version you read  |
| the version has moved on         | `409` + `ETag` of the winner + `details.current` |
| creating over an existing row    | `409` + the current `ETag`                       |
| updating a row that is not there | `409` + `details.current: null`                  |

Two dungeon results landing on one inventory is the failure this shape exists to prevent, so a losing write is refused rather than merged, and the response says what it lost to.

## Document caps

64 KB per document, 10000 documents per channel, both refusals rather than truncation. The document cap is measured on the bytes **as sent**, because those are the bytes stored: the request is parsed only to prove it is JSON, never re-encoded — `JSON.stringify(JSON.parse(x))` would rewrite an integer past 2^53, collapse duplicate keys and reorder integer-like ones, and the platform promises to carry a game's schema opaquely.

## Operating

- No Redis, no schema of its own. Console owns every migration (`state_docs`, migration `5_state_docs`; `kv_*`, migration `m0014_kvstore`) and this stack's MySQL account may only `SELECT` on `channels` and `kv_collections`, and read/write `state_docs`, `kv_entries` and `kv_keys`.
- `KV_KEK` is a stage secret, and `serverless.yml` gives it an **empty default on purpose**: an unresolvable `${ssm:…}` fails at deploy time, which would block every deploy of this stack — a `/s/*` hotfix included — on a stage whose parameter does not exist yet, exactly the coupling `handler.ts` goes to trouble to avoid at runtime. An empty value is not silent: the cold start logs `kv crypto unavailable` and every kv call answers 503. Losing the value loses every encrypted value for good, so the long-term copy lives in the private ops repo beside the state account. `scripts/bootstrap-ssm.sh` and `scripts/get-env.sh` do not know the key yet (`todo/33`, S5); until they do it is created by hand, once per stage.
- Deploy console before state when a change spans both.
- A stage without a state account simply has no state stack; console then omits `docUrl` from auth channel views instead of advertising a host that does not resolve.
- Documents die with their channel — deletion, not expiry, since extending revives an expired channel.
- CORS is open (`*`) with `ETag` exposed: the credential is an explicit header, not a cookie, and a browser cannot do a conditional write without reading the version first.
- Verify on dev: `scripts/smoke/state.mjs https://doc-dev.yyt.life $(cat local/deploy/debug-key.dev) https://auth-dev.yyt.life https://console-dev.yyt.life`.
