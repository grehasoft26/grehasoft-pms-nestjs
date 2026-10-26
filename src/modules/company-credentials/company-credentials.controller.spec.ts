import * as nodeCrypto from 'crypto';
import { Test } from '@nestjs/testing';
import { CanActivate, ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as request from 'supertest';
import { CompanyCredentialsController } from './company-credentials.controller';
import { CompanyCredentialsService } from './company-credentials.service';
import { PrismaService } from '../../core/prisma.service';
import { EncryptionService } from '../../core/encryption.service';
import { CredentialCryptoService } from '../../core/credential-crypto.service';
import { CredentialAuditService } from '../credential-audit/credential-audit.service';
import { CredentialAuditController } from '../credential-audit/credential-audit.controller';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';

/**
 * HTTP-level tests: real controllers, services, CredentialCryptoService and PermissionsGuard;
 * JWT auth is replaced by a test guard and Prisma by an in-memory store whose $transaction
 * rolls back on error like the database.
 */
const USERS: Record<string, any> = {
  superadmin: { id: 1, username: 'owner', role: { name: 'SUPER_ADMIN', permissions: [] } },
  infra: { id: 2, username: 'ops', role: { name: 'OPS', permissions: ['MANAGE_INFRASTRUCTURE'] } },
  member: { id: 3, username: 'member', role: { name: 'TEAM_MEMBER', permissions: ['VIEW_DASHBOARD', 'VIEW_TASKS'] } },
  client: { id: 4, username: 'client', role: { name: 'CLIENT', permissions: [] } },
  manager: { id: 5, username: 'manager', role: { name: 'VAULT_MANAGER', permissions: ['MANAGE_CREDENTIALS'] } },
  revealer: { id: 6, username: 'revealer', role: { name: 'VAULT_READER', permissions: ['REVEAL_CREDENTIALS'] } },
  auditor: { id: 7, username: 'auditor', role: { name: 'VAULT_AUDITOR', permissions: ['VIEW_CREDENTIAL_AUDIT'] } },
};

const ENV: Record<string, string> = {
  CREDENTIAL_KEYS: `1:${nodeCrypto.randomBytes(32).toString('base64')}`,
  CREDENTIAL_ACTIVE_KEY_VERSION: '1',
  SECRET_KEY: 'http-test-secret',
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
  let audits: any[] = [];
  let nextId = 1;
  const matches = (row: any, where: any = {}) => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.category && row.category !== where.category) return false;
    if (where.action && row.action !== where.action) return false;
    if (where.credential_id !== undefined && row.credential_id !== where.credential_id) return false;
    if (where.OR) {
      return where.OR.some((cond: any) => {
        const [field, filter] = Object.entries(cond)[0] as [string, any];
        return String(row[field] ?? '').toLowerCase().includes(String(filter.contains).toLowerCase());
      });
    }
    return true;
  };
  const prisma: any = {
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
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.entries(data).forEach(([k, v]) => {
          if (v !== undefined) row[k] = v;
        });
        return { ...row };
      }),
      delete: jest.fn(async ({ where }: any) => {
        rows = rows.filter((r) => r.id !== where.id);
      }),
    },
    credentialAuditLog: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: audits.length + 1, created_at: new Date(), ...data };
        audits.push(row);
        return row;
      }),
      count: jest.fn(async ({ where }: any = {}) => audits.filter((a) => matches(a, where)).length),
      findMany: jest.fn(async ({ where, skip = 0, take }: any = {}) =>
        audits.filter((a) => matches(a, where)).reverse().slice(skip, take ? skip + take : undefined),
      ),
    },
    $transaction: jest.fn(async (fn: any) => {
      const snapshot = { rows: rows.map((r) => ({ ...r })), audits: [...audits], nextId };
      try {
        return await fn(prisma);
      } catch (error) {
        ({ rows, audits, nextId } = snapshot);
        throw error;
      }
    }),
    rows: () => rows,
    audits: () => audits,
  };
  return prisma;
};

