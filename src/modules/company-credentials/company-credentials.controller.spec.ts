import { Test } from '@nestjs/testing';
import { CanActivate, ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as request from 'supertest';
import { CompanyCredentialsController } from './company-credentials.controller';
import { CompanyCredentialsService } from './company-credentials.service';
import { PrismaService } from '../../core/prisma.service';
import { EncryptionService } from '../../core/encryption.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';

/**
 * HTTP-level tests: real controller, service, EncryptionService and PermissionsGuard;
 * JWT auth is replaced by a test guard and Prisma by an in-memory store.
 */
const USERS: Record<string, any> = {
  superadmin: { id: 1, role: { name: 'SUPER_ADMIN', permissions: [] } },
  infra: { id: 2, role: { name: 'OPS', permissions: ['MANAGE_INFRASTRUCTURE'] } },
  member: { id: 3, role: { name: 'TEAM_MEMBER', permissions: ['VIEW_DASHBOARD', 'VIEW_TASKS'] } },
  client: { id: 4, role: { name: 'CLIENT', permissions: [] } },
};

class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const user = USERS[req.headers['x-test-user']];
    if (!user) throw new UnauthorizedException('Authentication token required or invalid');
    req.user = user;
    return true;
  }
}

const createInMemoryPrisma = () => {
  let rows: any[] = [];
  let nextId = 1;
  const matches = (row: any, where: any = {}) => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.category && row.category !== where.category) return false;
    if (where.OR) {
      return where.OR.some((cond: any) => {
        const [field, filter] = Object.entries(cond)[0] as [string, any];
        return String(row[field] ?? '').toLowerCase().includes(String(filter.contains).toLowerCase());
      });
    }
    return true;
  };
  return {
    companyCredential: {
      findMany: jest.fn(async ({ where, skip = 0, take }: any = {}) => {
        const found = rows.filter((r) => matches(r, where)).sort((a, b) => b.id - a.id);
        return found.slice(skip, take ? skip + take : undefined);
      }),
      count: jest.fn(async ({ where }: any = {}) => rows.filter((r) => matches(r, where)).length),
      findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: nextId++, created_at: new Date(), updated_at: new Date(), ...data };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.entries(data).forEach(([k, v]) => {
          if (v !== undefined) row[k] = v;
        });
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        rows = rows.filter((r) => r.id !== where.id);
      }),
    },
    rows: () => rows,
  };
};

