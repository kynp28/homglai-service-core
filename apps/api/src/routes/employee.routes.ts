import { Router } from 'express';
import { EmployeeController } from '../controllers/employee.controller';
import { authenticate, requireRole } from '../middlewares/auth.middleware';

const router = Router();

/**
 * @openapi
 * /api/employees:
 *   post:
 *     summary: Create employee account (Admin only)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, name, password, role]
 *             properties:
 *               username: { type: string }
 *               name: { type: string }
 *               password: { type: string, minLength: 12 }
 *               role: { type: string, enum: [ADMIN, TECHNICIAN, RECEPTIONIST] }
 *     responses:
 *       201:
 *         description: Employee created successfully
 *   get:
 *     summary: List all employees (Admin only)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of employees
 */
router.post('/', authenticate, requireRole('ADMIN'), EmployeeController.create);
router.get('/', authenticate, requireRole('ADMIN'), EmployeeController.list);

/**
 * @openapi
 * /api/employees/{id}:
 *   patch:
 *     summary: Update employee details or deactivate (Admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Employee updated
 */
router.patch('/:id', authenticate, requireRole('ADMIN'), EmployeeController.update);

/**
 * @openapi
 * /api/employees/{id}/reset-password:
 *   post:
 *     summary: Reset employee password (Admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [newPassword]
 *             properties:
 *               newPassword: { type: string, minLength: 12 }
 *     responses:
 *       200:
 *         description: Password reset successfully
 */
router.post('/:id/reset-password', authenticate, requireRole('ADMIN'), EmployeeController.resetPassword);

/**
 * @openapi
 * /api/employees/{id}/status:
 *   patch:
 *     summary: Update employee status and trigger auto-assignment
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Status updated
 */
router.patch('/:id/status', authenticate, EmployeeController.updateStatus);

export default router;
