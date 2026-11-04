import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@homglai/db';
import { AppError } from '../utils/app-error';

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // 1. AppError (Custom application errors)
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  // 2. Zod validation errors
  if (err instanceof ZodError) {
    const formattedErrors = err.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));
    res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors: formattedErrors,
    });
    return;
  }

  // 3. Prisma Known Request Errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({
        status: 'error',
        message: 'A resource with this identifier already exists',
      });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({
        status: 'error',
        message: 'Requested record not found in database',
      });
      return;
    }

    console.error('[Prisma DB Error]:', err.code, err.message);
    res.status(500).json({
      status: 'error',
      message: 'Database operation failed',
    });
    return;
  }

  // 4. Fallback unexpected internal server error
  console.error('[Unhandled Internal Error]:', err.stack || err);
  res.status(500).json({
    status: 'error',
    message: 'Internal server error',
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    status: 'error',
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}
