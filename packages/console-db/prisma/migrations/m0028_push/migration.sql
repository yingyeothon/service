-- Push notifications (docs/decisions.md *Push notifications (Android, FCM)*,
-- todo/56 P0). One enum value appended to `channels`.`kind` and four new
-- tables. Pure **expand** -- nothing existing is dropped or narrowed -- so
-- this is deliberately not a `-- contract` file and
-- `scripts/deploy.sh console <stage>` applies it with no flag.
--
--   * `push_apps`       the registration claim, one row per push channel
--                       (console only);
--   * `push_pool`       which slots of the Firebase project pool are closed to
--                       new registrations (console only);
--   * `push_tokens`     device tokens, written by the state stack;
--   * `push_send_stats` one counter row per channel and UTC day, written by
--                       the state stack and read by the console digest.
--
-- Grants, by hand in the private ops repo *after* this runs (a `GRANT` on an
-- absent table is `ERROR 1146` and grants nothing):
--   * the state account gains `SELECT, INSERT, UPDATE, DELETE` on
--     `push_tokens`; its `SELECT` on `channels` already exists. Every
--     `/push/*` route answers 503 until then. The token upsert is
--     `INSERT ... ON DUPLICATE KEY UPDATE` plus a read and a delete of the
--     user's rows, so it spends all four;
--   * the state account gains `SELECT, INSERT, UPDATE` on `push_send_stats`.
--     `INSERT ... ON DUPLICATE KEY UPDATE col = col + VALUES(col)` needs
--     `INSERT`, `UPDATE` on the assigned columns **and `SELECT` on the columns
--     the assignment reads** (measured on `mariadb:10.5`: without `SELECT`
--     the statement is `ERROR 1143`, even when it inserts). No `DELETE`: the
--     console removes old days. Without this grant a send still succeeds --
--     the counter write is best effort and its failure is one log line;
--   * the match account later (todo/56 P1) gains `SELECT` on `push_tokens`;
--   * nobody but console is granted `push_apps` or `push_pool`.
-- Who can read `push_tokens` today is wider than those grants: auth, topic and
-- match hold a database-level `SELECT` (`rules/security.md`, the 2026-09-28
-- `SHOW GRANTS` finding), so all three can read device tokens until the owner
-- narrows those accounts. Only the state account is table-scoped.
--
-- What an old bundle sees. `push` goes on the end of the enum, so the stored
-- ordinals and the list's sort order of the five existing kinds do not move,
-- and nothing reads the value until a `push` row exists -- which only the
-- console bundle that follows this file can create. From that row on
-- (`rules/deployment.md`, the `m0016` lesson) **every** older generated
-- client throws on the enum value it does not know whenever a statement
-- returns the row:
--   * an older **console** fails every read that returns it -- the channel
--     list of that team and project, and the daily expiry sweep once the row
--     is due. Hard-delete the `push` rows (and their `push_apps` rows) before
--     rolling console back past this file;
--   * an older **auth, topic or match** reads a channel by id and checks the
--     kind afterwards (`findAuthChannel` and friends), so a request naming a
--     push channel's id where another kind's id belongs throws (a 5xx)
--     instead of answering 404. The rollout therefore redeploys auth, topic
--     and match after console and **before the first push channel exists**
--     (`rules/deployment.md`, *Push rollout order*); state ships with push.
-- The four tables did not exist, so no generated client anywhere selects
-- them, and `push_apps`.`sender` is an enum on a table of its own.
--
-- Verify around this file (read-only, per stage):
--   SHOW CREATE TABLE channels
--   SELECT kind, count(*) FROM channels GROUP BY kind
--   SHOW CREATE TABLE push_apps
--   SHOW CREATE TABLE push_pool
--   SHOW CREATE TABLE push_tokens
--   SHOW CREATE TABLE push_send_stats
-- `channels`.`kind` must still be `NOT NULL` and the per-kind counts
-- identical before and after. `push_tokens`.`user_id` must show
-- `utf8mb4_bin` and every table `utf8mb4_unicode_ci`. The plans the tables
-- exist for (expect `range`/`ref` on the named index, never `ALL`):
--   EXPLAIN SELECT user_id, token, firebase_project FROM push_tokens
--    WHERE channel_id = 'x' AND user_id IN ('a', 'b')     -- push_tokens_user
--   EXPLAIN DELETE FROM push_tokens WHERE updated_at < 0  -- push_tokens_stale
--   EXPLAIN DELETE FROM push_send_stats WHERE day < 0     -- push_send_stats_day
--
-- If a statement fails half way (MariaDB DDL is per statement): drop
-- whichever of the four tables were created (`push_apps` first, it holds the
-- foreign key), leave the enum as it is -- an unused trailing value harms
-- nothing, and shrinking it back is `ERROR 1265` once a `push` row exists --
-- then `prisma migrate resolve --rolled-back m0028_push` and rerun
-- scripts/migrate.sh. Backing this file out **later**: delete the `push`
-- channel rows, then four `DROP TABLE`s, `push_tokens` in bounded batches
-- first.