describe('CompanyCredentialsController (HTTP)', () => {
  let app: INestApplication;
  let prisma: ReturnType<typeof createInMemoryPrisma>;

  const api = '/api/v1/infrastructure/company-credentials';

  beforeEach(async () => {
    prisma = createInMemoryPrisma();
    const moduleRef = await Test.createTestingModule({
      controllers: [CompanyCredentialsController],
      providers: [
        CompanyCredentialsService,
        EncryptionService,
        { provide: ConfigService, useValue: { get: () => 'http-test-secret' } },
        { provide: PrismaService, useValue: prisma },
      ],
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

  const as = (user: string) => ({
    get: (url: string) => request(app.getHttpServer()).get(url).set('x-test-user', user),
    post: (url: string) => request(app.getHttpServer()).post(url).set('x-test-user', user),
    patch: (url: string) => request(app.getHttpServer()).patch(url).set('x-test-user', user),
    put: (url: string) => request(app.getHttpServer()).put(url).set('x-test-user', user),
    delete: (url: string) => request(app.getHttpServer()).delete(url).set('x-test-user', user),
  });

  describe('permissions', () => {
    it('rejects unauthenticated requests with 401', async () => {
      await request(app.getHttpServer()).get(api).expect(401);
    });

    it.each(['member', 'client'])('rejects %s users without MANAGE_INFRASTRUCTURE with 403', async (user) => {
      await as(user).get(api).expect(403);
      await as(user).post(api).send({ name: 'X' }).expect(403);
      await as(user).delete(`${api}/1`).expect(403);
      expect(prisma.companyCredential.create).not.toHaveBeenCalled();
    });

    it('allows users with MANAGE_INFRASTRUCTURE', async () => {
      await as('infra').get(api).expect(200);
      await as('infra').post(api).send({ name: 'Slack' }).expect(201);
    });

    it('allows super admins', async () => {
      await as('superadmin').get(api).expect(200);
    });
  });

  describe('CRUD flow', () => {
    it('creates, views, edits, searches and deletes a credential', async () => {
      const created = await as('superadmin')
        .post(api)
        .send({
          name: 'Hostinger Panel',
          category: 'HOSTING',
          provider: 'Hostinger',
          login_url: 'https://hpanel.hostinger.com',
          username: 'admin@grehasoft.com',
          password: 'h0st-pass',
          notes: 'Shared hosting',
        })
        .expect(201);

      expect(created.body).toMatchObject({ name: 'Hostinger Panel', category: 'HOSTING', has_password: true });
      expect(created.body.password).toBeUndefined();
      const id = created.body.id;

      // Stored encrypted, not plaintext
      expect(prisma.rows()[0].password).not.toContain('h0st-pass');

      const viewed = await as('infra').get(`${api}/${id}`).expect(200);
      expect(viewed.body.password).toBeUndefined();
      expect(viewed.body.provider).toBe('Hostinger');

      const edited = await as('infra').patch(`${api}/${id}`).send({ notes: 'Moved to VPS' }).expect(200);
      expect(edited.body.notes).toBe('Moved to VPS');
      expect(edited.body.has_password).toBe(true);

      await as('infra').put(`${api}/${id}`).send({ name: 'Hostinger VPS' }).expect(200);

      const list = await as('infra').get(`${api}?search=vps`).expect(200);
      expect(list.body.count).toBe(1);
      expect(list.body.results[0].name).toBe('Hostinger VPS');
      expect(list.body.results[0].password).toBeUndefined();

      const none = await as('infra').get(`${api}?search=nomatch`).expect(200);
      expect(none.body.count).toBe(0);

      await as('infra').delete(`${api}/${id}`).expect(204);
      await as('infra').get(`${api}/${id}`).expect(404);
    });

    it('returns the existing pagination response format', async () => {
      for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) {
        await as('superadmin').post(api).send({ name }).expect(201);
      }

      const page1 = await as('superadmin').get(api).expect(200);
      expect(Object.keys(page1.body).sort()).toEqual(['count', 'next', 'previous', 'results']);
      expect(page1.body.count).toBe(6);
      expect(page1.body.results).toHaveLength(5);
      expect(page1.body.next).toContain('page=2');

      const all = await as('superadmin').get(`${api}?all=true`).expect(200);
      expect(Array.isArray(all.body)).toBe(true);
      expect(all.body).toHaveLength(6);
    });

    it('returns 400 for validation errors', async () => {
      const res = await as('superadmin').post(api).send({ name: '' }).expect(400);
      expect(res.body.message).toBe('Credential name is required.');

      await as('superadmin').post(api).send({ name: 'X', login_url: 'not-a-url' }).expect(400);
      await as('superadmin').post(api).send({ name: 'X', category: 'UNKNOWN' }).expect(400);
    });

    it('returns 400 for a non-numeric id', async () => {
      await as('superadmin').get(`${api}/abc`).expect(400);
    });
  });

  describe('password reveal', () => {
    let id: number;

    beforeEach(async () => {
      const res = await as('superadmin').post(api).send({ name: 'Gmail', password: 'mail-secret' }).expect(201);
      id = res.body.id;
    });

    it('returns the plaintext password to super admins', async () => {
      const res = await as('superadmin').get(`${api}/${id}/password`).expect(200);
      expect(res.body).toEqual({ password: 'mail-secret' });
    });

    it('refuses MANAGE_INFRASTRUCTURE users who are not super admins', async () => {
      await as('infra').get(`${api}/${id}/password`).expect(403);
    });

    it('refuses users without the permission', async () => {
      await as('member').get(`${api}/${id}/password`).expect(403);
    });

    it('keeps the password when editing without a new one', async () => {
      await as('infra').patch(`${api}/${id}`).send({ name: 'Gmail Ops', password: '' }).expect(200);

      const res = await as('superadmin').get(`${api}/${id}/password`).expect(200);
      expect(res.body.password).toBe('mail-secret');
    });

    it('changes and clears the password', async () => {
      await as('infra').patch(`${api}/${id}`).send({ password: 'rotated' }).expect(200);
      expect((await as('superadmin').get(`${api}/${id}/password`)).body.password).toBe('rotated');

      const cleared = await as('infra').patch(`${api}/${id}`).send({ clear_password: true }).expect(200);
      expect(cleared.body.has_password).toBe(false);
      expect((await as('superadmin').get(`${api}/${id}/password`)).body.password).toBe('');
    });
  });
});
