import { Router } from 'express';
import { RepairController } from '../controllers/repair.controller';
import { authenticate, requireRole } from '../middlewares/auth.middleware';

const router = Router();

/**
 * @openapi
 * /api/repairs:
 *   post:
 *     summary: Create a new repair order
 *     security:
 *       - bearerAuth: []
 *     description: Registers or updates customer, registers machine, links symptoms, and opens a repair order with NEW status. Accessible by RECEPTIONIST and ADMIN.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - customer
 *               - machine
 *             properties:
 *               customer:
 *                 type: object
 *                 required:
 *                   - name
 *                   - phone
 *                 properties:
 *                   name: { type: string }
 *                   phone: { type: string }
 *               machine:
 *                 type: object
 *                 required:
 *                   - brand
 *                   - model
 *                 properties:
 *                   brand: { type: string }
 *                   model: { type: string }
 *                   serialNumber: { type: string }
 *               symptomIds:
 *                 type: array
 *                 items: { type: integer }
 *                 example: [1, 2]
 *               otherSymptom: { type: string }
 *     responses:
 *       201:
 *         description: Repair order created successfully.
 *       401:
 *         description: Unauthorized.
 *       403:
 *         description: Forbidden.
 */
router.post('/', authenticate, requireRole('RECEPTIONIST', 'ADMIN'), RepairController.createRepair);

/**
 * @openapi
 * /api/repairs:
 *   get:
 *     summary: List repair orders with filtering and pagination
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: technicianId
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: List of repair orders
 *       401:
 *         description: Unauthorized
 */
router.get('/', authenticate, RepairController.getRepairs);

/**
 * @openapi
 * /api/repairs/{id}:
 *   get:
 *     summary: Get repair order details by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Repair order details
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (Technician viewing unassigned/other order)
 *       404:
 *         description: Not found
 */
router.get('/:id', authenticate, RepairController.getRepairById);

/**
 * @openapi
 * /api/repairs/{id}/items:
 *   post:
 *     summary: Add a repair item and trigger approval loop
 *     security:
 *       - bearerAuth: []
 *     description: Adds a part/item to the repair order. Accessible by the assigned TECHNICIAN or ADMIN.
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
 *             required:
 *               - name
 *               - price
 *             properties:
 *               name:
 *                 type: string
 *                 example: "Water Pump"
 *               price:
 *                 type: number
 *                 example: 2500
 *     responses:
 *       201:
 *         description: Item added and status updated.
 *       401:
 *         description: Unauthorized.
 *       403:
 *         description: Forbidden.
 *       404:
 *         description: Order not found.
 */
router.post('/:id/items', authenticate, RepairController.addItem);

/**
 * @openapi
 * /api/repairs/{id}/items/{itemId}/status:
 *   patch:
 *     summary: Approve or reject a repair item (Staff proxy)
 *     security:
 *       - bearerAuth: []
 *     description: Staff resolves a pending repair item on customer behalf. Accessible by RECEPTIONIST and ADMIN.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [APPROVED, REJECTED]
 *     responses:
 *       200:
 *         description: Item resolved successfully.
 *       401:
 *         description: Unauthorized.
 *       403:
 *         description: Forbidden.
 */
router.patch(
  '/:id/items/:itemId/status',
  authenticate,
  requireRole('RECEPTIONIST', 'ADMIN'),
  RepairController.resolveItem
);

/**
 * @openapi
 * /api/repairs/{id}/items/{itemId}/complete:
 *   patch:
 *     summary: Mark an approved item as completed
 *     security:
 *       - bearerAuth: []
 *     description: Sets status of an approved item to COMPLETED. Accessible by assigned technician or ADMIN.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Item marked as COMPLETED
 *       403:
 *         description: Forbidden
 *       409:
 *         description: Item not in APPROVED status
 */
router.patch(
  '/:id/items/:itemId/complete',
  authenticate,
  RepairController.completeItem
);

/**
 * @openapi
 * /api/repairs/{id}/status:
 *   patch:
 *     summary: Update repair order status
 *     security:
 *       - bearerAuth: []
 *     description: Updates repair order status. Accessible by all authenticated roles (TECHNICIAN must be assigned technician).
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
 *             required:
 *               - status
 *             properties:
 *               status: 
 *                 type: string
 *                 enum: [NEW, INSPECTING, WAITING_APPROVAL, REPAIRING, COMPLETED, DELIVERED, CANCELLED]
 *               note: { type: string }
 *     responses:
 *       200:
 *         description: Status updated successfully.
 *       401:
 *         description: Unauthorized.
 *       403:
 *         description: Forbidden.
 *       404:
 *         description: Order not found.
 */
router.patch('/:id/status', authenticate, RepairController.updateStatus);

export default router;
