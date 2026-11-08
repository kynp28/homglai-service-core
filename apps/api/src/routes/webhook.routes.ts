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

/**
 * @openapi
 * /api/webhook/line/tech:
 *   post:
 *     summary: LINE webhook of the technicians' channel
 *     description: |
 *       Signed with LINE_TECH_CHANNEL_SECRET (raw body). Handles the "รับงานนี้" postback
 *       (action=accept_job&orderId=N) sent with JOB_RESERVED pushes: the job is accepted as the employee whose
 *       linked LINE account pressed it (same rules as POST /api/repairs/{id}/accept). No auth header.
 *     responses:
 *       200:
 *         description: OK
 *       401:
 *         description: Missing/invalid signature or secret not configured
 */
router.post('/line/tech', WebhookController.lineTechWebhook);

export default router;
