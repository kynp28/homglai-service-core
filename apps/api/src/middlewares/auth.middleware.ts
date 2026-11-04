import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import prisma, { EmployeeRole } from '@homglai/db';
import { getJwtSecret } from '../config/env';

export interface AuthUser {
  employeeId: number;
  role: EmployeeRole;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'error',
    message: 'Too many login attempts. Please try again later.',
  },
});

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ status: 'error', message: 'Authentication required' });
    return;
  }

  const token = authHeader.substring(7).trim();
  let decoded: any;
  try {
    decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
  } catch (error) {
    res.status(401).json({ status: 'error', message: 'Invalid or expired token' });
    return;
  }

  try {
    // Freshly query database to verify employee existence, active status, and real-time role
    const employee = await prisma.employee.findUnique({
      where: { id: decoded.employeeId },
      select: { id: true, role: true, isActive: true },
    });

    if (!employee || !employee.isActive) {
      res.status(401).json({ status: 'error', message: 'Account is deactivated or not found' });
      return;
    }

    // Use current role from database, overriding any stale claims in token
    req.user = {
      employeeId: employee.id,
      role: employee.role,
    };
    next();
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: 'Authentication service error' });
  }
}

export function requireRole(...allowedRoles: EmployeeRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ status: 'error', message: 'Authentication required' });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({ status: 'error', message: 'Forbidden: Insufficient permissions' });
      return;
    }

    next();
  };
}
