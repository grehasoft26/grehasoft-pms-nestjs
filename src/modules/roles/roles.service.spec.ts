import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { RolesService } from './roles.service';
import { PrismaService } from '../../core/prisma.service';
import { KNOWN_PERMISSIONS } from '../../core/utils/permission-catalog';

/** SUPER_ADMIN protection and safe deletion in RolesService (in-memory Prisma fake). */
const buildDb = () => {
  const roles: any[] = [
    { id: 1, name: 'SUPER_ADMIN', description: 'Built-in', permissions: ['MANAGE_USERS'], deleted_at: null },
    { id: 2, name: 'ADMIN', description: '', permissions: ['MANAGE_USERS'], deleted_at: null },
    { id: 3, name: 'EDITOR', description: '', permissions: ['VIEW_TASKS'], deleted_at: null },
    { id: 4, name: 'UNUSED', description: '', permissions: [], deleted_at: null },
  ];
  const users: any[] = [
    { id: 10, role_id: 1, deleted_at: null },
    { id: 11, role_id: 3, deleted_at: null },
    { id: 12, role_id: 4, deleted_at: new Date() }, // soft-deleted user does not block deletion
  ];
  const matches = (row: any, where: any = {}) =>
    Object.entries(where).every(([k, v]) => (v === null ? row[k] === null || row[k] === undefined : row[k] === v));
  const prisma: any = {
    role: {
      findFirst: jest.fn(async ({ where }: any) => roles.find((r) => matches(r, where)) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(roles.find((r) => r.id === where.id), data)),
      create: jest.fn(async ({ data }: any) => {
        const r = { id: roles.length + 1, deleted_at: null, ...data };
        roles.push(r);
        return r;
      }),
    },
    user: { count: jest.fn(async ({ where }: any) => users.filter((u) => matches(u, where)).length) },
  };
  return { prisma, roles, users };
};

const superAdmin = { id: 10, is_superuser: false, role: { id: 1, name: 'SUPER_ADMIN', deleted_at: null } };
const rootFlag = { id: 99, is_superuser: true, role: null };
// Non-super-admin role manager (MANAGE_ROLES) holding every catalog permission, on its own role (id 50)
const roleManager = { id: 20, is_superuser: false, role_id: 50, role: { id: 50, name: "ROLE_MANAGERS", permissions: [...KNOWN_PERMISSIONS], deleted_at: null } };

describe('RolesService security', () => {
  let service: RolesService;
  let db: ReturnType<typeof buildDb>;

  beforeEach(async () => {
    db = buildDb();
    const module: TestingModule = await Test.createTestingModule({
      providers: [RolesService, { provide: PrismaService, useValue: db.prisma }],
    }).compile();
    service = module.get(RolesService);
  });

  describe('built-in SUPER_ADMIN role', () => {
    it('8. cannot be renamed, even by a super admin', async () => {
      await expect(service.update(1, { name: 'owner' }, superAdmin)).rejects.toThrow(BadRequestException);
      await expect(service.update(1, { name: 'owner' }, rootFlag)).rejects.toThrow(BadRequestException);
      expect(db.roles[0].name).toBe('SUPER_ADMIN');
    });

    it('cannot be modified by a non-super admin holding MANAGE_ROLES', async () => {
      await expect(service.update(1, { description: 'x', permissions: [] }, roleManager)).rejects.toThrow(ForbiddenException);
      expect(db.roles[0]).toMatchObject({ description: 'Built-in', permissions: ['MANAGE_USERS'] });
    });

    it('super admins can still edit its description and permission list (bypass is unaffected)', async () => {
      await service.update(1, { name: 'super_admin', description: 'Owners', permissions: ['VIEW_DASHBOARD'] }, superAdmin);
      expect(db.roles[0]).toMatchObject({ name: 'SUPER_ADMIN', description: 'Owners', permissions: ['VIEW_DASHBOARD'] });
    });

    it('8. cannot be deleted by anyone', async () => {
      await expect(service.remove(1)).rejects.toThrow(ForbiddenException);
      expect(db.roles[0].deleted_at).toBeNull();
    });

    it('its name is reserved: no other role can be renamed or created as SUPER_ADMIN', async () => {
      await expect(service.update(3, { name: 'super admin'.replace(' ', '_') }, superAdmin)).rejects.toThrow(BadRequestException);
      await expect(service.update(3, { name: 'SUPER_ADMIN' }, roleManager)).rejects.toThrow(BadRequestException);
      await expect(service.create({ name: 'super_admin' }, roleManager)).rejects.toThrow(ForbiddenException);
      expect(db.prisma.role.create).not.toHaveBeenCalled();
    });
  });

  describe('deletion', () => {
    it('11. refuses to delete a role still assigned to active users', async () => {
      await expect(service.remove(3)).rejects.toThrow(ConflictException);
      expect(db.roles[2].deleted_at).toBeNull();
    });

    it('allows deleting a role with no active users (soft-deleted users do not count)', async () => {
      await service.remove(4);
      expect(db.roles[3].deleted_at).toBeInstanceOf(Date);
    });

    it('a deleted role cannot be updated or deleted again', async () => {
      await service.remove(4);
      await expect(service.update(4, { description: 'x' }, superAdmin)).rejects.toThrow(NotFoundException);
      await expect(service.remove(4)).rejects.toThrow(NotFoundException);
    });
  });

  describe('ordinary roles are unaffected', () => {
    it('MANAGE_ROLES holders can still rename and edit custom roles', async () => {
      await service.update(3, { name: 'content editor'.replace(' ', '_'), permissions: ['VIEW_TASKS', 'MANAGE_TASKS'] }, roleManager);
      expect(db.roles[2]).toMatchObject({ name: 'CONTENT_EDITOR', permissions: ['VIEW_TASKS', 'MANAGE_TASKS'] });
    });

    it('MANAGE_ROLES holders can still create custom roles', async () => {
      const result: any = await service.create({ name: 'qa', permissions: ['VIEW_TASKS'] }, roleManager);
      expect(result).toMatchObject({ created: true, data: { name: 'QA' } });
    });
  });
});
