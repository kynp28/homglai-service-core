import { Router } from 'express';
import { SymptomController } from '../controllers/symptom.controller';
import { authenticate } from '../middlewares/auth.middleware';

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
 *         description: List of categories with symptoms
 *       401:
 *         description: Unauthorized
 */
router.get('/', authenticate, SymptomController.getSymptoms);

export default router;
