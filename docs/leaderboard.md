# Leaderboards (`lb`)

Design of record: `docs/decisions.md` _Serverless clients_ #1–#4 (2026-09-08, revised 2026-09-09). This page is the working reference between that contract and the code: who may do what, how a bucket is keyed, and where each surface lives. Route-level detail is in `services/state/README.md` (_LB routes_) and `docs/team-project.md` (console routes and list parameters). Execution record: `todo/36`.

A board holds **one score per owner per period bucket**. It exists for the one thing kv could not express: an ordering. Sorting a JSON field would need an extracted column and would bend the kv grammar into rank semantics, and a Redis sorted set would need a MariaDB backing layer anyway — so scores live in MariaDB (`leaderboard_scores`), never in Redis, whose `allkeys-lru` plus mandatory TTL would evaporate a ranking.

## Principals

| principal | credential                                                 | entry point                | rights                                                                       |
| --------- | ---------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------- |
| `team`    | console session / `yyt_` token + team membership           | console API, SPA, `yyt lb` | create/edit/delete a board; read and delete scores — **never write one**     |
| `server`  | the auth channel's doc apiKey (`yds.{channelId}.{random}`) | LB API on the state stack  | read; submit on **anyone's** behalf on either kind of board; delete          |
| `owner`   | the auth channel JWT (`sub` = userId)                      | LB API                     | read; submit its own row on a `submit: owner` board (`me` alias); no deletes |

- API principals are bound to the auth channel's `projectId`; a mismatch, or a channel without one, answers 404 rather than 403 — a board id proves nothing about another project, whatever else is wrong with the request (the board is resolved **before** the credential, and the credential before the parameters).
- **The console never writes a score**, and there is no route, no SPA control and no CLI verb that would (owner decision 2026-09-09). That is what makes `channel_id` on every row the credential that wrote it, and therefore what makes the channel purge one predicate instead of the owner-set derivation kv needs.
- The doc apiKey may submit on a `submit: owner` board too. It is the same widening the kv `user` scope already grants a server key, and it is the only way to correct a row.
- Reads are open to every credential of the project: a ranking that cannot be listed is not a ranking. `GET /top` was the surface that found the unsalted `deriveUserId` (`docs/decisions.md` _Player ids are salted per auth channel_), so a board of a channel created before that salt exists stays reversible — which is why `todo/41` shipped first.

## Board settings (four of them immutable)

| field           | values                       | note                                                               |
| --------------- | ---------------------------- | ------------------------------------------------------------------ |
| `submit`        | `server` \| `owner`          | who may write; the apiKey may always                               |
| `rule`          | `best` \| `latest` \| `sum`  | how a new score meets the stored one; `sum` saturates at ±(2^53−1) |
| `order`         | `desc` \| `asc`              | which end ranks first; `asc` is for times                          |
| `periods`       | ⊆ `{alltime, daily, weekly}` | at least one, stored in that canonical order                       |
| `maxEntries`    | 1–10,000 (default 2,000)     | per **bucket**; also the ceiling on the `count` behind every rank  |
| `retainPeriods` | 0–12 (default 4)             | past buckets kept per period; `alltime` is never dropped           |

The first four never change: a board that changed how a new score meets the stored one, or which buckets exist, would be ranking rows written under two different rules. The console `PATCH` names the field and says "delete and recreate it"; `name`, `description`, `maxEntries` and `retainPeriods` stay editable. One board's worst case is `maxEntries × (1 + 2 × (retainPeriods + 1))` rows — 11 buckets at the defaults, 27 at `retainPeriods: 12` — because retention keeps the **current** bucket of each period plus `retainPeriods` past ones. The `+ 1` was missing from three places until 2026-09-10.

`rule` × `order` is a matrix, not a comparison. On an `asc` board `next > stored` would crown the slowest player, which is exactly the bug the plan review caught before a line was written; `lbAccepts`/`lbMergedScore` and the SQL `IF` both spell the four cases out.

## Periods

Keys are computed by the platform in `Asia/Seoul` as fixed arithmetic (UTC+9, no DST since 1988 — a tzdata update that moved a boundary would silently re-key stored rows): `""` for alltime, `YYYY-MM-DD` daily, ISO `YYYY-Www` weekly with a Monday start. A client never names a bucket key on the API; it names a **period**, and every answer carries `periodKey` and `periodEndsAt` so nothing is derived from a browser's clock.

The two ISO-week boundaries worth pinning, because the obvious "week of the calendar year" is wrong at both: `2027-01-01` is `2026-W53` (2026 has 53 weeks) and `2024-12-30` is `2025-W01`. Both are fixtures in `packages/console-db/test/leaderboard.test.ts` and in the SPA's own copy of the arithmetic.

One submission updates **every** configured bucket, atomically per bucket, in one multi-row `INSERT … ON DUPLICATE KEY UPDATE`. In that clause `score` is assigned **last**: MySQL evaluates the assignments left to right, so a `score` written first would make every following `IF` compare the incoming value against itself and accept a submission the rule rejects. A bucket at its cap refuses the **whole** submission (`409 board_full`) rather than part of it — "every period at once" is the promise, and a client with a row in `alltime` and none in `daily` could never tell which.

