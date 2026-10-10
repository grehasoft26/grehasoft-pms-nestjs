-- CreateTable
CREATE TABLE `seo_report` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `client_id` INTEGER NOT NULL,
    `website_id` INTEGER NOT NULL,
    `report_title` VARCHAR(255) NOT NULL,
    `report_month` VARCHAR(7) NOT NULL,
    `period_start_date` DATE NOT NULL,
    `period_end_date` DATE NOT NULL,
    `status` ENUM('draft', 'under_review', 'approved', 'generated', 'published') NOT NULL DEFAULT 'draft',
    `data_source` ENUM('manual', 'imported', 'gsc_api', 'ga4_api', 'gbp_api', 'hybrid') NOT NULL DEFAULT 'manual',
    `executive_summary` TEXT NULL,
    `key_achievements` JSON NULL,
    `challenges_notes` TEXT NULL,
    `recommendations` JSON NULL,
    `next_month_plan` JSON NULL,
    `domain_authority` INTEGER NULL DEFAULT 0,
    `previous_da` INTEGER NULL DEFAULT 0,
    `page_authority` INTEGER NULL DEFAULT 0,
    `spam_score` INTEGER NULL DEFAULT 0,
    `health_score` INTEGER NULL DEFAULT 100,
    `total_indexed_pages` INTEGER NULL DEFAULT 0,
    `total_backlinks` INTEGER NULL DEFAULT 0,
    `gsc_clicks` INTEGER NULL DEFAULT 0,
    `gsc_prev_clicks` INTEGER NULL DEFAULT 0,
    `gsc_impressions` INTEGER NULL DEFAULT 0,
    `gsc_prev_impressions` INTEGER NULL DEFAULT 0,
    `gsc_avg_ctr` DOUBLE NULL DEFAULT 0.0,
    `gsc_prev_avg_ctr` DOUBLE NULL DEFAULT 0.0,
    `gsc_avg_position` DOUBLE NULL DEFAULT 0.0,
    `gsc_prev_avg_position` DOUBLE NULL DEFAULT 0.0,
    `ga4_organic_users` INTEGER NULL DEFAULT 0,
    `ga4_prev_users` INTEGER NULL DEFAULT 0,
    `ga4_new_users` INTEGER NULL DEFAULT 0,
    `ga4_sessions` INTEGER NULL DEFAULT 0,
    `ga4_prev_sessions` INTEGER NULL DEFAULT 0,
    `ga4_engagement_rate` DOUBLE NULL DEFAULT 0.0,
    `ga4_avg_session_duration` VARCHAR(20) NULL,
    `gbp_profile_views` INTEGER NULL DEFAULT 0,
    `gbp_prev_views` INTEGER NULL DEFAULT 0,
    `gbp_interactions` INTEGER NULL DEFAULT 0,
    `gbp_phone_calls` INTEGER NULL DEFAULT 0,
    `gbp_direction_requests` INTEGER NULL DEFAULT 0,
    `gbp_website_clicks` INTEGER NULL DEFAULT 0,
    `last_synced_at` DATETIME(3) NULL,
    `manually_edited` BOOLEAN NOT NULL DEFAULT false,
    `pdf_file_path` VARCHAR(255) NULL,
    `pdf_filename` VARCHAR(255) NULL,
    `pdf_file_size` INTEGER NULL DEFAULT 0,
    `pdf_generated_at` DATETIME(3) NULL,
    `created_by_id` INTEGER NOT NULL,
    `approved_by_id` INTEGER NULL,
    `approved_at` DATETIME(3) NULL,
    `published_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `seo_report_client_id_report_month_idx`(`client_id`, `report_month`),
    INDEX `seo_report_status_idx`(`status`),
    UNIQUE INDEX `seo_report_website_id_report_month_key`(`website_id`, `report_month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seo_report_keyword` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `report_id` INTEGER NOT NULL,
    `keyword` VARCHAR(255) NOT NULL,
    `target_url` VARCHAR(255) NULL,
    `search_engine` VARCHAR(50) NOT NULL DEFAULT 'Google',
    `initial_rank` INTEGER NULL DEFAULT 0,
    `previous_rank` INTEGER NULL DEFAULT 0,
    `current_rank` INTEGER NULL DEFAULT 0,
    `target_rank` INTEGER NULL DEFAULT 1,
    `rank_change` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seo_report_top_query` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `report_id` INTEGER NOT NULL,
    `query_text` VARCHAR(255) NOT NULL,
    `clicks` INTEGER NOT NULL DEFAULT 0,
    `impressions` INTEGER NOT NULL DEFAULT 0,
    `ctr` DOUBLE NOT NULL DEFAULT 0.0,
    `average_position` DOUBLE NOT NULL DEFAULT 0.0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seo_report_traffic_source` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `report_id` INTEGER NOT NULL,
    `channel_group` VARCHAR(100) NOT NULL,
    `users_count` INTEGER NOT NULL DEFAULT 0,
    `percentage` DOUBLE NOT NULL DEFAULT 0.0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seo_report_activity_summary` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `report_id` INTEGER NOT NULL,
    `activity_name` VARCHAR(150) NOT NULL,
    `completed_count` INTEGER NOT NULL DEFAULT 0,
    `notes` VARCHAR(255) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seo_report_file` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `report_id` INTEGER NOT NULL,
    `section_name` VARCHAR(50) NOT NULL,
    `file_path` VARCHAR(255) NOT NULL,
    `original_filename` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(100) NOT NULL,
    `file_size` INTEGER NOT NULL DEFAULT 0,
    `caption` VARCHAR(255) NULL,
    `display_order` INTEGER NOT NULL DEFAULT 0,
    `uploaded_by_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `seo_report_file_report_id_section_name_idx`(`report_id`, `section_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `seo_report` ADD CONSTRAINT `seo_report_client_id_fkey` FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seo_report` ADD CONSTRAINT `seo_report_website_id_fkey` FOREIGN KEY (`website_id`) REFERENCES `seo_website`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seo_report` ADD CONSTRAINT `seo_report_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seo_report` ADD CONSTRAINT `seo_report_approved_by_id_fkey` FOREIGN KEY (`approved_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seo_report_keyword` ADD CONSTRAINT `seo_report_keyword_report_id_fkey` FOREIGN KEY (`report_id`) REFERENCES `seo_report`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seo_report_top_query` ADD CONSTRAINT `seo_report_top_query_report_id_fkey` FOREIGN KEY (`report_id`) REFERENCES `seo_report`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seo_report_traffic_source` ADD CONSTRAINT `seo_report_traffic_source_report_id_fkey` FOREIGN KEY (`report_id`) REFERENCES `seo_report`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seo_report_activity_summary` ADD CONSTRAINT `seo_report_activity_summary_report_id_fkey` FOREIGN KEY (`report_id`) REFERENCES `seo_report`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seo_report_file` ADD CONSTRAINT `seo_report_file_report_id_fkey` FOREIGN KEY (`report_id`) REFERENCES `seo_report`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seo_report_file` ADD CONSTRAINT `seo_report_file_uploaded_by_id_fkey` FOREIGN KEY (`uploaded_by_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
