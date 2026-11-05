import { z } from 'zod';

export const getNotificationsQuerySchema = z.object({
  unreadOnly: z
    .preprocess(
      (val) => (val === '' || val === undefined ? undefined : val),
      z
        .enum(['true', 'false'], { errorMap: () => ({ message: 'unreadOnly must be true or false' }) })
        .optional()
    )
    .transform((val) => val === 'true'),
  page: z.preprocess(
    (val) => (val === '' ? undefined : val),
    z.coerce.number().int().positive('page must be a positive integer').optional().default(1)
  ),
  limit: z.preprocess(
    (val) => (val === '' ? undefined : val),
    z.coerce.number().int().min(1).max(100, 'limit must be between 1 and 100').optional().default(20)
  ),
});
