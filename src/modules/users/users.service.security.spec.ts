import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../../core/prisma.service';

/**
 * Role-assignment security for PATCH /users/:id, POST /users and DELETE /users/:id.
 * Uses a small in-memory Prisma fake (no database).
 */
const DELETED = new Date('2026-10-01T00:00:00.000Z');

const buildDb = () => {
  const roles = [
    { id: 1, name: 'SUPER_ADMIN', permissions: [], deleted_at: null as Date | null },
    { id: 2, name: 'ADMIN', permissions: ['MANAGE_USERS'], deleted_at: null as Date | null },
    { id: 3, name: 'TEAM_MEMBER', permissions: ['VIEW_TASKS'], deleted_at: null as Date | null },
    { id: 4, name: 'OLD_ROLE', permissions: ['MANAGE_USERS'], deleted_at: DELETED as Date | null },
    // Ordinary, non-privileged role whose permissions every requester holds (none)
    { id: 6, name: 'GUEST', permissions: [], deleted_at: null as Date | null },
  ];
  const users = [
    { id: 1, name: 'Owner', username: 'owner', email: 'o@x.test', role_id: 1, is_superuser: false, deleted_at: null as Date | null },
    { id: 2, name: 'Admin', username: 'admin', email: 'a@x.test', role_id: 2, is_superuser: false, deleted_at: null as Date | null },
    { id: 3, name: 'Member', username: 'member', email: 'm@x.test', role_id: 3, is_superuser: false, deleted_at: null as Date | null },
    { id: 4, name: 'Root', username: 'root', email: 'r@x.test', role_id: null as number | null, is_superuser: true, deleted_at: null as Date | null },
    // Ordinary account whose (empty) access every requester covers
    { id: 5, name: 'Newcomer', username: 'newcomer', email: 'n@x.test', role_id: null as number | null, is_superuser: false, deleted_at: null as Date | null },
  ];
  const matches = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (k === 'OR') return v.some((c: any) => matches(row, c));
      if (v === null) return row[k] === null || row[k] === undefined;
      return row[k] === v;
    });
  const withRelations = (u: any) => u && { ...u, role: roles.find((r) => r.id === u.role_id) ?? null, department: null, client: null };

  const prisma: any = {
    role: { findFirst: jest.fn(async ({ where }: any) => roles.find((r) => matches(r, where)) ?? null) },
    user: {
      findFirst: jest.fn(async ({ where }: any) => withRelations(users.find((u) => matches(u, where)))),
      update: jest.fn(async ({ where, data }: any) => {
        const u = users.find((x) => x.id === where.id)!;
        Object.assign(u, data);
        return withRelations(u);
      }),
      create: jest.fn(async ({ data }: any) => {
        const u = { id: users.length + 1, deleted_at: null, is_superuser: false, ...data };
        users.push(u);
        return withRelations(u);
      }),
    },
    employee: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn() },
  };
  return { prisma, roles, users, as: (id: number) => withRelations(users.find((u) => u.id === id)) };
};

/** Asserts the exception type and the `{ role: message }` field-error body used by the user forms. */
const expectRoleError = async (promise: Promise<unknown>, type: any, message: string) => {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(type);
  expect(error.getResponse()).toEqual({ role: message });
};

