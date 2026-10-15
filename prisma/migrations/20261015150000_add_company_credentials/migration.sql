-- CreateTable
CREATE TABLE `company_credentials` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `category` ENUM('EMAIL', 'HOSTING', 'DOMAIN_REGISTRAR', 'DEVELOPMENT_TOOLS', 'BUSINESS_TOOLS', 'OTHER') NOT NULL DEFAULT 'OTHER',
    `provider` VARCHAR(255) NULL,
    `login_url` VARCHAR(500) NULL,
    `username` VARCHAR(255) NULL,
    `password` TEXT NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `company_credentials_category_idx`(`category`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
