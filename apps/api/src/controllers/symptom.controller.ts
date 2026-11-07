import { Request, Response, NextFunction } from 'express';
import { SymptomService } from '../services/symptom.service';
import { categoryBodySchema, createSymptomSchema, updateSymptomSchema } from '../validators/symptom.validator';
import { AppError } from '../utils/app-error';

function idParam(req: Request, label: string): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, `Invalid ${label} ID`);
  return id;
}

export class SymptomController {
  /** GET /api/symptoms — every staff role; categories with their symptoms. */
  static async getSymptoms(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({ status: 'success', data: await SymptomService.list() });
    } catch (error) {
      next(error);
    }
  }

  static async createCategory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name } = categoryBodySchema.parse(req.body);
      res.status(201).json({ status: 'success', data: await SymptomService.createCategory(name) });
    } catch (error) {
      next(error);
    }
  }

  static async renameCategory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = idParam(req, 'category');
      const { name } = categoryBodySchema.parse(req.body);
      res.status(200).json({ status: 'success', data: await SymptomService.renameCategory(id, name) });
    } catch (error) {
      next(error);
    }
  }

  static async deleteCategory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = idParam(req, 'category');
      await SymptomService.deleteCategory(id);
      res.status(200).json({ status: 'success', data: { id } });
    } catch (error) {
      next(error);
    }
  }

  static async createSymptom(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = createSymptomSchema.parse(req.body);
      res.status(201).json({ status: 'success', data: await SymptomService.createSymptom(data) });
    } catch (error) {
      next(error);
    }
  }

  static async updateSymptom(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = idParam(req, 'symptom');
      const data = updateSymptomSchema.parse(req.body);
      res.status(200).json({ status: 'success', data: await SymptomService.updateSymptom(id, data) });
    } catch (error) {
      next(error);
    }
  }

  static async deleteSymptom(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = idParam(req, 'symptom');
      await SymptomService.deleteSymptom(id);
      res.status(200).json({ status: 'success', data: { id } });
    } catch (error) {
      next(error);
    }
  }
}
