import { z } from 'zod';

export const createEmployeeSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(50, 'Username cannot exceed 50 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain alphanumeric characters, hyphens, and underscores'),
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name cannot exceed 100 characters'),
  password: z.string().min(12, 'Password must be at least 12 characters long'),
  role: z.enum(['ADMIN', 'TECHNICIAN', 'RECEPTIONIST'], {
    errorMap: () => ({ message: 'Role must be ADMIN, TECHNICIAN, or RECEPTIONIST' }),
  }),
});

export const updateEmployeeSchema = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty').max(100).optional(),
  role: z.enum(['ADMIN', 'TECHNICIAN', 'RECEPTIONIST']).optional(),
  isActive: z.boolean().optional(),
  // Fixed weekly day off, 0 = Sunday ... 6 = Saturday; null clears it
  weeklyDayOff: z.number().int().min(0).max(6).nullable().optional(),
});

export const resetEmployeePasswordSchema = z.object({
  newPassword: z.string().min(12, 'New password must be at least 12 characters long'),
});

export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(12, 'New password must be at least 12 characters long'),
});

export const updateEmployeeStatusSchema = z.object({
  status: z.enum(['AVAILABLE', 'BUSY', 'OFFLINE'], {
    errorMap: () => ({ message: 'Status must be AVAILABLE, BUSY, or OFFLINE' }),
  }),
});
