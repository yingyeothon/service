# Key-value store (`kv`)

Design of record: `docs/decisions.md` _Key-value store (`kv`)_ (ten decisions, 2026-09-03). This page is the working reference that sits between that contract and the code: who may do what, where each surface lives, and the order a stage is rolled out in. Route-level detail is in `services/state/README.md` (_KV routes_) and `docs/team-project.md` (console routes and list parameters).

## Principals and scopes

| principal | credential                                                 | entry point                | rights                                                                                      |
| --------- | ---------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `team`    | console session / `yyt_` token + team membership           | console API, SPA, `yyt kv` | read/write/delete every plaintext collection's entries; encrypted: metadata and delete only |
| `server`  | the auth channel's doc apiKey (`yds.{channelId}.{random}`) | KV API on the state stack  | project-scope read/write; every user namespace on behalf of any owner                       |
| `owner`   | the auth channel JWT (`sub` = userId)                      | KV API                     | project-scope read/write; its own user namespace only (`me` alias)                          |

- API principals are bound to the auth channel's `projectId`; a mismatch or a channel without one answers 404, not 403, so a collection id proves nothing about another project.
- Scope matrix: `team` → the API refuses (403); `project` → team, server and owner on every entry; `user` → the owner on its own entries, server and team on all. `writeScope: user` puts every entry in an owner namespace `(collection, ownerId, key)`; otherwise the collection has one shared namespace. `readScope: user` requires `writeScope: user`; `encrypted` requires both scopes in `project | user`.
- `readScope`, `writeScope` and `encrypted` are immutable after creation (the console PATCH names the field and says "delete and recreate"); `name`, `description`, `maxEntries`, `maxEntriesPerOwner` are editable.
- Conditional writes (`If-Match`, `If-None-Match: *`) and `PATCH {incr}` need the read right as well; a compare-and-set 409 carries `{current: version | null}` only (the other 409s — `encrypted`, `owner_full`, `collection_full` — carry `details.reason`).

## Surfaces

- **KV API** (`services/state/src/kvstore.ts`, `doc{-dev}.yyt.life/kv/*`): meta, two listings (shared namespace or every owner; one owner under `/u/{ownerId}`), and GET/PUT/PATCH/DELETE of one entry in either namespace. Values are raw JSON bodies; `ETag` is the version; `x-kv-expires-at` is sent whenever the stored row has an expiry after the write (a `keep` write over a row without one sends nothing).
- **Console API** (`services/console/src/kvstore.ts`): `POST|GET /projects/{prj}/kv`, `GET|PATCH|DELETE /kv/{id}`, and `/kv/{id}/entries` (page with `prefix`, `owner`, `cursor`, `limit`, `order`; single GET/PUT/DELETE; DELETE by owner). Every write takes the per-member write slot and writes audit (collection and owner, never key or value). The console holds no KEK: an encrypted collection is read-only here (PUT → 409 `encrypted`) and its rows carry no `valueText`; a seatless platform admin gets the same shape.
- **SPA** (`apps/console-web`): the project page's _Key-value_ tab (list, sortable by name, scopes, entries, updated; the create drawer with the two scope selects, the encrypted checkbox and the two caps) and the collection page `/ui/kv/{id}` (header badges, the API block as one copyable `name=value` block, the entries table with prefix/owner filters, cursor _Load more_, per-row edit/delete, _New entry_ and _Clear owner_, the edit drawer with the caps and the danger zone). The value column follows the collection's flag and the caller's standing, _Edit_ follows the row: no `valueText`, no edit. Neither surface shows `channelId` outside `--json`; it is an operator's field.
- **CLI** (`cli/internal/cmd/kvstore.go`): `yyt kv list|create|get|update|delete`, `yyt kv entries`, `yyt kv entry get|put|delete|clear` (`cli/README.md` _Key-value collections_). `entry get` prints the value byte for byte for a pipe; `entry put` takes `--value`, `--file` or stdin.
- **Shared rules** (`packages/console-db/src/kvstore.ts`): caps (`KV_COLLECTIONS_PER_PROJECT = 20`, `MAX_KV_VALUE_BYTES = 16 KiB`, `KV_MAX_ENTRIES_HARD = 100_000`, `KV_MAX_ENTRIES_PER_OWNER_HARD = 1_000`), the key grammar `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, the owner grammar (32 hex or `{kind}:{id}`), list limits 1–100 (default 50), TTL 1 s – 366 d, the cursor codec and the compare-and-set. Both writers call the same functions, so the console and the API answer alike.

## Encryption

A stage KEK (`/yyt-service/{stage}/state/kv-kek`, 32 bytes hex) reaches only the state stack's env. Each encrypted collection gets a DEK minted on its first write, wrapped with the KEK (AES-256-GCM, AAD = collection id) and stored in `kv_keys`, which the console never selects. Values are AES-256-GCM under the DEK with the three fields (collection, owner, key) length-prefixed as associated data, stored as `enc1.{iv}.{ct}.{tag}`. A read whose `enc1.` prefix disagrees with the collection's flag, or that fails to decrypt, answers 503 and logs the collection id only. Replacing the KEK makes every stored value unreadable, which is why `scripts/bootstrap-ssm.sh` refuses a different value without `KV_KEK_ROTATE=1`.

## Lifecycle

Deleting a collection soft-deletes it (frees the name at once by parking the row on its own id), drains the rows inline in batches of 1,000 up to ten times, and leaves the rest to the daily sweep (`runKvStoreSweep`: soft-deleted collections, expired rows per live collection, and the rows of auth channels the sweep hard-deleted). Deleting an auth channel purges the rows its players wrote (`channel_id`), best-effort inline and finished by the sweep; rows the console wrote have no channel and survive (owner decision 5 in `todo/33` covers the owner-namespace case).

## Deploy order (per stage)

1. `scripts/bootstrap-ssm.sh <stage> state` — mints `kv-kek` when absent, keeps it otherwise; then `FORCE=1 scripts/get-env.sh <stage> state` and a copy into the private ops repo.
2. `scripts/deploy.sh console <stage>` — applies `m0014_kvstore`.
   - Owner preflight, once per stage, before 3: `select count(*) from channels where kind='auth' and project_id is null` must be 0. `6_org_project` added the column nullable and nothing backfills it; such a channel resolves to no project and 404s on every kv route, indistinguishable from a wrong collection id. A non-zero count means those channels need a project before their keys or JWTs can use kv. (dev 2026-09-04: 0; prod not yet run.)
3. Owner: grant the state account `SELECT` on `kv_collections`, `SELECT, INSERT` on `kv_keys`, `SELECT, INSERT, UPDATE, DELETE` on `kv_entries` (the tables must exist, hence after 2). Until then `/kv/*` answers `503 unavailable`.
4. `scripts/deploy.sh state <stage>` — the KEK is baked into the Lambda env here, so 1 must precede it.
5. `scripts/deploy-web.sh <stage>`; then the smoke (`rules/manual-verification.md`) on dev, and a `yyt kv` round trip on prod.

Rollback and the alarm gap are in `rules/deployment.md` _SSM environment values_.
