/**
 * Demo data for showing the system (not for the test suites): the symptom list of the intake form
 * and a few staff accounts. Safe to run more than once: it only adds what is missing (matched by
 * category name, symptom name within its category, and username) and never deletes or overwrites.
 *
 *   SEED_DEMO_PASSWORD='<at least 12 characters>' pnpm --filter @homglai/api seed:demo
 *
 * The first ADMIN is still created with `pnpm --filter @homglai/api create-admin`.
 */
import bcrypt from 'bcryptjs';
import prisma from '@homglai/db';

const SYMPTOMS: Record<string, string[]> = {
  'เครื่องชงกาแฟ': [
    'ไม่มีน้ำออกจากหัวชง',
    'น้ำไหลช้า / ไหลไม่สม่ำเสมอ',
    'น้ำรั่วซึม',
    'สตีมไม่ออก / แรงสตีมอ่อน',
    'แรงดันไม่ขึ้น',
    'น้ำไม่ร้อน / อุณหภูมิไม่คงที่',
    'ปั๊มไม่ทำงาน',
    'มีเสียงดังผิดปกติ',
  ],
  'เครื่องบดกาแฟ': ['บดไม่ออก', 'บดหยาบ / ละเอียดผิดปกติ', 'มอเตอร์ไม่หมุน', 'เมล็ดติดค้างในช่องบด'],
  'เครื่องปั่น': ['มอเตอร์ไม่หมุน', 'ใบมีดฟรี / ไม่หมุน', 'โถปั่นรั่ว', 'มีกลิ่นไหม้', 'หยุดทำงานกลางคัน'],
  'ระบบไฟฟ้า': ['เปิดไม่ติด', 'เบรกเกอร์ตัด / ไฟดับเมื่อเปิดเครื่อง', 'หน้าจอ / ปุ่มกดไม่ทำงาน', 'ไฟรั่ว'],
  'อื่นๆ': ['ล้างทำความสะอาด / บำรุงรักษา (PM)', 'อื่นๆ (ระบุเพิ่มเติม)'],
};

const STAFF = [
  { username: 'frontdesk', name: 'พนักงานหน้าร้าน (เดโม)', role: 'RECEPTIONIST' as const, weeklyDayOff: null },
  { username: 'tech.a', name: 'ช่าง A (เดโม)', role: 'TECHNICIAN' as const, weeklyDayOff: 1 },
  { username: 'tech.b', name: 'ช่าง B (เดโม)', role: 'TECHNICIAN' as const, weeklyDayOff: 3 },
  { username: 'tech.c', name: 'ช่าง C (เดโม)', role: 'TECHNICIAN' as const, weeklyDayOff: 5 },
];

async function main() {
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error('SEED_DEMO_PASSWORD is required (at least 12 characters). No default password is used.');
  }

  let categoriesAdded = 0;
  let symptomsAdded = 0;
  for (const [categoryName, names] of Object.entries(SYMPTOMS)) {
    let category = await prisma.symptomCategory.findFirst({ where: { name: categoryName } });
    if (!category) {
      category = await prisma.symptomCategory.create({ data: { name: categoryName } });
      categoriesAdded++;
    }
    for (const name of names) {
      const exists = await prisma.symptom.findFirst({ where: { name, categoryId: category.id } });
      if (!exists) {
        await prisma.symptom.create({ data: { name, categoryId: category.id } });
        symptomsAdded++;
      }
    }
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const staffAdded: string[] = [];
  for (const s of STAFF) {
    const exists = await prisma.employee.findUnique({ where: { username: s.username } });
    if (exists) continue;
    await prisma.employee.create({
      data: {
        ...s,
        passwordHash,
        isActive: true,
        // Technicians start OFFLINE: they press "ว่าง" themselves to join the queue
        status: s.role === 'TECHNICIAN' ? 'OFFLINE' : 'AVAILABLE',
      },
    });
    staffAdded.push(`${s.username} (${s.role})`);
  }

  console.log(`Symptom categories added: ${categoriesAdded}, symptoms added: ${symptomsAdded}`);
  console.log(staffAdded.length ? `Staff added: ${staffAdded.join(', ')}` : 'Staff: all demo accounts already exist');
  console.log('Existing data was not changed.');
}

main()
  .catch((err) => {
    console.error('Demo seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
