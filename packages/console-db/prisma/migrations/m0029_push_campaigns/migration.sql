-- Push campaigns (docs/decisions.md *Push notifications (Android, FCM)* #9,
-- todo/56 P2). Three new tables and nothing else. Pure **expand** -- nothing
-- existing is dropped, narrowed or altered -- so this is deliberately not a
-- `-- contract` file and `scripts/deploy.sh console <stage>` applies it with
-- no flag.
--
--   * `push_templates`  message templates of a push channel, at most 20;
--   * `push_uploads`    recipient CSVs a presigned PUT was issued for;
--   * `push_jobs`       campaign, dry-run and broadcast jobs: the queue the
--                       console's `pushJob` worker drains, and their results.
--
-- Grants: **console only**. No other account is granted any of the three,
-- and none needs one: the worker is a function of the console stack. The
-- worker reads `push_tokens` and adds to `push_send_stats` with the console
-- account, which owns both. Accounts holding a database-level `SELECT` (auth,
-- topic, match; `rules/security.md`) can read these tables like every other;
-- they hold user ids of recipients nowhere -- a job row carries counts only
-- and the recipient list stays in S3.
--
-- What an old bundle sees: nothing. The tables did not exist, so no generated
-- client anywhere selects them, and `kind` / `status` are VARCHARs with a
-- CHECK rather than ENUMs, so a value added later cannot make an older
-- console bundle throw on a row it reads. Rolling console back past this
-- file needs no data step: the older bundle has no route that reads them,
-- and jobs left `queued` simply never run.
--
-- Verify around this file (read-only, per stage):
--   SHOW CREATE TABLE push_templates
--   SHOW CREATE TABLE push_uploads
--   SHOW CREATE TABLE push_jobs
-- Every table must show `utf8mb4_unicode_ci`. The plans the indexes exist
-- for (expect `ref`/`range` on the named index, never `ALL`):
--   EXPLAIN SELECT id FROM push_jobs WHERE channel_id = 'x'
--    ORDER BY created_at DESC, id DESC LIMIT 20            -- push_jobs_channel
--   EXPLAIN SELECT count(*) FROM push_jobs
--    WHERE day = 1 AND channel_id = 'x' AND dry_run = 0    -- push_jobs_day
--   EXPLAIN SELECT id FROM push_jobs
--    WHERE status IN ('queued', 'running') AND lease_until <= 1
--    ORDER BY lease_until LIMIT 1                          -- push_jobs_runnable
--   EXPLAIN DELETE FROM push_jobs WHERE finished_at < 0    -- push_jobs_finished
--   EXPLAIN DELETE FROM push_uploads WHERE created_at < 0  -- push_uploads_created
--
-- If a statement fails half way (MariaDB DDL is per statement): drop
-- whichever of the three tables were created (`push_templates` first, it
-- holds the foreign key), then `prisma migrate resolve --rolled-back
-- m0029_push_campaigns` and rerun scripts/migrate.sh. Backing this file out
-- later: three `DROP TABLE`s; the S3 objects under `push-uploads/` and
-- `push-reports/` expire by the bucket's lifecycle rules.