describe('UsersService role-assignment security', () => {
  let service: UsersService;
  let db: ReturnType<typeof buildDb>;

  beforeEach(async () => {
    db = buildDb();
    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: db.prisma }],
    }).compile();
    service = module.get(UsersService);
  });

  describe('update (PATCH /users/:id)', () => {
    it('1. ADMIN cannot assign SUPER_ADMIN to themselves', async () => {
      await expect(service.update(db.as(2), 2, { role: 1 })).rejects.toThrow(ForbiddenException);
      expect(db.users[1].role_id).toBe(2);
    });

    it('2. ADMIN cannot assign SUPER_ADMIN to another user', async () => {
      await expectRoleError(service.update(db.as(2), 3, { role: 1 }), ForbiddenException, 'Only Super Admins can assign the SUPER_ADMIN role.');
      expect(db.users[2].role_id).toBe(3);
    });

    it('3. a user cannot change their own role (even to a lower role)', async () => {
      await expectRoleError(service.update(db.as(2), 2, { role: 3 }), ForbiddenException, 'You cannot change your own role.');
      await expect(service.update(db.as(2), 2, { role: null })).rejects.toThrow(ForbiddenException);
      expect(db.users[1].role_id).toBe(2);
    });

    it('3b. a super admin cannot change their own role either (prevents self-lockout)', async () => {
      await expect(service.update(db.as(1), 1, { role: 3 })).rejects.toThrow(ForbiddenException);
    });

    it('4. a super admin can assign SUPER_ADMIN to another user', async () => {
      await service.update(db.as(1), 3, { role: 1 });
      expect(db.users[2].role_id).toBe(1);
    });

    it('4b. an is_superuser account (no role) can assign roles', async () => {
      await service.update(db.as(4), 3, { role: '1' });
      expect(db.users[2].role_id).toBe(1);
    });

    it('4c. ADMIN can still assign ordinary roles to other users (Phase 2.1: not ADMIN itself)', async () => {
      // Target's current access is covered by ADMIN (see "account takeover" below for targets it is not)
      await service.update(db.as(2), 5, { role: 6 });
      expect(db.users[4].role_id).toBe(6);
    });

    it('5. rejects a nonexistent role', async () => {
      await expectRoleError(service.update(db.as(1), 3, { role: 999 }), BadRequestException, 'Role not found or has been deleted.');
      await expectRoleError(service.update(db.as(1), 3, { role: 'abc' }), BadRequestException, 'Invalid role.');
      expect(db.users[2].role_id).toBe(3);
    });

    it('6. rejects a soft-deleted role', async () => {
      await expectRoleError(service.update(db.as(1), 3, { role: 4 }), BadRequestException, 'Role not found or has been deleted.');
      expect(db.users[2].role_id).toBe(3);
    });

    it('10. ordinary profile updates still work, including re-sending the unchanged role', async () => {
      const result: any = await service.update(db.as(2), 2, { name: 'Admin Renamed', email: 'new@x.test', role: 2 });
      expect(db.users[1]).toMatchObject({ name: 'Admin Renamed', email: 'new@x.test', role_id: 2 });
      expect(result.name).toBe('Admin Renamed');
    });

    it('10b. ordinary updates of other users without a role field are unaffected', async () => {
      await service.update(db.as(2), 3, { name: 'Member 2' });
      expect(db.users[2]).toMatchObject({ name: 'Member 2', role_id: 3 });
    });

    it('a non-super admin still cannot edit a super-admin account', async () => {
      await expect(service.update(db.as(2), 1, { name: 'Hacked' })).rejects.toThrow(ForbiddenException);
      await expect(service.update(db.as(2), 4, { role: 3 })).rejects.toThrow(ForbiddenException);
    });

    it('8. a deleted SUPER_ADMIN role does not give its holder super-admin rights', async () => {
      db.roles[0].deleted_at = DELETED;
      await expect(service.update(db.as(1), 5, { role: 6 })).resolves.toBeDefined(); // ordinary assignment is fine
      // ...but without an active SUPER_ADMIN role the holder cannot assign privileged roles
      await expect(service.update(db.as(1), 5, { role: 2 })).rejects.toThrow(ForbiddenException);
      // ...nor manage accounts whose role grants permissions it does not hold
      await expect(service.update(db.as(1), 3, { password: 'Takeover123' })).rejects.toThrow(ForbiddenException);
      db.roles[0].deleted_at = null;
      const holder = { ...db.as(1), role: { ...db.roles[0], deleted_at: DELETED } };
      db.roles.push({ id: 5, name: 'SUPER_ADMIN_COPY', permissions: [], deleted_at: null });
      await expect(service.update(holder, 3, { role: 1 })).rejects.toThrow(ForbiddenException);
    });
  });

  describe('create (POST /users)', () => {
    it('rejects a nonexistent or soft-deleted role instead of silently creating a user without one', async () => {
      await expect(service.create(db.as(1), { username: 'x', email: 'x@x.test', role: 999 })).rejects.toThrow(BadRequestException);
      await expectRoleError(service.create(db.as(1), { username: 'y', email: 'y@x.test', role: 4 }), BadRequestException, 'Role not found or has been deleted.');
      expect(db.prisma.user.create).not.toHaveBeenCalled();
    });

    it('ADMIN cannot create a SUPER_ADMIN user (by id or name) - 403 since Phase 2.1', async () => {
      await expect(service.create(db.as(2), { username: 'x', email: 'x@x.test', role: 1 })).rejects.toThrow(ForbiddenException);
      await expect(service.create(db.as(2), { username: 'x', email: 'x@x.test', role: 'SUPER_ADMIN' })).rejects.toThrow(ForbiddenException);
      expect(db.prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('remove (DELETE /users/:id)', () => {
    it('ADMIN cannot delete a super-admin account', async () => {
      await expect(service.remove(db.as(2), 1)).rejects.toThrow('Only Super Admins can delete Super Admin accounts.');
      await expect(service.remove(db.as(2), 4)).rejects.toThrow(ForbiddenException);
      expect(db.users[0].deleted_at).toBeNull();
    });

    it('nobody can delete their own account', async () => {
      await expect(service.remove(db.as(1), 1)).rejects.toThrow('You cannot delete your own account.');
    });

    it('ADMIN can still delete ordinary users; super admins can delete super admins', async () => {
      await service.remove(db.as(2), 5);
      expect(db.users[4].deleted_at).toBeInstanceOf(Date);
      await service.remove(db.as(4), 1);
      expect(db.users[0].deleted_at).toBeInstanceOf(Date);
    });
  });

  describe('account takeover through custom roles (least privilege)', () => {
    const OPS = 7;
    const OPS_USER = 6;
    beforeEach(() => {
      // A custom role a super admin created; its name is not ADMIN or SUPER_ADMIN
      db.roles.push({ id: OPS, name: 'OPS_LEAD', permissions: ['MANAGE_USERS', 'manage_roles', 'MANAGE_INFRASTRUCTURE'], deleted_at: null });
      // is_active/status are non-null columns (defaults true/'active')
      db.users.push({ id: OPS_USER, name: 'Ops', username: 'ops', email: 'ops@x.test', role_id: OPS, is_superuser: false, deleted_at: null, is_active: true, status: 'active' } as any);
    });
    const opsRow = () => db.users.find((u) => u.id === OPS_USER)!;
    const PROTECTED = 'an account whose role grants permissions you do not have (MANAGE_ROLES, MANAGE_INFRASTRUCTURE)';

    it('a MANAGE_USERS holder cannot reset the password of a more powerful custom-role account', async () => {
      await expect(service.update(db.as(2), OPS_USER, { password: 'Takeover123' })).rejects.toThrow(
        `Only Super Admins can change password of ${PROTECTED}.`,
      );
      expect(db.prisma.user.update).not.toHaveBeenCalled();
    });

    it('nor change its login or access fields, alone or hidden among harmless ones', async () => {
      for (const body of [
        { email: 'mine@x.test' },
        { username: 'taken' },
        { is_active: false },
        { status: 'inactive' },
        { name: 'Harmless', password: 'Takeover123' },
      ]) {
        await expect(service.update(db.as(2), OPS_USER, body)).rejects.toThrow(ForbiddenException);
      }
      expect(opsRow()).toMatchObject({ email: 'ops@x.test', username: 'ops' });
      expect(db.prisma.user.update).not.toHaveBeenCalled();
    });

    it('nor change or clear its role, whatever the role id format', async () => {
      for (const role of [6, '6', null, '']) {
        await expectRoleError(
          service.update(db.as(2), OPS_USER, { role }),
          ForbiddenException,
          `Only Super Admins can change the role of ${PROTECTED}.`,
        );
      }
      expect(opsRow().role_id).toBe(OPS);
    });

    it('nor delete it', async () => {
      await expect(service.remove(db.as(2), OPS_USER)).rejects.toThrow(`Only Super Admins can delete ${PROTECTED}.`);
      expect(opsRow().deleted_at).toBeNull();
    });

    it('a soft-deleted custom role still protects its holders (it could be restored)', async () => {
      db.roles.find((r) => r.id === OPS)!.deleted_at = DELETED;
      await expect(service.update(db.as(2), OPS_USER, { password: 'Takeover123' })).rejects.toThrow(ForbiddenException);
      await expect(service.remove(db.as(2), OPS_USER)).rejects.toThrow(ForbiddenException);
    });

    it('built-in roles are protected the same way (seeded ADMIN lacks VIEW_TASKS of TEAM_MEMBER)', async () => {
      await expect(service.update(db.as(2), 3, { password: 'Takeover123' })).rejects.toThrow(
        'Only Super Admins can change password of an account whose role grants permissions you do not have (VIEW_TASKS).',
      );
      await expect(service.remove(db.as(2), 3)).rejects.toThrow(ForbiddenException);
    });

    it('non-sensitive edits and re-sending unchanged values remain allowed', async () => {
      await service.update(db.as(2), OPS_USER, { name: 'Ops Renamed', email: 'ops@x.test', role: OPS, password: '' });
      expect(opsRow()).toMatchObject({ name: 'Ops Renamed', email: 'ops@x.test', role_id: OPS });
    });

    it('a requester holding every permission of the role may manage the account', async () => {
      const peer = { ...db.as(2), role: { id: 99, name: 'PEER', permissions: ['MANAGE_USERS', 'MANAGE_ROLES', 'MANAGE_INFRASTRUCTURE'], deleted_at: null } };
      await service.update(peer, OPS_USER, { password: 'Reset12345', email: 'ops2@x.test' });
      expect(opsRow().email).toBe('ops2@x.test');
      await service.remove(peer, OPS_USER);
      expect(opsRow().deleted_at).toBeInstanceOf(Date);
    });

    it('super admins (role or is_superuser) and the account owner are unaffected', async () => {
      await service.update(db.as(1), OPS_USER, { password: 'Reset12345' });
      await service.update(db.as(4), OPS_USER, { email: 'root-set@x.test' });
      await service.update(db.as(OPS_USER), OPS_USER, { password: 'MyOwn12345', email: 'self@x.test' });
      expect(opsRow().email).toBe('self@x.test');
    });

    it('a requester with a deleted role holds nothing and cannot manage the account', async () => {
      const stale = { ...db.as(2), role: { ...db.roles[1], permissions: ['MANAGE_USERS', 'MANAGE_ROLES', 'MANAGE_INFRASTRUCTURE'], deleted_at: DELETED } };
      await expect(service.update(stale, OPS_USER, { password: 'Takeover123' })).rejects.toThrow(ForbiddenException);
    });
  });
});
