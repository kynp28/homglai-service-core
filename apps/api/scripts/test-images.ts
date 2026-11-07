/**
 * Phase 7 tests: photo upload (content check, EXIF removal, resize, limits, permissions),
 * list / download (no storage path, IDOR), purge of expired photos.
 * Test images are generated with sharp; no external files. Runs against the API started by
 * test-runner.js (IMAGE_STORAGE_DIR=./data/test-uploads) on a *_test database.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import prisma from '@homglai/db';
import { assertSafeDatabaseUrl } from '../src/utils/test-safety';
import { getAppConfig, getJwtSecret } from '../src/config/env';
import { getBangkokDateOnly } from '../src/utils/date';
import { getStorage, LocalDiskStorage, StorageService } from '../src/storage/storage.service';
import { purgeExpiredImages } from '../src/services/image.service';

type Headers = Record<string, string>;
const API = 'http://localhost:4000/api';
const TECHS = [3, 4, 5, 6, 7];
const DAY = 86_400_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}
function eq(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual:   ${JSON.stringify(actual)}`);
  }
}
function pass(message: string): void {
  console.log(`  [PASS] ${message}`);
}
async function tokenFor(id: number): Promise<Headers> {
  const e = await prisma.employee.findUniqueOrThrow({ where: { id } });
  return { Authorization: `Bearer ${jwt.sign({ employeeId: e.id, role: e.role }, getJwtSecret(), { algorithm: 'HS256', expiresIn: '30m' })}` };
}

type Part = { data: Buffer; name: string; type: string };
const allTexts: string[] = [];
async function upload(orderId: number, kind: string | null, files: Part[], headers: Headers = {}) {
  const fd = new FormData();
  if (kind !== null) fd.append('kind', kind);
  for (const f of files) fd.append('files', new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
  const res = await fetch(`${API}/repairs/${orderId}/images`, { method: 'POST', headers, body: fd });
  const text = await res.text();
  allTexts.push(text);
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
async function getJson(url: string, headers: Headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  allTexts.push(text);
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
async function download(orderId: number, imageId: number, headers: Headers = {}) {
  const res = await fetch(`${API}/repairs/${orderId}/images/${imageId}`, { headers });
  const data = Buffer.from(await res.arrayBuffer());
  if (!res.headers.get('content-type')?.startsWith('image/')) allTexts.push(data.toString('utf8'));
  return { status: res.status, headers: res.headers, data };
}
async function expectStatus(label: string, expected: number, actual: number, body?: string) {
  if (actual !== expected) throw new Error(`ASSERTION FAILED: ${label} — expected HTTP ${expected}, got ${actual} ${body ?? ''}`);
  pass(`${label} -> ${expected}`);
}

const jpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 30 } } }).jpeg().toBuffer();
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 200, b: 30 } } }).png().toBuffer();
const webp = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 30, b: 200 } } }).webp().toBuffer();
const asJpg = (data: Buffer, name = 'photo.jpg'): Part => ({ data, name, type: 'image/jpeg' });

function filesUnder(storage: LocalDiskStorage, orderId: number): string[] {
  const dir = path.join(storage.root, String(orderId));
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

async function resetWorld() {
  await prisma.notification.deleteMany({});
  await prisma.repairOrderImage.deleteMany({});
  await prisma.orderLineSubscription.deleteMany({});
  await prisma.repairOrderHelper.deleteMany({});
  await prisma.statusLog.deleteMany({});
  await prisma.repairItem.deleteMany({});
  await prisma.repairOrderSymptom.deleteMany({});
  await prisma.repairOrder.deleteMany({});
  await prisma.employee.updateMany({
    where: { id: { in: TECHS } },
    data: { status: 'OFFLINE', isActive: true, role: 'TECHNICIAN', availableSince: null, weeklyDayOff: null },
  });
}

async function main() {
  assertSafeDatabaseUrl();
  console.log('==================================================================');
  console.log('PHASE 7: REPAIR ORDER PHOTOS');
  console.log('==================================================================\n');

  const storage = getStorage() as LocalDiskStorage;
  assert(/test-uploads$/.test(storage.root), `tests must use the test image folder (got ${storage.root})`);
  fs.rmSync(storage.root, { recursive: true, force: true }); // only the test folder (checked above)

  const admin = await tokenFor(1);
  const recep = await tokenFor(2);
  const t3 = await tokenFor(3);
  const t4 = await tokenFor(4);
  const maxLong = getAppConfig().imageMaxLongEdge;
  const maxPerKind = getAppConfig().imageMaxPerKind;

  await resetWorld();
  const customer = await prisma.customer.create({ data: { name: 'Image Customer', phone: `0854${String(Date.now()).slice(-6)}` } });
  const machine = await prisma.machine.create({ data: { brand: 'LEHEHE', model: 'LH-01', customerId: customer.id } });
  let seq = 0;
  const mk = (status: any, technicianId: number | null, extra: any = {}) =>
    prisma.repairOrder.create({
      data: {
        jobNumber: `REP-P7-${String(++seq).padStart(4, '0')}`,
        trackingToken: crypto.randomBytes(24).toString('base64url'),
        status,
        receivedDate: getBangkokDateOnly(),
        customerId: customer.id,
        machineId: machine.id,
        technicianId,
        lastActivityAt: new Date(),
        ...extra,
      },
    });
  await prisma.employee.updateMany({ where: { id: { in: [3, 4] } }, data: { status: 'BUSY' } });
  const O = await mk('INSPECTING', 3);
  const P = await mk('INSPECTING', 4);

  try {
    // ---------------------------------------------------------------
    console.log('[Test 1] Upload, convert, strip metadata, resize...');
    const rotatedInput = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#c83232' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    assert((await sharp(rotatedInput).metadata()).orientation === 6, 'input has EXIF orientation 6');
    const r1 = await upload(O.id, 'INTAKE', [asJpg(rotatedInput), { data: await png(300, 200), name: 'small.png', type: 'image/png' }, { data: await webp(2000, 1000), name: 'w.webp', type: 'image/webp' }], recep);
    await expectStatus('RECEPTIONIST uploads JPEG + PNG + WebP (INTAKE)', 201, r1.status, r1.text);
    eq(r1.json.data.length, 3, 'three images listed');
    assert(r1.json.data.every((i: any) => JSON.stringify(Object.keys(i).sort()) === JSON.stringify(['createdAt', 'id', 'kind', 'uploadedBy'])), 'image keys: id, kind, uploadedBy, createdAt');
    eq(r1.json.data[0].uploadedBy.id, 2, 'uploadedBy recorded');

    const outs = [];
    for (const img of r1.json.data) {
      const d = await download(O.id, img.id, recep);
      eq(d.status, 200, 'download 200');
      eq(d.headers.get('content-type'), 'image/jpeg', 'Content-Type image/jpeg');
      eq(d.headers.get('cache-control'), 'private, no-store', 'Cache-Control private, no-store');
      eq(d.headers.get('x-content-type-options'), 'nosniff', 'nosniff');
      outs.push(await sharp(d.data).metadata());
    }
    eq(`${outs[0].format} ${outs[0].width}x${outs[0].height}`, `jpeg ${Math.round((maxLong * 2000) / 3000)}x${maxLong}`, 'EXIF rotation applied, long edge = IMAGE_MAX_LONG_EDGE');
    eq(`${outs[1].format} ${outs[1].width}x${outs[1].height}`, 'jpeg 300x200', 'small PNG converted to JPEG, not enlarged');
    eq(`${outs[2].format} ${outs[2].width}x${outs[2].height}`, `jpeg ${maxLong}x${maxLong / 2}`, 'WebP converted and shrunk');
    assert(outs.every((m) => m.exif === undefined && m.orientation === undefined && m.icc === undefined && m.xmp === undefined), 'no EXIF / orientation / ICC / XMP left');
    eq(filesUnder(storage, O.id).length, 3, 'three files on disk under <orderId>/');
    assert(filesUnder(storage, O.id).every((f) => /^[0-9a-f-]{36}\.jpg$/.test(f)), 'stored as <uuid>.jpg (client file names never used)');
    pass('JPEG/PNG/WebP -> JPEG, EXIF removed, long edge capped, small image kept');

    // ---------------------------------------------------------------
    console.log('\n[Test 2] Rejected content and limits...');
    const filesBefore = filesUnder(storage, O.id).length;
    const notImage = await upload(O.id, 'OTHER', [asJpg(Buffer.from('this is not an image at all'), 'fake.jpg')], recep);
    await expectStatus('".jpg" that is not an image', 415, notImage.status, notImage.text);
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'ascii'), Buffer.alloc(200, 7)]);
    const heicRes = await upload(O.id, 'OTHER', [{ data: heic, name: 'IMG_0001.HEIC', type: 'image/heic' }], recep);
    await expectStatus('HEIC', 415, heicRes.status, heicRes.text);
    assert(heicRes.json.message.includes('JPEG') && heicRes.json.message.includes('แปลง'), 'message tells (Thai + English) to convert to JPEG');
    const mixed = await upload(O.id, 'OTHER', [asJpg(await jpeg(100, 100)), asJpg(Buffer.from('broken'), 'b.jpg')], recep);
    await expectStatus('one valid + one invalid file in the same request', 415, mixed.status, mixed.text);
    const big = await upload(O.id, 'OTHER', [asJpg(crypto.randomBytes(getAppConfig().imageMaxBytes + 10), 'big.jpg')], recep);
    await expectStatus('file larger than IMAGE_MAX_BYTES', 413, big.status, big.text);
    const noFiles = await upload(O.id, 'OTHER', [], recep);
    await expectStatus('no files', 400, noFiles.status, noFiles.text);
    const badKind = await upload(O.id, 'SELFIE', [asJpg(await jpeg(50, 50))], recep);
    await expectStatus('unknown kind', 400, badKind.status, badKind.text);
    eq(filesUnder(storage, O.id).length, filesBefore, 'no file written by any rejected upload');
    eq(await prisma.repairOrderImage.count({ where: { repairOrderId: O.id } }), 3, 'no record written by any rejected upload');

    const ten = await Promise.all(Array.from({ length: maxPerKind }, () => png(64, 64)));
    const fill = await upload(O.id, 'DELIVERY', ten.map((d, i) => ({ data: d, name: `${i}.png`, type: 'image/png' })), t3);
    await expectStatus(`${maxPerKind} DELIVERY images in one request (assigned technician)`, 201, fill.status, fill.text);
    const eleventh = await upload(O.id, 'DELIVERY', [asJpg(await jpeg(64, 64))], t3);
    await expectStatus(`image ${maxPerKind + 1} of the same kind`, 409, eleventh.status, eleventh.text);
    const tooMany = await upload(P.id, 'OTHER', Array.from({ length: maxPerKind + 1 }, (_, i) => ({ data: ten[0], name: `${i}.png`, type: 'image/png' })), t4);
    await expectStatus(`${maxPerKind + 1} files in one request`, 400, tooMany.status, tooMany.text);
    pass('Content checked from the bytes; size / count limits; nothing half-written');

    // ---------------------------------------------------------------
    console.log('\n[Test 3] Permissions and IDOR...');
    const small = asJpg(await jpeg(80, 60));
    await expectStatus('another technician uploads to this order', 403, (await upload(O.id, 'OTHER', [small], t4)).status);
    await expectStatus('technician uploads INTAKE', 403, (await upload(O.id, 'INTAKE', [small], t3)).status);
    await expectStatus('technician uploads RECEIPT_PAPER', 403, (await upload(O.id, 'RECEIPT_PAPER', [small], t3)).status);
    await expectStatus('not logged in uploads', 401, (await upload(O.id, 'OTHER', [small])).status);
    await expectStatus('another technician lists images', 403, (await getJson(`${API}/repairs/${O.id}/images`, t4)).status);
    const someImage = r1.json.data[0].id;
    await expectStatus('another technician downloads an image', 403, (await download(O.id, someImage, t4)).status);
    await expectStatus('not logged in downloads', 401, (await download(O.id, someImage)).status);
    const pImg = await upload(P.id, 'OTHER', [small], t4);
    await expectStatus('owner technician uploads OTHER', 201, pImg.status);
    await expectStatus("image of another order through this order's URL", 404, (await download(O.id, pImg.json.data[0].id, admin)).status);
    await expectStatus('unknown image id', 404, (await download(O.id, 999999, admin)).status);
    const ownList = await getJson(`${API}/repairs/${O.id}/images`, t3);
    await expectStatus('assigned technician lists images', 200, ownList.status);
    eq(ownList.json.data.length, 3 + maxPerKind, 'all images of the order listed');

    // Technician upload counts as activity
    await prisma.repairOrder.update({ where: { id: P.id }, data: { lastActivityAt: new Date(Date.now() - 5 * DAY), progressReminderCount: 2 } });
    await upload(P.id, 'OTHER', [small], t4);
    const pAfter = await prisma.repairOrder.findUniqueOrThrow({ where: { id: P.id } });
    assert(pAfter.lastActivityAt && Date.now() - pAfter.lastActivityAt.getTime() < 60_000, 'technician upload updates lastActivityAt');
    eq(pAfter.progressReminderCount, 0, 'and clears the reminder counter');

    // Record exists but the file is gone -> 404
    const gone = await prisma.repairOrderImage.findUniqueOrThrow({ where: { id: someImage } });
    await storage.delete(gone.storagePath);
    await expectStatus('record without file', 404, (await download(O.id, someImage, admin)).status);

    // Closed order
    await prisma.repairOrder.update({ where: { id: P.id }, data: { status: 'DELIVERED', closedAt: new Date() } });
    await expectStatus('upload to a DELIVERED order', 409, (await upload(P.id, 'OTHER', [small], recep)).status);
    pass('Role / ownership rules, IDOR guard, activity, missing file, closed order');

    // ---------------------------------------------------------------
    console.log('\n[Test 4] No storage path in any response...');
    const paths = (await prisma.repairOrderImage.findMany({ select: { storagePath: true } })).map((i) => i.storagePath);
    const everything = allTexts.join('\n') + JSON.stringify((await getJson(`${API}/repairs/${O.id}`, admin)).json);
    assert(!everything.includes('storagePath'), 'no "storagePath" key anywhere');
    for (const p of paths) assert(!everything.includes(p), `stored path ${p} never returned`);
    assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg/.test(everything), 'no <uuid>.jpg in responses');
    // Test job numbers (REP-P7-xxxx) are not in the public format, so search by a paper receipt number
    await prisma.repairOrder.update({ where: { id: O.id }, data: { paperReceiptNo: '99770001' } });
    const pub = await fetch(`${API}/tracking/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '99770001' }) });
    eq(pub.status, 200, 'public search finds the order (runs before the privacy suite uses up the rate limit)');
    assert(!(await pub.text()).toLowerCase().includes('image'), 'public search has no images');
    pass(`${allTexts.length} responses checked`);

    // ---------------------------------------------------------------
    console.log('\n[Test 5] purgeExpiredImages...');
    const recordImage = async (orderId: number, createdAt = new Date()) => {
      const relPath = `${orderId}/${crypto.randomUUID()}.jpg`;
      await storage.save(relPath, await jpeg(32, 32));
      return prisma.repairOrderImage.create({ data: { repairOrderId: orderId, kind: 'OTHER', storagePath: relPath, uploadedById: 2, createdAt } });
    };
    const now = new Date();
    const C31 = await mk('DELIVERED', null, { closedAt: new Date(now.getTime() - 31 * DAY) });
    const C29 = await mk('CANCELLED', null, { closedAt: new Date(now.getTime() - 29 * DAY) });
    const OPEN60 = await mk('REPAIRING', 5, { createdAt: new Date(now.getTime() - 60 * DAY) });
    const a1 = await recordImage(C31.id);
    const a2 = await recordImage(C31.id);
    const missing = await recordImage(C31.id);
    await storage.delete(missing.storagePath); // file already gone
    const keep29 = await recordImage(C29.id);
    const keepOpen = await recordImage(OPEN60.id, new Date(now.getTime() - 60 * DAY));

    // A file that cannot be deleted keeps its record for the next run
    const failing: StorageService = {
      save: storage.save.bind(storage),
      createReadStream: storage.createReadStream.bind(storage),
      exists: storage.exists.bind(storage),
      delete: async () => { throw new Error('disk busy'); },
    };
    eq(await purgeExpiredImages(now, { storage: failing }), 0, 'delete failure -> nothing removed');
    eq(await prisma.repairOrderImage.count({ where: { repairOrderId: C31.id } }), 3, 'records kept for retry');

    eq(await purgeExpiredImages(now, { batchSize: 2 }), 3, '3 images of the order closed 31 days ago removed (batches of 2)');
    for (const img of [a1, a2, missing]) {
      eq(await prisma.repairOrderImage.count({ where: { id: img.id } }), 0, `record ${img.id} removed`);
      eq(await storage.exists(img.storagePath), false, `file ${img.id} removed`);
    }
    eq(await storage.exists(keep29.storagePath), true, 'order closed 29 days ago: file kept');
    eq(await prisma.repairOrderImage.count({ where: { id: keep29.id } }), 1, 'order closed 29 days ago: record kept');
    eq(await storage.exists(keepOpen.storagePath), true, 'open order with a 60-day-old photo: file kept');
    eq(await prisma.repairOrderImage.count({ where: { id: keepOpen.id } }), 1, 'open order: record kept');
    eq(await purgeExpiredImages(now), 0, 'second run removes nothing');
    eq(await purgeExpiredImages(new Date(now.getTime() + 2 * DAY)), 1, 'two days later the 29-day order expires too');
    pass('Retention counted from closedAt; missing file OK; failed delete keeps the record; open orders untouched');

    // Storage root guard
    let escaped = false;
    try {
      await storage.save('../outside.jpg', Buffer.from('x'));
      escaped = true;
    } catch { /* expected */ }
    assert(!escaped, 'path traversal refused');
    pass('Storage refuses paths outside its root');

    console.log('\n==================================================================');
    console.log('PHASE 7 IMAGE TESTS PASSED');
    console.log('==================================================================\n');
  } finally {
    await prisma.employee.updateMany({
      where: { id: { in: TECHS } },
      data: { status: 'AVAILABLE', isActive: true, role: 'TECHNICIAN', availableSince: null },
    });
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error('\nPhase 7 Test Failed:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