-- A message template of a push channel: `title`, `body` and the values of
-- `data_json` (a JSON object of strings) may hold `{{var}}` placeholders that
-- a campaign fills from its CSV. At most 20 per channel, a code constant
-- counted under the channel row's lock (`PushJobsDb.createTemplate`).
--
-- `name` keeps the database default collation, so two spellings that differ
-- only by case are one name; the grammar is ASCII without blanks, so PAD
-- SPACE and accent folding have nothing to fold.
--
-- `created_by` / `updated_by` are display-only actor columns (member ids, no
-- foreign key, like `push_pool`.`closed_by`).
--
-- The foreign key cascades: at most 20 small rows per channel, so the purge
-- of a channel row takes them inside its one statement.
CREATE TABLE `push_templates` (
    `id` VARCHAR(64) NOT NULL,
    `channel_id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `title` VARCHAR(1024) NOT NULL,
    `body` VARCHAR(4096) NOT NULL,
    `data_json` TEXT NOT NULL,
    `created_by` VARCHAR(64) NOT NULL,
    `updated_by` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    UNIQUE INDEX `push_templates_name`(`channel_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `push_templates` ADD CONSTRAINT `push_templates_channel_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- A recipient CSV a presigned PUT was issued for. The object's key is derived
-- from `channel_id` and `id` (`push-uploads/{channel_id}/{id}.csv`), so the
-- row stores no key. `size` is the byte length signed into the URL; a job is
-- refused unless the stored object has exactly that length.
--
-- A row is the upload's whole state: whether the object exists is asked of
-- S3 when a job names it. Rows older than two days are swept with their
-- objects, except while an unfinished job reads one.
--
-- **No foreign key to `channels`**: the table is swept by age, globally, and
-- a channel's delete drains it in bounded batches like `push_tokens`.
--
-- `created_by` is a member id or the literal `apikey`.
CREATE TABLE `push_uploads` (
    `id` VARCHAR(64) NOT NULL,
    `channel_id` VARCHAR(64) NOT NULL,
    `size` BIGINT NOT NULL,
    `created_by` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,

    -- A channel's live uploads (the cap) and its purge.
    INDEX `push_uploads_channel`(`channel_id`),
    -- The age sweep, which is global, so `created_at` leads.
    INDEX `push_uploads_created`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One campaign, dry run or broadcast. The row is the queue entry, the
-- progress and the result: the `pushJob` worker claims it with a lease,
-- advances `cursor_row` after every batch and ends it `done` or `failed`.
--
--   * `kind`     `campaign` (a CSV of recipients) or `broadcast` (one topic
--                message per Firebase project of the channel);
--   * `dry_run`  a campaign that resolves and counts but sends nothing; it
--                does not count against `push.jobsPerDay`;
--   * `status`   `queued` -> `running` -> `done` | `failed`. A cancelled job
--                is `failed` with `error` = `canceled`;
--   * `title`, `body`, `data_json`, `options_json`  the message as it was at
--                submit time: a later template edit does not change a job;
--   * `params_hash`  sha256 of what the submit named, so a repeated
--                `idempotency_key` with other parameters is told apart;
--   * `day`      the UTC day number of `created_at`, what the daily cap and
--                the digest group by;
--   * `total`    data rows of the CSV, NULL until the worker counted them;
--   * `cursor_row`  data rows fully processed (sent or skipped, reported and
--                counted). A batch advances it in the statement that adds
--                the batch's counts, so a crash resends one batch at most;
--   * the counters are per user (row), not per device: `resolved` rows with
--     a token, `sent`, `no_token`, `unregistered` (every device was gone),
--     `failed`, and the three kinds of skipped row -- `duplicates`,
--     `missing` (a template variable was empty) and `invalid` (a bad user
--     id, or a rendered message over the size limit);
--   * `lease_owner` / `lease_until`  the claim. A row is runnable while its
--     status is `queued` or `running` and `lease_until` is not in the
--     future; a worker that yields sets `lease_owner` NULL, so a claim that
--     finds an owner knows the previous run died and counts an `attempts`;
--   * `report_at`  when the per-row report object was written
--                (`push-reports/{channel_id}/{id}.csv`); NULL while there is
--                none. The report is offered for 7 days from then;
--   * `author`   a member id, or the literal `apikey`.
--
-- `kind` and `status` are VARCHARs with a CHECK, not ENUMs (the header).
-- `cursor_row`, not `cursor`: the latter is a reserved word.
--
-- **No foreign key to `channels`** and none to `push_uploads` or
-- `push_templates`: finished rows are swept by age, a channel's delete
-- drains them in bounded batches, and a job must outlive the template it
-- was made from.
--
-- Access paths:
--   * `push_jobs_idem` is the idempotency key, unique per channel for as
--     long as the row is kept;
--   * `push_jobs_channel` lists a channel's jobs newest first and drains
--     them on a purge;
--   * `push_jobs_day` counts a channel's jobs of one UTC day (the
--     `push.jobsPerDay` claim, taken under the channel row's lock) and gives
--     the digest every channel's jobs of a day, so `day` leads;
--   * `push_jobs_runnable` is the worker's claim and the stuck-job sweep;
--   * `push_jobs_finished` is the retention sweep, global;
--   * `push_jobs_upload` answers "does an unfinished job read this upload".
CREATE TABLE `push_jobs` (
    `id` VARCHAR(64) NOT NULL,
    `channel_id` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `dry_run` BOOLEAN NOT NULL,
    `idempotency_key` VARCHAR(64) NOT NULL,
    `params_hash` VARCHAR(64) NOT NULL,
    `template_id` VARCHAR(64) NULL,
    `title` VARCHAR(1024) NOT NULL,
    `body` VARCHAR(4096) NOT NULL,
    `data_json` TEXT NOT NULL,
    `options_json` VARCHAR(255) NOT NULL,
    `upload_id` VARCHAR(64) NULL,
    `upload_etag` VARCHAR(128) NULL,
    `day` INTEGER NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `error` VARCHAR(32) NULL,
    `error_detail` VARCHAR(255) NULL,
    `cancel_requested` BOOLEAN NOT NULL,
    `total` INTEGER NULL,
    `cursor_row` INTEGER NOT NULL,
    `resolved` INTEGER NOT NULL,
    `sent` INTEGER NOT NULL,
    `no_token` INTEGER NOT NULL,
    `unregistered` INTEGER NOT NULL,
    `failed` INTEGER NOT NULL,
    `duplicates` INTEGER NOT NULL,
    `missing` INTEGER NOT NULL,
    `invalid` INTEGER NOT NULL,
    `attempts` INTEGER NOT NULL,
    `lease_owner` VARCHAR(64) NULL,
    `lease_until` BIGINT NOT NULL,
    `author` VARCHAR(64) NOT NULL,
    `created_at` BIGINT NOT NULL,
    `started_at` BIGINT NULL,
    `finished_at` BIGINT NULL,
    `report_at` BIGINT NULL,
    `updated_at` BIGINT NOT NULL,

    UNIQUE INDEX `push_jobs_idem`(`channel_id`, `idempotency_key`),
    INDEX `push_jobs_channel`(`channel_id`, `created_at`),
    INDEX `push_jobs_day`(`day`, `channel_id`, `dry_run`),
    INDEX `push_jobs_runnable`(`status`, `lease_until`),
    INDEX `push_jobs_finished`(`finished_at`),
    INDEX `push_jobs_upload`(`upload_id`),
    CONSTRAINT `push_jobs_kind` CHECK (`kind` IN ('campaign', 'broadcast')),
    CONSTRAINT `push_jobs_status` CHECK (`status` IN ('queued', 'running', 'done', 'failed')),
    -- A campaign reads an upload and a broadcast reads none.
    CONSTRAINT `push_jobs_upload_kind` CHECK ((`kind` = 'campaign') + (`upload_id` IS NULL) = 1),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
