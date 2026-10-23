-- Domain status (Active/Expired), chosen by users in the Add/Edit Domain form; it is not derived
-- from expiry_date. Additive only: one new column with a default, so existing rows become 'active'
-- and nothing else changes. domains.provider is unchanged (VARCHAR); its allowed values are
-- checked by the API, so existing provider values are kept as they are.

-- AlterTable
ALTER TABLE `domains` ADD COLUMN `status` ENUM('active', 'expired') NOT NULL DEFAULT 'active';
