import prisma from '@homglai/db';
import bcrypt from 'bcryptjs';
import readline from 'readline';

function askQuestion(query: string, hideInput = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function main() {
  console.log('=== Homglai Service Core - Admin User Provisioning ===\n');

  let username = process.env.ADMIN_USERNAME;
  let name = process.env.ADMIN_NAME;
  let password = process.env.ADMIN_PASSWORD;

  if (!username) {
    username = await askQuestion('Enter Admin Username (min 3 chars): ');
  }
  if (!name) {
    name = await askQuestion('Enter Admin Full Name: ');
  }
  if (!password) {
    password = await askQuestion('Enter Admin Password (min 12 chars): ');
  }

  if (!username || username.length < 3) {
    console.error('Error: Username must be at least 3 characters long.');
    process.exit(1);
  }

  if (!name || name.length < 1) {
    console.error('Error: Full name is required.');
    process.exit(1);
  }

  if (!password || password.length < 12) {
    console.error('Error: Password must be at least 12 characters long.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const admin = await prisma.employee.upsert({
    where: { username },
    update: {
      name,
      role: 'ADMIN',
      status: 'AVAILABLE',
      isActive: true,
      passwordHash,
    },
    create: {
      username,
      name,
      role: 'ADMIN',
      status: 'AVAILABLE',
      isActive: true,
      passwordHash,
    },
  });

  console.log(`\nAdmin account provisioned successfully! ID: ${admin.id}, Username: ${admin.username}, Name: ${admin.name}`);
}

main()
  .catch((err) => {
    console.error('Fatal error provisioning admin:', err.message || err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
