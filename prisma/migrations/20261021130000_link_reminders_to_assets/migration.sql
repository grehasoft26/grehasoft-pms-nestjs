-- Reminders can be linked to the domain or server they are about (renewal reminders).
-- Additive: two nullable columns, two indexes, two foreign keys (ON DELETE SET NULL: deleting an
-- asset keeps the reminder and clears the link) and two triggers. No existing row is changed;
-- legacy "Domain Renewal: <name>" reminders are linked separately, after review
-- (prisma/runbooks/reminder-link-backfill.ts).
-- The ALTER TABLE ... ADD CONSTRAINT statements rebuild `reminders` (MySQL copies the table when
-- adding a foreign key with foreign_key_checks on): run in the maintenance window.
-- Generated with `prisma migrate diff`; the triggers are hand-written (Prisma does not model them).

-- AlterTable
ALTER TABLE `reminders` ADD COLUMN `domain_id` INTEGER NULL,
    ADD COLUMN `server_id` INTEGER NULL;

-- CreateIndex
CREATE INDEX `reminders_domain_id_is_completed_idx` ON `reminders`(`domain_id`, `is_completed`);

-- CreateIndex
CREATE INDEX `reminders_server_id_is_completed_idx` ON `reminders`(`server_id`, `is_completed`);

-- AddForeignKey
ALTER TABLE `reminders` ADD CONSTRAINT `reminders_domain_id_fkey` FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reminders` ADD CONSTRAINT `reminders_server_id_fkey` FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- A reminder is linked to a domain OR a server, never both. A CHECK constraint is not possible:
-- MySQL refuses CHECK constraints on columns used by a foreign key referential action
-- (ERROR 3823), so the rule is enforced by triggers (the ON DELETE SET NULL cascades only clear
-- links and never conflict with them).
CREATE TRIGGER `reminders_single_asset_bi` BEFORE INSERT ON `reminders` FOR EACH ROW
BEGIN
  IF NEW.`domain_id` IS NOT NULL AND NEW.`server_id` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A reminder can be linked to a domain or a server, not both';
  END IF;
END;

CREATE TRIGGER `reminders_single_asset_bu` BEFORE UPDATE ON `reminders` FOR EACH ROW
BEGIN
  IF NEW.`domain_id` IS NOT NULL AND NEW.`server_id` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A reminder can be linked to a domain or a server, not both';
  END IF;
END;
