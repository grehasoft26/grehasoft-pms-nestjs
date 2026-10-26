-- Credential Vault audit trail (Stage 4). Additive only: creates one new table, changes nothing else.
-- Stores actor, credential type/id, action, time, IP and user agent; never secrets, ciphertext or keys.

-- CreateTable
CREATE TABLE `credential_audit_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `actor_id` INTEGER NULL,
    `actor_username` VARCHAR(150) NOT NULL,
    `credential_type` VARCHAR(50) NOT NULL,
    `credential_id` INTEGER NULL,
    `action` VARCHAR(30) NOT NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `credential_audit_logs_credential_type_credential_id_created__idx`(`credential_type`, `credential_id`, `created_at`),
    INDEX `credential_audit_logs_actor_id_created_at_idx`(`actor_id`, `created_at`),
    INDEX `credential_audit_logs_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

