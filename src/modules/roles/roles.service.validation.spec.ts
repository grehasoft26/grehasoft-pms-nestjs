import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { RolesService } from './roles.service';
import { PrismaService } from '../../core/prisma.service';
import { KNOWN_PERMISSIONS } from '../../core/utils/permission-catalog';

/**
 * Phase 1.1: permission validation, duplicate names, built-in roles and MySQL-compatible search.
 * The in-memory fake mirrors MySQL utf8mb4_unicode_ci: `contains` and equality are
 * case-insensitive, and roles.name is unique across active and soft-deleted rows.
 */
const DELETED = new Date('2026-09-01T00:00:00.000Z');

const buildDb = () => {
  const roles: any[] = [
    { id: 1, name: 'SUPER_ADMIN', description: 'Built-in super admin', permissions: [], deleted_at: null },
    { id: 2, name: 'ADMIN', description: 'System Administrator', permissions: ['MANAGE_USERS', 'MANAGE_ROLES'], deleted_at: null },
    { id: 3, name: 'SALES_EXECUTIVE', description: 'Sales team', permissions: ['MANAGE_LEADS'], deleted_at: null },
    { id: 4, name: 'CONTENT_WRITER', description: 'Writes blog content', permissions: ['VIEW_TASKS'], deleted_at: null },
    { id: 5, name: 'ARCHIVED_ROLE', description: 'Old admin helper', permissions: ['MANAGE_USERS'], deleted_at: DELETED },
    { id: 6, name: 'UNUSED_CUSTOM', description: '', permissions: [], deleted_at: null },
  ];
  const users: any[] = [{ id: 10, role_id: 4, deleted_at: null }];
  const ci = (v: unknown) => String(v ?? '').toLowerCase();
  const matches = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (k === 'OR') return v.some((c: any) => matches(row, c));
      if (k === 'NOT') return !matches(row, v);
      if (v === null) return row[k] === null || row[k] === undefined;
      if (v && typeof v === 'object' && 'contains' in v) {
        if ('mode' in v) throw new Error('Unknown argument `mode` (not supported on MySQL)');
        return ci(row[k]).includes(ci(v.contains));
      }
      return typeof v === 'string' ? ci(row[k]) === ci(v) : row[k] === v;
    });
  const prisma: any = {
    role: {
      findFirst: jest.fn(async ({ where }: any) => roles.find((r) => matches(r, where)) ?? null),
      findMany: jest.fn(async ({ where }: any) => roles.filter((r) => matches(r, where))),
      count: jest.fn(async ({ where }: any) => roles.filter((r) => matches(r, where)).length),
      create: jest.fn(async ({ data }: any) => {
        if (roles.some((r) => ci(r.name) === ci(data.name))) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        const r = { id: roles.length + 1, deleted_at: null, ...data };
        roles.push(r);
        return r;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        if (data.name && roles.some((r) => r.id !== where.id && ci(r.name) === ci(data.name))) {
          throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        }
        return Object.assign(roles.find((r) => r.id === where.id), data);
      }),
    },
    user: { count: jest.fn(async ({ where }: any) => users.filter((u) => matches(u, where)).length) },
  };
  return { prisma, roles };
};

const superAdmin = { id: 1, is_superuser: false, role: { id: 1, name: 'SUPER_ADMIN', deleted_at: null } };
// Non-super-admin role manager (MANAGE_ROLES) holding every catalog permission, on its own role (id 50)
const roleManager = { id: 2, is_superuser: false, role_id: 50, role: { id: 50, name: "ROLE_MANAGERS", permissions: [...KNOWN_PERMISSIONS], deleted_at: null } };

/** Asserts exception type and that the response carries a plain-string message (shown by the UI). */
const expectError = async (promise: Promise<unknown>, type: any, message: string | RegExp) => {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(type);
  const body = error.getResponse();
  expect(typeof body.message).toBe('string');
  expect(body.message).toMatch(message);
};

