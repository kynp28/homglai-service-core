import prisma, { Prisma } from '@homglai/db';
import { AppError } from '../utils/app-error';

/** Fields returned to the recipient (recipientId is implied: always the caller). */
const notificationSelect = {
  id: true,
  type: true,
  repairOrderId: true,
  title: true,
  body: true,
  payload: true,
  createdAt: true,
  readAt: true,
} satisfies Prisma.NotificationSelect;

export class NotificationService {
  /** The caller's own notifications, newest first. */
  static async listForRecipient(
    recipientId: number,
    params: { unreadOnly: boolean; page: number; limit: number }
  ) {
    const page = Math.max(1, params.page);
    const limit = Math.min(100, Math.max(1, params.limit));
    const where: Prisma.NotificationWhereInput = {
      recipientId,
      ...(params.unreadOnly ? { readAt: null } : {}),
    };

    const [total, unreadCount, notifications] = await Promise.all([
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { recipientId, readAt: null } }),
      prisma.notification.findMany({
        where,
        select: notificationSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { total, unreadCount, page, limit, totalPages: Math.ceil(total / limit), notifications };
  }

  /**
   * Marks one of the caller's notifications as read. Someone else's notification is reported as
   * 404 (not 403) so its existence is not revealed. Idempotent: readAt keeps its first value.
   */
  static async markRead(id: number, recipientId: number) {
    await prisma.notification.updateMany({
      where: { id, recipientId, readAt: null },
      data: { readAt: new Date() },
    });

    const notification = await prisma.notification.findFirst({
      where: { id, recipientId },
      select: notificationSelect,
    });
    if (!notification) {
      throw new AppError(404, 'Notification not found');
    }
    return notification;
  }
}
