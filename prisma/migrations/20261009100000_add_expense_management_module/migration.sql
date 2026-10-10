-- CreateTable
CREATE TABLE `expense_categories` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(150) NOT NULL,
    `description` TEXT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `expense_categories_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expenses` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(255) NOT NULL,
    `category_id` INTEGER NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `expense_date` DATE NOT NULL,
    `vendor` VARCHAR(200) NULL,
    `reference_number` VARCHAR(100) NULL,
    `payment_method` ENUM('cash', 'upi', 'bank_transfer', 'company_card', 'other') NOT NULL DEFAULT 'cash',
    `payment_status` ENUM('pending', 'partially_paid', 'paid') NOT NULL DEFAULT 'paid',
    `amount_paid` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `outstanding_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `gst_number` VARCHAR(50) NULL,
    `gst_amount` DECIMAL(12, 2) NULL DEFAULT 0.00,
    `notes` TEXT NULL,
    `receipt_file` VARCHAR(255) NULL,
    `receipt_filename` VARCHAR(255) NULL,
    `employee_id` INTEGER NULL,
    `user_id` INTEGER NULL,
    `approval_status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'approved',
    `created_by_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `expenses_expense_date_idx`(`expense_date`),
    INDEX `expenses_category_id_idx`(`category_id`),
    INDEX `expenses_payment_status_idx`(`payment_status`),
    INDEX `expenses_approval_status_idx`(`approval_status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