## Ranks

`rank` is `1 + count(better)`, so equal scores share a rank and the next distinct score takes the position it actually occupies. A page spends **one** `count` — the true rank of its first row — and `lbRankPage` walks down from there. Both callers pass their `offset` as well, and that is load-bearing: a page starting **inside** a tie has a first rank below its own offset, so numbering the rest from `firstRank + i` under-counts every row after the tie ends (`30,20,20,10` at offset 2 ranked the last row 3 instead of 4; found by the route test, 2026-09-10).

One index carries all of it: `(board_id, period, period_key, score)`, with `owner_id` appended by InnoDB. Ties therefore order by owner id **in the scan's own direction**, because a mixed `score DESC, owner ASC` cannot be served by one range scan. `?offset=` is capped at 1,000 on the API — beyond that a client wants `GET /scores/{ownerId}` — while the console's own table pages to the board cap, since an operator looking for one player on a full board would otherwise stop a tenth of the way down.

## Surfaces

- **LB API** (`services/state/src/leaderboard.ts`, `doc{-dev}.yyt.life/lb/*`): `GET /lb/{board}` (shape + every live bucket), `PUT /lb/{board}/scores/{ownerId|me}`, `GET /lb/{board}/top?period=&limit=&offset=`, `GET /lb/{board}/scores/{ownerId|me}?period=` → `{score, rank, total}`, `DELETE` of a score or of the current bucket (both `server` only). `{board}` is the id **or the name**, resolved within the caller's project, every miss the same 404. `/scores/{ownerId}` is one route with `me` resolved inside it: the router matches in declaration order and percent-decodes first, so splitting the two would make the credential rule depend on spelling (`%6de`).
- **Console API** (`services/console/src/leaderboard.ts`): `POST|GET /projects/{prj}/leaderboards`, `GET|PATCH|DELETE /leaderboards/{id}`, `GET /leaderboards/{id}/scores?period=&limit=&offset=`, `GET|DELETE /leaderboards/{id}/scores/{ownerId}`, `DELETE /leaderboards/{id}/periods/{period}`. `{period}` is a **period name** for the live bucket (`alltime`, `daily`, `weekly`) or a **key** for a past one (`2026-09-10`, `2026-W37`); `alltime`, whose key is the empty string, can only ever be named. Accepting only `alltime` there made `?period=weekly` — which the SPA's selector and `yyt lb top --period weekly` both send — a 400 on the console while the same word worked on the API; found on dev, 2026-09-10, because every unit test mocked the other side. Every write takes the per-member write slot and writes audit (board id and owner id, never a score or `meta`).
- **SPA** (`apps/console-web`): the project page's _Leaderboards_ tab (list, sortable by name/submit/rule/updated; the create drawer with the three enum selects, the period checkboxes and the two caps) and the board page `/ui/leaderboards/{id}` (header badges, the API block as one copyable `name=value` block, a bucket selector offering the live periods and the retained past keys, the ranked table, per-row _Delete score_, _Clear period_, the edit drawer with the caps and the danger zone). `meta` is rendered as a text node — the stored bytes are whatever a game sent.
- **CLI** (`cli/internal/cmd/leaderboard.go`): `yyt lb list|create|get|update|delete`, `yyt lb top`, `yyt lb clear`, `yyt lb score get|delete` — and **no** `score put` (`cli/README.md` _Leaderboards_). `top` prints which bucket answered on stderr, so a piped table stays a table.
- **Shared rules** (`packages/console-db/src/leaderboard.ts`): the caps (`LEADERBOARDS_PER_PROJECT = 20`, `LB_MAX_ENTRIES_HARD = 10_000`, `LB_RETAIN_MAX = 12`, `LB_META_BYTES = 1024`), the name grammar (kv's, so a name never folds onto a `lb_` id), the KST period arithmetic, the retention cutoff, `lbRankPage`, and the submission itself. Both writers call the same functions, so the console and the API answer alike.

## `meta`

An optional `meta` is a **JSON text field** ≤ 1 KiB: sent as a string and stored byte for byte, never parsed. Taking it as an object would mean re-encoding, and `JSON.stringify(JSON.parse(x))` loses integers past 2^53 and duplicate keys — the dev smoke round-trips `{"build":9007199254740993}` for exactly that reason. It belongs to the accepted score: a submission the rule **rejects** leaves the stored `meta` alone, and an accepted one that carries none clears it.

One byte class is refused: a raw C0/C1 control character (added 2026-09-10). `meta` is printed into operator-facing tables, and `textsafe.Clean` keeps `\n` and `\t` on purpose, so a player's newline forges a row in `yyt lb score get` with an attacker-chosen owner and rank — the same forgery `rules/security.md` records against an event's close reason. It costs the contract nothing, because JSON forbids a raw U+0000–001F inside a string: no well-formed value can carry one, and the escaped `\u001b` is six plain bytes that still pass. This is what earns `meta` the "no `Clean`" exemption `rules/workflow.md` grants only to JSON-validated fields.

A **platform admin with no seat in the team** does not get `meta` at all, on either console read. The override exists so an admin can see that a resource exists and delete a team, and it never reaches a secret; `meta` is the team's own payload, so it is withheld exactly as `mayReadValues` withholds a kv value. The ranking itself — rank, owner, score, times — stays visible, which is the meta-only view kv gives too.

One byte class is refused: a raw C0/C1 control character (added 2026-09-10). `meta` is printed into operator-facing tables, and `textsafe.Clean` keeps `\n` and `\t` on purpose, so a player's newline forges a row in `yyt lb score get` with an attacker-chosen owner and rank — the same forgery `rules/security.md` records against an event's close reason. It costs the contract nothing, because JSON forbids a raw U+0000–001F inside a string: no well-formed value can carry one, and the escaped `\u001b` is six plain bytes that still pass. This is what earns `meta` the "no `Clean`" exemption `rules/workflow.md` grants only to JSON-validated fields.

A **platform admin with no seat in the team** does not get `meta` at all, on either console read. The override exists so an admin can see that a resource exists and delete a team, and it never reaches a secret; `meta` is the team's own payload, so it is withheld exactly as `mayReadValues` withholds a kv value. The ranking itself — rank, owner, score, times — stays visible, which is the meta-only view kv gives too.

## Lifecycle

Deleting a board soft-deletes it (frees the name at once by parking the row on its own id), drains the scores inline in batches of 1,000 up to ten times, and leaves the rest to the daily sweep. `runLeaderboardSweep` has **its own budget and its own cursor** (`lb:sweep:after`), never the kv sweep's: the two reclaim different tables, and a stage whose kv expiry ran long must still drop retired buckets. Its three phases are the kv sweep's, in the same order and for the same reasons — the scores of the auth channels that run finished with (their ids exist nowhere else afterwards), then soft-deleted boards, then retention per live board.

Unlike the kv sweep's last two, **all three phases have a budget of their own** (2026-09-10): one deleted board at the hard caps leaves ~260,000 rows for the drain, which is ~260 statements, so a shared 20 meant no live board on the stage dropped a retired bucket for a fortnight. Retention's budget is the number that decides how many big boards a stage can carry: 40 statements of 1,000 rows keeps up with roughly 17 default boards or 3 at the hard caps, since one board retires at most `maxEntries` rows per day plus `maxEntries` every seventh. Past that, `leaderboard_scores` grows until someone lowers a cap, and the signals are the digest's `lb:bytes` warning plus this sweep's own `truncated` — logged at `warn`, or at **`error`** when it is the channel phase that ran short, because those rows are then unreclaimable for good.

Unlike the kv sweep's last two, **all three phases have a budget of their own** (2026-09-10): one deleted board at the hard caps leaves ~260,000 rows for the drain, which is ~260 statements, so a shared 20 meant no live board on the stage dropped a retired bucket for a fortnight. Retention's budget is the number that decides how many big boards a stage can carry: 40 statements of 1,000 rows keeps up with roughly 17 default boards or 3 at the hard caps, since one board retires at most `maxEntries` rows per day plus `maxEntries` every seventh. Past that, `leaderboard_scores` grows until someone lowers a cap, and the signals are the digest's `lb:bytes` warning plus this sweep's own `truncated` — logged at `warn`, or at **`error`** when it is the channel phase that ran short, because those rows are then unreclaimable for good.

Retention drops every bucket of a period whose key sorts below the cutoff, which is a range on the primary key — and that is why `period` precedes `period_key` there. Under `utf8mb4_bin` the key alone does not separate the three kinds (`''` sorts before everything, `'2026-W01'` after `'2026-01-01'`), so a `period_key <` delete keyed on the second column would walk the whole board and could take the alltime row with it.

Scores die with their auth channel (`channel_id`, one predicate), like kv rows and documents: a userId means nothing outside the channel that derived it. A board dies with its project only by being deleted first — project and team deletion are refused while one exists (`countResources.lb`, the `RESTRICT` rule every resource follows).

## Operating notes

- The state account's grant is a **hard gate**: `SELECT` on `leaderboards` and DML on `leaderboard_scores`. Without it every `/lb/*` route answers `503 {"code":"unavailable"}` while `/s/*` and `/kv/*` keep working, and on prod that crosses the `api-failures` log-metric alarm. `GRANT` on a table that does not exist applies nothing, so the order is **console deploy (migration) → grant → state deploy**; a `GRANT` reaches open connections, so nothing is redeployed after one. The statements themselves live in the private ops repo.
- The daily usage digest carries `leaderboard_scores`' physical size and the heaviest boards beside the kv pair, with its own threshold; an unreadable size is announced rather than read as zero.
- The dev smoke is `scripts/smoke/leaderboard.mjs`, and it exists to prove the grant as much as the routes: it spends `SELECT`, `INSERT`, `UPDATE` and `DELETE` at least once each through the API (`rules/manual-verification.md`).
