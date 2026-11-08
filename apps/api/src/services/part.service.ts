import prisma, { Prisma } from '@homglai/db';
import { AppError } from '../utils/app-error';
import { createPartSchema, importPartsSchema, listPartsQuerySchema, stockSchema, updatePartSchema } from '../validators/part.validator';

const money = (d: Prisma.Decimal | null) => (d === null ? null : new Prisma.Decimal(d).toFixed(2));

/** API view: money as "750.00" strings. */
function toView<T extends { sellPrice: Prisma.Decimal | null; costPrice: Prisma.Decimal | null }>(part: T) {
  return { ...part, sellPrice: money(part.sellPrice), costPrice: money(part.costPrice) };
}

function isUniqueCode(err: any): boolean {
  return err?.code === 'P2002';
}

/** Next generated code: HG00001, HG00002, … (zero-padded so they sort). */
async function nextGeneratedCode(tx: Prisma.TransactionClient): Promise<string> {
  const last = await tx.part.findFirst({
    where: { code: { startsWith: 'HG' } },
    orderBy: { code: 'desc' },
    select: { code: true },
  });
  const n = last && /^HG\d{5,}$/.test(last.code) ? Number(last.code.slice(2)) + 1 : 1;
  return `HG${String(n).padStart(5, '0')}`;
}

export class PartService {
  static async list(rawQuery: unknown) {
    const q = listPartsQuerySchema.parse(rawQuery);
    const where: Prisma.PartWhereInput = {
      ...(q.includeInactive ? {} : { isActive: true }),
      ...(q.search ? { OR: [{ code: { contains: q.search } }, { name: { contains: q.search } }, { machineModels: { contains: q.search } }] } : {}),
    };
    const [total, parts] = await Promise.all([
      prisma.part.count({ where }),
      prisma.part.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    return { total, page: q.page, limit: q.limit, totalPages: Math.ceil(total / q.limit), parts: parts.map(toView) };
  }

  static async byCode(code: string) {
    const part = await prisma.part.findUnique({ where: { code: code.trim() } });
    if (!part) throw new AppError(404, 'Part not found');
    return toView(part);
  }

  static async create(raw: unknown, employeeId: number) {
    const data = createPartSchema.parse(raw);
    try {
      const part = await prisma.$transaction(async (tx) => {
        const code = data.code ?? (await nextGeneratedCode(tx));
        const created = await tx.part.create({
          data: {
            code,
            name: data.name,
            category: data.category ?? null,
            machineModels: data.machineModels ?? null,
            unit: data.unit ?? 'ชิ้น',
            sellPrice: data.sellPrice ?? null,
            costPrice: data.costPrice ?? null,
            note: data.note ?? null,
            stockQty: data.stockQty ?? 0,
          },
        });
        if (created.stockQty > 0) {
          await tx.partStockLog.create({
            data: { partId: created.id, change: created.stockQty, qtyAfter: created.stockQty, reason: 'SCAN_IN', note: 'ตั้งต้นตอนเพิ่มอะไหล่', employeeId },
          });
        }
        return created;
      });
      return toView(part);
    } catch (err) {
      if (isUniqueCode(err)) throw new AppError(409, `รหัส ${data.code} มีในระบบแล้ว`);
      throw err;
    }
  }

  static async update(id: number, raw: unknown) {
    const data = updatePartSchema.parse(raw);
    try {
      const part = await prisma.part.update({
        where: { id },
        data: {
          ...(data.code !== undefined ? { code: data.code } : {}),
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.category !== undefined ? { category: data.category } : {}),
          ...(data.machineModels !== undefined ? { machineModels: data.machineModels } : {}),
          ...(data.unit !== undefined ? { unit: data.unit } : {}),
          ...(data.sellPrice !== undefined ? { sellPrice: data.sellPrice } : {}),
          ...(data.costPrice !== undefined ? { costPrice: data.costPrice } : {}),
          ...(data.note !== undefined ? { note: data.note } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        },
      });
      return toView(part);
    } catch (err: any) {
      if (err?.code === 'P2025') throw new AppError(404, 'Part not found');
      if (isUniqueCode(err)) throw new AppError(409, `รหัส ${data.code} มีในระบบแล้ว`);
      throw err;
    }
  }

  /** +n / -n or set to a counted quantity; stock never goes below 0. Logged with who and why. */
  static async adjustStock(id: number, raw: unknown, employeeId: number) {
    const data = stockSchema.parse(raw);
    const part = await prisma.$transaction(async (tx) => {
      // Row lock: concurrent scans of the same part are applied one after the other
      const rows = await tx.$queryRaw<Array<{ stockQty: number }>>`SELECT stockQty FROM Part WHERE id = ${id} FOR UPDATE`;
      if (rows.length === 0) throw new AppError(404, 'Part not found');
      const current = Number(rows[0].stockQty);
      const next = data.set !== undefined ? data.set : current + (data.change as number);
      if (next < 0) throw new AppError(409, `สต็อกไม่พอ (คงเหลือ ${current})`);
      const updated = await tx.part.update({ where: { id }, data: { stockQty: next } });
      await tx.partStockLog.create({
        data: {
          partId: id,
          change: next - current,
          qtyAfter: next,
          reason: data.reason ?? (data.set !== undefined ? 'COUNT' : 'ADJUST'),
          note: data.note ?? null,
          employeeId,
        },
      });
      return updated;
    });
    return toView(part);
  }

  static async stockLogs(id: number) {
    const logs = await prisma.partStockLog.findMany({
      where: { partId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: { id: true, change: true, qtyAfter: true, reason: true, note: true, createdAt: true, employee: { select: { id: true, name: true } } },
    });
    return logs;
  }

  /**
   * Upsert by code (Excel import). Existing parts get the given fields; stockQty is only applied to NEW parts
   * (counting existing stock goes through the scan page so it is logged). Rows are validated together first.
   */
  static async import(raw: unknown, employeeId: number) {
    const { rows } = importPartsSchema.parse(raw);
    const seen = new Set<string>();
    let created = 0;
    let updated = 0;
    const skipped: Array<{ code: string; reason: string }> = [];
    for (const row of rows) {
      if (seen.has(row.code)) {
        skipped.push({ code: row.code, reason: 'รหัสซ้ำในไฟล์ (ใช้แถวแรก)' });
        continue;
      }
      seen.add(row.code);
      const existing = await prisma.part.findUnique({ where: { code: row.code }, select: { id: true } });
      const values = {
        name: row.name,
        ...(row.category !== undefined ? { category: row.category } : {}),
        ...(row.machineModels !== undefined ? { machineModels: row.machineModels } : {}),
        ...(row.unit !== undefined ? { unit: row.unit } : {}),
        ...(row.sellPrice !== undefined ? { sellPrice: row.sellPrice } : {}),
        ...(row.costPrice !== undefined ? { costPrice: row.costPrice } : {}),
        ...(row.note !== undefined ? { note: row.note } : {}),
      };
      if (existing) {
        await prisma.part.update({ where: { id: existing.id }, data: values });
        updated++;
      } else {
        await PartService.create({ code: row.code, ...values, stockQty: row.stockQty }, employeeId);
        created++;
      }
    }
    return { created, updated, skipped };
  }
}

export type PartView = Awaited<ReturnType<typeof PartService.byCode>>;
