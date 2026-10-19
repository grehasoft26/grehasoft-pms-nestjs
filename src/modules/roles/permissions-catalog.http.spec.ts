import { Test } from '@nestjs/testing';
import { CanActivate, ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import * as request from 'supertest';
import { RolesController } from './roles.controller';
import { PermissionsController } from './permissions.controller';
import { RolesService } from './roles.service';
import { PrismaService } from '../../core/prisma.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { KNOWN_PERMISSIONS, PERMISSION_CATEGORIES, PERMISSION_DEFINITIONS } from '../../core/utils/permission-catalog';

/**
 * Phase 2: permission catalog endpoint and MANAGE_ROLES-based role management.
 * Real controllers, RolesService and PermissionsGuard; auth replaced by a guard that loads
 * the user and role from the in-memory database (like JwtStrategy).
 */
const buildDb = () => {
  const roles: any[] = [
    { id: 1, name: 'SUPER_ADMIN', description: '', permissions: [], deleted_at: null },
    { id: 2, name: 'USER_ADMINS', description: '', permissions: ['MANAGE_USERS'], deleted_at: null },
    { id: 3, name: 'SETTINGS_ONLY', description: '', permissions: ['MANAGE_SETTINGS'], deleted_at: null },
    { id: 4, name: 'ROLE_MANAGERS', description: '', permissions: ['MANAGE_ROLES', 'VIEW_TASKS', 'MANAGE_TASKS'], deleted_at: null },
    { id: 5, name: 'TASK_VIEWERS', description: 'Read-only tasks', permissions: ['VIEW_TASKS'], deleted_at: null },
    { id: 6, name: 'BACKUP_OPERATORS', description: 'Backups', permissions: ['MANAGE_BACKUPS', 'VIEW_TASKS'], deleted_at: null },
    { id: 7, name: 'NOBODY', description: '', permissions: [], deleted_at: null },
  ];
  const users: any[] = [
    { id: 1, role_id: 1, is_superuser: false, deleted_at: null },
    { id: 2, role_id: 2, is_superuser: false, deleted_at: null },
    { id: 3, role_id: 3, is_superuser: false, deleted_at: null },
    { id: 4, role_id: 4, is_superuser: false, deleted_at: null },
    { id: 5, role_id: 5, is_superuser: false, deleted_at: null },
    { id: 9, role_id: null, is_superuser: true, deleted_at: null },
  ];
  const ci = (v: unknown) => String(v ?? '').toLowerCase();
  const matches = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (k === 'OR') return v.some((c: any) => matches(row, c));
      if (k === 'NOT') return !matches(row, v);
      if (v === null) return row[k] === null || row[k] === undefined;
      if (v && typeof v === 'object' && 'contains' in v) return ci(row[k]).includes(ci(v.contains));
      return typeof v === 'string' ? ci(row[k]) === ci(v) : row[k] === v;
    });
  const withRole = (u: any) => u && { ...u, role: roles.find((r) => r.id === u.role_id) ?? null };
  const prisma: any = {
    role: {
      findFirst: async ({ where }: any) => roles.find((r) => matches(r, where)) ?? null,
      findMany: async ({ where }: any) => roles.filter((r) => matches(r, where)),
      count: async ({ where }: any) => roles.filter((r) => matches(r, where)).length,
      create: async ({ data }: any) => { const r = { id: roles.length + 1, deleted_at: null, ...data }; roles.push(r); return r; },
      update: async ({ where, data }: any) => Object.assign(roles.find((r) => r.id === where.id), data),
    },
    user: { count: async ({ where }: any) => users.filter((u) => matches(u, where)).length },
  };
  return { prisma, roles, users, withRole };
};

