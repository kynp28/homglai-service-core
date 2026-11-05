import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { TrackingController } from '../controllers/tracking.controller';
import { getAppConfig } from '../config/env';

const router = Router();

const WINDOW_MS = 15 * 60 * 1000;

/** Public search: PUBLIC_SEARCH_RATE_LIMIT_MAX requests / 15 min / IP (client IP follows TRUST_PROXY). */
const searchLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: () => getAppConfig().publicSearchRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'ค้นหาบ่อยเกินไป กรุณาลองใหม่ภายหลัง' },
});

/** LINE linking: 10 requests / 15 min / IP. */
const subscribeLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'ลองผูกบัญชีบ่อยเกินไป กรุณาลองใหม่ภายหลัง' },
});

const wrap =
  (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    handler(req, res).catch(next);

/**
 * @openapi
 * /api/tracking/search:
 *   post:
 *     summary: Public job status search (no login)
 *     description: |
 *       Search by ONE number: a job number "REP-YYMM-NNNN" or the paper receipt number (1-10 digits).
 *       Phone numbers are not accepted. Returns a whitelist only: jobNumber, status, statusLabelTh, receivedDate,
 *       updatedAt, machine { brand, model }, timeline [{ status, statusLabelTh, at }] (consecutive repeats collapsed).
 *       Every not-found case (unknown number, wrong format, missing body) returns the same 404 body.
 *       Rate limited per IP (PUBLIC_SEARCH_RATE_LIMIT_MAX / 15 min, default 30).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               query: { type: string, example: 'REP-2611-0001' }
 *     responses:
 *       200:
 *         description: Public status view
 *       404:
 *         description: '{ status: "error", message: "ไม่พบข้อมูลใบงาน กรุณาตรวจสอบเลขที่อีกครั้ง" }'
 *       429:
 *         description: Too many searches from this IP
 */
router.post('/search', searchLimiter, wrap(TrackingController.search));

/**
 * @openapi
 * /api/tracking/subscribe-line:
 *   post:
 *     summary: Link the customer's LINE account to one repair order (LIFF)
 *     description: |
 *       lineAccessToken is a LIFF access token; the server verifies it with LINE (channel must be
 *       LINE_LOGIN_CHANNEL_ID) and takes the userId from LINE — a lineUserId is never accepted from the client.
 *       The phone must match the customer's phone on file. Idempotent. One LINE account may link many orders and
 *       one order may be linked to several accounts. Every failure returns the same 400 body. 10 requests / 15 min / IP.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [query, phone, lineAccessToken]
 *             properties:
 *               query: { type: string, description: 'REP-YYMM-NNNN or paper receipt number' }
 *               phone: { type: string }
 *               lineAccessToken: { type: string }
 *     responses:
 *       200:
 *         description: '{ subscribed: true, alreadySubscribed, jobNumber, status, statusLabelTh }'
 *       400:
 *         description: Generic failure (unknown order, wrong phone or invalid token)
 *       429:
 *         description: Too many attempts from this IP
 */
router.post('/subscribe-line', subscribeLimiter, wrap(TrackingController.subscribeLine));

/**
 * @openapi
 * /api/tracking/stream/{trackingToken}:
 *   get:
 *     summary: Establish SSE connection for live tracking
 *     description: Opens a persistent Server-Sent Events stream using an order trackingToken. Each event is exactly { status, updatedAt }.
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
