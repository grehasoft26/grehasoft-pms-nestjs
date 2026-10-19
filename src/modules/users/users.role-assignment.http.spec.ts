import { Test } from '@nestjs/testing';
import { CanActivate, ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import * as request from 'supertest';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PrismaService } from '../../core/prisma.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';

/**
 * Phase 2.1: privileged-role and delegated role assignment on POST/PATCH /api/v1/users.
 * Real controller, UsersService and PermissionsGuard; roles mirror prisma/seed.ts plus a
 * custom role a super admin gave extra permissions. In-memory Prisma fake, no database.
 */
const ADMIN_PERMS = [
  'MANAGE_USERS', 'MANAGE_ROLES', 'MANAGE_DEPARTMENTS', 'MANAGE_PROJECTS', 'MANAGE_TASKS', 'MANAGE_LEADS',
  'MANAGE_PROPOSALS', 'MANAGE_INVOICES', 'MANAGE_SEO', 'GENERATE_HR_DOCS', 'VIEW_DASHBOARD',
];

const buildDb = () => {
  const roles: any[] = [
    { id: 1, name: 'SUPER_ADMIN', permissions: [], deleted_at: null },
    { id: 2, name: 'ADMIN', permissions: ADMIN_PERMS, deleted_at: null },
    { id: 3, name: 'PROJECT_MANAGER', permissions: ['MANAGE_PROJECTS', 'MANAGE_TASKS', 'VIEW_DASHBOARD'], deleted_at: null },
    { id: 4, name: 'TEAM_MEMBER', permissions: ['VIEW_DASHBOARD', 'VIEW_PROJECTS', 'VIEW_TASKS', 'MANAGE_TASKS'], deleted_at: null },
    { id: 5, name: 'SALES_MANAGER', permissions: ['MANAGE_LEADS', 'MANAGE_PROPOSALS', 'VIEW_DASHBOARD'], deleted_at: null },
    // Custom role a super admin granted extra permissions
    { id: 6, name: 'OPS_LEAD', permissions: ['VIEW_DASHBOARD', 'MANAGE_BACKUPS', 'MANAGE_INFRASTRUCTURE'], deleted_at: null },
    { id: 7, name: 'RETIRED_ROLE', permissions: [], deleted_at: new Date('2026-09-01') },
    { id: 8, name: 'CLIENT', permissions: ['VIEW_DASHBOARD'], deleted_at: null },
  ];
  const users: any[] = [
    { id: 1, name: 'Owner', username: 'owner', email: 'o@x.test', role_id: 1, is_superuser: false, deleted_at: null },
    { id: 2, name: 'Admin', username: 'admin', email: 'a@x.test', role_id: 2, is_superuser: false, deleted_at: null },
    { id: 3, name: 'Other Admin', username: 'admin2', email: 'a2@x.test', role_id: 2, is_superuser: false, deleted_at: null },
    { id: 4, name: 'PM', username: 'pm', email: 'pm@x.test', role_id: 3, is_superuser: false, deleted_at: null },
    { id: 5, name: 'Member', username: 'member', email: 'm@x.test', role_id: 4, is_superuser: false, deleted_at: null },
    { id: 9, name: 'Root', username: 'root', email: 'r@x.test', role_id: null, is_superuser: true, deleted_at: null },
  ];
  const ci = (v: unknown) => String(v ?? '').toLowerCase();
  const matches = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (k === 'OR') return v.some((c: any) => matches(row, c));
      if (v === null) return row[k] === null || row[k] === undefined;
      return typeof v === 'string' ? ci(row[k]) === ci(v) : row[k] === v;
    });
  const withRole = (u: any) => u && { ...u, role: roles.find((r) => r.id === u.role_id) ?? null, department: null, client: null };
  const prisma: any = {
    role: { findFirst: jest.fn(async ({ where }: any) => roles.find((r) => matches(r, where)) ?? null) },
    user: {
      findFirst: jest.fn(async ({ where }: any) => withRole(users.find((u) => matches(u, where)))),
      update: jest.fn(async ({ where, data }: any) => withRole(Object.assign(users.find((u) => u.id === where.id), data))),
      create: jest.fn(async ({ data }: any) => {
        const u = { id: users.length + 100, deleted_at: null, is_superuser: false, ...data };
        users.push(u);
        return withRole(u);
      }),
    },
    employee: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({})), create: jest.fn(), update: jest.fn() },
  };
  return { prisma, roles, users, withRole };
};

