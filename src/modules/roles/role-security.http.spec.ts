import { Test } from '@nestjs/testing';
import { CanActivate, ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import * as request from 'supertest';
import { UsersController } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { PrismaService } from '../../core/prisma.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';

/**
 * HTTP-level role-management security: real controllers, services and PermissionsGuard.
 * JWT auth is replaced by a guard that, like JwtStrategy, loads the user with their role
 * from the (in-memory) database on every request.
 */
const buildDb = () => {
  const roles: any[] = [
    { id: 1, name: 'SUPER_ADMIN', description: '', permissions: [], deleted_at: null },
    { id: 2, name: 'ADMIN', description: '', permissions: ['MANAGE_USERS'], deleted_at: null },
    { id: 3, name: 'TEAM_MEMBER', description: '', permissions: ['VIEW_TASKS'], deleted_at: null },
    { id: 4, name: 'LEGACY_MANAGER', description: '', permissions: ['MANAGE_USERS', 'MANAGE_SETTINGS'], deleted_at: new Date('2026-09-01') },
    { id: 5, name: 'ROLE_ADMINS', description: 'Can manage roles', permissions: ['MANAGE_ROLES', 'VIEW_TASKS', 'MANAGE_LEADS'], deleted_at: null },
    { id: 6, name: 'SALES_EXECUTIVE', description: 'Built-in, unused', permissions: ['MANAGE_LEADS'], deleted_at: null },
  ];
  const users: any[] = [
    { id: 1, name: 'Owner', username: 'owner', email: 'o@x.test', role_id: 1, is_superuser: false, is_active: true, deleted_at: null },
    { id: 2, name: 'Admin', username: 'admin', email: 'a@x.test', role_id: 2, is_superuser: false, is_active: true, deleted_at: null },
    { id: 3, name: 'Member', username: 'member', email: 'm@x.test', role_id: 3, is_superuser: false, is_active: true, deleted_at: null },
    // Legacy data: user still assigned to a soft-deleted role that had admin-level permissions
    { id: 4, name: 'Stale', username: 'stale', email: 's@x.test', role_id: 4, is_superuser: false, is_active: true, deleted_at: null },
    // Non-super admin who may manage roles (MANAGE_ROLES)
    { id: 5, name: 'Roles Admin', username: 'roles', email: 'ra@x.test', role_id: 5, is_superuser: false, is_active: true, deleted_at: null },
  ];
  // Mirrors MySQL utf8mb4_unicode_ci: case-insensitive equality and LIKE
  const ci = (v: unknown) => String(v ?? '').toLowerCase();
  const matches = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (k === 'OR') return v.some((c: any) => matches(row, c));
      if (k === 'NOT') return !matches(row, v);
      if (v === null) return row[k] === null || row[k] === undefined;
      if (v && typeof v === 'object' && 'contains' in v) {
        if ('mode' in v) throw new Error('Unknown argument `mode`');
        return ci(row[k]).includes(ci(v.contains));
      }
      return typeof v === 'string' ? ci(row[k]) === ci(v) : row[k] === v;
    });
  const withRole = (u: any) => u && { ...u, role: roles.find((r) => r.id === u.role_id) ?? null, department: null, client: null };
  const prisma: any = {
    role: {
      findFirst: async ({ where }: any) => roles.find((r) => matches(r, where)) ?? null,
      findMany: async ({ where }: any) => roles.filter((r) => matches(r, where)),
      count: async ({ where }: any) => roles.filter((r) => matches(r, where)).length,
      create: async ({ data }: any) => { const r = { id: roles.length + 1, deleted_at: null, ...data }; roles.push(r); return r; },
      update: async ({ where, data }: any) => Object.assign(roles.find((r) => r.id === where.id), data),
    },
    user: {
      findFirst: async ({ where }: any) => withRole(users.find((u) => matches(u, where))),
      count: async ({ where }: any) => users.filter((u) => matches(u, where)).length,
      update: async ({ where, data }: any) => withRole(Object.assign(users.find((u) => u.id === where.id), data)),
    },
    employee: { findUnique: async () => null },
  };
  return { prisma, roles, users, withRole };
};

