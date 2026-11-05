-- Phase 6 (SRS 3.2, 6.2): LINE accounts are linked per repair order, not per customer.
-- Safe 3 steps: (1) copy every existing customer link to every order of that customer,
-- (2) verify nothing is missing (aborts the migration otherwise), (3) only then drop the column.

-- Step 1: copy (idempotent; existing subscriptions are kept)
INSERT IGNORE INTO `OrderLineSubscription` (`repairOrderId`, `lineUserId`, `createdAt`)
SELECT ro.`id`, c.`lineUserId`, CURRENT_TIMESTAMP(3)
FROM `RepairOrder` ro
JOIN `Customer` c ON c.`id` = ro.`customerId`
WHERE c.`lineUserId` IS NOT NULL;

-- Step 2: verify. The CHECK constraint makes the INSERT fail ("Check constraint ... is violated") when
-- any order of a LINE-linked customer has no matching subscription, which stops the migration before
-- the column is dropped.
CREATE TEMPORARY TABLE `_line_subscription_backfill_check` (
    `missing` INTEGER NOT NULL,
    CONSTRAINT `line_subscription_backfill_complete` CHECK (`missing` = 0)
);
INSERT INTO `_line_subscription_backfill_check` (`missing`)
SELECT COUNT(*)
FROM `RepairOrder` ro
JOIN `Customer` c ON c.`id` = ro.`customerId`
WHERE c.`lineUserId` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `OrderLineSubscription` s
     WHERE s.`repairOrderId` = ro.`id` AND s.`lineUserId` = c.`lineUserId`
  );
DROP TEMPORARY TABLE `_line_subscription_backfill_check`;

-- Step 3: drop the per-customer link
DROP INDEX `Customer_lineUserId_key` ON `Customer`;
ALTER TABLE `Customer` DROP COLUMN `lineUserId`;
