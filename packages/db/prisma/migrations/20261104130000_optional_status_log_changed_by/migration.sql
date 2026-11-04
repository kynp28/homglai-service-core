-- DropForeignKey
ALTER TABLE `StatusLog` DROP FOREIGN KEY `StatusLog_changedById_fkey`;

-- DropIndex
DROP INDEX `StatusLog_changedById_fkey` ON `StatusLog`;

-- AlterTable
ALTER TABLE `StatusLog` MODIFY `changedById` INTEGER NULL;

-- AddForeignKey
ALTER TABLE `StatusLog` ADD CONSTRAINT `StatusLog_changedById_fkey` FOREIGN KEY (`changedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
