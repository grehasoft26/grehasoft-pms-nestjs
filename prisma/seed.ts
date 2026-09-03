import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('--- STARTING PRISMA SEED FOR GREHASOFT PMS ---');

  // 1. Predefined Roles matching Django core/startup.py and apps/users/models.py
  const rolesData = [
    {
      name: 'SUPER_ADMIN',
      description: 'Super Administrator with full access to all system modules',
      permissions: [
        'MANAGE_INFRASTRUCTURE',
        'MANAGE_USERS',
        'MANAGE_ROLES',
        'MANAGE_DEPARTMENTS',
        'MANAGE_PROJECTS',
        'MANAGE_TASKS',
        'MANAGE_LEADS',
        'MANAGE_PROPOSALS',
        'MANAGE_INVOICES',
        'MANAGE_SEO',
        'GENERATE_HR_DOCS',
        'VIEW_DASHBOARD',
      ],
    },
    {
      name: 'ADMIN',
      description: 'System Administrator',
      permissions: [
        'MANAGE_USERS',
        'MANAGE_ROLES',
        'MANAGE_DEPARTMENTS',
        'MANAGE_PROJECTS',
        'MANAGE_TASKS',
        'MANAGE_LEADS',
        'MANAGE_PROPOSALS',
        'MANAGE_INVOICES',
        'MANAGE_SEO',
        'GENERATE_HR_DOCS',
        'VIEW_DASHBOARD',
      ],
    },
    {
      name: 'PROJECT_MANAGER',
      description: 'Project Manager',
      permissions: ['MANAGE_PROJECTS', 'MANAGE_TASKS', 'VIEW_DASHBOARD'],
    },
    {
      name: 'TEAM_MEMBER',
      description: 'Team Member',
      permissions: ['VIEW_DASHBOARD', 'VIEW_PROJECTS', 'VIEW_TASKS', 'MANAGE_TASKS'],
    },
    {
      name: 'SALES_MANAGER',
      description: 'Sales Manager',
      permissions: ['MANAGE_LEADS', 'MANAGE_PROPOSALS', 'VIEW_DASHBOARD'],
    },
    {
      name: 'SALES_EXECUTIVE',
      description: 'Sales Executive',
      permissions: ['MANAGE_LEADS', 'VIEW_DASHBOARD'],
    },
    {
      name: 'CLIENT',
      description: 'Client Portal User',
      permissions: ['VIEW_DASHBOARD'],
    },
    {
      name: 'SEO_MANAGER',
      description: 'SEO Manager role with full target setting and review access',
      permissions: [
        'VIEW_DASHBOARD',
        'VIEW_PROJECTS',
        'VIEW_TASKS',
        'VIEW_CLIENTS',
        'VIEW_REMINDERS',
        'MANAGE_REMINDERS',
        'VIEW_SEO_DASHBOARD',
        'MANAGE_SEO_WEBSITES',
        'VIEW_SEO_WEBSITES',
        'MANAGE_SEO_ACTIVITIES',
        'VIEW_SEO_ACTIVITIES',
        'MANAGE_SEO_TARGETS',
        'MANAGE_SEO_TASKS',
        'VIEW_SEO_TASKS',
        'MANAGE_SEO_REMINDERS',
        'VIEW_SEO_REMINDERS',
        'IMPORT_SEO_ACTIVITIES',
        'EXPORT_SEO_REPORTS',
      ],
    },
    {
      name: 'SEO_EXECUTIVE',
      description: 'SEO Executive role for logging daily work and tracking tasks',
      permissions: [
        'VIEW_DASHBOARD',
        'VIEW_PROJECTS',
        'VIEW_TASKS',
        'VIEW_CLIENTS',
        'VIEW_REMINDERS',
        'VIEW_SEO_DASHBOARD',
        'VIEW_SEO_WEBSITES',
        'MANAGE_SEO_ACTIVITIES',
        'VIEW_SEO_ACTIVITIES',
        'VIEW_SEO_TASKS',
        'VIEW_SEO_REMINDERS',
        'EXPORT_SEO_REPORTS',
      ],
    },
  ];

  const roleRecords: Record<string, any> = {};

  for (const roleDef of rolesData) {
    let existingRole = await prisma.role.findFirst({
      where: { name: roleDef.name, deleted_at: null },
    });

    if (!existingRole) {
      existingRole = await prisma.role.create({
        data: roleDef,
      });
      console.log(`✓ Created Role: ${existingRole.name}`);
    } else {
      console.log(`✓ Role already exists: ${existingRole.name}`);
    }
    roleRecords[roleDef.name] = existingRole;
  }

  // 2. Initial Superuser matching Django core/startup.py
  const superAdminRole = roleRecords['SUPER_ADMIN'];
  const superuserUsername = 'admin';
  const superuserEmail = 'admin@gmail.com';
  const superuserPasswordRaw = 'Admin@123';

  let existingUser = await prisma.user.findFirst({
    where: {
      OR: [{ username: superuserUsername }, { email: superuserEmail }],
      deleted_at: null,
    },
  });

  if (!existingUser) {
    const hashedPassword = await bcrypt.hash(superuserPasswordRaw, 10);
    existingUser = await prisma.user.create({
      data: {
        username: superuserUsername,
        email: superuserEmail,
        password: hashedPassword,
        name: 'System Administrator',
        is_superuser: true,
        is_active: true,
        status: 'active',
        role_id: superAdminRole.id,
      },
    });
    console.log(`✓ Created Superuser: ${existingUser.username} (${existingUser.email})`);
  } else {
    console.log(`✓ Superuser already exists: ${existingUser.username}`);
  }

  console.log('--- SEEDING COMPLETED SUCCESSFULLY ---');
}

main()
  .catch((e) => {
    console.error('SEEDING_ERROR:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
