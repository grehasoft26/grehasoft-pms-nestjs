import { Test } from '@nestjs/testing';
import { CanActivate, ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import * as request from 'supertest';
import { UsersController } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import { RolesController } from './roles.controller';
import { PermissionsController } from './permissions.controller';
import { RolesService } from './roles.service';
import { PrismaService } from '../../core/prisma.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';

/**
 * Credential Vault permissions (MANAGE_CREDENTIALS, REVEAL_CREDENTIALS, VIEW_CREDENTIAL_AUDIT)
 * can be granted or revoked only by super admins, through roles and through user role
 * assignment. Real controllers, services and PermissionsGuard over an in-memory database, as in
 * role-security.http.spec. The non-super "keeper" holds every credential permission plus role and
 * user management, so the ordinary "grant only what you hold" rule would let them through.
 */
const CREDENTIALS = ['MANAGE_CREDENTIALS', 'REVEAL_CREDENTIALS', 'VIEW_CREDENTIAL_AUDIT'];

const buildDb = () => {
  const roles: any[] = [
    { id: 1, name: 'SUPER_ADMIN', description: '', permissions: [], deleted_at: null },
    { id: 2, name: 'VAULT_KEEPER', description: '', permissions: ['MANAGE_ROLES', 'MANAGE_USERS', 'VIEW_TASKS', 'MANAGE_LEADS', ...CREDENTIALS], deleted_at: null },
    { id: 3, name: 'TEAM_MEMBER', description: '', permissions: ['VIEW_TASKS'], deleted_at: null },
    { id: 4, name: 'CREDENTIAL_VIEWERS', description: 'Can reveal', permissions: ['VIEW_TASKS', 'REVEAL_CREDENTIALS'], deleted_at: null },
    { id: 5, name: 'SALES_TEAM', description: '', permissions: ['MANAGE_LEADS'], deleted_at: null },
  ];
  const users: any[] = [
    { id: 1, name: 'Owner', username: 'owner', email: 'o@x.test', role_id: 1, is_superuser: false, is_active: true, deleted_at: null },
    { id: 2, name: 'Keeper', username: 'keeper', email: 'k@x.test', role_id: 2, is_superuser: false, is_active: true, deleted_at: null },
    { id: 3, name: 'Member', username: 'member', email: 'm@x.test', role_id: 3, is_superuser: false, is_active: true, deleted_at: null },
    { id: 4, name: 'Viewer', username: 'viewer', email: 'v@x.test', role_id: 4, is_superuser: false, is_active: true, deleted_at: null },
  ];
  const matches = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (k === 'OR') return v.some((c: any) => matches(row, c));
      if (k === 'NOT') return !matches(row, v);
      if (v === null) return row[k] === null || row[k] === undefined;
      return typeof v === 'string' ? String(row[k] ?? '').toLowerCase() === v.toLowerCase() : row[k] === v;
    });
  const withRole = (u: any) => u && { ...u, role: roles.find((r) => r.id === u.role_id) ?? null, department: null, client: null };
  const prisma: any = {
    role: {
      findFirst: async ({ where }: any) => roles.find((r) => matches(r, where)) ?? null,
      count: async ({ where }: any) => roles.filter((r) => matches(r, where)).length,
      create: async ({ data }: any) => { const r = { id: roles.length + 1, deleted_at: null, ...data }; roles.push(r); return r; },
      update: async ({ where, data }: any) => Object.assign(roles.find((r) => r.id === where.id), data),
    },
    user: {
      findFirst: async ({ where }: any) => withRole(users.find((u) => matches(u, where))),
      count: async ({ where }: any) => users.filter((u) => matches(u, where)).length,
      create: async ({ data }: any) => { const u = { id: users.length + 1, deleted_at: null, is_active: true, ...data }; users.push(u); return withRole(u); },
      update: async ({ where, data }: any) => withRole(Object.assign(users.find((u) => u.id === where.id), data)),
    },
    employee: { findUnique: async () => null },
  };
  return { prisma, roles, users, withRole };
};

