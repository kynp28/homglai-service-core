import { z } from 'zod';

/** Empty / whitespace-only strings become null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));

/** Barcode content: letters, digits and - _ . / (what USB scanners type), at most 64 characters. */
export const partCodeSchema = z
  .string()
  .trim()
  .min(1, 'code is required')
  .max(64, 'code cannot exceed 64 characters')
  .regex(/^[A-Za-z0-9._\/-]+$/, 'code may contain letters, digits and - _ . / only');

const money = z
  .union([z.number(), z.string()])
  .nullable()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0 || n > 99_999_999.99 || Math.round(n * 100) / 100 !== n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'price must be a number >= 0 with at most 2 decimals' });
      return z.NEVER;
    }
    return n;
  });

const fields = {
  name: z.string().trim().min(1, 'name is required').max(191),
  category: optionalText(100),
  machineModels: optionalText(500),
  unit: z.string().trim().min(1).max(20).optional(),
  sellPrice: money,
  costPrice: money,
  note: optionalText(500),
};

export const createPartSchema = z
  .object({
    /** Omit to get a generated HG00001-style code (for parts without a label) */
    code: partCodeSchema.optional(),
    ...fields,
    stockQty: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export const updatePartSchema = z
  .object({
    code: partCodeSchema.optional(),
    ...fields,
    name: fields.name.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

/** change: +n / -n (SCAN_IN, ADJUST) · set: the counted quantity (COUNT) */
export const stockSchema = z
  .object({
    change: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    set: z.number().int().min(0).max(1_000_000).optional(),
    reason: z.enum(['SCAN_IN', 'ADJUST', 'COUNT']).optional(),
    note: optionalText(500),
  })
  .strict()
  .refine((v) => (v.change !== undefined) !== (v.set !== undefined), 'Send either change or set')
  .refine((v) => v.change === undefined || v.change !== 0, 'change cannot be 0');

export const importPartsSchema = z
  .object({
    rows: z
      .array(
        z
          .object({ code: partCodeSchema, ...fields, unit: fields.unit, stockQty: z.number().int().min(0).optional() })
          .strip()
      )
      .min(1, 'rows is empty')
      .max(5000, 'At most 5000 rows per import'),
  })
  .strict();

export const listPartsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  includeInactive: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(500).optional().default(50),
});
