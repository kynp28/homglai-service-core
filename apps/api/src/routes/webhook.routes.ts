import { Router } from 'express';
import { WebhookController } from '../controllers/webhook.controller';

const router = Router();

/**
 * @openapi
 * /api/webhook/line:
 *   post:
 *     summary: LINE Messaging API Webhook
 *     description: Receives events from LINE. Do not require Auth.
 *     responses:
 *       200:
 *         description: OK
 */
router.post('/line', WebhookController.lineWebhook);

export default router;
