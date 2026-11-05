import { z } from 'zod';
import { isValidThaiPhone, normalizePhone } from '../utils/phone';

export const createRepairOrderSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(1, 'Customer name is required'),
    phone: z
      .string()
      .trim()
      .refine((val) => isValidThaiPhone(val), {
        message: 'Invalid Thai phone number. Must be 9-10 digits.',
      })
      .transform((val) => normalizePhone(val)),
  }),
  machine: z.object({
    brand: z.string().trim().min(1, 'Machine brand is required'),
    model: z.string().trim().min(1, 'Machine model is required'),
    serialNumber: z.string().trim().optional().nullable(),
  }),
  symptomIds: z
    .array(z.number().int().positive('Symptom ID must be a positive integer'))
    .min(1, 'At least one symptom must be selected'),
  otherSymptom: z.string().trim().optional().nullable(),
});

export const addRepairItemSchema = z.object({
  name: z.string().trim().min(1, 'Item name is required'),
  price: z
    .union([z.number(), z.string()])
    .transform((val) => (typeof val === 'string' ? parseFloat(val) : val))
    .refine((val) => !isNaN(val) && val > 0, {
      message: 'Price must be a positive number',
    })
    .refine((val) => val <= 99999999.99, {
      message: 'Price exceeds maximum allowed value (99,999,999.99)',
    })
    .refine(
      (val) => {
        const str = val.toString();
        const parts = str.split('.');
        return parts.length < 2 || parts[1].length <= 2;
      },
      {
        message: 'Price cannot have more than 2 decimal places',
      }
    ),
});

export const resolveRepairItemSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED'], {
    errorMap: () => ({ message: 'Status must be APPROVED or REJECTED' }),
  }),
});

export const updateRepairStatusSchema = z.object({
  status: z.enum([
    'NEW',
    'INSPECTING',
    'WAITING_APPROVAL',
    'REPAIRING',
    'COMPLETED',
    'DELIVERED',
    'CANCELLED',
  ], {
    errorMap: () => ({ message: 'Invalid repair order status' }),
  }),
  note: z.string().trim().optional(),
});

export const getRepairsQuerySchema = z.object({
  status: z
    .preprocess(
      (val) => (val === '' ? undefined : val),
      z.enum([
        'NEW',
        'INSPECTING',
        'WAITING_APPROVAL',
        'REPAIRING',
        'COMPLETED',
        'DELIVERED',
        'CANCELLED',
      ], {
        errorMap: () => ({ message: 'Invalid repair order status filter' }),
      }).optional()
    ),
  technicianId: z
    .preprocess(
      (val) => (val === '' ? undefined : val),
      z.coerce.number().int().positive('technicianId must be a positive integer').optional()
    ),
  search: z
    .string()
    .trim()
    .max(100, 'Search query cannot exceed 100 characters')
    .optional(),
  page: z
    .preprocess(
      (val) => (val === '' ? undefined : val),
      z.coerce.number().int().positive('page must be a positive integer').optional().default(1)
    ),
  limit: z
    .preprocess(
      (val) => (val === '' ? undefined : val),
      z.coerce.number().int().min(1).max(100, 'limit must be between 1 and 100').optional().default(20)
    ),
});
