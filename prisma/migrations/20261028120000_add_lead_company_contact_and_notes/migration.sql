-- Lead form: the company's own email and phone (separate from the contact person's email/phone)
-- and lead-level "Last Notes" (separate from lead_followups.notes). Additive only: three new
-- nullable columns, so existing rows get NULL and nothing else changes. enquiry_from,
-- how_contacted and contacted_person are kept as they are (no longer on the form, still stored).

-- AlterTable
ALTER TABLE `leads` ADD COLUMN `company_email` VARCHAR(150) NULL,
    ADD COLUMN `company_phone` VARCHAR(20) NULL,
    ADD COLUMN `notes` TEXT NULL;
