import crypto from 'crypto';
import { lockOrderRow } from '../utils/order-lock';
import sharp from 'sharp';
import prisma, { ImageKind } from '@homglai/db';
import { AppError } from '../utils/app-error';
import { getAppConfig } from '../config/env';
import { getStorage, StorageService } from '../storage/storage.service';
import { recordActivity } from '../utils/activity';

/** Largest decoded image accepted (protects against decompression bombs). */
export const MAX_INPUT_PIXELS = 50_000_000;
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);
export const UNSUPPORTED_IMAGE_MESSAGE =
  'Unsupported image: only JPEG, PNG or WebP photos are accepted (convert HEIC/HEIF to JPEG first) / ' +
  'รองรับเฉพาะรูป JPEG, PNG หรือ WebP (รูป HEIC/HEIF กรุณาแปลงเป็น JPEG ก่อนอัปโหลด)';

const CLOSED = ['DELIVERED', 'CANCELLED'];
const FRONT_DESK_KINDS: ImageKind[] = ['INTAKE', 'RECEIPT_PAPER'];

interface Actor {
  id: number;
  role: string;
}

/**
 * Checks the real file content (never the client's mimetype or file name), then: EXIF auto-rotate,
 * strip ALL metadata (sharp drops EXIF/GPS unless asked to keep it), shrink to IMAGE_MAX_LONG_EDGE
 * (never enlarge), re-encode as JPEG quality 82.
 */
