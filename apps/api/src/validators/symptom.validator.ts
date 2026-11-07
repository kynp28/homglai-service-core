import { z } from 'zod';

const name = z.string().trim().min(1, 'Name is required').max(100, 'Name cannot exceed 100 characters');
const id = z.coerce.number().int().positive();

export const categoryBodySchema = z.object({ name }).strict();

export const createSymptomSchema = z.object({ name, categoryId: id }).strict();

export const updateSymptomSchema = z
  .object({ name: name.optional(), categoryId: id.optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.categoryId !== undefined, 'Nothing to update: send name and/or categoryId');
