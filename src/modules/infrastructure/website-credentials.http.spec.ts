import * as nodeCrypto from 'crypto';
import { Test } from '@nestjs/testing';
import { CanActivate, ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as request from 'supertest';
import { CredentialsController } from './infrastructure.controller';
import { WebsiteCredentialsService } from './website-credentials.service';
import { PrismaService } from '../../core/prisma.service';
import { CredentialCryptoService } from '../../core/credential-crypto.service';
import { CredentialAuditService } from '../credential-audit/credential-audit.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';

/**
 * Client (website) credentials over HTTP: real controller, service, PermissionsGuard,
 * CredentialCryptoService and audit service; Prisma is an in-memory store with project
 * memberships and a $transaction that rolls back on error.
 */
const role = (name: string, permissions: string[]) => ({ name, permissions, deleted_at: null });
const USERS: Record<string, any> = {
  super: { id: 1, username: 'owner', role: role('SUPER_ADMIN', []) },
  ops: { id: 2, username: 'ops', role: role('OPS', ['MANAGE_INFRASTRUCTURE']) }, // member of project 10
  opsOther: { id: 3, username: 'ops-other', role: role('OPS', ['MANAGE_INFRASTRUCTURE']) }, // member of project 20 only
  revealer: { id: 4, username: 'revealer', role: role('VAULT_READER', ['REVEAL_CREDENTIALS']) }, // member of project 10
  revealerOutside: { id: 5, username: 'revealer-outside', role: role('VAULT_READER', ['REVEAL_CREDENTIALS']) }, // no projects
  member: { id: 6, username: 'member', role: role('TEAM_MEMBER', ['VIEW_TASKS']) }, // member of project 10
  manager: { id: 7, username: 'manager', role: role('VAULT_MANAGER', ['MANAGE_CREDENTIALS']) }, // member of project 10
};
const MEMBERSHIP: Record<number, number[]> = { 2: [10], 3: [20], 4: [10], 6: [10], 7: [10] };
const ENV: Record<string, string> = {
  CREDENTIAL_KEYS: `1:${nodeCrypto.randomBytes(32).toString('base64')}`,
  CREDENTIAL_ACTIVE_KEY_VERSION: '1',
  CREDENTIAL_LEGACY_DJANGO_SECRET_KEY: 'test-only-django-secret-not-a-real-key',
};
// Django Fernet fixture from credential-crypto.service.spec (made-up secret above)
const FERNET = 'gAAAAABq2aizYmoIVxLZHKAecPVpNyXWrlAAhLAkbcUXXynTqPjYHyZ1diN0lElEy7CBIWMuGJSJhM-rdDmczHUR7gJ8b8cpwHpQ2-VGmqdm7JEQMxsRM5c=';
// Static-key value for 'legacy-static-pass' as the former InfrastructureService helper wrote it
// (helper removed in Stage 6; the value is verified in credential-crypto.service.spec)
const STATIC_LEGACY_PASS = '390423887eaa4e0511c6b96b1126549de0c8fe74f32ccc31b31978b7600f8577';
const PASSWORDS = ['admin_password', 'cpanel_password', 'ftp_password', 'client_email_password', 'business_email_password'];

class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const user = USERS[req.headers['x-test-user']];
    if (!user) throw new UnauthorizedException();
    req.user = user;
    return true;
  }
}

