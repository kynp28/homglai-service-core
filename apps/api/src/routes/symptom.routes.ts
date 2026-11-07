import { Router } from 'express';
import { SymptomController } from '../controllers/symptom.controller';
import { authenticate, requireRole } from '../middlewares/auth.middleware';

const router = Router();

/**
 * @openapi
 * /api/symptoms:
 *   get:
 *     summary: Get all symptoms grouped by category
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "[{ id, name, symptoms: [{ id, name, categoryId }] }]"
 *       401:
 *         description: Unauthorized
 *   post:
 *     summary: Add a symptom to a category (ADMIN)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, categoryId]
 *             properties:
 *               name: { type: string, maxLength: 100, example: 'ไม่มีน้ำออกจากหัวชง' }
 *               categoryId: { type: integer, example: 1 }
 *     responses:
 *       201:
 *         description: Created symptom
 *       400:
 *         description: Invalid body
 *       403:
 *         description: Not ADMIN
 *       404:
 *         description: Category not found
 *       409:
 *         description: Same name already exists in this category
 */
router.get('/', authenticate, SymptomController.getSymptoms);
router.post('/', authenticate, requireRole('ADMIN'), SymptomController.createSymptom);

/**
 * @openapi
 * /api/symptoms/categories:
 *   post:
 *     summary: Add a symptom category (ADMIN)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, maxLength: 100, example: 'ระบบน้ำ' }
 *     responses:
 *       201:
 *         description: Created category
 *       400:
 *         description: Invalid body
 *       403:
 *         description: Not ADMIN
 *       409:
 *         description: Category name already exists
 */
router.post('/categories', authenticate, requireRole('ADMIN'), SymptomController.createCategory);

/**
 * @openapi
 * /api/symptoms/categories/{id}:
 *   patch:
 *     summary: Rename a symptom category (ADMIN)
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
 *             required: [name]
 *             properties:
 *               name: { type: string, maxLength: 100 }
 *     responses:
 *       200:
 *         description: Renamed category
 *       404:
 *         description: Category not found
 *       409:
 *         description: Category name already exists
 *   delete:
 *     summary: Delete an empty symptom category (ADMIN)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Deleted
 *       404:
 *         description: Category not found
 *       409:
 *         description: Category still has symptoms
 */
router.patch('/categories/:id', authenticate, requireRole('ADMIN'), SymptomController.renameCategory);
router.delete('/categories/:id', authenticate, requireRole('ADMIN'), SymptomController.deleteCategory);

/**
 * @openapi
 * /api/symptoms/{id}:
 *   patch:
 *     summary: Rename a symptom or move it to another category (ADMIN)
 *     description: Renaming also changes how existing orders display it. Send name and/or categoryId.
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
 *             properties:
 *               name: { type: string, maxLength: 100 }
 *               categoryId: { type: integer }
 *     responses:
 *       200:
 *         description: Updated symptom
 *       400:
 *         description: Invalid body / nothing to update
 *       404:
 *         description: Symptom or category not found
 *       409:
 *         description: Same name already exists in the target category
 *   delete:
 *     summary: Delete a symptom that no repair order uses (ADMIN)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Deleted
 *       404:
 *         description: Symptom not found
 *       409:
 *         description: Used on repair orders (rename instead)
 */
router.patch('/:id', authenticate, requireRole('ADMIN'), SymptomController.updateSymptom);
router.delete('/:id', authenticate, requireRole('ADMIN'), SymptomController.deleteSymptom);

export default router;
