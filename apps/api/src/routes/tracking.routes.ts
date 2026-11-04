import { Router } from 'express';
import { TrackingController } from '../controllers/tracking.controller';

const router = Router();

/**
 * @openapi
 * /api/tracking/stream/{trackingToken}:
 *   get:
 *     summary: Establish SSE connection for live tracking
 *     description: Opens a persistent Server-Sent Events stream using an order trackingToken.
 *     parameters:
 *       - in: path
 *         name: trackingToken
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Event stream established.
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       404:
 *         description: Invalid tracking token.
 */
router.get('/stream/:trackingToken', TrackingController.streamTrackingUpdates);

export default router;