const createInMemoryPrisma = () => {
  let rows: any[] = [];
  let audits: any[] = [];
  let nextId = 1;
  const PROJECTS: Record<number, string> = { 10: 'Acme', 20: 'Globex' };
  const DOMAINS: Record<number, any> = { 100: { id: 100, project_id: 10, domain_name: 'acme.test' }, 200: { id: 200, project_id: 20, domain_name: 'globex.test' } };
  const withRelations = (r: any) => r && { ...r, project: { id: r.project_id, name: PROJECTS[r.project_id] }, domain: { id: r.domain_id, domain_name: DOMAINS[r.domain_id]?.domain_name } };
  const contains = (value: any, term: string) => String(value ?? '').toLowerCase().includes(term.toLowerCase());
  const matches = (r: any, where: any = {}) => {
    if (where.project_id?.in && !where.project_id.in.includes(r.project_id)) return false;
    if (where.OR) {
      return where.OR.some((cond: any) => {
        const [field, filter]: [string, any] = Object.entries(cond)[0] as any;
        if (field === 'project') return contains(PROJECTS[r.project_id], filter.name.contains);
        if (field === 'domain') return contains(DOMAINS[r.domain_id]?.domain_name, filter.domain_name.contains);
        if (filter.mode) throw new Error('Unknown argument `mode`');
        if (!(field in r)) throw new Error(`Unknown argument \`${field}\``);
        return contains(r[field], filter.contains);
      });
    }
    return true;
  };
  const prisma: any = {
    projectMember: { findMany: jest.fn(async ({ where }: any) => (MEMBERSHIP[where.user_id] || []).map((project_id) => ({ project_id }))) },
    domain: { findUnique: jest.fn(async ({ where }: any) => DOMAINS[where.id] ?? null) },
    websiteCredential: {
      findMany: jest.fn(async ({ where, skip = 0, take }: any = {}) =>
        rows.filter((r) => matches(r, where)).sort((a, b) => b.id - a.id).slice(skip, take ? skip + take : undefined).map(withRelations)),
      count: jest.fn(async ({ where }: any = {}) => rows.filter((r) => matches(r, where)).length),
      findUnique: jest.fn(async ({ where }: any) => withRelations(rows.find((r) => r.id === where.id)) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: nextId++, created_at: new Date(), admin_url: '', admin_username: '', cpanel_url: '', cpanel_username: '', ftp_host: '', ftp_username: '', client_email: '', business_email: null, ...data };
        rows.push(row);
        return withRelations({ ...row });
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.entries(data).forEach(([k, v]) => { if (v !== undefined) row[k] = v; });
        return withRelations({ ...row });
      }),
      delete: jest.fn(async ({ where }: any) => { rows = rows.filter((r) => r.id !== where.id); }),
    },
    credentialAuditLog: { create: jest.fn(async ({ data }: any) => { audits.push({ id: audits.length + 1, ...data }); return data; }) },
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

