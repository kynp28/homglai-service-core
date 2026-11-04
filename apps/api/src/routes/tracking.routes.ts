import { Router } from 'express';
import { TrackingController } from '../controllers/tracking.controller';

const router = Router();

/**
 * @openapi
 * /api/tracking/stream/{jobNumber}:
 *   get:
 *     summary: Establish SSE connection for live tracking
 *     description: Opens a persistent Server-Sent Events stream for a specific repair order.
 *     parameters:
 *       - in: path
 *         name: jobNumber
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
 */
router.get('/stream/:jobNumber', TrackingController.streamTrackingUpdates);

export default router;
