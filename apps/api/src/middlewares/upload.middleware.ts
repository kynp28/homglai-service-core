import { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { getAppConfig } from '../config/env';
import { AppError } from '../utils/app-error';

/**
 * multipart/form-data with field "files" (one or more) and field "kind". Files stay in memory
 * (they are validated and re-encoded before anything touches the disk). Multer errors become
 * 413 (file too large) or 400 instead of 500.
 */
export function uploadImages(req: Request, res: Response, next: NextFunction): void {
  const config = getAppConfig();
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.imageMaxBytes, files: config.imageMaxPerKind, fields: 5, parts: config.imageMaxPerKind + 5 },
  }).array('files', config.imageMaxPerKind);

  handler(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(413, `Each image must be at most ${config.imageMaxBytes} bytes`));
      }
      return next(new AppError(400, `Invalid upload (${err.code}): send at most ${config.imageMaxPerKind} files in field "files"`));
    }
    return next(new AppError(400, 'Invalid multipart upload'));
  });
}