describe('Client credentials (HTTP)', () => {
  let app: INestApplication;
  let prisma: any;
  let crypto: CredentialCryptoService;
  const api = '/api/v1/infrastructure/credentials';

  beforeEach(async () => {
    prisma = createInMemoryPrisma();
    const moduleRef = await Test.createTestingModule({
      controllers: [CredentialsController],
      providers: [
        WebsiteCredentialsService,
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
    delete: (url: string) => request(app.getHttpServer()).delete(url).set('x-test-user', user),
  });
  const SECRETS: Record<string, string> = {
    admin_password: 'wp-Secret-1',
    cpanel_password: 'cp-Secret-2',
    ftp_password: 'ftp-Secret-3',
    client_email_password: 'mail-Secret-4',
    business_email_password: 'biz-Secret-5',
  };
  const createFull = async (user = 'ops') =>
    (await as(user).post(api).send({ project: 10, domain: 100, admin_url: 'https://acme.test/wp-admin', admin_username: 'AcmeAdmin', business_email: 'biz@acme.test', ...SECRETS }).expect(201)).body;
  const noSecrets = (body: any) => {
    const text = JSON.stringify(body);
    return Object.values(SECRETS).every((s) => !text.includes(s)) && !text.includes('gcm1');
  };

  describe('encryption and responses', () => {
    it('stores each password as gcm1 bound to table, field and record; responses carry only the mask', async () => {
      const created = await createFull();
      expect(noSecrets(created)).toBe(true);
      for (const f of PASSWORDS) expect(created[f]).toBe('••••••••');

      const row = prisma.rows()[0];
      for (const f of PASSWORDS) {
        expect(row[f]).toMatch(/^gcm1:1:/);
        expect(crypto.decrypt(row[f], { table: 'website_credentials', field: f, recordId: created.id })).toBe(SECRETS[f]);
      }
      // A value moved to another field or record does not decrypt
      expect(() => crypto.decrypt(row.admin_password, { table: 'website_credentials', field: 'ftp_password', recordId: created.id })).toThrow();
      expect(() => crypto.decrypt(row.admin_password, { table: 'website_credentials', field: 'admin_password', recordId: created.id + 1 })).toThrow();
    });

    it.each(['super', 'ops', 'revealer', 'manager'])('list and detail never contain secrets or ciphertext (%s)', async (user) => {
      const { id } = await createFull();
      const list = await as(user).get(api).expect(200);
      const all = await as(user).get(`${api}?all=true`).expect(200);
      const detail = await as(user).get(`${api}/${id}`).expect(200);
      for (const body of [list.body, all.body, detail.body]) expect(noSecrets(body)).toBe(true);
      expect(detail.body.admin_password).toBe('••••••••');
    });

    it('a project member without MANAGE_INFRASTRUCTURE, MANAGE_CREDENTIALS or REVEAL_CREDENTIALS gets 403 (metadata policy B)', async () => {
      const { id } = await createFull();
      for (const url of [api, `${api}?all=true`, `${api}/${id}`]) {
        const res = await as('member').get(url).expect(403);
        expect(noSecrets(res.body)).toBe(true);
      }
    });

    it('update responses never contain secrets; the placeholder keeps a password, empty clears it', async () => {
      const { id } = await createFull();
      const before = { ...prisma.rows()[0] };
      const res = await as('ops').patch(`${api}/${id}`).send({ admin_password: '••••••••', cpanel_password: 'cp-New-6', ftp_password: '' }).expect(200);
      expect(noSecrets(res.body)).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('cp-New-6');
      const row = prisma.rows()[0];
      expect(row.admin_password).toBe(before.admin_password);
      expect(crypto.decrypt(row.cpanel_password, { table: 'website_credentials', field: 'cpanel_password', recordId: id })).toBe('cp-New-6');
      expect(row.ftp_password).toBe('');
      expect(res.body.ftp_password).toBe('');
    });

    it('rolls back the new row when encryption fails (no plaintext stored)', async () => {
      jest.spyOn(crypto, 'encrypt').mockImplementation(() => { throw new Error('encryption failure'); });
      await as('ops').post(api).send({ project: 10, domain: 100, admin_password: 'never-stored' }).expect(500);
      expect(prisma.rows()).toEqual([]);
      expect(prisma.audits()).toEqual([]);
    });
  });

  describe('reveal', () => {
    it('returns one field to REVEAL_CREDENTIALS holders with no-store, after auditing REVEAL', async () => {
      const { id } = await createFull();
      for (const f of PASSWORDS) {
        const res = await as('revealer').post(`${api}/${id}/reveal`).send({ field: f }).expect(200);
        expect(res.body).toEqual({ field: f, password: SECRETS[f] });
        expect(res.headers['cache-control']).toBe('no-store');
      }
      expect(prisma.audits().filter((a: any) => a.action === 'REVEAL')).toHaveLength(5);
      expect(prisma.audits().every((a: any) => a.credential_type === 'website')).toBe(true);
    });

    it('super admins can reveal (existing bypass)', async () => {
      const { id } = await createFull();
      await as('super').post(`${api}/${id}/reveal`).send({ field: 'ftp_password' }).expect(200);
    });

    it.each(['ops', 'manager', 'member'])('refuses %s (no REVEAL_CREDENTIALS) and audits REVEAL_DENIED', async (user) => {
      const { id } = await createFull();
      const res = await as(user).post(`${api}/${id}/reveal`).send({ field: 'admin_password' }).expect(403);
      expect(noSecrets(res.body)).toBe(true);
      expect(prisma.audits().filter((a: any) => a.action === 'REVEAL_DENIED' && a.actor_username === USERS[user].username)).toHaveLength(1);
    });

    it('refuses a revealer outside the project (404) and audits REVEAL_DENIED', async () => {
      const { id } = await createFull();
      await as('revealerOutside').post(`${api}/${id}/reveal`).send({ field: 'admin_password' }).expect(404);
      expect(prisma.audits().map((a: any) => a.action)).toEqual(['CREATE', 'REVEAL_DENIED']);
    });

    it('validates the field name', async () => {
      const { id } = await createFull();
      for (const field of [undefined, 'password', 'admin_username', '__proto__']) {
        await as('revealer').post(`${api}/${id}/reveal`).send({ field }).expect(400);
      }
      expect(prisma.audits().filter((a: any) => a.action === 'REVEAL')).toHaveLength(0);
    });

    it('does not return the secret when the REVEAL audit cannot be written', async () => {
      const { id } = await createFull();
      prisma.credentialAuditLog.create.mockRejectedValue(new Error('audit table missing'));
      const res = await as('revealer').post(`${api}/${id}/reveal`).send({ field: 'admin_password' }).expect(500);
      expect(noSecrets(res.body)).toBe(true);
    });

    it('reads legacy static-key and Django Fernet values without rewriting them', async () => {
      const { id } = await createFull();
      const staticValue = STATIC_LEGACY_PASS;
      prisma.rows()[0].admin_password = staticValue;
      prisma.rows()[0].cpanel_password = FERNET;
      expect((await as('revealer').post(`${api}/${id}/reveal`).send({ field: 'admin_password' })).body.password).toBe('legacy-static-pass');
      expect((await as('revealer').post(`${api}/${id}/reveal`).send({ field: 'cpanel_password' })).body.password).toBe('legacy-fixture-password');
      expect(prisma.rows()[0].admin_password).toBe(staticValue);
      expect(prisma.rows()[0].cpanel_password).toBe(FERNET);
    });

    it.each([
      ['plaintext', () => 'plaintext-left-behind'],
      ['a tampered gcm1 value', (s: string) => s.slice(0, -2) + (s.endsWith('A') ? 'BA' : 'AA')],
      ['a value from another field (AAD mismatch)', (_s: string, row: any) => row.ftp_password],
    ])('refuses %s with 422 and never returns it', async (_label, make: any) => {
      const { id } = await createFull();
      const row = prisma.rows()[0];
      const bad = make(row.admin_password, row);
      row.admin_password = bad;
      const res = await as('revealer').post(`${api}/${id}/reveal`).send({ field: 'admin_password' }).expect(422);
      expect(JSON.stringify(res.body)).not.toContain(bad);
      expect(prisma.audits().filter((a: any) => a.action === 'REVEAL')).toHaveLength(0);
    });
  });

  describe('project scoping on writes', () => {
    it('cannot create a credential for a project the user is not a member of (404)', async () => {
      await as('opsOther').post(api).send({ project: 10, domain: 100, admin_password: 'x' }).expect(404);
      expect(prisma.rows()).toEqual([]);
    });

    it('cannot update or delete another project\'s credential by id (404), data unchanged', async () => {
      const { id } = await createFull();
      const before = JSON.stringify(prisma.rows());
      await as('opsOther').patch(`${api}/${id}`).send({ admin_password: 'hijack', notes: 'x' }).expect(404);
      await as('opsOther').delete(`${api}/${id}`).expect(404);
      expect(JSON.stringify(prisma.rows())).toBe(before);
      expect(prisma.audits().map((a: any) => a.action)).toEqual(['CREATE']);
    });

    it('cannot move a credential into a project the user is not a member of', async () => {
      const { id } = await createFull();
      await as('ops').patch(`${api}/${id}`).send({ project: 20, domain: 200 }).expect(404);
      expect(prisma.rows()[0].project_id).toBe(10);
    });

    it('rejects a domain of another project', async () => {
      await as('super').post(api).send({ project: 10, domain: 200 }).expect(400);
    });

    it('members and super admins can still write their credentials; writes are audited', async () => {
      const { id } = await createFull('ops');
      await as('ops').patch(`${api}/${id}`).send({ ftp_password: 'rotated' }).expect(200);
      await as('super').delete(`${api}/${id}`).expect(204);
      expect(prisma.audits().map((a: any) => a.action)).toEqual(['CREATE', 'UPDATE_SECRET', 'DELETE']);
      expect(JSON.stringify(prisma.audits())).not.toMatch(/Secret|rotated|gcm1/);
    });

    it('writes still require MANAGE_INFRASTRUCTURE (unchanged)', async () => {
      const { id } = await createFull();
      await as('member').post(api).send({ project: 10, domain: 100 }).expect(403);
      await as('revealer').patch(`${api}/${id}`).send({ notes: 'x' }).expect(403);
      await as('manager').delete(`${api}/${id}`).expect(403);
    });
  });

  describe('search', () => {
    it('matches real columns and project/domain names, case-insensitively, without errors', async () => {
      await createFull();
      for (const term of ['acmeadmin', 'ACME.TEST/WP', 'globex', 'biz@acme']) {
        const res = await as('ops').get(`${api}?search=${encodeURIComponent(term)}`).expect(200);
        expect(res.body.count).toBe(term === 'globex' ? 0 : 1);
      }
      // Passwords are never searchable
      expect((await as('ops').get(`${api}?search=wp-Secret-1`).expect(200)).body.count).toBe(0);
    });
  });
});
