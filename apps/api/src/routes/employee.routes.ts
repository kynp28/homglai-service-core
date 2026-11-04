import { Router } from 'express';
import { EmployeeController } from '../controllers/employee.controller';

const router = Router();

/**
 * @openapi
 * /api/employees/{id}/status:
 *   patch:
 *     summary: Update employee status and trigger auto-assignment
 *     description: Updates technician status. If set to AVAILABLE, auto-assigns the oldest NEW repair order.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status: 
 *                 type: string
 *                 enum: [AVAILABLE, BUSY, OFFLINE]
 *     responses:
 *       200:
 *         description: Status updated, potentially returning an auto-assigned order.
 */
router.patch('/:id/status', EmployeeController.updateStatus);

export default router;
