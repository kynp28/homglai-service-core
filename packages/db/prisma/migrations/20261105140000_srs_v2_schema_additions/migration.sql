-- Phase 1: SRS v2 schema additions (additive only, safe 3-step for NOT NULL columns)
-- Step 1: add columns / enum values / tables (new NOT NULL columns have defaults or are added NULLABLE)
-- Step 2: backfill legacy rows
-- Step 3: enforce NOT NULL and add unique indexes

-- =====================================================================
-- Step 1: structural additions
-- =====================================================================

-- Employee: RESERVED status + availableSince
ALTER TABLE `Employee`
    MODIFY `status` ENUM('AVAILABLE', 'BUSY', 'OFFLINE', 'RESERVED') NOT NULL DEFAULT 'AVAILABLE',
    ADD COLUMN `availableSince` DATETIME(3) NULL;

-- Customer: address
ALTER TABLE `Customer`
    ADD COLUMN `address` TEXT NULL;

-- RepairOrder: paper form, assignment, reminder and closing fields
-- (receivedDate is added NULLABLE here and tightened in Step 3 after backfill)
ALTER TABLE `RepairOrder`
    ADD COLUMN `paperBookNo` VARCHAR(20) NULL,
    ADD COLUMN `paperReceiptNo` VARCHAR(20) NULL,
    ADD COLUMN `receivedDate` DATE NULL,
    ADD COLUMN `workType` ENUM('REPAIR') NOT NULL DEFAULT 'REPAIR',
    ADD COLUMN `warrantyStatus` ENUM('IN_WARRANTY', 'OUT_OF_WARRANTY') NULL,
    ADD COLUMN `warrantyExpiryDate` DATE NULL,
    ADD COLUMN `billingType` ENUM('CHARGE_OUT_OF_WARRANTY', 'NO_CHARGE_IN_WARRANTY', 'CHARGE_IN_WARRANTY') NULL,
    ADD COLUMN `loanerMachine` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `loanerNote` VARCHAR(500) NULL,
    ADD COLUMN `accessories` JSON NULL,
    ADD COLUMN `careAdvice` JSON NULL,
    ADD COLUMN `warningNote` TEXT NULL,
    ADD COLUMN `assignedAt` DATETIME(3) NULL,
    ADD COLUMN `acknowledgedAt` DATETIME(3) NULL,
    ADD COLUMN `lastAckReminderAt` DATETIME(3) NULL,
    ADD COLUMN `ackReminderCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `queuePriority` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `lastActivityAt` DATETIME(3) NULL,
    ADD COLUMN `lastProgressReminderAt` DATETIME(3) NULL,
    ADD COLUMN `progressReminderCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `closedAt` DATETIME(3) NULL,
    ADD COLUMN `completionSummary` TEXT NULL;

-- RepairItem: new columns. `price` is NOT renamed or moved: Prisma maps it as `unitPrice` via @map("price").
ALTER TABLE `RepairItem`
    ADD COLUMN `barcode` VARCHAR(64) NULL,
    ADD COLUMN `quantity` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `itemType` ENUM('PART', 'TRAVEL_FEE', 'LABOR_HOURS', 'SERVICE_FEE') NOT NULL DEFAULT 'PART',
    ADD COLUMN `resolvedById` INTEGER NULL,
    ADD COLUMN `resolvedAt` DATETIME(3) NULL,
    ADD COLUMN `resolutionChannel` ENUM('PHONE', 'LINE') NULL,
    ADD COLUMN `resolutionNote` VARCHAR(500) NULL;

