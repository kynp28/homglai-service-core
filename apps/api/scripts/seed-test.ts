import prisma from '@homglai/db';

async function seed() {
  try {
    console.log('Seeding Master Data for Testing...');

    // 1. Create Employees (ID 1 as ADMIN/RECEPTIONIST, ID 2-6 as TECHNICIAN)
    await prisma.employee.createMany({
      data: [
        { id: 1, name: 'Admin User', role: 'ADMIN', status: 'AVAILABLE' },
        { id: 2, name: 'Tech 1', role: 'TECHNICIAN', status: 'AVAILABLE' },
        { id: 3, name: 'Tech 2', role: 'TECHNICIAN', status: 'AVAILABLE' },
        { id: 4, name: 'Tech 3', role: 'TECHNICIAN', status: 'AVAILABLE' },
        { id: 5, name: 'Tech 4', role: 'TECHNICIAN', status: 'AVAILABLE' },
        { id: 6, name: 'Tech 5', role: 'TECHNICIAN', status: 'AVAILABLE' },
      ],
      skipDuplicates: true,
    });

    // 2. Create Symptom Category & Symptom (ID 1)
    await prisma.symptomCategory.createMany({
      data: [{ id: 1, name: 'ทั่วไป' }],
      skipDuplicates: true,
    });
    
    await prisma.symptom.createMany({
      data: [{ id: 1, name: 'เปิดไม่ติด', categoryId: 1 }],
      skipDuplicates: true,
    });

    console.log('Seed Success!');
  } catch (error) {
    console.error('Seed Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}
seed();
