import { Router } from 'express';
import { HolidayController } from '../controllers/holiday.controller';
import { authenticate, requireRole } from '../middlewares/auth.middleware';

const router = Router();

/**
 * @openapi
 * /api/holidays:
 *   get:
 *     summary: List shop holidays (special closures)
 *     security:
 *       - bearerAuth: []
 *     description: Any staff role. Business-minute timers (progress reminders, needsProgressUpdate) skip these dates.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: "[{ id, date, name, createdAt, createdBy: { id, name } }] ordered by date"
 *       400:
 *         description: Invalid query
 *   post:
 *     summary: Add a shop holiday, or a range of consecutive closed days (ADMIN)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [date, name]
 *             properties:
 *               date: { type: string, format: date, example: '2027-04-13' }
 *               toDate: { type: string, format: date, example: '2027-04-15', description: 'Last day (inclusive), at most 31 days' }
 *               name: { type: string, maxLength: 100, example: 'สงกรานต์' }
 *     responses:
 *       201:
 *         description: Created holidays
 *       400:
 *         description: Validation error
 *       403:
 *         description: Not ADMIN
 *       409:
 *         description: One of the dates is already a holiday (details.existingDates)
 */
router.get('/', authenticate, HolidayController.list);
router.post('/', authenticate, requireRole('ADMIN'), HolidayController.create);

/**
 * @openapi
 * /api/holidays/{id}:
 *   delete:
 *     summary: Remove a shop holiday (ADMIN)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Removed
 *       404:
 *         description: Not found
 */
router.delete('/:id', authenticate, requireRole('ADMIN'), HolidayController.remove);

export default router;