-- Appended, never inserted mid-list: a trailing ENUM value is added in place,
-- and the explicit ALGORITHM makes a server that could not do so fail here
-- instead of rebuilding `channels` quietly (rules/data.md).
ALTER TABLE `channels`
    MODIFY `kind` ENUM('auth', 'topic', 'match', 'lobby', 'q', 'push') NOT NULL,
    ALGORITHM=INSTANT;

-- The registration claim of a push channel. It is what makes three rules
-- transactional (`PushDb.claimApp`): a package name is unique per stage among
-- the `platform` claims, a slot takes at most 20 platform registrations, and
-- `push.appsPerTeam` counts a team's `platform` rows.
--
-- Uniqueness is the `platform` claims' alone. A `team`-sender channel
-- registers nothing in the pool -- its key and its Firebase project are the
-- team's own -- so its row must not take a name out of the stage: it would
-- cost its holder nothing and no cap counts it. `platform_package` carries
-- the name for a `platform` row and NULL for a `team` row, and the unique
-- index is on that column (NULLs never collide). A plain nullable column
-- with a CHECK rather than a generated one: Prisma does not model generated
-- columns, and `prisma migrate diff` must stay empty.
--
-- Both name columns keep the database default collation, so two spellings
-- that differ only by case are one name here: refusing the second is the
-- safe direction for a name that is unique in a Firebase project too.
--
-- `slot` is the pool label (`p1`, `p2`, ...), never a Firebase project id. A
-- `team`-sender channel holds no slot and counts against neither limit; the
-- CHECKs tie the columns together (SQL only, Prisma does not model them).
--
-- The foreign key is the safety net, not the release path: a deleted channel
-- gives its claim back explicitly (`PushDb.deleteApp`), and the purge of the
-- channel row 30 days later cascades whatever was left. One row per channel,
-- so the cascade is one row.
CREATE TABLE `push_apps` (
    `channel_id` VARCHAR(64) NOT NULL,
    `team_id` VARCHAR(64) NOT NULL,
    `package_name` VARCHAR(255) NOT NULL,
    -- `package_name` again for a `platform` row, NULL for a `team` row.
    `platform_package` VARCHAR(255) NULL,
    `sender` ENUM('platform', 'team') NOT NULL,
    `slot` VARCHAR(32) NULL,
    -- NULL until Firebase answered the registration.
    `firebase_app_id` VARCHAR(255) NULL,
    `created_at` BIGINT NOT NULL,

    UNIQUE INDEX `push_apps_package`(`platform_package`),
    -- Per-slot counts and the reconciliation's per-slot list.
    INDEX `push_apps_slot`(`slot`),
    -- The team cap: `team_id = ? AND sender = 'platform'`.
    INDEX `push_apps_team`(`team_id`, `sender`),
    CONSTRAINT `push_apps_slot_sender` CHECK ((`sender` = 'team') + (`slot` IS NOT NULL) = 1),
    CONSTRAINT `push_apps_platform_package` CHECK (`platform_package` <=> IF(`sender` = 'platform', `package_name`, NULL)),
    PRIMARY KEY (`channel_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `push_apps` ADD CONSTRAINT `push_apps_channel_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- A slot of the pool closed to new registrations. The pool itself is the
-- stage's SSM path, so a slot with no row here is open; a claim materialises
-- the rows it locks. `closed_by` is a display-only actor column (no foreign
-- key, like `events`.`vote_closed_by`): a member id, or the platform's own
-- `auto:firebase-limit`, which is the only closure the daily sweep reopens.
CREATE TABLE `push_pool` (
    `slot` VARCHAR(32) NOT NULL,
    `closed_at` BIGINT NULL,
    `closed_by` VARCHAR(64) NULL,
    `updated_at` BIGINT NOT NULL,

    PRIMARY KEY (`slot`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One row per device token **per channel**. A token can be long, so its
-- identity inside a channel is its sha256 (`token_hash`, lowercase hex), and
-- the primary key is `(channel_id, token_hash)`: registering a token in one
-- channel never removes or moves another channel's row, and inside one
-- channel a token registered again by another user **moves** to that user.
-- `user_id` is `utf8mb4_bin` like every player-id column; `channel_id` keeps
-- the default so it compares with `channels`.`id`.
--
-- **No foreign key to `channels`**, like `social_profiles`: a channel holds
-- up to 5 tokens per player, and a cascade would run inside the purge's one
-- `DELETE FROM channels` against a 5 s `max_statement_time`. The console
-- deletes these rows explicitly, in bounded batches.
--
-- `platform` is a VARCHAR, not an ENUM: the match stack reads this table,
-- and a later value must not be one its generated client throws on.
--
-- Access paths:
--   * the primary key answers a token's own write and delete, and a
--     channel's purge (`channel_id = ?` is its prefix);
--   * `push_tokens_user` answers a send (`channel_id = ? AND user_id IN
--     (...)`), a user's own rows, the 5-per-user cap and its eviction order;
--   * `push_tokens_stale` is the 60-day sweep, which is global rather than
--     per channel, so `updated_at` leads (rules/data.md).
CREATE TABLE `push_tokens` (
    `channel_id` VARCHAR(64) NOT NULL,
    `token_hash` VARCHAR(64) NOT NULL,
    `user_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `token` VARCHAR(4096) NOT NULL,
    `firebase_project` VARCHAR(64) NOT NULL,
    `platform` VARCHAR(16) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `push_tokens_user`(`channel_id`, `user_id`, `updated_at`),
    INDEX `push_tokens_stale`(`updated_at`),
    PRIMARY KEY (`channel_id`, `token_hash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- What the targeted send did, per channel and UTC day (`day` is the day
-- number, `floor(unix seconds / 86400)`). The state stack adds one send
-- call's counts with one upsert, best effort; the console's daily digest
-- reads yesterday's failures and deletes rows older than 30 days. Counts
-- only: no user id and nothing of a device.
--
-- `calls` is send requests; `sent`, `no_token` and `failed` count the users
-- of those requests by their reported status; `unregistered` counts device
-- tokens FCM reported gone (and the send deleted).
--
-- **No foreign key to `channels`**, for the reason `push_tokens` has none;
-- at most 30 rows per channel, and the channel's purge drains them.
--
-- `push_send_stats_day` leads with `day` because both of its readers are
-- global, not per channel (rules/data.md, the global-sweep index lesson):
-- the digest's `day = ? AND failed > 0 ORDER BY failed DESC LIMIT n` and the
-- retention's `day < ? LIMIT n`.
CREATE TABLE `push_send_stats` (
    `channel_id` VARCHAR(64) NOT NULL,
    `day` INTEGER NOT NULL,
    `calls` BIGINT NOT NULL,
    `sent` BIGINT NOT NULL,
    `no_token` BIGINT NOT NULL,
    `failed` BIGINT NOT NULL,
    `unregistered` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `push_send_stats_day`(`day`, `failed`),
    PRIMARY KEY (`channel_id`, `day`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
