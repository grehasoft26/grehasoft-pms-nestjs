import { ForbiddenException } from '@nestjs/common';
import { UsersService } from './users.service';

/**
 * Phase 2.2: a manager holding MANAGE_USERS (e.g. ADMIN) must not take over another
 * ADMIN account by resetting its password or changing its login/access fields, or delete it.
 * Super admins keep full control; harmless profile edits stay allowed.
 */
const buildDb = () => {
  const roles = [
    { id: 1, name: 'SUPER_ADMIN', permissions: [], deleted_at: null },
    { id: 2, name: 'ADMIN', permissions: ['MANAGE_USERS'], deleted_at: null },
    { id: 3, name: 'TEAM_MEMBER', permissions: [], deleted_at: null },
  ];
  const users: any[] = [
    { id: 1, name: 'Owner', username: 'owner', email: 'o@x.test', role_id: 1, is_superuser: false, is_active: true, status: 'active', department_id: null, client_id: null, deleted_at: null },
    { id: 2, name: 'Admin', username: 'admin', email: 'a@x.test', role_id: 2, is_superuser: false, is_active: true, status: 'active', department_id: null, client_id: null, deleted_at: null },
    { id: 3, name: 'Other Admin', username: 'admin2', email: 'a2@x.test', role_id: 2, is_superuser: false, is_active: true, status: 'active', department_id: 4, client_id: null, deleted_at: null },
    { id: 5, name: 'Member', username: 'member', email: 'm@x.test', role_id: 3, is_superuser: false, is_active: true, status: 'active', department_id: null, client_id: null, deleted_at: null },
  ];
  const withRelations = (u: any) => u && { ...u, role: roles.find((r) => r.id === u.role_id) ?? null, department: null, client: null };
  const prisma: any = {
    role: { findFirst: jest.fn(async ({ where }: any) => roles.find((r) => r.id === where.id || r.name === where.name) ?? null) },
    user: {
      findFirst: jest.fn(async ({ where }: any) => withRelations(users.find((u) => u.id === where.id && !u.deleted_at))),
      update: jest.fn(async ({ where, data }: any) => withRelations(Object.assign(users.find((u) => u.id === where.id), data))),
    },
    employee: { findUnique: jest.fn(async () => null), create: jest.fn(), update: jest.fn(), upsert: jest.fn() },
  };
  return { prisma, users, as: (id: number) => withRelations(users.find((u) => u.id === id)) };
};

describe('Privileged account protection (Phase 2.2)', () => {
  let db: ReturnType<typeof buildDb>;
  let service: UsersService;

  beforeEach(() => {
    db = buildDb();
    service = new UsersService(db.prisma);
  });

  const SENSITIVE: Record<string, any> = {
    password: { password: 'N3w-pass!word' },
    email: { email: 'attacker@x.test' },
    username: { username: 'taken-over' },
    is_active: { is_active: false },
    status: { status: 'inactive' },
    department: { department: 9 },
    client: { client: 1 },
  };

  for (const [field, body] of Object.entries(SENSITIVE)) {
    it(`ADMIN cannot change ${field} of another ADMIN account`, async () => {
      await expect(service.update(db.as(2), 3, body)).rejects.toThrow(ForbiddenException);
      expect(db.prisma.user.update).not.toHaveBeenCalled();
    });
  }

  it('ADMIN may re-send unchanged values and edit harmless fields of another ADMIN', async () => {
    await expect(service.update(db.as(2), 3, { name: 'Renamed', email: 'a2@x.test', username: 'admin2', department: 4 })).resolves.toBeTruthy();
    expect(db.users.find((u) => u.id === 3).name).toBe('Renamed');
  });

  it('ADMIN can still reset passwords and emails of ordinary users', async () => {
    await expect(service.update(db.as(2), 5, { email: 'new@x.test', password: 'N3w-pass!word' })).resolves.toBeTruthy();
  });

  it('ADMIN can still update their own account', async () => {
    await expect(service.update(db.as(2), 2, { email: 'me@x.test' })).resolves.toBeTruthy();
  });

  it('super admins can change sensitive fields of ADMIN accounts', async () => {
    await expect(service.update(db.as(1), 3, { email: 'new-admin@x.test', password: 'N3w-pass!word', is_active: false })).resolves.toBeTruthy();
  });

  it('only super admins can delete ADMIN accounts', async () => {
    await expect(service.remove(db.as(2), 3)).rejects.toThrow(ForbiddenException);
    expect(db.users.find((u) => u.id === 3).deleted_at).toBeNull();
    await expect(service.remove(db.as(2), 5)).resolves.toBeNull();
    await expect(service.remove(db.as(1), 3)).resolves.toBeNull();
  });
});
