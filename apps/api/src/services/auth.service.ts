import prisma from '@homglai/db';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { getJwtSecret } from '../config/env';
import { AppError } from '../utils/app-error';
import { EmployeeService } from './employee.service';

const loginInputSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(100, 'Username too long'),
  password: z.string().min(1, 'Password is required').max(100, 'Password too long'),
});

// Fixed dummy hash for constant-time comparison when user does not exist (timing attack mitigation)
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

export class AuthService {
  static async login(rawInput: any) {
    const validated = loginInputSchema.parse(rawInput);
    const genericErrorMessage = 'Invalid username or password';

    const employee = await prisma.employee.findUnique({
      where: { username: validated.username },
    });

    if (!employee) {
      // Execute dummy comparison to equalize response time and prevent user enumeration
      await bcrypt.compare(validated.password, DUMMY_HASH);
      throw new AppError(401, genericErrorMessage);
    }

    if (!employee.isActive) {
      // Compare password to prevent timing disclosure even if deactivated
      try {
        await bcrypt.compare(validated.password, employee.passwordHash);
      } catch (_) {}
      throw new AppError(401, genericErrorMessage);
    }

    let isValidPassword = false;
    try {
      isValidPassword = await bcrypt.compare(validated.password, employee.passwordHash);
    } catch (_) {
      isValidPassword = false;
    }

    if (!isValidPassword) {
      throw new AppError(401, genericErrorMessage);
    }

    const secret = getJwtSecret();
    const token = jwt.sign(
      { employeeId: employee.id, role: employee.role },
      secret,
      { algorithm: 'HS256', expiresIn: '12h' }
    );

    return {
      token,
      employee: {
        id: employee.id,
        username: employee.username,
        name: employee.name,
        role: employee.role,
        status: employee.status,
      },
    };
  }

  static async changePassword(employeeId: number, data: { oldPassword: string; newPassword: string }) {
    return EmployeeService.changePassword(employeeId, data.oldPassword, data.newPassword);
  }
}