describe('Credential permission delegation (HTTP)', () => {
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
      controllers: [UsersController, RolesController, PermissionsController],
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
  const OWNER = 1;
  const KEEPER = 2;
  const ROLES = '/api/v1/roles';
  const USERS = '/api/v1/users';
  const role = (id: number) => db.roles.find((r) => r.id === id);
  const user = (id: number) => db.users.find((u) => u.id === id);

  describe('Super Admin', () => {
    it('creates a role with credential permissions', async () => {
      await as(OWNER).post(ROLES).send({ name: 'VAULT_AUDITORS', permissions: ['VIEW_CREDENTIAL_AUDIT'] }).expect(201);
      expect(db.roles.find((r) => r.name === 'VAULT_AUDITORS')?.permissions).toEqual(['VIEW_CREDENTIAL_AUDIT']);
    });

    it('grants and revokes credential permissions on a role', async () => {
      await as(OWNER).patch(`${ROLES}/3`).send({ permissions: ['VIEW_TASKS', 'MANAGE_CREDENTIALS'] }).expect(200);
      expect(role(3).permissions).toEqual(['VIEW_TASKS', 'MANAGE_CREDENTIALS']);
      await as(OWNER).patch(`${ROLES}/4`).send({ permissions: ['VIEW_TASKS'] }).expect(200);
      expect(role(4).permissions).toEqual(['VIEW_TASKS']);
    });

    it('assigns and removes a credential role on a user', async () => {
      await as(OWNER).patch(`${USERS}/3`).send({ role: 4 }).expect(200);
      expect(user(3).role_id).toBe(4);
      await as(OWNER).patch(`${USERS}/4`).send({ role: 3 }).expect(200);
      expect(user(4).role_id).toBe(3);
    });

    it('sees credential permissions as assignable in the catalog', async () => {
      const res = await as(OWNER).get('/api/v1/permissions').expect(200);
      const credential = res.body.permissions.filter((p: any) => CREDENTIALS.includes(p.id));
      expect(credential.map((p: any) => p.assignable)).toEqual([true, true, true]);
    });
  });

  describe('non-super role manager holding every credential permission', () => {
    it('cannot create a role with a credential permission', async () => {
      const res = await as(KEEPER).post(ROLES).send({ name: 'SHADOW_VAULT', permissions: ['VIEW_TASKS', 'REVEAL_CREDENTIALS'] }).expect(403);
      expect(res.body.message).toContain('Only Super Admins can grant or revoke credential permissions: REVEAL_CREDENTIALS');
      expect(db.roles.some((r) => r.name === 'SHADOW_VAULT')).toBe(false);
    });

    it('cannot add a credential permission to a role', async () => {
      await as(KEEPER).patch(`${ROLES}/3`).send({ permissions: ['VIEW_TASKS', 'reveal_credentials'] }).expect(403);
      expect(role(3).permissions).toEqual(['VIEW_TASKS']);
    });

    it('cannot remove a credential permission from a role', async () => {
      const res = await as(KEEPER).patch(`${ROLES}/4`).send({ permissions: ['VIEW_TASKS'] }).expect(403);
      expect(res.body.message).toContain('REVEAL_CREDENTIALS');
      expect(role(4).permissions).toEqual(['VIEW_TASKS', 'REVEAL_CREDENTIALS']);
    });

    it('can still edit a credential role without changing its credential permissions', async () => {
      await as(KEEPER).patch(`${ROLES}/4`).send({ description: 'Vault readers', permissions: ['REVEAL_CREDENTIALS', 'VIEW_TASKS', 'MANAGE_LEADS'] }).expect(200);
      expect(role(4).description).toBe('Vault readers');
      expect(role(4).permissions).toEqual(['REVEAL_CREDENTIALS', 'VIEW_TASKS', 'MANAGE_LEADS']);
    });

    it('sees credential permissions as not assignable, unrelated held ones as assignable', async () => {
      const res = await as(KEEPER).get('/api/v1/permissions').expect(200);
      const assignable = Object.fromEntries(res.body.permissions.map((p: any) => [p.id, p.assignable]));
      expect(CREDENTIALS.map((id) => assignable[id])).toEqual([false, false, false]);
      expect(assignable.MANAGE_LEADS).toBe(true);
      expect(assignable.MANAGE_SETTINGS).toBe(false);
    });

    it('cannot create a user with a credential role', async () => {
      const res = await as(KEEPER).post(USERS).send({ username: 'newbie', email: 'n@x.test', password: 'Secret#123', role: 4 }).expect(403);
      expect(res.body.role).toContain('grants credential permissions: REVEAL_CREDENTIALS');
      expect(db.users.some((u) => u.username === 'newbie')).toBe(false);
    });

    it('cannot assign a credential role to a user', async () => {
      await as(KEEPER).patch(`${USERS}/3`).send({ role: 4 }).expect(403);
      expect(user(3).role_id).toBe(3);
    });

    it('cannot revoke credential access by re-roling, clearing, deactivating or deleting the holder', async () => {
      await as(KEEPER).patch(`${USERS}/4`).send({ role: 3 }).expect(403);
      await as(KEEPER).patch(`${USERS}/4`).send({ role: null }).expect(403);
      await as(KEEPER).patch(`${USERS}/4`).send({ is_active: false }).expect(403);
      await as(KEEPER).delete(`${USERS}/4`).expect(403);
      expect(user(4)).toMatchObject({ role_id: 4, is_active: true, deleted_at: null });
    });

    it('cannot take over a credential holder by resetting their password or email', async () => {
      await as(KEEPER).patch(`${USERS}/4`).send({ password: 'Takeover#1' }).expect(403);
      await as(KEEPER).patch(`${USERS}/4`).send({ email: 'mine@x.test' }).expect(403);
      expect(user(4).email).toBe('v@x.test');
    });

    it('can still edit non-access fields of a credential holder', async () => {
      await as(KEEPER).patch(`${USERS}/4`).send({ name: 'Viewer Renamed' }).expect(200);
      expect(user(4).name).toBe('Viewer Renamed');
    });
  });

  describe('unrelated delegation rules are unchanged', () => {
    it('a non-super manager still grants and assigns unrelated permissions they hold', async () => {
      await as(KEEPER).patch(`${ROLES}/3`).send({ permissions: ['VIEW_TASKS', 'MANAGE_LEADS'] }).expect(200);
      await as(KEEPER).patch(`${USERS}/3`).send({ role: 5 }).expect(200);
      expect(user(3).role_id).toBe(5);
    });

    it('a non-super manager still cannot grant permissions they do not hold', async () => {
      const res = await as(KEEPER).patch(`${ROLES}/3`).send({ permissions: ['VIEW_TASKS', 'MANAGE_SETTINGS'] }).expect(403);
      expect(res.body.message).toBe('You cannot grant permissions you do not have: MANAGE_SETTINGS.');
    });

    it('self role changes and own-role edits stay blocked', async () => {
      await as(KEEPER).patch(`${USERS}/2`).send({ role: 3 }).expect(403);
      await as(KEEPER).patch(`${ROLES}/2`).send({ description: 'mine' }).expect(403);
    });
  });
});
