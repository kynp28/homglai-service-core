-- Step 1: Add new columns as NULLABLE (with isActive defaulting to true)
ALTER TABLE `Employee`
    ADD COLUMN `username` VARCHAR(191) NULL,
    ADD COLUMN `passwordHash` VARCHAR(191) NULL,
    ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE `RepairOrder`
    ADD COLUMN `trackingToken` VARCHAR(191) NULL;

-- Step 2: Backfill existing data
-- (a) Backfill username using user<id>
UPDATE `Employee`
SET `username` = CONCAT('user', `id`)
WHERE `username` IS NULL;

-- (b) Backfill passwordHash with an unguessable/unusable random hash until reset
UPDATE `Employee`
SET `passwordHash` = CONCAT('$2a$10$DISABLED_', MD5(RAND()), SHA2(UUID(), 256))
WHERE `passwordHash` IS NULL;

-- (c) Backfill trackingToken with random unique tokens
UPDATE `RepairOrder`
SET `trackingToken` = CONCAT('trk_', HEX(RANDOM_BYTES(24)))
WHERE `trackingToken` IS NULL;

-- Step 3: Enforce NOT NULL and add UNIQUE indexes
ALTER TABLE `Employee`
    MODIFY `username` VARCHAR(191) NOT NULL,
    MODIFY `passwordHash` VARCHAR(191) NOT NULL;

CREATE UNIQUE INDEX `Employee_username_key` ON `Employee`(`username`);

ALTER TABLE `RepairOrder`
    MODIFY `trackingToken` VARCHAR(191) NOT NULL;

CREATE UNIQUE INDEX `RepairOrder_trackingToken_key` ON `RepairOrder`(`trackingToken`);
