import { NextFunction, Request, Response } from 'express';
import { ShopCalendarService } from '../services/shop-calendar.service';
import { createHolidaySchema, listHolidaysQuerySchema } from '../validators/holiday.validator';
import { AppError } from '../utils/app-error';

export class HolidayController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = listHolidaysQuerySchema.parse(req.query);
      res.status(200).json({ status: 'success', data: await ShopCalendarService.list(query) });
    } catch (error) {
      next(error);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = createHolidaySchema.parse(req.body);
      const created = await ShopCalendarService.create(data, req.user!.employeeId);
      res.status(201).json({ status: 'success', data: created });
    } catch (error) {
      next(error);
    }
  }

  static async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'Invalid holiday ID');
      await ShopCalendarService.remove(id);
      res.status(200).json({ status: 'success', data: { id } });
    } catch (error) {
      next(error);
    }
  }
}
