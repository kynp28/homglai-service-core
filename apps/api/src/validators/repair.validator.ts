import { z } from 'zod';
import { isValidThaiPhone, normalizePhone } from '../utils/phone';
import { diffDateOnlyDays, dateOnlyToDate, getBangkokDateOnly, isDateOnlyString } from '../utils/date';

// ---------------------------------------------------------------------------
// Shared field schemas (SRS 2, 2.1)
// ---------------------------------------------------------------------------

/** Empty / whitespace-only strings become null so optional text columns stay clean. */
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} cannot exceed ${max} characters`)
    .nullable()
    .optional()
    .transform((val) => (val === undefined ? undefined : val === null || val === '' ? null : val));

const dateOnly = (label: string) =>
  z
    .string()
    .trim()
    .refine((val) => isDateOnlyString(val), { message: `${label} must be a valid date in YYYY-MM-DD format` });

/** receivedDate: YYYY-MM-DD, may not be more than 1 day after today's date in Asia/Bangkok. */
const receivedDateSchema = dateOnly('receivedDate').refine(
  (val) => diffDateOnlyDays(getBangkokDateOnly(new Date()), dateOnlyToDate(val)) <= 1,
  { message: 'receivedDate cannot be more than 1 day in the future (Asia/Bangkok)' }
);

/** Paper receipt number: digits only, 1-10 digits. Numbers are accepted and converted to strings. */
const paperReceiptNoSchema = z
  .union([z.string(), z.number().int().nonnegative()])
  .transform((val) => String(val).trim())
  .refine((val) => /^\d{1,10}$/.test(val), { message: 'paperReceiptNo must contain digits only (1-10 digits)' });

/** SRS 2.1 accessories checklist (9 items on the paper form). Unknown keys are rejected. */
export const accessoriesSchema = z
  .object({
    drainTray: z.boolean().default(false),
    portafilter: z.boolean().default(false),
    basket1Shot: z.boolean().default(false),
    basket2Shot: z.boolean().default(false),
    powerCord: z.boolean().default(false),
    waterTank: z.boolean().default(false),
    tamper: z.boolean().default(false),
    steamWandCover: z.boolean().default(false),
    other: z
      .string()
      .trim()
      .max(100, 'accessories.other cannot exceed 100 characters')
      .nullable()
      .optional()
      .transform((val) => (val ? val : null)),
  })
  .strict();

/** Care advice tick boxes on the paper form. Unknown keys are rejected. */
export const careAdviceSchema = z
  .object({
    cleanAfterUse: z.boolean().default(false),
    noOverload: z.boolean().default(false),
  })
  .strict();

const warrantyStatusSchema = z.enum(['IN_WARRANTY', 'OUT_OF_WARRANTY'], {
  errorMap: () => ({ message: 'warrantyStatus must be IN_WARRANTY or OUT_OF_WARRANTY' }),
});

const billingTypeSchema = z.enum(['CHARGE_OUT_OF_WARRANTY', 'NO_CHARGE_IN_WARRANTY', 'CHARGE_IN_WARRANTY'], {
  errorMap: () => ({
    message: 'billingType must be CHARGE_OUT_OF_WARRANTY, NO_CHARGE_IN_WARRANTY or CHARGE_IN_WARRANTY',
  }),
});

const customerNameSchema = z.string().trim().min(1, 'Customer name is required').max(191, 'Customer name is too long');
const customerAddressSchema = optionalText(1000, 'customer.address');

/**
 * Warranty consistency rule (SRS 2): IN_WARRANTY requires an expiry date;
 * an expiry date is only allowed together with IN_WARRANTY.
 * Returns an error message or null. Shared by create (schema) and edit (service, merged values).
 */
export function warrantyConsistencyError(
  warrantyStatus: string | null | undefined,
  warrantyExpiryDate: unknown
): string | null {
  const hasExpiry = warrantyExpiryDate !== null && warrantyExpiryDate !== undefined;
  if (warrantyStatus === 'IN_WARRANTY' && !hasExpiry) {
    return 'warrantyExpiryDate is required when warrantyStatus is IN_WARRANTY';
  }
  if (warrantyStatus !== 'IN_WARRANTY' && hasExpiry) {
    return 'warrantyExpiryDate is only allowed when warrantyStatus is IN_WARRANTY';
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /api/repairs
// ---------------------------------------------------------------------------

export const createRepairOrderSchema = z
  .object({
    customer: z.object({
      name: customerNameSchema,
      phone: z
        .string()
        .trim()
        .refine((val) => isValidThaiPhone(val), {
          message: 'Invalid Thai phone number. Must be 9-10 digits.',
        })
        .transform((val) => normalizePhone(val)),
      address: customerAddressSchema,
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

    // Paper form fields (SRS 2)
    paperBookNo: optionalText(20, 'paperBookNo'),
    paperReceiptNo: paperReceiptNoSchema.nullable().optional(),
    receivedDate: receivedDateSchema.optional(),
    workType: z.enum(['REPAIR'], { errorMap: () => ({ message: 'workType must be REPAIR' }) }).optional(),
    warrantyStatus: warrantyStatusSchema.nullable().optional(),
    warrantyExpiryDate: dateOnly('warrantyExpiryDate').nullable().optional(),
    accessories: accessoriesSchema.nullable().optional(),
    loanerMachine: z.boolean().optional(),
    loanerNote: optionalText(500, 'loanerNote'),
    billingType: billingTypeSchema.nullable().optional(),
    careAdvice: careAdviceSchema.nullable().optional(),
    warningNote: optionalText(2000, 'warningNote'),
  })
  .superRefine((data, ctx) => {
    const error = warrantyConsistencyError(data.warrantyStatus, data.warrantyExpiryDate);
    if (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['warrantyExpiryDate'], message: error });
    }
  });

export type CreateRepairOrderInput = z.infer<typeof createRepairOrderSchema>;

// ---------------------------------------------------------------------------
// PATCH /api/repairs/:id  (edit intake data only)
// status / technicianId / jobNumber / customer.phone are NOT accepted (strict => 400)
// ---------------------------------------------------------------------------

export const updateRepairOrderSchema = z
  .object({
    customer: z
      .object({
        name: customerNameSchema.optional(),
        address: customerAddressSchema,
      })
      .strict(),
    machine: z
      .object({
        brand: z.string().trim().min(1, 'Machine brand is required').optional(),
        model: z.string().trim().min(1, 'Machine model is required').optional(),
        serialNumber: optionalText(191, 'machine.serialNumber'),
      })
      .strict(),
    symptomIds: z
      .array(z.number().int().positive('Symptom ID must be a positive integer'))
      .min(1, 'At least one symptom must be selected'),
    otherSymptom: optionalText(5000, 'otherSymptom'),
    paperBookNo: optionalText(20, 'paperBookNo'),
    paperReceiptNo: paperReceiptNoSchema.nullable(),
    receivedDate: receivedDateSchema,
    warrantyStatus: warrantyStatusSchema.nullable(),
    warrantyExpiryDate: dateOnly('warrantyExpiryDate').nullable(),
    accessories: accessoriesSchema.nullable(),
    loanerMachine: z.boolean(),
    loanerNote: optionalText(500, 'loanerNote'),
    billingType: billingTypeSchema.nullable(),
    careAdvice: careAdviceSchema.nullable(),
    warningNote: optionalText(2000, 'warningNote'),
  })
  .partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field must be provided' });

export type UpdateRepairOrderInput = z.infer<typeof updateRepairOrderSchema>;

// ---------------------------------------------------------------------------
// POST /api/repairs/:id/items  (RepairItem v2, SRS 2.2)
// ---------------------------------------------------------------------------

const MAX_PRICE = 99999999.99;

const moneySchema = z
  .union([z.number(), z.string()])
  .transform((val) => (typeof val === 'string' ? parseFloat(val) : val))
  .refine((val) => !isNaN(val) && isFinite(val) && val >= 0, {
    message: 'Price must be a positive number',
  })
  .refine((val) => val <= MAX_PRICE, {
    message: 'Price exceeds maximum allowed value (99,999,999.99)',
  })
  .refine(
    (val) => {
      const parts = val.toString().split('.');
      return parts.length < 2 || parts[1].length <= 2;
    },
    { message: 'Price cannot have more than 2 decimal places' }
  );

export const addRepairItemSchema = z
  .object({
    name: z.string().trim().min(1, 'Item name is required').max(191, 'Item name is too long'),
    quantity: z
      .union([z.number(), z.string()])
      .transform((val) => (typeof val === 'string' ? Number(val) : val))
      .refine((val) => Number.isInteger(val) && val >= 1 && val <= 999, {
        message: 'quantity must be an integer between 1 and 999',
      })
      .optional()
      .default(1),
    unitPrice: moneySchema.optional(),
    /** @deprecated legacy alias of unitPrice (kept for backward compatibility) */
    price: moneySchema.optional(),
    barcode: optionalText(64, 'barcode'),
    itemType: z
      .enum(['PART', 'TRAVEL_FEE', 'LABOR_HOURS', 'SERVICE_FEE'], {
        errorMap: () => ({ message: 'itemType must be PART, TRAVEL_FEE, LABOR_HOURS or SERVICE_FEE' }),
      })
      .optional()
      .default('PART'),
  })
  .superRefine((data, ctx) => {
    if (data.unitPrice === undefined && data.price === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unitPrice'], message: 'unitPrice is required' });
      return;
    }
    if (data.unitPrice !== undefined && data.price !== undefined && data.unitPrice !== data.price) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['price'],
        message: 'price is an alias of unitPrice; send only one of them or the same value',
      });
      return;
    }
    const value = (data.unitPrice ?? data.price) as number;
    // LABOR_HOURS rows record hours only (no price on the paper form), so 0 is allowed there.
    if (data.itemType !== 'LABOR_HOURS' && value <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unitPrice'], message: 'Price must be a positive number' });
    }
  })
  .transform(({ price, unitPrice, ...rest }) => ({
    ...rest,
    unitPrice: (unitPrice ?? price) as number,
  }));

export type AddRepairItemInput = z.infer<typeof addRepairItemSchema>;

export const resolveRepairItemSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED'], {
    errorMap: () => ({ message: 'Status must be APPROVED or REJECTED' }),
  }),
  /** Short evidence of the phone call, e.g. "โทรคุยกับเจ้าของร้าน 14:20" */
  note: optionalText(500, 'note'),
});

const helperIdsSchema = z
  .array(z.number().int().positive('Helper technician ID must be a positive integer'))
  .max(10, 'At most 10 helper technicians are allowed');

/** POST /api/repairs/:id/complete */
export const completeRepairSchema = z
  .object({
    completionSummary: z
      .string()
      .trim()
      .min(1, 'completionSummary is required')
      .max(2000, 'completionSummary cannot exceed 2000 characters'),
    helperTechnicianIds: helperIdsSchema.optional(),
    // NOT_REPAIRED: customer declined the repair; the machine is returned (owner decision 2026-11-05)
    outcome: z.enum(['REPAIRED', 'NOT_REPAIRED']).optional(),
  })
  .strict();

/** Payment received from the customer (record only). */
export const paymentSchema = z
  .object({
    amount: z
      .number({ invalid_type_error: 'amount must be a number' })
      .min(0, 'amount cannot be negative')
      .max(99_999_999.99, 'amount is too large')
      .refine((v) => Number.isInteger(Math.round(v * 100)) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
        message: 'amount can have at most 2 decimal places',
      }),
    method: z.enum(['CASH', 'TRANSFER', 'OTHER'], {
      errorMap: () => ({ message: 'method must be CASH, TRANSFER or OTHER' }),
    }),
    note: z.string().trim().max(500, 'note cannot exceed 500 characters').optional(),
  })
  .strict();
export type PaymentInput = z.infer<typeof paymentSchema>;

/** PUT /api/repairs/:id/helpers */
export const setHelpersSchema = z
  .object({
    technicianIds: helperIdsSchema,
  })
  .strict();

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
  // Only with status DELIVERED: payment received at handover (optional, record only)
  payment: paymentSchema.optional(),
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
  needsProgressUpdate: z
    .preprocess(
      (val) => (val === '' || val === undefined ? undefined : val),
      z.enum(['true', 'false'], { errorMap: () => ({ message: 'needsProgressUpdate must be true or false' }) }).optional()
    )
    .transform((val) => val === 'true'),
  awaitingAck: z
    .preprocess(
      (val) => (val === '' || val === undefined ? undefined : val),
      z.enum(['true', 'false'], { errorMap: () => ({ message: 'awaitingAck must be true or false' }) }).optional()
    )
    .transform((val) => val === 'true'),
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
