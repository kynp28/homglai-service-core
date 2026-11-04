import { Request, Response, NextFunction } from 'express';
import prisma from '@homglai/db';

export class SymptomController {
  static async getSymptoms(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const categories = await prisma.symptomCategory.findMany({
        include: {
          symptoms: {
            orderBy: { id: 'asc' },
          },
        },
        orderBy: { id: 'asc' },
      });

      res.status(200).json({
        status: 'success',
        data: categories,
      });
    } catch (error) {
      next(error);
    }
  }
}
