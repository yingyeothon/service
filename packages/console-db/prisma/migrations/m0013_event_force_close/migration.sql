-- Early close of a date vote by a platform admin (docs/decisions.md
-- *Hackathon workflow*, todo/25): who forced it, when, and why. Additive only --
-- three nullable columns on an existing table, no backfill -- so it is
-- expand-safe and needs no preflight.

ALTER TABLE `events`
    ADD COLUMN `vote_closed_at` BIGINT NULL,
    ADD COLUMN `vote_closed_by` VARCHAR(64) NULL,
    ADD COLUMN `vote_closed_reason` VARCHAR(500) NULL;
