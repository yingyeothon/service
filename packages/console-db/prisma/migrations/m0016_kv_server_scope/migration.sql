-- kv gains a fourth scope, `server`, and an entry records who wrote it
-- (docs/decisions.md *Serverless clients* #5-#6, todo/37). Pure expand: no
-- column is dropped or narrowed and no existing row changes value -- so this
-- is deliberately not a gated file, and `scripts/deploy.sh console <stage>`
-- applies it with no flag.
--
-- `server` is inserted in the middle rather than appended, because the enum's
-- declaration order is the console list's sort order and `team, server,
-- project, user` is the order of widening reach. MariaDB 11 converts an ENUM
-- column by **name**, not by ordinal, and it refuses to do it in place at all:
-- ALGORITHM=INPLACE answers ERROR 1846 "Cannot change column type. Try
-- ALGORITHM=COPY" (measured on mariadb:11.8 while writing this). COPY is
-- therefore pinned rather than left to the server -- if a future version ever
-- gains an in-place path for this, it must still rebuild rather than
-- silently reinterpret the stored ordinals. The table holds at most 20 rows
-- per project, so the rebuild is free; LOCK=SHARED blocks writes to
-- kv_collections while it runs.
--
-- NOT NULL is repeated on purpose: a MODIFY that omits it silently makes the
-- column nullable, which would drift from schema.prisma the moment it applies.
--
-- Verify around this file (read-only, per stage, before and after):
--   SELECT read_scope, write_scope, count(*) FROM kv_collections GROUP BY 1, 2
--   SHOW CREATE TABLE kv_collections
-- The multiset must be identical and the indexes, foreign keys and collation
-- must come back unchanged; the COPY re-creates all of them.
--
-- If a statement fails half way (MariaDB DDL is per statement and the shared
-- host's max_statement_time does apply to ALTER TABLE): revert whatever
-- applied, `prisma migrate resolve --rolled-back m0016_kv_server_scope`, then
-- rerun scripts/migrate.sh. Backing this file out later needs every
-- `server`-scoped collection deleted first -- shrinking the enum with such a
-- row is ERROR 1265 under strict mode.
ALTER TABLE `kv_collections`
    MODIFY `read_scope` ENUM('team', 'server', 'project', 'user') NOT NULL,
    MODIFY `write_scope` ENUM('team', 'server', 'project', 'user') NOT NULL,
    ALGORITHM=COPY, LOCK=SHARED;

-- Who wrote the row: an owner's `sub`, or the literals `server` (an apiKey
-- write) and `team` (a console write), neither of which the owner grammar can
-- produce. utf8mb4_bin like every other identity column here. The index is
-- what lets a cross-owner write be charged to its *sender* as well as to its
-- recipient (decisions #6) without scanning the collection.
ALTER TABLE `kv_entries`
    ADD COLUMN `from_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    ADD INDEX `kv_entries_from`(`collection_id`, `from_id`);
