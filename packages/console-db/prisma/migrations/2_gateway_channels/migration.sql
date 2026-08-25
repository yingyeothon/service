-- AlterEnum: `lobby` and `q` join the channel kinds (realtime gateway).
-- Additive only: existing rows keep their value and no code path reads the new
-- ones until the gateway ships, so this is expand-safe and needs no backfill.
ALTER TABLE `channels`
    MODIFY `kind` ENUM('auth', 'topic', 'match', 'lobby', 'q') NOT NULL;
