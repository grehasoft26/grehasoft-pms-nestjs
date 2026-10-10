-- AlterTable
ALTER TABLE `expenses`
  ADD COLUMN `client_id` INTEGER NULL,
  ADD COLUMN `project_id` INTEGER NULL,
  ADD COLUMN `invoice_id` INTEGER NULL,
  ADD COLUMN `payment_account_source` VARCHAR(100) NULL;

-- CreateIndex
CREATE INDEX `expenses_client_id_idx` ON `expenses`(`client_id`);

-- CreateIndex
CREATE INDEX `expenses_project_id_idx` ON `expenses`(`project_id`);

-- CreateIndex
CREATE INDEX `expenses_invoice_id_idx` ON `expenses`(`invoice_id`);

-- CreateIndex
CREATE INDEX `expenses_payment_account_source_idx` ON `expenses`(`payment_account_source`);

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_client_id_fkey` FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_invoice_id_fkey` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
