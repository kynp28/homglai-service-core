import { z } from 'zod';
import { isDateOnlyString } from '../utils/date';

const dateOnly = z.string().refine(isDateOnlyString, 'Must be a real date in YYYY-MM-DD format');

export const createHolidaySchema = z
  .object({
    date: dateOnly,
    // Optional last day of a closure that spans several days (inclusive, at most 31 days)
    toDate: dateOnly.optional(),
    name: z.string().trim().min(1, 'Name is required').max(100, 'Name cannot exceed 100 characters'),
  })
  .strict();

export const listHolidaysQuerySchema = z
  .object({
    from: dateOnly.optional(),
    to: dateOnly.optional(),
  })
  .strict();
