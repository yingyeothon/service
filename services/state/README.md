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
| `GET /time`           | none   | `{now, epochMs}` — `now` ISO-8601 UTC, `epochMs` **milliseconds**; `no-store`           |
| `GET /s/{ownerId}`    | either | `200` + the document, `ETag: "{version}"`, `Cache-Control: no-store`; `404` when absent |
| `PUT /s/{ownerId}`    | apiKey | `201` (created) / `204` (updated) + the new `ETag`; **requires `If-Match`**             |
| `DELETE /s/{ownerId}` | apiKey | `204`; `If-Match` optional                                                              |

Both list routes take `?prefix=`, `?cursor=`, `?limit=` (1–100, default 50), `?order=asc|desc` and `?values=1`, and answer `{entries: [{owner?, key, version, bytes, expiresAt, updatedAt, valueText?}], nextCursor?}`. `owner` appears only where owners are a namespace; `valueText` only with `?values=1`.

`GET /time` is the platform clock and the stack's **only route without a credential** (`docs/decisions.md` _Serverless clients_ #7): a serverless game has no trustworthy clock of its own for a daily reset or an event window. It reads no channel, touches no database and needs no KEK, so it answers even on a stage whose kv is 503 — and the identity resolver skips this path on purpose, so a client that attaches its bearer to every request still costs it no MySQL round trip. `epochMs` is in **milliseconds** while every other timestamp here (`expiresAt`, `updatedAt`, `x-kv-expires-at`) is in seconds; call it once at session start and keep the offset rather than polling, because it shares the stage's 20 rps with `/s/*` and `/kv/*` and `no-store` forbids any edge caching. That sharing is also its exposure: it is the one route anyone with the URL can spend the stage's throttle on, and API Gateway's 429s never reach the Lambda, so a flood produces no `request failed` line and the stack's one alarm stays flat. Nothing bounds it today beyond the stage throttle itself.

`ownerId` is either a player — the 32 lowercase hex of `deriveUserId`, exactly what a token's `sub` holds — or a non-user owner written `{kind}:{id}` (`party:…`, `guild:…`) for state a game keeps per group. A player id can never contain `:`, so the two spaces cannot collide.

There is no list route: enumerating a channel's owners is a server capability, and a route a client could reach with its own token would hand it one.

## KV routes

A **collection** (`kv_…`) is a project resource created in the console or with `yyt kv`; this stack only serves its entries. `{col}` is the collection's id **or its name** (the console admits `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, so a name is one plain path segment with nothing to encode; matched the way the console's unique index folds it — case-insensitively). Both principals are bound to their auth channel's **project**: a name is looked up within that project, and a collection of another project, a missing name, a soft-deleted collection and a malformed segment are all the same `404` as one that does not exist. A segment the console would refuse as a name because it folds onto an id shape (`KV_01H…`) is refused without a lookup. The edge is not transparent to encoded segments — API Gateway decodes `%2F` before routing and answers `%25` with its own 400 — which is why the name grammar matters: nothing the console accepts needs encoding.