export async function normalizeImage(input: Buffer, maxLongEdge = getAppConfig().imageMaxLongEdge): Promise<Buffer> {
  let format: string | undefined;
  try {
    format = (await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()).format;
  } catch {
    format = undefined;
  }
  if (!format || !ACCEPTED_FORMATS.has(format)) {
    throw new AppError(415, UNSUPPORTED_IMAGE_MESSAGE);
  }
  try {
    return await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: maxLongEdge, height: maxLongEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch {
    // Truncated / corrupt data or too many pixels
    throw new AppError(415, UNSUPPORTED_IMAGE_MESSAGE);
  }
}

/** Response shape: never contains storagePath. */
const imageViewSelect = {
  id: true,
  kind: true,
  createdAt: true,
  uploadedBy: { select: { id: true, name: true } },
} as const;

async function loadOrderForImages(repairOrderId: number) {
  const order = await prisma.repairOrder.findUnique({
    where: { id: repairOrderId },
    select: { id: true, status: true, technicianId: true },
  });
  if (!order) throw new AppError(404, 'Repair order not found');
  return order;
}

function assertCanView(order: { technicianId: number | null }, actor: Actor): void {
  if (actor.role === 'TECHNICIAN' && order.technicianId !== actor.id) {
    throw new AppError(403, 'Forbidden: You do not have permission to view images of this repair order');
  }
}

export class ImageService {
  /**
   * POST /api/repairs/:id/images. INTAKE / RECEIPT_PAPER: RECEPTIONIST, ADMIN.
   * DELIVERY / OTHER: the assigned TECHNICIAN, RECEPTIONIST, ADMIN.
   * All files are validated and converted before anything is written; if writing or the database
   * insert fails, every file written by this request is removed (no orphans).
   */
  static async upload(
    repairOrderId: number,
    actor: Actor,
    kind: ImageKind,
    files: Buffer[],
    storage: StorageService = getStorage()
  ) {
    const config = getAppConfig();
    if (files.length === 0) throw new AppError(400, 'No image files were uploaded (field "files")');

    const order = await loadOrderForImages(repairOrderId);
    if (FRONT_DESK_KINDS.includes(kind)) {
      if (actor.role !== 'RECEPTIONIST' && actor.role !== 'ADMIN') {
        throw new AppError(403, `Forbidden: ${kind} images are uploaded by RECEPTIONIST or ADMIN`);
      }
    } else if (actor.role === 'TECHNICIAN' && order.technicianId !== actor.id) {
      throw new AppError(403, 'Forbidden: Only the assigned technician can upload images to this repair order');
    }
    if (CLOSED.includes(order.status)) {
      throw new AppError(409, `Cannot add images to a ${order.status} repair order`);
    }

    const existing = await prisma.repairOrderImage.count({ where: { repairOrderId, kind } });
    if (existing + files.length > config.imageMaxPerKind) {
      throw new AppError(
        409,
        `Too many ${kind} images: ${existing} stored + ${files.length} uploaded exceeds the limit of ${config.imageMaxPerKind}`,
        { existing, uploaded: files.length, limit: config.imageMaxPerKind }
      );
    }

    // 1. Validate + convert everything first (nothing written if any file is rejected)
    const converted: Buffer[] = [];
    for (const file of files) converted.push(await normalizeImage(file, config.imageMaxLongEdge));

    // 2. Write files, 3. insert records; clean up written files on any failure
    const written: string[] = [];
    try {
      for (const data of converted) {
        const relPath = `${repairOrderId}/${crypto.randomUUID()}.jpg`;
        await storage.save(relPath, data);
        written.push(relPath);
      }
      const now = new Date();
      await prisma.$transaction(async (tx) => {
        // Re-checked under a row lock: concurrent uploads to the same order are counted one at a time
        const fresh = await lockOrderRow(tx, repairOrderId);
        if (!fresh) throw new AppError(404, 'Repair order not found');
        if (CLOSED.includes(fresh.status)) throw new AppError(409, `Cannot add images to a ${fresh.status} repair order`);
        const count = await tx.repairOrderImage.count({ where: { repairOrderId, kind } });
        if (count + written.length > config.imageMaxPerKind) {
          throw new AppError(409, `Too many ${kind} images (limit ${config.imageMaxPerKind})`);
        }
        await tx.repairOrderImage.createMany({
          data: written.map((storagePath) => ({ repairOrderId, kind, storagePath, uploadedById: actor.id, createdAt: now })),
        });
        // A technician uploading photos is working on the job (SRS 3.6)
        if (actor.role === 'TECHNICIAN') await recordActivity(tx, repairOrderId, now);
      });
    } catch (err) {
      await Promise.all(written.map((p) => storage.delete(p).catch(() => undefined)));
      throw err;
    }

    return ImageService.list(repairOrderId, actor);
  }

  /** GET /api/repairs/:id/images — metadata only (no storagePath). */
  static async list(repairOrderId: number, actor: Actor) {
    const order = await loadOrderForImages(repairOrderId);
    assertCanView(order, actor);
    return prisma.repairOrderImage.findMany({
      where: { repairOrderId },
      select: imageViewSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** Opens one image for streaming. The image must belong to this order (IDOR guard). */
  static async open(repairOrderId: number, imageId: number, actor: Actor, storage: StorageService = getStorage()) {
    const order = await loadOrderForImages(repairOrderId);
    assertCanView(order, actor);
    const image = await prisma.repairOrderImage.findFirst({
      where: { id: imageId, repairOrderId },
      select: { storagePath: true },
    });
    if (!image || !(await storage.exists(image.storagePath))) {
      throw new AppError(404, 'Image not found');
    }
    return storage.createReadStream(image.storagePath);
  }
}

/**
 * Deletes images of orders closed (DELIVERED / CANCELLED) at least IMAGE_RETENTION_DAYS ago (SRS 2.3).
 * File first, then record: a file already gone counts as deleted; if a file cannot be deleted its
 * record is kept for the next run. Open orders (closedAt null) are never touched. Works in batches
 * of at most 200 rows. Returns the number of images removed. Phase 8 schedules it.
 */
export async function purgeExpiredImages(
  now: Date,
  options: { storage?: StorageService; retentionDays?: number; batchSize?: number } = {}
): Promise<number> {
  const storage = options.storage ?? getStorage();
  const retentionDays = options.retentionDays ?? getAppConfig().imageRetentionDays;
  const batchSize = Math.min(options.batchSize ?? 200, 200);
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

  let removed = 0;
  let lastId = 0;
  while (true) {
    const batch = await prisma.repairOrderImage.findMany({
      where: { id: { gt: lastId }, repairOrder: { closedAt: { not: null, lte: cutoff } } },
      select: { id: true, storagePath: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (batch.length === 0) break;
    lastId = batch[batch.length - 1].id;

    const deletable: number[] = [];
    for (const image of batch) {
      try {
        await storage.delete(image.storagePath); // missing file = already deleted
        deletable.push(image.id);
      } catch (err: any) {
        console.error(`[Image Purge] keeping record ${image.id}, file could not be deleted:`, err?.message || err);
      }
    }
    if (deletable.length > 0) {
      const res = await prisma.repairOrderImage.deleteMany({ where: { id: { in: deletable } } });
      removed += res.count;
    }
    if (batch.length < batchSize) break;
  }
  return removed;
}
