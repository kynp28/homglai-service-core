import { NextFunction, Request, Response } from 'express';
import { NotificationService } from '../services/notification.service';
import { getNotificationsQuerySchema } from '../validators/notification.validator';
import { AppError } from '../utils/app-error';

export class NotificationController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = getNotificationsQuerySchema.parse(req.query);
      const result = await NotificationService.listForRecipient(req.user!.employeeId, query);
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  }

  static async markRead(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new AppError(400, 'Invalid notification ID');
      }
      const notification = await NotificationService.markRead(id, req.user!.employeeId);
      res.status(200).json({ status: 'success', data: notification });
    } catch (error) {
      next(error);
    }
  }
}
