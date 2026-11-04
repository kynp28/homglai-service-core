import prisma from '@homglai/db';
import bcrypt from 'bcryptjs';
import { assertSafeDatabaseUrl } from '../src/utils/test-safety';

async function seed() {
  try {
    // Enforce destructive test safety guard
    assertSafeDatabaseUrl();

    const seedPassword = process.env.SEED_DEFAULT_PASSWORD;
    if (!seedPassword) {
      throw new Error(
        'FATAL: SEED_DEFAULT_PASSWORD is required for seed-test.ts. No fallback password is permitted.'
      );
    }

    console.log('Seeding Master Data for Testing...');
    const passwordHash = await bcrypt.hash(seedPassword, 10);

    // 1. Create or update Employees with isActive: true
    const employees = [
      { id: 1, username: 'admin', name: 'Admin User', role: 'ADMIN' as const, status: 'AVAILABLE' as const, isActive: true, passwordHash },
      { id: 2, username: 'receptionist', name: 'Front Desk', role: 'RECEPTIONIST' as const, status: 'AVAILABLE' as const, isActive: true, passwordHash },
      { id: 3, username: 'tech1', name: 'Tech 1', role: 'TECHNICIAN' as const, status: 'AVAILABLE' as const, isActive: true, passwordHash },
      { id: 4, username: 'tech2', name: 'Tech 2', role: 'TECHNICIAN' as const, status: 'AVAILABLE' as const, isActive: true, passwordHash },
      { id: 5, username: 'tech3', name: 'Tech 3', role: 'TECHNICIAN' as const, status: 'AVAILABLE' as const, isActive: true, passwordHash },
      { id: 6, username: 'tech4', name: 'Tech 4', role: 'TECHNICIAN' as const, status: 'AVAILABLE' as const, isActive: true, passwordHash },
      { id: 7, username: 'tech5', name: 'Tech 5', role: 'TECHNICIAN' as const, status: 'AVAILABLE' as const, isActive: true, passwordHash },
    ];

    for (const emp of employees) {
      await prisma.employee.upsert({
        where: { id: emp.id },
        update: {
          username: emp.username,
          name: emp.name,
          role: emp.role,
          status: emp.status,
          isActive: emp.isActive,
          passwordHash: emp.passwordHash,
        },
        create: emp,
      });
    }

    // 2. Create Symptom Category & Symptom (ID 1)
    await prisma.symptomCategory.upsert({
      where: { id: 1 },
      update: { name: 'ทั่วไป' },
      create: { id: 1, name: 'ทั่วไป' },
    });

    await prisma.symptom.upsert({
      where: { id: 1 },
      update: { name: 'เปิดไม่ติด', categoryId: 1 },
      create: { id: 1, name: 'เปิดไม่ติด', categoryId: 1 },
    });

    console.log('Seed Success!');
    console.log(`Seeded ${employees.length} employees using SEED_DEFAULT_PASSWORD.`);
  } catch (error: any) {
    console.error('Seed Error:', error.message || error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

seed();
