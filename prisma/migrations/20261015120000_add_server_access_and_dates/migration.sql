-- AlterTable
ALTER TABLE `servers`
  ADD COLUMN `username` VARCHAR(255) NULL,
  ADD COLUMN `password` TEXT NULL,
  ADD COLUMN `phone_number` VARCHAR(50) NULL,
  ADD COLUMN `purchase_date` DATE NULL,
  ADD COLUMN `expiry_date` DATE NULL;