-- CreateTable
CREATE TABLE `RepairOrderImage` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `repairOrderId` INTEGER NOT NULL,
    `kind` ENUM('INTAKE', 'RECEIPT_PAPER', 'DELIVERY', 'OTHER') NOT NULL,
    `storagePath` VARCHAR(255) NOT NULL,
    `uploadedById` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RepairOrderImage_repairOrderId_kind_idx`(`repairOrderId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderLineSubscription` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `repairOrderId` INTEGER NOT NULL,
    `lineUserId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OrderLineSubscription_lineUserId_idx`(`lineUserId`),
    UNIQUE INDEX `OrderLineSubscription_repairOrderId_lineUserId_key`(`repairOrderId`, `lineUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Notification` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `recipientId` INTEGER NOT NULL,
    `type` VARCHAR(40) NOT NULL,
    `repairOrderId` INTEGER NULL,
    `title` VARCHAR(191) NOT NULL,
    `body` TEXT NOT NULL,
    `payload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `readAt` DATETIME(3) NULL,

    INDEX `Notification_recipientId_readAt_createdAt_idx`(`recipientId`, `readAt`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RepairItem` ADD CONSTRAINT `RepairItem_resolvedById_fkey` FOREIGN KEY (`resolvedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RepairOrderImage` ADD CONSTRAINT `RepairOrderImage_repairOrderId_fkey` FOREIGN KEY (`repairOrderId`) REFERENCES `RepairOrder`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RepairOrderImage` ADD CONSTRAINT `RepairOrderImage_uploadedById_fkey` FOREIGN KEY (`uploadedById`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderLineSubscription` ADD CONSTRAINT `OrderLineSubscription_repairOrderId_fkey` FOREIGN KEY (`repairOrderId`) REFERENCES `RepairOrder`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Notification` ADD CONSTRAINT `Notification_recipientId_fkey` FOREIGN KEY (`recipientId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================
-- Step 2: backfill legacy data
-- (CONVERT_TZ with numeric offsets is used because the MySQL image may not ship timezone tables.
--  DATETIME values are stored as UTC by Prisma.)
-- =====================================================================

-- (a) Technicians that are currently AVAILABLE keep their existing queue order (updatedAt)
UPDATE `Employee`
SET `availableSince` = `updatedAt`
WHERE `status` = 'AVAILABLE' AND `availableSince` IS NULL;

-- (b) receivedDate = calendar date of createdAt in Bangkok time (UTC+7)
UPDATE `RepairOrder`
SET `receivedDate` = DATE(CONVERT_TZ(`createdAt`, '+00:00', '+07:00'))
WHERE `receivedDate` IS NULL;

-- (c) lastActivityAt = updatedAt
UPDATE `RepairOrder`
SET `lastActivityAt` = `updatedAt`
WHERE `lastActivityAt` IS NULL;

-- (d) Orders that already left NEW: assignedAt = acknowledgedAt = first INSPECTING log time
--     (fallback updatedAt) so background reminders do not flood for legacy rows
UPDATE `RepairOrder` ro
SET ro.`assignedAt` = COALESCE(
    (SELECT MIN(sl.`createdAt`) FROM `StatusLog` sl WHERE sl.`repairOrderId` = ro.`id` AND sl.`status` = 'INSPECTING'),
    ro.`updatedAt`
)
WHERE ro.`status` <> 'NEW' AND ro.`assignedAt` IS NULL;

UPDATE `RepairOrder`
SET `acknowledgedAt` = `assignedAt`
WHERE `status` <> 'NEW' AND `acknowledgedAt` IS NULL;

-- (e) Closed orders: closedAt = updatedAt
UPDATE `RepairOrder`
SET `closedAt` = `updatedAt`
WHERE `status` IN ('DELIVERED', 'CANCELLED') AND `closedAt` IS NULL;

-- RepairItem.quantity defaults to 1 for all legacy rows (column default); unitPrice is the untouched legacy `price` column.

-- =====================================================================
-- Step 3: enforce NOT NULL + unique / lookup indexes
-- =====================================================================

ALTER TABLE `RepairOrder`
    MODIFY `receivedDate` DATE NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX `RepairOrder_paperReceiptNo_key` ON `RepairOrder`(`paperReceiptNo`);

-- CreateIndex
CREATE INDEX `RepairOrder_status_technicianId_idx` ON `RepairOrder`(`status`, `technicianId`);

-- CreateIndex
CREATE INDEX `RepairOrder_status_acknowledgedAt_idx` ON `RepairOrder`(`status`, `acknowledgedAt`);

-- CreateIndex
CREATE INDEX `RepairOrder_closedAt_idx` ON `RepairOrder`(`closedAt`);

-- CreateIndex
CREATE INDEX `RepairOrder_lastActivityAt_idx` ON `RepairOrder`(`lastActivityAt`);

-- CreateIndex
CREATE INDEX `RepairOrder_status_technicianId_queuePriority_createdAt_idx` ON `RepairOrder`(`status`, `technicianId`, `queuePriority`, `createdAt`);
