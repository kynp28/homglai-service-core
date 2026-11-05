-- Phase 5b (owner decisions 2026-11-05): job-number counter, shop holidays, technician weekly day off,
-- "not repaired" completion outcome, payment record at delivery.
-- Additive only: new tables, new NULLable columns, one backfill. No existing value is changed except
-- the new repairOutcome column of already COMPLETED/DELIVERED orders (= REPAIRED).

-- Step 1: new columns (NULLable) and tables
ALTER TABLE `Employee` ADD COLUMN `weeklyDayOff` INTEGER NULL;

ALTER TABLE `RepairOrder`
    ADD COLUMN `repairOutcome` ENUM('REPAIRED', 'NOT_REPAIRED') NULL,
    ADD COLUMN `paidAmount` DECIMAL(10, 2) NULL,
    ADD COLUMN `paymentMethod` ENUM('CASH', 'TRANSFER', 'OTHER') NULL,
    ADD COLUMN `paymentNote` VARCHAR(500) NULL,
    ADD COLUMN `paidAt` DATETIME(3) NULL,
    ADD COLUMN `paymentRecordedById` INTEGER NULL;

-- CreateTable
CREATE TABLE `JobNumberSequence` (
    `prefix` VARCHAR(16) NOT NULL,
    `lastSeq` INTEGER NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`prefix`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShopHoliday` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `date` DATE NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `createdById` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ShopHoliday_date_key`(`date`),
    INDEX `ShopHoliday_createdById_idx`(`createdById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Step 2: backfill
-- Counter starts after the highest existing number of each REP-YYMM prefix
INSERT INTO `JobNumberSequence` (`prefix`, `lastSeq`, `updatedAt`)
SELECT SUBSTRING_INDEX(`jobNumber`, '-', 2), MAX(CAST(SUBSTRING_INDEX(`jobNumber`, '-', -1) AS UNSIGNED)), CURRENT_TIMESTAMP(3)
FROM `RepairOrder`
WHERE `jobNumber` REGEXP '^REP-[0-9]{4}-[0-9]+$'
GROUP BY SUBSTRING_INDEX(`jobNumber`, '-', 2);

-- Orders completed before this migration were repaired (the only completion path that existed)
UPDATE `RepairOrder` SET `repairOutcome` = 'REPAIRED' WHERE `status` IN ('COMPLETED', 'DELIVERED');

-- Step 3: indexes and foreign keys
CREATE INDEX `RepairOrder_paymentRecordedById_idx` ON `RepairOrder`(`paymentRecordedById`);

-- AddForeignKey
ALTER TABLE `RepairOrder` ADD CONSTRAINT `RepairOrder_paymentRecordedById_fkey` FOREIGN KEY (`paymentRecordedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShopHoliday` ADD CONSTRAINT `ShopHoliday_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