| Route                               | Result                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /kv/{col}`                     | the collection's shape: scopes, `encrypted`, both caps; `403` when both scopes are `team` |
| `GET /kv/{col}/entries`             | the shared namespace, or every owner of a user namespace                                  |
| `GET /kv/{col}/u/{ownerId}/entries` | one owner's namespace; a player may write `me`                                            |
| `GET …/entries/{key}`               | `200` + the stored value, `ETag: "{version}"`, `X-KV-Expires-At`                          |
| `PUT …/entries/{key}?ttl=`          | `201` created / `204` updated; `If-Match` and `If-None-Match: *` optional                 |
| `PATCH …/entries/{key}?ttl=`        | `{"incr": n, "min"?, "max"?}` → `{value, version}`; conditional headers are a `400`       |
| `DELETE …/entries/{key}`            | `204`; `If-Match` optional                                                                |

- **Scopes decide everything.** `readScope`/`writeScope` are `team` (console and CLI only — the API answers 403), `server` (the doc apiKey and the console; a player's JWT is a 403), `project` (any credential of the project) or `user` (the server key on anyone's behalf, a player on its own). **Either** scope being `user` puts entries in `/u/{ownerId}/…`; using the wrong path is a `400` naming the one that works.
- **`readScope: user` + `writeScope: project|server` is mail.** Any player may `PUT` into another owner's namespace, create-only (`409 exists`), with a key that must start with its own id and a colon, charged to the recipient's `maxEntriesPerOwner` **and** to its own total in the collection (`409 owner_full` / `sender_full`). A cross-owner `DELETE` or `PATCH` is a 403 and a conditional header a 400; success is `204` with no `ETag`. The platform stamps the writer (`X-KV-From`, plus `X-KV-At` = the row's `updatedAt`, and `from` in list rows) on per-owner collections only — a shared collection is as anonymous as it ever was. The stamp is re-written by every accepted write, so a recipient overwriting its own row replaces it.
- **`PATCH {incr}` takes optional `min`/`max`.** A result outside the range is `409` `out_of_range` carrying `details.value`, the stored number — not `details.current`, which means a version. They guard one request; nothing stores them, a missing counter still starts at zero, and a value already outside the range cannot be repaired here.
- **A conditional write needs the right to read** (`403` otherwise), and so does `PATCH {incr}`: each of them reveals what is stored. A write-only inbox takes a plain `PUT` and `DELETE` and nothing else, and those tell it nothing either — a caller without the read right gets `204` for both a create and an update, `204` for a delete of a key that was never there, and no `ETag`, because “did this key exist” and “how many times has it been written” are facts about stored data. No `409` body ever carries a stored **value** except `out_of_range`, whose `details.value` a `PATCH` caller may read by definition; `details.current` is the live **version**, and only to a reader.
- **`PATCH` takes no conditional header.** It is already a compare-and-set over the value it just read, so `If-Match`/`If-None-Match` are a `400` rather than a header the route would have to ignore.
- **TTL** is `?ttl=` in seconds (1 s … 366 d); omitted on an update keeps the row's expiry, `0` clears it. An expired entry is invisible to every read, but its **version keeps climbing**, or a stale `If-Match` could land on the reborn key. `X-KV-Expires-At` comes back on a write only when _that_ write set the expiry; after a `keep` write the row's expiry is what a `GET` says.
- **Caps** are counted on create only, and on the rows the table actually **holds**: a client writing a fresh key with `ttl=1` each time is invisible to a live count a second later, so the create path reads the stored count first, and a collection whose stored rows reach a cap purges its own expired rows inline before judging the live ones. `maxEntries` bounds everyone, `maxEntriesPerOwner` bounds one player; the two `409`s carry `details.reason` `collection_full` or `owner_full`. One accepted edge: at a full collection a write-only caller's `PUT` answers `204` for an existing key and `409` for a missing one — a key-existence signal, unavoidable while cap refusals are distinct errors.
- **Encryption** is the collection's `encrypted` flag. Values are AES-256-GCM under a per-collection DEK, wrapped by the stage KEK (`KV_KEK`, SSM `kv-kek`) which only this stack holds; the collection, owner and key are the associated data, so a row moved into another slot does not open. A row whose form disagrees with its collection's flag, or that fails its tag, is `503 kv_value_unreadable` and never served as data. Without a usable `KV_KEK` every kv route is `503 kv_encryption_not_configured` — and `/s/*` keeps working, because it holds nothing encrypted.

## LB routes

A **leaderboard** (`lb_…`) is a project resource created in the console or with `yyt lb`; this stack only serves its scores. `{board}` is the board's id **or its name**, resolved the way `{col}` is — within the caller's auth channel's project, folded case-insensitively, with a board of another project, a missing name, a soft-deleted board and an id-shaped non-id all the same `404`. That 404 comes **first**: a bad period, a bad owner and a bad score are each a `400` on a board the caller can see, and all of them are the same 404 on one it cannot, or a board id becomes an oracle. The credential is checked next, and the parameters last.

| Route                                          | Result                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /lb/{board}`                              | the board's shape (`submit`, `rule`, `order`, `maxEntries`) + every **live** bucket     |
| `PUT /lb/{board}/scores/{ownerId\|me}`         | `{"score": n, "meta"?: "…"}` → what is stored in each configured bucket after the write |
| `GET /lb/{board}/top?period=&limit=&offset=`   | one bucket's ranked page + `total`                                                      |
| `GET /lb/{board}/scores/{ownerId\|me}?period=` | `{score, meta, rank, total}` for one owner                                              |
| `DELETE /lb/{board}/scores/{ownerId}`          | `204`; the owner's row in **every** bucket. `server` only                               |
| `DELETE /lb/{board}/periods/{period}`          | the **current** bucket of that period, one batch: `{deleted, truncated}`. `server` only |

- **`submit` decides who may write.** `server` is the doc apiKey alone; `owner` also admits a player writing **its own** row — and the apiKey may still submit on anyone's behalf either way, the same widening the kv `user` scope grants it and the only way to correct a row. Reads are open to every credential of the project: a ranking that cannot be listed is not a ranking. Deletes are the apiKey's.
- **`/scores/{ownerId}` is one route**, with `me` resolved inside the handler. The router matches in declaration order and percent-decodes first (`%6de` is `me`), so two routes would make the credential rule depend on spelling. `me` from a server key is a `400`: a key holds no owner of its own, and guessing one fills a board with rows nobody meant.
- **`?period=` names a period, never a bucket key** (`alltime`, `daily`, `weekly`; absent = the board's first). The platform keys the bucket from its own clock in `Asia/Seoul`, and every answer carries `periodKey` and `periodEndsAt` — a client that could name a key could name one it invented. A period the board does not keep is a `400`.
- **One submission writes every configured bucket**, in one statement, and a bucket at its cap refuses the **whole** submission (`409` `details.reason: board_full`) rather than part of it. The response says what is stored per bucket, which is how a `best` client learns whether it improved; it carries no rank, which would be one `count` per bucket on the hot path.
- **`meta` is a string of JSON text**, at most 1 KiB, stored byte for byte. An object is a `400`: re-encoding it would lose an integer past 2^53. It belongs to the accepted score — a rejected submission leaves the stored `meta` alone, an accepted one without a `meta` clears it.
- **`rank` is `1 + count(better)`**, so equal scores share a rank; `?offset=` is capped at 1,000, beyond which a client wants `/scores/{ownerId}`.
- **`DELETE /periods/{period}` takes one batch of 500 and says `truncated`.** This stack runs with `timeout: 10`, concurrency 6 and one connection, so its job is to answer, not to drain; clearing a board at its cap is the console's route.
- Without the state account's grant on `leaderboards` and `leaderboard_scores`, **every** `/lb/*` route answers `503 database error` while `/s/*` and `/kv/*` keep working. That is the designed gate, and the reason `scripts/smoke/leaderboard.mjs` spends each privilege once.

### When kv answers 503

All three 503s are `AppError`s, so the **Lambda invocation succeeds** and a Lambda `Errors` metric never moves. The stack's one alarm is therefore a **log metric** (`api-failures`, prod only, 2026-09-06): it counts the `request failed` and `unhandled error` lines, so a stage-wide kv outage pages like a crash loop does. The log group tells them apart:

| Line                                                    | Means                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `kv crypto ready` + `kekId`                             | one per cold start; the stage has a KEK, and this is which one                                                                  |
| `kv crypto unavailable`                                 | `KV_KEK` was absent or not 64 hex — every kv route now answers `kv_encryption_not_configured`                                   |
| `kv decrypt failed` + `collectionId`, `kekId`, `reason` | one row (or one collection) would not open                                                                                      |
| `request failed` + a Prisma `P…` cause                  | the DB grant is missing (deploy-order step 3 not applied) — every kv route answers `503 unavailable` while `/s/*` keeps working |

`kekId` is 12 hex of `sha256(kek)`, and it is what separates “this stage has the wrong KEK” — every collection failing at once, and the id differing from the one in the ops repo — from “this one row is corrupt”. `reason` is `malformed`, `auth_failed` or `envelope`; it never reaches the caller, who gets one indistinguishable 503 either way. The debug lines `kv collection unavailable` and `kv refused` say which cause produced a 404 and which scope produced a 403, since the request line carries only the route pattern and the channel. The 404 `reason` is one of `shape` (not an id, and not a name the console could have accepted: id-shaped after folding, or over 255 characters), `missing` (an id with no row), `name` (no such name in the caller's project), `project` (the caller's channel has no project, or the id belongs to another one) or `deleted`; `collectionId` is attached only when the segment was an id — a name is never logged.

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

- No Redis, no schema of its own. Console owns every migration (`state_docs`, migration `5_state_docs`; `kv_*`, migration `m0014_kvstore`; `leaderboard*`, migration `m0017_leaderboard`) and this stack's MySQL account may only `SELECT` on `channels`, `kv_collections` and `leaderboards`, read/write `state_docs`, `kv_entries` and `leaderboard_scores`, and `SELECT, INSERT` on `kv_keys` — no `UPDATE`/`DELETE` there, because overwriting a wrapped DEK destroys a collection for good (`rules/data.md`).
- `KV_KEK` is a stage secret, and `serverless.yml` gives it an **empty default on purpose**: an unresolvable `${ssm:…}` fails at deploy time, which would block every deploy of this stack — a `/s/*` hotfix included — on a stage whose parameter does not exist yet, exactly the coupling `handler.ts` goes to trouble to avoid at runtime. An empty value is not silent: the cold start logs `kv crypto unavailable` and every kv call answers 503. Losing the value loses every encrypted value for good, so the long-term copy lives in the private ops repo beside the state account. `scripts/bootstrap-ssm.sh` mints `kv-kek` once per stage and keeps whatever SSM already holds (replacing it needs `KV_KEK_ROTATE=1`, which makes every stored value unreadable — never by hand); `FORCE=1 scripts/get-env.sh <stage> state` pulls it into the env file for the ops-repo copy.
- Deploy console before state when a change spans both.
- A stage without a state account simply has no state stack; console then omits `docUrl` from auth channel views instead of advertising a host that does not resolve.
- Documents die with their channel — deletion, not expiry, since extending revives an expired channel. So do kv entries and leaderboard scores.
- CORS is open (`*`) with `ETag` exposed: the credential is an explicit header, not a cookie, and a browser cannot do a conditional write without reading the version first.
- Verify on dev: `scripts/smoke/state.mjs`, `scripts/smoke/kvstore.mjs` and `scripts/smoke/leaderboard.mjs`, each `<docBase> $(cat local/deploy/debug-key.dev) <authBase> <consoleBase>`.