describe('Permission catalog and MANAGE_ROLES authorization (HTTP)', () => {
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
      controllers: [RolesController, PermissionsController],
      providers: [RolesService, { provide: PrismaService, useValue: db.prisma }],
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
  const CATALOG = '/api/v1/permissions';
  const ROLES = '/api/v1/roles';
  const SUPER = 1, USER_ADMIN = 2, SETTINGS_ONLY = 3, MANAGER = 4, VIEWER = 5, ROOT = 9;

  describe('GET /api/v1/permissions', () => {
    it('returns the canonical catalog (ids, labels, categories) to super admins', async () => {
      const res = await as(SUPER).get(CATALOG).expect(200);
      expect(res.body.categories).toEqual([...PERMISSION_CATEGORIES]);
      expect(res.body.permissions.map((p: any) => p.id)).toEqual([...KNOWN_PERMISSIONS]);
      expect(res.body.permissions[0]).toEqual({ ...PERMISSION_DEFINITIONS[0], assignable: true });
      expect(res.body.permissions.every((p: any) => p.assignable)).toBe(true);
    });

    it('exposes only catalog fields (no user or role data)', async () => {
      const res = await as(MANAGER).get(CATALOG).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['categories', 'permissions']);
      for (const p of res.body.permissions) {
        expect(Object.keys(p).sort()).toEqual(['assignable', 'category', 'description', 'id', 'label']);
      }
    });

    it('marks only the permissions a non-super role manager holds as assignable', async () => {
      const res = await as(MANAGER).get(CATALOG).expect(200);
      const assignable = res.body.permissions.filter((p: any) => p.assignable).map((p: any) => p.id).sort();
      expect(assignable).toEqual(['MANAGE_ROLES', 'MANAGE_TASKS', 'VIEW_TASKS']);
    });

    it('is_superuser accounts get everything assignable', async () => {
      const res = await as(ROOT).get(CATALOG).expect(200);
      expect(res.body.permissions.every((p: any) => p.assignable)).toBe(true);
    });

    it('is denied to users without MANAGE_ROLES (least privilege)', async () => {
      await as(USER_ADMIN).get(CATALOG).expect(403);
      await as(SETTINGS_ONLY).get(CATALOG).expect(403);
      await as(VIEWER).get(CATALOG).expect(403);
      await request(app.getHttpServer()).get(CATALOG).expect(401);
    });
  });

  describe('role endpoints use MANAGE_ROLES', () => {
    it('MANAGE_SETTINGS alone no longer grants role management', async () => {
      await as(SETTINGS_ONLY).get(ROLES).expect(403);
      await as(SETTINGS_ONLY).post(ROLES).send({ name: 'x' }).expect(403);
      await as(SETTINGS_ONLY).patch(`${ROLES}/7`).send({ description: 'x' }).expect(403);
      await as(SETTINGS_ONLY).delete(`${ROLES}/7`).expect(403);
      expect(db.roles[6]).toMatchObject({ description: '', deleted_at: null });
    });

    it('MANAGE_USERS can still list roles (user role dropdown) but not change them', async () => {
      await as(USER_ADMIN).get(`${ROLES}?all=true`).expect(200);
      await as(USER_ADMIN).get(`${ROLES}/5`).expect(200);
      await as(USER_ADMIN).post(ROLES).send({ name: 'x' }).expect(403);
      await as(USER_ADMIN).delete(`${ROLES}/7`).expect(403);
    });

    it('users with neither permission are denied everything', async () => {
      await as(VIEWER).get(ROLES).expect(403);
      await as(VIEWER).post(ROLES).send({ name: 'x' }).expect(403);
    });

    it('MANAGE_ROLES holders can list, create, edit and delete other roles', async () => {
      await as(MANAGER).get(ROLES).expect(200);
      const created = await as(MANAGER).post(ROLES).send({ name: 'qa team', permissions: ['VIEW_TASKS'] }).expect(201);
      expect(created.body.data).toMatchObject({ name: 'QA_TEAM', permissions: ['VIEW_TASKS'] });
      await as(MANAGER).patch(`${ROLES}/5`).send({ description: 'Updated', permissions: ['VIEW_TASKS', 'MANAGE_TASKS'] }).expect(200);
      expect(db.roles[4]).toMatchObject({ description: 'Updated', permissions: ['VIEW_TASKS', 'MANAGE_TASKS'] });
      await as(MANAGER).delete(`${ROLES}/7`).expect(204);
    });
  });

  describe('least privilege for non-super role managers', () => {
    it('cannot grant permissions they do not hold (create)', async () => {
      const res = await as(MANAGER).post(ROLES).send({ name: 'sneaky', permissions: ['VIEW_TASKS', 'MANAGE_BACKUPS', 'MANAGE_USERS'] }).expect(403);
      expect(res.body.message).toBe('You cannot grant permissions you do not have: MANAGE_BACKUPS, MANAGE_USERS.');
      expect(db.roles.some((r) => r.name === 'SNEAKY')).toBe(false);
    });

    it('cannot add permissions they do not hold (update)', async () => {
      await as(MANAGER).patch(`${ROLES}/5`).send({ permissions: ['VIEW_TASKS', 'MANAGE_USERS'] }).expect(403);
      expect(db.roles[4].permissions).toEqual(['VIEW_TASKS']);
    });

    it('may keep or remove permissions a role already has, even ones they do not hold', async () => {
      await as(MANAGER).patch(`${ROLES}/6`).send({ description: 'Ops', permissions: ['MANAGE_BACKUPS', 'VIEW_TASKS'] }).expect(200);
      await as(MANAGER).patch(`${ROLES}/6`).send({ permissions: ['VIEW_TASKS'] }).expect(200);
      expect(db.roles[5].permissions).toEqual(['VIEW_TASKS']);
    });

    it('cannot modify or delete the role assigned to their own account', async () => {
      const res = await as(MANAGER).patch(`${ROLES}/4`).send({ description: 'x' }).expect(403);
      expect(res.body.message).toBe('You cannot modify the role assigned to your own account.');
      await as(MANAGER).delete(`${ROLES}/4`).expect(403);
      expect(db.roles[3]).toMatchObject({ description: '', deleted_at: null });
    });

    it('invalid permissions are still rejected with 400', async () => {
      await as(MANAGER).post(ROLES).send({ name: 'bad', permissions: ['GOD_MODE'] }).expect(400);
      await as(MANAGER).patch(`${ROLES}/5`).send({ permissions: 'VIEW_TASKS' }).expect(400);
    });
  });

  describe('SUPER_ADMIN keeps full access', () => {
    it('can grant any catalog permission and edit any non-protected role', async () => {
      await as(SUPER).post(ROLES).send({ name: 'ops', permissions: ['MANAGE_BACKUPS', 'MANAGE_INFRASTRUCTURE'] }).expect(201);
      await as(SUPER).patch(`${ROLES}/4`).send({ permissions: ['MANAGE_ROLES', 'MANAGE_USERS'] }).expect(200);
    });

    it('can edit its own SUPER_ADMIN role description but still cannot rename or delete it', async () => {
      await as(SUPER).patch(`${ROLES}/1`).send({ description: 'Owners' }).expect(200);
      await as(SUPER).patch(`${ROLES}/1`).send({ name: 'OWNER' }).expect(400);
      await as(SUPER).delete(`${ROLES}/1`).expect(403);
    });
  });
});
