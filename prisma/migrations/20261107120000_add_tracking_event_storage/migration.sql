-- Phase 2: tracking state-transition event storage.
--
-- Additive only. Extends the existing (previously unused) `tracking_activity_log` table in place:
--   * keeps every existing row, column, index and foreign key;
--   * extends the activity_type ENUM (the three original values keep their positions);
--   * adds nullable event columns, a `source` column defaulting to 'legacy', and `occurred_at`;
--   * relaxes `session_id` to NULL (events that no session covers, e.g. late offline events);
--   * adds query indexes and a per-user unique key on client_event_id for idempotency
--     (NULLs are not considered equal, so existing rows without an id do not conflict).
--
-- Generated with `prisma migrate diff` from the previous schema, then hand-edited so that
-- `occurred_at` is backfilled from `timestamp` before it becomes NOT NULL (adding a NOT NULL
-- DATETIME without a default would fail or write zero dates on a table that already has rows).

-- AlterTable: new columns (occurred_at nullable for the backfill below)
ALTER TABLE `tracking_activity_log` ADD COLUMN `client_event_id` VARCHAR(100) NULL,
    ADD COLUMN `device_id` VARCHAR(255) NULL,
    ADD COLUMN `duration_seconds` INTEGER NULL,
    ADD COLUMN `ended_at` DATETIME(3) NULL,
    ADD COLUMN `metadata` JSON NULL,
    ADD COLUMN `occurred_at` DATETIME(3) NULL,
    ADD COLUMN `reason` VARCHAR(64) NULL,
    ADD COLUMN `source` ENUM('legacy', 'desktop_client', 'server_heartbeat', 'server_inferred') NOT NULL DEFAULT 'legacy',
    MODIFY `session_id` INTEGER NULL,
    MODIFY `activity_type` ENUM('active', 'idle', 'offline', 'session_start', 'session_end', 'idle_start', 'idle_end', 'lock', 'unlock', 'sleep', 'resume', 'offline_start', 'offline_end') NOT NULL;

-- Backfill: existing rows only ever had `timestamp`, which is the best available event time
UPDATE `tracking_activity_log` SET `occurred_at` = `timestamp` WHERE `occurred_at` IS NULL;

-- AlterTable: occurred_at is required from now on
ALTER TABLE `tracking_activity_log` MODIFY `occurred_at` DATETIME(3) NOT NULL;

-- CreateIndex
CREATE INDEX `tracking_activity_log_user_id_occurred_at_idx` ON `tracking_activity_log`(`user_id`, `occurred_at`);

-- CreateIndex
CREATE INDEX `tracking_activity_log_session_id_occurred_at_idx` ON `tracking_activity_log`(`session_id`, `occurred_at`);

-- CreateIndex
CREATE INDEX `tracking_activity_log_user_id_device_id_occurred_at_idx` ON `tracking_activity_log`(`user_id`, `device_id`, `occurred_at`);

-- CreateIndex
CREATE UNIQUE INDEX `tracking_activity_log_user_id_client_event_id_key` ON `tracking_activity_log`(`user_id`, `client_event_id`);