describe('Role management security (HTTP)', () => {
  let app: INestApplication;
  let db: ReturnType<typeof buildDb>;

  beforeEach(async () => {
    db = buildDb();
    class TestAuthGuard implements CanActivate {
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest();
        const user = db.withRole(db.users.find((u) => u.id === Number(req.headers['x-user-id']) && !u.deleted_at));
        if (!user) throw new UnauthorizedException();
        req.user = user;
        return true;
      }
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController, RolesController],
      providers: [UsersService, RolesService, { provide: PrismaService, useValue: db.prisma }],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestAuthGuard)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const as = (userId: number) => {
    const server = app.getHttpServer();
    return {
      get: (url: string) => request(server).get(url).set('x-user-id', String(userId)),
      post: (url: string) => request(server).post(url).set('x-user-id', String(userId)),
      patch: (url: string) => request(server).patch(url).set('x-user-id', String(userId)),
      delete: (url: string) => request(server).delete(url).set('x-user-id', String(userId)),
    };
  };
  const USERS = '/api/v1/users';
  const ROLES = '/api/v1/roles';

  it('1. ADMIN cannot make themselves SUPER_ADMIN (the verified escalation) and gains nothing', async () => {
    const res = await as(2).patch(`${USERS}/2`).send({ role: 1 }).expect(403);
    // Self role changes are rejected before the SUPER_ADMIN check
    expect(res.body.role).toBe('You cannot change your own role.');
    expect(db.users[1].role_id).toBe(2);
    // Still no role-management rights afterwards
    await as(2).post(ROLES).send({ name: 'x' }).expect(403);
  });

  it('2. ADMIN cannot assign SUPER_ADMIN to another user', async () => {
    await as(2).patch(`${USERS}/3`).send({ role: 1 }).expect(403);
    expect(db.users[2].role_id).toBe(3);
  });

  it('3. ADMIN cannot change their own role; ordinary users cannot call the endpoint at all', async () => {
    await as(2).patch(`${USERS}/2`).send({ role: 3 }).expect(403);
    await as(3).patch(`${USERS}/3`).send({ role: 2 }).expect(403);
    expect(db.users[2].role_id).toBe(3);
  });

  it('4. SUPER_ADMIN can assign SUPER_ADMIN to another user', async () => {
    await as(1).patch(`${USERS}/3`).send({ role: 1 }).expect(200);
    expect(db.users[2].role_id).toBe(1);
  });

  it('5/6. assigning a missing or soft-deleted role returns 400', async () => {
    await as(1).patch(`${USERS}/3`).send({ role: 999 }).expect(400);
    await as(1).patch(`${USERS}/3`).send({ role: 4 }).expect(400);
    expect(db.users[2].role_id).toBe(3);
  });

  it('9. a user on a soft-deleted role gets none of its permissions', async () => {
    await as(4).get(ROLES).expect(403);
    await as(4).patch(`${USERS}/3`).send({ name: 'x' }).expect(403);
    await as(4).post(ROLES).send({ name: 'x' }).expect(403);
  });

  it('8. SUPER_ADMIN role cannot be renamed or deleted; super admin keeps access', async () => {
    await as(1).patch(`${ROLES}/1`).send({ name: 'OWNER' }).expect(400);
    await as(1).delete(`${ROLES}/1`).expect(403);
    expect(db.roles[0]).toMatchObject({ name: 'SUPER_ADMIN', deleted_at: null });
    await as(1).get(ROLES).expect(200);
  });

  it('11. a role with assigned users cannot be deleted (409)', async () => {
    await as(1).delete(`${ROLES}/3`).expect(409);
    expect(db.roles[2].deleted_at).toBeNull();
  });

  it('ADMIN cannot delete the super-admin account', async () => {
    await as(2).delete(`${USERS}/1`).expect(403);
    expect(db.users[0].deleted_at).toBeNull();
  });

  describe('Phase 1.1 role validation over HTTP (plain-string messages for the UI)', () => {
    it('duplicate role name -> 409 and the existing role is untouched', async () => {
      const res = await as(5).post(ROLES).send({ name: 'role admins', permissions: ['MANAGE_USERS'] }).expect(409);
      expect(res.body.message).toBe('A role named ROLE_ADMINS already exists.');
      expect(db.roles[4].permissions).toEqual(['MANAGE_ROLES', 'VIEW_TASKS', 'MANAGE_LEADS']);
    });

    it('unknown permission -> 400 with the offending names', async () => {
      const res = await as(5).post(ROLES).send({ name: 'qa', permissions: ['VIEW_TASKS', 'GOD_MODE'] }).expect(400);
      expect(res.body.message).toBe('Unknown permission(s): GOD_MODE.');
    });

    it('permissions as a string -> 400', async () => {
      const res = await as(5).patch(`${ROLES}/6`).send({ permissions: 'MANAGE_USERS' }).expect(400);
      expect(res.body.message).toBe('Permissions must be an array of permission names.');
    });

    it('renaming a built-in role -> 400; deleting it as a non-super admin -> 403', async () => {
      expect((await as(5).patch(`${ROLES}/6`).send({ name: 'SALES_REP' }).expect(400)).body.message).toBe('The built-in SALES_EXECUTIVE role cannot be renamed.');
      expect((await as(5).delete(`${ROLES}/6`).expect(403)).body.message).toBe('Only Super Admins can delete the built-in SALES_EXECUTIVE role.');
      expect(db.roles[5]).toMatchObject({ name: 'SALES_EXECUTIVE', deleted_at: null });
    });

    it('valid create by a MANAGE_ROLES holder -> 201', async () => {
      const res = await as(5).post(ROLES).send({ name: 'content writer', description: 'Blog', permissions: ['view_tasks', 'VIEW_TASKS'] }).expect(201);
      expect(res.body.data).toMatchObject({ name: 'CONTENT_WRITER', permissions: ['VIEW_TASKS'] });
    });

    it('search is case-insensitive, MySQL-compatible and excludes deleted roles', async () => {
      const res = await as(1).get(`${ROLES}?all=true&search=manager`).expect(200);
      expect(res.body.map((r: any) => r.name)).toEqual([]); // LEGACY_MANAGER is deleted
      const admins = await as(1).get(`${ROLES}?all=true&search=ADMIN`).expect(200);
      expect(admins.body.map((r: any) => r.name)).toEqual(['SUPER_ADMIN', 'ADMIN', 'ROLE_ADMINS']);
    });
  });

  it('10. ordinary updates through the API still work', async () => {
    const res = await as(2).patch(`${USERS}/3`).send({ name: 'Member Renamed', role: 3 }).expect(200);
    expect(res.body.name).toBe('Member Renamed');
    expect(db.users[2].role_id).toBe(3);
  });
});
