import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ImageService } from '../services/image.service';
import { AppError } from '../utils/app-error';

const kindSchema = z.enum(['INTAKE', 'RECEIPT_PAPER', 'DELIVERY', 'OTHER'], {
  errorMap: () => ({ message: 'kind must be INTAKE, RECEIPT_PAPER, DELIVERY or OTHER' }),
});

function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, `Invalid ${label}`);
  return id;
}

export class ImageController {
  static async upload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const repairOrderId = positiveId(req.params.id, 'repair order ID');
      const kind = kindSchema.parse(req.body?.kind);
      const files = ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => f.buffer);
      const images = await ImageService.upload(repairOrderId, { id: req.user!.employeeId, role: req.user!.role }, kind, files);
      res.status(201).json({ status: 'success', data: images });
    } catch (error) {
      next(error);
    }
  }

  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const repairOrderId = positiveId(req.params.id, 'repair order ID');
      const images = await ImageService.list(repairOrderId, { id: req.user!.employeeId, role: req.user!.role });
      res.status(200).json({ status: 'success', data: images });
    } catch (error) {
      next(error);
    }
  }

  static async download(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const repairOrderId = positiveId(req.params.id, 'repair order ID');
      const imageId = positiveId(req.params.imageId, 'image ID');
      const stream = await ImageService.open(repairOrderId, imageId, { id: req.user!.employeeId, role: req.user!.role });
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      stream.on('error', (err) => {
        if (!res.headersSent) next(new AppError(404, 'Image not found'));
        else res.destroy(err);
      });
      stream.pipe(res);
    } catch (error) {
      next(error);
    }
  }
}
