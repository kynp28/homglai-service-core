import { Router } from 'express';
import { NotificationController } from '../controllers/notification.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();

/**
 * @openapi
 * /api/notifications:
 *   get:
 *     summary: List my notifications (in-app staff notifications)
 *     security:
 *       - bearerAuth: []
 *     description: Returns only the caller's own notifications, newest first. Any authenticated role.
 *     parameters:
 *       - in: query
 *         name: unreadOnly
 *         schema: { type: string, enum: ['true', 'false'], default: 'false' }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *     responses:
 *       200:
 *         description: "{ total, unreadCount, page, limit, totalPages, notifications: [{ id, type, repairOrderId, title, body, payload, createdAt, readAt }] }"
 *       400:
 *         description: Invalid query
 *       401:
 *         description: Unauthorized
 */
router.get('/', authenticate, NotificationController.list);

/**
 * @openapi
 * /api/notifications/{id}/read:
 *   patch:
 *     summary: Mark one of my notifications as read
 *     security:
 *       - bearerAuth: []
 *     description: Idempotent (readAt keeps its first value). Another employee's notification returns 404.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: The notification with readAt set
 *       400:
 *         description: Invalid id
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Not found (or belongs to someone else)
 */
router.patch('/:id/read', authenticate, NotificationController.markRead);

export default router;
