-- Domain & server renewals: default renewal period on both, and the renewal history table.
-- Additive only: two nullable columns per table and a new table; no existing data is changed.
-- Generated with `prisma migrate diff` from the previous schema.prisma.

-- AlterTable
ALTER TABLE `servers` ADD COLUMN `renewal_period_unit` ENUM('month', 'year') NULL,
    ADD COLUMN `renewal_period_value` INTEGER NULL;

-- AlterTable
ALTER TABLE `domains` ADD COLUMN `renewal_period_unit` ENUM('month', 'year') NULL,
    ADD COLUMN `renewal_period_value` INTEGER NULL;

-- CreateTable
CREATE TABLE `asset_renewals` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `asset_type` ENUM('domain', 'server') NOT NULL,
    `asset_id` INTEGER NOT NULL,
    `asset_name` VARCHAR(255) NOT NULL,
    `domain_id` INTEGER NULL,
    `server_id` INTEGER NULL,
    `event` ENUM('renewed', 'failed', 'manual_change') NOT NULL,
    `previous_expiry_date` DATE NULL,
    `new_expiry_date` DATE NULL,
    `renewal_date` DATE NULL,
    `period_value` INTEGER NULL,
    `period_unit` ENUM('month', 'year') NULL,
    `cost` DECIMAL(10, 2) NULL,
    `payment_reference` VARCHAR(255) NULL,
    `notes` TEXT NULL,
    `failure_reason` TEXT NULL,
    `reminder_id` INTEGER NULL,
    `performed_by_id` INTEGER NULL,
    `performed_by_name` VARCHAR(150) NULL,
    `idempotency_key` VARCHAR(64) NULL,
    `cycle_key` VARCHAR(64) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `asset_renewals_idempotency_key_key`(`idempotency_key`),
    UNIQUE INDEX `asset_renewals_cycle_key_key`(`cycle_key`),
    INDEX `asset_renewals_asset_type_asset_id_created_at_idx`(`asset_type`, `asset_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `asset_renewals` ADD CONSTRAINT `asset_renewals_domain_id_fkey` FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asset_renewals` ADD CONSTRAINT `asset_renewals_server_id_fkey` FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asset_renewals` ADD CONSTRAINT `asset_renewals_reminder_id_fkey` FOREIGN KEY (`reminder_id`) REFERENCES `reminders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asset_renewals` ADD CONSTRAINT `asset_renewals_performed_by_id_fkey` FOREIGN KEY (`performed_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