describe('RolesService Phase 1.1 validation', () => {
  let service: RolesService;
  let db: ReturnType<typeof buildDb>;

  beforeEach(async () => {
    db = buildDb();
    const module: TestingModule = await Test.createTestingModule({
      providers: [RolesService, { provide: PrismaService, useValue: db.prisma }],
    }).compile();
    service = module.get(RolesService);
  });

  describe('permission validation', () => {
    it('accepts known permissions, upper-cases them and removes duplicates', async () => {
      const result: any = await service.create(
        { name: 'qa', permissions: ['view_tasks', 'VIEW_TASKS', ' MANAGE_TASKS ', 'VIEW_INVOICES'] },
        roleManager,
      );
      expect(result.data.permissions).toEqual(['VIEW_TASKS', 'MANAGE_TASKS', 'VIEW_INVOICES']);
    });

    it('accepts an empty array and defaults to [] when omitted', async () => {
      expect(((await service.create({ name: 'empty_a', permissions: [] }, roleManager)) as any).data.permissions).toEqual([]);
      expect(((await service.create({ name: 'empty_b' }, roleManager)) as any).data.permissions).toEqual([]);
    });

    it('rejects unknown permission names on create and lists them', async () => {
      await expectError(
        service.create({ name: 'qa', permissions: ['VIEW_TASKS', 'NOT_A_PERM', 'ALSO_BAD', 'NOT_A_PERM'] }, roleManager),
        BadRequestException,
        'Unknown permission(s): NOT_A_PERM, ALSO_BAD.',
      );
      expect(db.prisma.role.create).not.toHaveBeenCalled();
    });

    it('rejects unknown permission names on update and leaves the role unchanged', async () => {
      await expectError(service.update(4, { permissions: ['DELETE_EVERYTHING'] }, roleManager), BadRequestException, /Unknown permission/);
      expect(db.roles[3].permissions).toEqual(['VIEW_TASKS']);
    });

    it.each([
      ['a string', 'MANAGE_SETTINGS'],
      ['an object', { 0: 'VIEW_TASKS' }],
      ['null', null],
      ['a number', 5],
    ])('rejects permissions given as %s', async (_label, permissions) => {
      await expectError(service.create({ name: 'qa', permissions }, roleManager), BadRequestException, 'Permissions must be an array of permission names.');
      await expectError(service.update(4, { permissions }, roleManager), BadRequestException, 'Permissions must be an array of permission names.');
    });

    it.each([[['VIEW_TASKS', 5]], [['VIEW_TASKS', null]], [['VIEW_TASKS', '']], [[{ name: 'VIEW_TASKS' }]]])(
      'rejects non-string or empty entries %p',
      async (permissions) => {
        await expectError(service.create({ name: 'qa', permissions }, roleManager), BadRequestException, 'Each permission must be a non-empty permission name.');
      },
    );

    it('keeps existing permissions that the UI does not list (e.g. MANAGE_ROLES) valid', async () => {
      await service.update(2, { permissions: ['MANAGE_USERS', 'MANAGE_ROLES', 'MANAGE_DEPARTMENTS', 'MANAGE_SEO', 'MANAGE_BACKUPS'] }, superAdmin);
      expect(db.roles[1].permissions).toEqual(['MANAGE_USERS', 'MANAGE_ROLES', 'MANAGE_DEPARTMENTS', 'MANAGE_SEO', 'MANAGE_BACKUPS']);
    });
  });

  describe('role names and duplicates', () => {
    it('rejects a duplicate active name with 409 and does not touch the existing role', async () => {
      await expectError(service.create({ name: 'content writer', permissions: ['MANAGE_USERS'] }, roleManager), ConflictException, 'A role named CONTENT_WRITER already exists.');
      expect(db.roles[3].permissions).toEqual(['VIEW_TASKS']);
      expect(db.prisma.role.create).not.toHaveBeenCalled();
      expect(db.prisma.role.update).not.toHaveBeenCalled();
    });

    it('treats names case-insensitively (matches the database collation)', async () => {
      await expectError(service.create({ name: 'Content_Writer' }, roleManager), ConflictException, /already exists/);
    });

    it('rejects renaming to an existing active name with 409', async () => {
      await expectError(service.update(6, { name: 'content_writer' }, roleManager), ConflictException, 'A role named CONTENT_WRITER already exists.');
      expect(db.roles[5].name).toBe('UNUSED_CUSTOM');
    });

    it('rejects renaming to a name held by a deleted role with 409', async () => {
      await expectError(service.update(6, { name: 'archived_role' }, roleManager), ConflictException, 'The name ARCHIVED_ROLE is used by a deleted role.');
    });

    it('allows a no-op rename that only changes case/spacing', async () => {
      await service.update(4, { name: 'content writer', description: 'Updated' }, roleManager);
      expect(db.roles[3]).toMatchObject({ name: 'CONTENT_WRITER', description: 'Updated' });
    });

    it('allows renaming a custom role to a free name', async () => {
      await service.update(6, { name: 'support agent' }, roleManager);
      expect(db.roles[5].name).toBe('SUPPORT_AGENT');
    });

    it('converts a database unique violation (race) into 409', async () => {
      db.prisma.role.findFirst.mockResolvedValueOnce(null);
      db.roles.push({ id: 99, name: 'RACE', permissions: [], deleted_at: null });
      await expectError(service.create({ name: 'race' }, roleManager), ConflictException, /already exists/);
    });

    it.each([
      ['missing', undefined, 'Role name is required.'],
      ['blank', '   ', 'Role name is required.'],
      ['not text', 42, 'Role name must be text.'],
      ['bad characters', 'sales-team!', 'Role name may contain only letters, numbers and underscores.'],
      ['too long', 'x'.repeat(51), 'Role name must be at most 50 characters.'],
    ])('rejects a %s name', async (_label, name, message) => {
      await expectError(service.create({ name }, roleManager), BadRequestException, message);
    });

  });

  describe('deleted role names cannot be reused', () => {
    const REUSE_MESSAGE = 'This role name has already been used and cannot be reused, even if the role was deleted.';
    const archivedSnapshot = () => ({ ...db.roles[4] });

    it('creating a role with a new name still succeeds', async () => {
      const result: any = await service.create({ name: 'brand new role', permissions: ['VIEW_TASKS'] }, roleManager);
      expect(result).toEqual({ data: expect.objectContaining({ name: 'BRAND_NEW_ROLE' }), created: true });
    });

    it('an existing active name still returns 409 with the duplicate message', async () => {
      await expectError(service.create({ name: 'content_writer' }, roleManager), ConflictException, 'A role named CONTENT_WRITER already exists.');
    });

    it('a previously deleted name returns 409 and the deleted role is not modified or reactivated', async () => {
      const before = archivedSnapshot();
      await expectError(service.create({ name: 'archived_role', description: 'New', permissions: ['VIEW_TASKS'] }, roleManager), ConflictException, REUSE_MESSAGE);
      expect(db.roles[4]).toEqual(before);
      expect(db.roles[4].deleted_at).toBe(DELETED);
      expect(db.prisma.role.update).not.toHaveBeenCalled();
      expect(db.prisma.role.create).not.toHaveBeenCalled();
    });

    it('matches deleted names case-insensitively after normalization', async () => {
      await expectError(service.create({ name: 'Archived Role' }, roleManager), ConflictException, REUSE_MESSAGE);
      await expectError(service.create({ name: '  ARCHIVED_role ' }, superAdmin), ConflictException, REUSE_MESSAGE);
      expect(db.roles[4].deleted_at).toBe(DELETED);
    });

    it('a deleted built-in name stays reserved for non-super admins (403) and cannot be reused by super admins (409)', async () => {
      db.roles[2].deleted_at = DELETED; // SALES_EXECUTIVE soft-deleted
      const before = { ...db.roles[2] };
      await expectError(service.create({ name: 'sales_executive' }, roleManager), ForbiddenException, 'The SALES_EXECUTIVE role name is reserved for the built-in role.');
      await expectError(service.create({ name: 'sales executive', permissions: ['MANAGE_LEADS'] }, superAdmin), ConflictException, REUSE_MESSAGE);
      expect(db.roles[2]).toEqual(before);
      expect(db.prisma.role.update).not.toHaveBeenCalled();
    });

    it('a concurrent unique-constraint conflict returns 409 without exposing the database error', async () => {
      db.prisma.role.findFirst.mockResolvedValueOnce(null); // name looked free at check time
      const error = await service.create({ name: 'archived_role' }, roleManager).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse().message).toBe('A role named ARCHIVED_ROLE already exists.');
      expect(JSON.stringify(error.getResponse())).not.toMatch(/P2002|Unique constraint/);
      expect(db.roles[4].deleted_at).toBe(DELETED);
    });
  });

  describe('built-in roles', () => {
    it('cannot be renamed by anyone (not only SUPER_ADMIN)', async () => {
      await expectError(service.update(2, { name: 'administrators' }, superAdmin), BadRequestException, 'The built-in ADMIN role cannot be renamed.');
      await expectError(service.update(3, { name: 'sales_rep' }, roleManager), BadRequestException, 'The built-in SALES_EXECUTIVE role cannot be renamed.');
      expect(db.roles[1].name).toBe('ADMIN');
    });

    it('their permissions and description can still be edited by MANAGE_ROLES holders', async () => {
      await service.update(3, { description: 'Field sales', permissions: ['MANAGE_LEADS', 'VIEW_CLIENTS'] }, roleManager);
      expect(db.roles[2]).toMatchObject({ name: 'SALES_EXECUTIVE', description: 'Field sales', permissions: ['MANAGE_LEADS', 'VIEW_CLIENTS'] });
    });

    it('custom roles cannot be renamed to a built-in name', async () => {
      await expectError(service.update(6, { name: 'project manager' }, superAdmin), BadRequestException, 'The PROJECT_MANAGER role name is reserved for the built-in role.');
    });

    it('built-in names cannot be created by non-super admins', async () => {
      await expectError(service.create({ name: 'project_manager' }, roleManager), ForbiddenException, 'The PROJECT_MANAGER role name is reserved for the built-in role.');
    });

    it('non-super admins cannot delete built-in roles; super admins can when unused', async () => {
      await expectError(service.remove(3, roleManager), ForbiddenException, 'Only Super Admins can delete the built-in SALES_EXECUTIVE role.');
      await service.remove(3, superAdmin);
      expect(db.roles[2].deleted_at).toBeInstanceOf(Date);
    });

    it('SUPER_ADMIN protections remain: no rename, no delete, only super admins can edit it', async () => {
      await expectError(service.update(1, { name: 'owner' }, superAdmin), BadRequestException, 'The built-in SUPER_ADMIN role cannot be renamed.');
      await expectError(service.update(1, { description: 'x' }, roleManager), ForbiddenException, 'Only Super Admins can modify the SUPER_ADMIN role.');
      await expectError(service.remove(1, superAdmin), ForbiddenException, 'The built-in SUPER_ADMIN role cannot be deleted.');
    });

    it('custom roles can still be deleted by MANAGE_ROLES holders when unused, but not while assigned', async () => {
      await expectError(service.remove(4, roleManager), ConflictException, /1 user\(s\) are still assigned/);
      await service.remove(6, roleManager);
      expect(db.roles[5].deleted_at).toBeInstanceOf(Date);
    });
  });

  describe('search (MySQL compatible)', () => {
    const names = async (search?: string) => ((await service.findAll({ all: 'true', search })) as any[]).map((r) => r.name);

    it('never sends the PostgreSQL-only `mode` option', async () => {
      await service.findAll({ search: 'admin' });
      const where = db.prisma.role.findMany.mock.calls[0][0].where;
      expect(JSON.stringify(where)).not.toContain('mode');
      expect(where).toEqual({ deleted_at: null, OR: [{ name: { contains: 'admin' } }, { description: { contains: 'admin' } }] });
    });

    it('matches names and descriptions', async () => {
      expect(await names('WRITER')).toEqual(['CONTENT_WRITER']);
      expect(await names('blog')).toEqual(['CONTENT_WRITER']);
    });

    it('is case-insensitive (database collation)', async () => {
      expect(await names('admin')).toEqual(['SUPER_ADMIN', 'ADMIN']);
      expect(await names('AdMiN')).toEqual(['SUPER_ADMIN', 'ADMIN']);
    });

    it('returns nothing for non-matching input', async () => {
      expect(await names('zzz-no-match')).toEqual([]);
    });

    it('never returns deleted roles', async () => {
      expect(await names('archived')).toEqual([]);
      expect(await names('helper')).toEqual([]);
    });

    it('treats empty or whitespace search as no filter (deleted still excluded)', async () => {
      const all = ['SUPER_ADMIN', 'ADMIN', 'SALES_EXECUTIVE', 'CONTENT_WRITER', 'UNUSED_CUSTOM'];
      expect(await names('')).toEqual(all);
      expect(await names('   ')).toEqual(all);
      expect(await names(undefined)).toEqual(all);
    });

    it('paginated search counts only matching active roles', async () => {
      const result: any = await service.findAll({ search: 'admin', page: '1', limit: '5' });
      expect(result.count).toBe(2);
    });
  });
});
