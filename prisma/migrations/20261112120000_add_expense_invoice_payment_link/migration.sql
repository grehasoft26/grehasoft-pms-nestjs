-- Explicit link from an expense to the invoice payment it was recorded from ("Also record an expense").
-- Nullable: existing expenses stay unlinked (no backfill). Unique: at most one expense per payment.
-- Deleting a payment keeps the expense and clears the link (ON DELETE SET NULL).

-- AlterTable
ALTER TABLE `expenses` ADD COLUMN `invoice_payment_id` INTEGER NULL;

-- CreateIndex
CREATE UNIQUE INDEX `expenses_invoice_payment_id_key` ON `expenses`(`invoice_payment_id`);

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_invoice_payment_id_fkey` FOREIGN KEY (`invoice_payment_id`) REFERENCES `invoice_payments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
