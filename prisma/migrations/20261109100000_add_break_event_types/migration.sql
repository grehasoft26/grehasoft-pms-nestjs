-- Stage 4: manual break tracking. Adds the `break_start` and `break_end` event types.
--
-- Additive only: extends the `activity_type` ENUM of `tracking_activity_log` by appending two values, so every
-- existing value keeps its position and every existing row, column, index, unique key and foreign key is untouched.
-- (MariaDB/MySQL rewrite the column definition; no row data changes because only new values are added at the end.)
-- No new index is needed: break events are read through the existing (user_id, occurred_at),
-- (session_id, occurred_at) and (user_id, device_id, occurred_at) indexes.

-- AlterTable
ALTER TABLE `tracking_activity_log` MODIFY `activity_type` ENUM('active', 'idle', 'offline', 'session_start', 'session_end', 'idle_start', 'idle_end', 'lock', 'unlock', 'sleep', 'resume', 'offline_start', 'offline_end', 'break_start', 'break_end') NOT NULL;
