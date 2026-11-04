import { Router } from 'express';
import { RepairController } from '../controllers/repair.controller';

const router = Router();

/**
 * @openapi
 * /api/repairs:
 *   post:
 *     summary: Create a new repair order
 *     description: Registers or updates customer, registers machine, links symptoms, and opens a repair order with NEW status.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - customer
 *               - machine
 *               - receptionistId
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
 *               receptionistId: { type: integer }
 *     responses:
 *       201:
 *         description: Repair order created successfully.
 */
router.post('/', RepairController.createRepair);

/**
 * @openapi
 * /api/repairs/{id}/items:
 *   post:
 *     summary: Add a repair item and trigger approval loop
 *     description: Adds a specific part/item to the repair order. Automatically sets order status to WAITING_APPROVAL.
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
 *               name:
 *                 type: string
 *                 example: "Water Pump"
 *               price:
 *                 type: number
 *                 example: 2500
 *               technicianId:
 *                 type: integer
 *                 example: 2
 *     responses:
 *       201:
 *         description: Item added and status updated.
 */
router.post('/:id/items', RepairController.addItem);

/**
 * @openapi
 * /api/repairs/{id}/items/{itemId}/status:
 *   patch:
 *     summary: Approve or reject a repair item
 *     description: Customer resolves a pending repair item. If all items are resolved, auto-resumes order status to REPAIRING.
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
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [APPROVED, REJECTED]
 *     responses:
 *       200:
 *         description: Item resolved successfully.
 */
router.patch('/:id/items/:itemId/status', RepairController.resolveItem);

/**
 * @openapi
 * /api/repairs/{id}/status:
 *   patch:
 *     summary: Update repair order status
 *     description: Updates the status of a repair order, logs the change, and broadcasts via SSE.
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
 *                 enum: [NEW, INSPECTING, WAITING_APPROVAL, REPAIRING, COMPLETED, DELIVERED, CANCELLED]
 *               userId: { type: integer }
 *               note: { type: string }
 *     responses:
 *       200:
 *         description: Status updated successfully and broadcasted.
 */
router.patch('/:id/status', RepairController.updateStatus);

export default router;
