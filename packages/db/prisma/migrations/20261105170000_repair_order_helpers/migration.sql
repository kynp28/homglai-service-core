-- Phase 5 (owner request, outside the original 9-phase plan): helper technicians per repair order.
-- Additive only: one new table, no change to existing tables or data.

-- CreateTable
CREATE TABLE `RepairOrderHelper` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `repairOrderId` INTEGER NOT NULL,
    `technicianId` INTEGER NOT NULL,
    `addedById` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RepairOrderHelper_technicianId_idx`(`technicianId`),
    INDEX `RepairOrderHelper_addedById_idx`(`addedById`),
    UNIQUE INDEX `RepairOrderHelper_repairOrderId_technicianId_key`(`repairOrderId`, `technicianId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RepairOrderHelper` ADD CONSTRAINT `RepairOrderHelper_repairOrderId_fkey` FOREIGN KEY (`repairOrderId`) REFERENCES `RepairOrder`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RepairOrderHelper` ADD CONSTRAINT `RepairOrderHelper_technicianId_fkey` FOREIGN KEY (`technicianId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RepairOrderHelper` ADD CONSTRAINT `RepairOrderHelper_addedById_fkey` FOREIGN KEY (`addedById`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