describe('User role assignment security (HTTP, Phase 2.1)', () => {
  let app: INestApplication;
  let db: ReturnType<typeof buildDb>;

  beforeEach(async () => {
    db = buildDb();
    class TestAuthGuard implements CanActivate {
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest();
        const user = db.withRole(db.users.find((u) => u.id === Number(req.headers['x-user-id'])));
        if (!user) throw new UnauthorizedException();
        req.user = user;
        return true;
      }
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [UsersService, { provide: PrismaService, useValue: db.prisma }],
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
      post: (body: any) => request(server).post('/api/v1/users').set('x-user-id', String(userId)).send(body),
      patch: (id: number, body: any) => request(server).patch(`/api/v1/users/${id}`).set('x-user-id', String(userId)).send(body),
      delete: (id: number) => request(server).delete(`/api/v1/users/${id}`).set('x-user-id', String(userId)),
    };
  };
  const SUPER = 1, ADMIN = 2, OTHER_ADMIN = 3, PM = 4, MEMBER = 5, ROOT = 9;
  const newUser = (role: any) => ({ username: `u${Math.random().toString(36).slice(2, 8)}`, email: 'n@x.test', name: 'New', password: 'Password123', role });

  describe('privileged roles (SUPER_ADMIN, ADMIN)', () => {
    it('a non-super user cannot create a SUPER_ADMIN account (by id or by name)', async () => {
      expect((await as(ADMIN).post(newUser(1)).expect(403)).body.role).toBe('Only Super Admins can assign the SUPER_ADMIN role.');
      await as(ADMIN).post(newUser('SUPER_ADMIN')).expect(403);
      expect(db.prisma.user.create).not.toHaveBeenCalled();
    });

    it('a non-super user cannot create an ADMIN account (by id or by name)', async () => {
      expect((await as(ADMIN).post(newUser(2)).expect(403)).body.role).toBe('Only Super Admins can assign the ADMIN role.');
      await as(ADMIN).post(newUser('admin')).expect(403);
      expect(db.prisma.user.create).not.toHaveBeenCalled();
    });

    it('a non-super user cannot promote an existing user to ADMIN or SUPER_ADMIN', async () => {
      await as(ADMIN).patch(MEMBER, { role: 2 }).expect(403);
      await as(ADMIN).patch(MEMBER, { role: 1 }).expect(403);
      expect(db.users[4].role_id).toBe(4);
    });

    it('a non-super user cannot change or clear the role of an existing ADMIN account', async () => {
      const res = await as(ADMIN).patch(OTHER_ADMIN, { role: 3 }).expect(403);
      expect(res.body.role).toBe('Only Super Admins can change the role of an account that has the ADMIN role.');
      await as(ADMIN).patch(OTHER_ADMIN, { role: null }).expect(403);
      expect(db.users[2].role_id).toBe(2);
    });

    it('a non-super user can still edit other fields of an ADMIN account (role unchanged)', async () => {
      await as(ADMIN).patch(OTHER_ADMIN, { name: 'Renamed Admin', role: 2 }).expect(200);
      expect(db.users[2]).toMatchObject({ name: 'Renamed Admin', role_id: 2 });
    });

    it('SUPER_ADMIN can create ADMIN and SUPER_ADMIN accounts and promote or demote users', async () => {
      await as(SUPER).post(newUser(2)).expect(201);
      await as(SUPER).post(newUser(1)).expect(201);
      await as(SUPER).patch(MEMBER, { role: 2 }).expect(200);
      expect(db.users[4].role_id).toBe(2);
      await as(SUPER).patch(OTHER_ADMIN, { role: 3 }).expect(200);
      expect(db.users[2].role_id).toBe(3);
    });

    it('is_superuser accounts follow the super-admin policy', async () => {
      await as(ROOT).patch(MEMBER, { role: 1 }).expect(200);
      expect(db.users[4].role_id).toBe(1);
    });
  });

  describe('role validation and self changes', () => {
    it('invalid, nonexistent and deleted roles are rejected with 400', async () => {
      await as(SUPER).patch(MEMBER, { role: 999 }).expect(400);
      await as(SUPER).patch(MEMBER, { role: 7 }).expect(400);
      await as(SUPER).patch(MEMBER, { role: 'abc' }).expect(400);
      await as(SUPER).post(newUser(7)).expect(400);
      await as(SUPER).post(newUser(999)).expect(400);
      expect(db.users[4].role_id).toBe(4);
    });

    it('self role changes remain blocked for admins and super admins', async () => {
      expect((await as(ADMIN).patch(ADMIN, { role: 3 }).expect(403)).body.role).toBe('You cannot change your own role.');
      await as(SUPER).patch(SUPER, { role: 2 }).expect(403);
    });

    it('users without MANAGE_USERS are stopped by the permission guard', async () => {
      await as(PM).patch(MEMBER, { role: 3 }).expect(403);
      await as(PM).post(newUser(3)).expect(403);
    });
  });

  describe('delegation: roles may not grant permissions the requester lacks', () => {
    it('rejects a role a super admin granted extra permissions (create and update)', async () => {
      const res = await as(ADMIN).patch(MEMBER, { role: 6 }).expect(403);
      expect(res.body.role).toBe('You cannot assign the OPS_LEAD role because it grants permissions you do not have: MANAGE_BACKUPS, MANAGE_INFRASTRUCTURE.');
      await as(ADMIN).post(newUser(6)).expect(403);
      expect(db.users[4].role_id).toBe(4);
    });

    it('allows roles whose permissions the requester fully holds', async () => {
      // Target is the PM account, whose current access ADMIN also covers (a TEAM_MEMBER target
      // is protected: see "account takeover" below)
      await as(ADMIN).patch(PM, { role: 5 }).expect(200); // SALES_MANAGER
      await as(ADMIN).patch(PM, { role: 3 }).expect(200); // PROJECT_MANAGER
      await as(ADMIN).post(newUser(8)).expect(201); // CLIENT
      expect(db.users[3].role_id).toBe(3);
    });
  });

  describe('account takeover: targets whose role grants permissions the requester lacks', () => {
    it('ADMIN cannot reset the password of, re-role or delete a custom-role account with more access', async () => {
      db.users[4].role_id = 6; // OPS_LEAD (MANAGE_BACKUPS, MANAGE_INFRASTRUCTURE), set by a super admin
      const reset = await as(ADMIN).patch(MEMBER, { password: 'Takeover123' }).expect(403);
      expect(reset.body.message).toBe(
        'Only Super Admins can change password of an account whose role grants permissions you do not have (MANAGE_BACKUPS, MANAGE_INFRASTRUCTURE).',
      );
      await as(ADMIN).patch(MEMBER, { email: 'mine@x.test' }).expect(403);
      await as(ADMIN).patch(MEMBER, { role: 3 }).expect(403);
      await as(ADMIN).delete(MEMBER).expect(403);
      expect(db.users[4]).toMatchObject({ role_id: 6, email: 'm@x.test', deleted_at: null });
    });

    it('SUPER_ADMIN can still manage that account', async () => {
      db.users[4].role_id = 6;
      await as(SUPER).patch(MEMBER, { password: 'Reset12345', role: 3 }).expect(200);
      expect(db.users[4].role_id).toBe(3);
    });

    it('documented impact: seeded ADMIN cannot assign TEAM_MEMBER (VIEW_PROJECTS and VIEW_TASKS are not held)', async () => {
      db.users[4].role_id = 3;
      const res = await as(ADMIN).patch(MEMBER, { role: 4 }).expect(403);
      expect(res.body.role).toBe('You cannot assign the TEAM_MEMBER role because it grants permissions you do not have: VIEW_PROJECTS, VIEW_TASKS.');
    });

    it('SUPER_ADMIN can assign any active role', async () => {
      await as(SUPER).patch(MEMBER, { role: 6 }).expect(200);
      await as(SUPER).post(newUser(4)).expect(201);
    });

    it('re-sending a user\'s current role is not an assignment (legacy roles stay editable)', async () => {
      db.users[4].role_id = 6; // assigned earlier by a super admin
      await as(ADMIN).patch(MEMBER, { name: 'Member Updated', role: 6 }).expect(200);
      expect(db.users[4]).toMatchObject({ name: 'Member Updated', role_id: 6 });
    });
  });
});