describe('CompanyCredentialsController (HTTP)', () => {
  let app: INestApplication;
  let prisma: ReturnType<typeof createInMemoryPrisma>;
  let crypto: CredentialCryptoService;

  const api = '/api/v1/infrastructure/company-credentials';

  beforeEach(async () => {
    prisma = createInMemoryPrisma();
    const moduleRef = await Test.createTestingModule({
      controllers: [CompanyCredentialsController, CredentialAuditController],
      providers: [
        CompanyCredentialsService,
        CredentialCryptoService,
        CredentialAuditService,
        { provide: ConfigService, useValue: { get: (k: string) => ENV[k] } },
        { provide: PrismaService, useValue: prisma },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestAuthGuard)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    crypto = moduleRef.get(CredentialCryptoService);
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
  const createAsSuper = async (body: any) => (await as('superadmin').post(api).send(body).expect(201)).body;

  describe('permissions', () => {
    it('rejects unauthenticated requests with 401', async () => {
      await request(app.getHttpServer()).get(api).expect(401);
      await request(app.getHttpServer()).post(`${api}/1/reveal`).expect(401);
    });

    it.each(['member', 'client'])('rejects %s users with 403', async (user) => {
      await as(user).get(api).expect(403);
      await as(user).post(api).send({ name: 'X' }).expect(403);
      await as(user).delete(`${api}/1`).expect(403);
      expect(prisma.companyCredential.create).not.toHaveBeenCalled();
    });

    it('MANAGE_CREDENTIALS manages records but cannot reveal', async () => {
      const created = await as('manager').post(api).send({ name: 'Slack', password: 's1' }).expect(201);
      await as('manager').get(api).expect(200);
      await as('manager').patch(`${api}/${created.body.id}`).send({ notes: 'n' }).expect(200);
      await as('manager').post(`${api}/${created.body.id}/reveal`).expect(403);
      await as('manager').delete(`${api}/${created.body.id}`).expect(204);
    });

    it('REVEAL_CREDENTIALS reads and reveals but cannot write', async () => {
      const { id } = await createAsSuper({ name: 'Gmail', password: 'mail-secret' });
      await as('revealer').get(api).expect(200);
      await as('revealer').get(`${api}/${id}`).expect(200);
      await as('revealer').post(`${api}/${id}/reveal`).expect(200);
      await as('revealer').post(api).send({ name: 'X' }).expect(403);
      await as('revealer').patch(`${api}/${id}`).send({ password: 'mine' }).expect(403);
      await as('revealer').delete(`${api}/${id}`).expect(403);
    });

    it('MANAGE_INFRASTRUCTURE keeps read access during the transition only', async () => {
      const { id } = await createAsSuper({ name: 'Gmail', password: 'mail-secret' });
      await as('infra').get(api).expect(200);
      await as('infra').get(`${api}/${id}`).expect(200);
      await as('infra').post(api).send({ name: 'X' }).expect(403);
      await as('infra').patch(`${api}/${id}`).send({ notes: 'x' }).expect(403);
      await as('infra').delete(`${api}/${id}`).expect(403);
      await as('infra').post(`${api}/${id}/reveal`).expect(403);
    });

    it('super admins can do everything (existing bypass)', async () => {
      const { id } = await createAsSuper({ name: 'Gmail', password: 'mail-secret' });
      await as('superadmin').get(api).expect(200);
      await as('superadmin').post(`${api}/${id}/reveal`).expect(200);
    });
  });

  describe('CRUD flow', () => {
    it('creates, views, edits, searches and deletes a credential without exposing secrets', async () => {
      const created = await as('manager')
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

      // Stored as gcm1 bound to this record, never plaintext
      const stored = prisma.rows()[0].password;
      expect(stored).toMatch(/^gcm1:1:/);
      expect(stored).not.toContain('h0st-pass');
      expect(crypto.decrypt(stored, { table: 'company_credentials', field: 'password', recordId: id })).toBe('h0st-pass');

      const viewed = await as('manager').get(`${api}/${id}`).expect(200);
      expect(viewed.body.password).toBeUndefined();
      expect(viewed.body.provider).toBe('Hostinger');

      const edited = await as('manager').patch(`${api}/${id}`).send({ notes: 'Moved to VPS' }).expect(200);
      expect(edited.body.notes).toBe('Moved to VPS');
      expect(edited.body.has_password).toBe(true);

      await as('manager').put(`${api}/${id}`).send({ name: 'Hostinger VPS' }).expect(200);

      const list = await as('revealer').get(`${api}?search=vps`).expect(200);
      expect(list.body.count).toBe(1);
      expect(list.body.results[0].name).toBe('Hostinger VPS');

      const none = await as('manager').get(`${api}?search=nomatch`).expect(200);
      expect(none.body.count).toBe(0);

      for (const body of [created.body, viewed.body, edited.body, list.body]) {
        expect(JSON.stringify(body)).not.toMatch(/h0st-pass|gcm1/);
      }

      await as('manager').delete(`${api}/${id}`).expect(204);
      await as('manager').get(`${api}/${id}`).expect(404);
    });

    it('returns the existing pagination response format', async () => {
      for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) {
        await createAsSuper({ name });
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
      await as('superadmin').post(`${api}/abc/reveal`).expect(400);
    });

    it('rolls back the new row when encryption fails, so no plaintext is stored', async () => {
      jest.spyOn(crypto, 'encrypt').mockImplementation(() => {
        throw new Error('encryption failure');
      });
      await as('manager').post(api).send({ name: 'Broken', password: 'never-stored' }).expect(500);
      expect(prisma.rows()).toEqual([]);
      expect(prisma.audits()).toEqual([]);
    });
  });

  describe('password reveal', () => {
    let id: number;

    beforeEach(async () => {
      id = (await createAsSuper({ name: 'Gmail', password: 'mail-secret' })).id;
    });

    it('returns the plaintext with Cache-Control: no-store and audits REVEAL', async () => {
      const res = await as('revealer').post(`${api}/${id}/reveal`).set('User-Agent', 'jest-agent').expect(200);
      expect(res.body).toEqual({ password: 'mail-secret' });
      expect(res.headers['cache-control']).toBe('no-store');

      const reveal = prisma.audits().find((a: any) => a.action === 'REVEAL');
      expect(reveal).toMatchObject({ actor_id: 6, actor_username: 'revealer', credential_type: 'company', credential_id: id, user_agent: 'jest-agent' });
      expect(reveal.ip_address).toBeTruthy();
    });

    it('audits denied attempts and never includes secrets in audit rows', async () => {
      await as('manager').post(`${api}/${id}/reveal`).expect(403);
      await as('member').post(`${api}/${id}/reveal`).expect(403);
      await as('revealer').post(`${api}/${id}/reveal`).expect(200);

      expect(prisma.audits().map((a: any) => [a.actor_username, a.action])).toEqual([
        ['owner', 'CREATE'],
        ['manager', 'REVEAL_DENIED'],
        ['member', 'REVEAL_DENIED'],
        ['revealer', 'REVEAL'],
      ]);
      expect(JSON.stringify(prisma.audits())).not.toMatch(/mail-secret|gcm1/);
    });

    it('a denied reveal looks the same whether or not the record exists', async () => {
      const existing = await as('member').post(`${api}/${id}/reveal`).expect(403);
      const missing = await as('member').post(`${api}/9999/reveal`).expect(403);
      expect(existing.body).toEqual(missing.body);
    });

    it('the old GET password endpoint no longer exists', async () => {
      await as('superadmin').get(`${api}/${id}/password`).expect(404);
    });

    it('keeps the password when editing without a new one', async () => {
      await as('manager').patch(`${api}/${id}`).send({ name: 'Gmail Ops', password: '' }).expect(200);

      const res = await as('revealer').post(`${api}/${id}/reveal`).expect(200);
      expect(res.body.password).toBe('mail-secret');
    });

    it('changes and clears the password, auditing each secret change', async () => {
      await as('manager').patch(`${api}/${id}`).send({ password: 'rotated' }).expect(200);
      expect((await as('revealer').post(`${api}/${id}/reveal`)).body.password).toBe('rotated');

      const cleared = await as('manager').patch(`${api}/${id}`).send({ clear_password: true }).expect(200);
      expect(cleared.body.has_password).toBe(false);
      expect((await as('revealer').post(`${api}/${id}/reveal`)).body.password).toBe('');

      expect(prisma.audits().filter((a: any) => a.action === 'UPDATE_SECRET')).toHaveLength(2);
    });

    it('reads values written by the previous EncryptionService', async () => {
      prisma.rows()[0].password = new EncryptionService({ get: () => ENV.SECRET_KEY } as any).encrypt('legacy-secret');
      const res = await as('revealer').post(`${api}/${id}/reveal`).expect(200);
      expect(res.body.password).toBe('legacy-secret');
    });

    it('refuses a value that cannot be decrypted safely (422) without returning it', async () => {
      prisma.rows()[0].password = 'plaintext-left-by-old-fallback';
      const res = await as('revealer').post(`${api}/${id}/reveal`).expect(422);
      expect(JSON.stringify(res.body)).not.toContain('plaintext-left-by-old-fallback');
    });
  });

  describe('credential audit API', () => {
    it('requires VIEW_CREDENTIAL_AUDIT and returns only credential audit rows', async () => {
      const { id } = await createAsSuper({ name: 'Gmail', password: 'mail-secret' });
      await as('revealer').post(`${api}/${id}/reveal`).expect(200);

      const res = await as('auditor').get('/api/v1/credential-audit?credential_type=company').expect(200);
      expect(res.body.count).toBe(2);
      expect(res.body.results.map((r: any) => r.action)).toEqual(['REVEAL', 'CREATE']);
      expect(JSON.stringify(res.body)).not.toMatch(/mail-secret|gcm1/);

      await as('superadmin').get('/api/v1/credential-audit').expect(200);
      for (const user of ['manager', 'revealer', 'infra', 'member', 'client']) {
        await as(user).get('/api/v1/credential-audit').expect(403);
      }
    });

    it('validates filters', async () => {
      await as('auditor').get('/api/v1/credential-audit?credential_type=users').expect(400);
      await as('auditor').get('/api/v1/credential-audit?action=DROP').expect(400);
      await as('auditor').get('/api/v1/credential-audit?credential_id=abc').expect(400);
    });
  });
});
