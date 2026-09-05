-- AlterTable
ALTER TABLE `invoice_payments` ADD COLUMN `receipt_number` VARCHAR(50) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `invoice_payments_receipt_number_key` ON `invoice_payments`(`receipt_number`);
