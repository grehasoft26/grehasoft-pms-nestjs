import * as nodeCrypto from 'crypto';
import { Test } from '@nestjs/testing';
import { CanActivate, ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as request from 'supertest';
import { SeoCredentialsController, SeoDailyLogsController } from './seo.controller';
import { SeoService } from './seo.service';
import { PrismaService } from '../../core/prisma.service';
import { CredentialCryptoService } from '../../core/credential-crypto.service';
import { CredentialAuditService } from '../credential-audit/credential-audit.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';

/**
 * SEO credentials and SEO work-log item passwords over HTTP: real controllers, SeoService,
 * CredentialCryptoService and audit service over an in-memory store whose $transaction rolls back.
 * Website 3 is assigned to `exec`; log 5 belongs to `exec`.
 */
const role = (name: string, permissions: string[] = []) => ({ name, permissions, deleted_at: null });
const REVEAL = ['REVEAL_CREDENTIALS'];
const USERS: Record<string, any> = {
  super: { id: 1, username: 'owner', role: role('SUPER_ADMIN') },
  manager: { id: 10, username: 'manager', role: role('SEO_MANAGER', REVEAL) },
  managerNoReveal: { id: 11, username: 'manager-noreveal', role: role('SEO_MANAGER') },
  exec: { id: 20, username: 'exec', role: role('SEO_EXECUTIVE', REVEAL) },
  execNoReveal: { id: 22, username: 'exec-noreveal', role: role('SEO_EXECUTIVE') },
  otherExec: { id: 21, username: 'other-exec', role: role('SEO_EXECUTIVE', REVEAL) },
  client: { id: 40, username: 'client', client_id: 1, role: role('CLIENT', REVEAL) },
  member: { id: 30, username: 'member', role: role('TEAM_MEMBER', REVEAL) },
};
const ENV: Record<string, string> = {
  CREDENTIAL_KEYS: `1:${nodeCrypto.randomBytes(32).toString('base64')}`,
  CREDENTIAL_ACTIVE_KEY_VERSION: '1',
  CREDENTIAL_LEGACY_DJANGO_SECRET_KEY: 'test-only-django-secret-not-a-real-key',
};
// Frozen legacy fixtures (see credential-crypto.service.spec): static-key hex and Django Fernet
const STATIC_LEGACY = { stored: 'ac6670cc5b803f67e79153cf2cb4bbaf7342a9a1aea3a39016b19285fb188582', plaintext: 'legacy-seo-pässwörd' };
const FERNET_LEGACY = {
  stored: 'gAAAAABq2aizYmoIVxLZHKAecPVpNyXWrlAAhLAkbcUXXynTqPjYHyZ1diN0lElEy7CBIWMuGJSJhM-rdDmczHUR7gJ8b8cpwHpQ2-VGmqdm7JEQMxsRM5c=',
  plaintext: 'legacy-fixture-password',
};
const MASK = '••••••••';
const SECRET = 'seo-Secret-7!';

class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const user = USERS[req.headers['x-test-user']];
    if (!user) throw new UnauthorizedException();
    req.user = user;
    return true;
  }
}

const createPrisma = () => {
  const websites: Record<number, any> = { 3: { id: 3, client_id: 1, website_name: 'acme.test', assigned_executive_id: 20 }, 4: { id: 4, client_id: 2, website_name: 'globex.test', assigned_executive_id: 21 } };
  let creds: any[] = [];
  let logs: any[] = [];
  let items: any[] = [];
  let audits: any[] = [];
  let ids = { cred: 1, log: 1, item: 1 };
  const withLog = (l: any) =>
    l && { ...l, website: websites[l.website_id], executive: { id: l.executive_id }, items: items.filter((i) => i.work_log_id === l.id).map((i) => ({ ...i, activity_type: { id: i.activity_type_id, name: 'Profile' } })), proof_files: [] };
  const sameDay = (a: Date, b: Date) => new Date(a).getTime() === new Date(b).getTime();
  const prisma: any = {
    sEOCredential: {
      findMany: jest.fn(async ({ where }: any = {}) =>
        creds.filter((c) => !where?.website || websites[c.website_id]?.assigned_executive_id === where.website.assigned_executive_id).map((c) => ({ ...c, website: websites[c.website_id] }))),
      findUnique: jest.fn(async ({ where }: any) => {
        const c = creds.find((r) => r.id === where.id);
        return c ? { ...c, website: websites[c.website_id] } : null;
      }),
      create: jest.fn(async ({ data }: any) => { const c = { id: ids.cred++, ...data }; creds.push(c); return { ...c, website: websites[c.website_id] }; }),
      update: jest.fn(async ({ where, data }: any) => {
        const c = creds.find((r) => r.id === where.id);
        Object.entries(data).forEach(([k, v]) => { if (v !== undefined) c[k] = v; });
        return { ...c, website: websites[c.website_id] };
      }),
      delete: jest.fn(async ({ where }: any) => { creds = creds.filter((r) => r.id !== where.id); return { id: where.id }; }),
    },
    sEODailyWorkLog: {
      findFirst: jest.fn(async ({ where }: any) => logs.find((l) => l.executive_id === where.executive_id && l.website_id === where.website_id && sameDay(l.log_date, where.log_date)) ?? null),
      findUnique: jest.fn(async ({ where }: any) => withLog(logs.find((l) => l.id === where.id)) ?? null),
      create: jest.fn(async ({ data }: any) => { const l = { id: ids.log++, ...data }; logs.push(l); return { ...l }; }),
      update: jest.fn(async ({ where, data }: any) => {
        const l = logs.find((r) => r.id === where.id);
        Object.entries(data).forEach(([k, v]) => { if (v !== undefined) l[k] = v; });
        return withLog(l);
      }),
      delete: jest.fn(async ({ where }: any) => {
        logs = logs.filter((r) => r.id !== where.id);
        items = items.filter((i) => i.work_log_id !== where.id); // cascade
        return { id: where.id };
      }),
    },
    sEODailyWorkLogItem: {
      create: jest.fn(async ({ data }: any) => { const i = { id: ids.item++, ...data }; items.push(i); return { ...i }; }),
      update: jest.fn(async ({ where, data }: any) => { const i = items.find((r) => r.id === where.id); Object.assign(i, data); return { ...i }; }),
      findFirst: jest.fn(async ({ where }: any) => items.find((i) => i.id === where.id && i.work_log_id === where.work_log_id) ?? null),
      findMany: jest.fn(async ({ where }: any) => items.filter((i) => i.work_log_id === where.work_log_id && i.password !== null)),
    },
    credentialAuditLog: { create: jest.fn(async ({ data }: any) => { audits.push(data); return data; }) },
    $transaction: jest.fn(async (fn: any) => {
      const snap = JSON.stringify({ creds, logs, items, audits, ids });
      try {
        return await fn(prisma);
      } catch (error) {
        ({ creds, logs, items, audits, ids } = JSON.parse(snap));
        logs.forEach((l) => (l.log_date = new Date(l.log_date)));
        throw error;
      }
    }),
    state: () => ({ creds, logs, items, audits }),
  };
  return prisma;
};

describe('SEO credentials and work-log item passwords (HTTP)', () => {
  let app: INestApplication;
  let prisma: any;
  let crypto: CredentialCryptoService;

  beforeEach(async () => {
    prisma = createPrisma();
    const moduleRef = await Test.createTestingModule({
      controllers: [SeoCredentialsController, SeoDailyLogsController],
      providers: [
        SeoService,
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
    put: (url: string) => request(app.getHttpServer()).put(url).set('x-test-user', user),
    patch: (url: string) => request(app.getHttpServer()).patch(url).set('x-test-user', user),
    delete: (url: string) => request(app.getHttpServer()).delete(url).set('x-test-user', user),
  });
  const clean = (body: any) => !JSON.stringify(body).includes(SECRET) && !JSON.stringify(body).includes('gcm1');
  const actions = () => prisma.state().audits.map((a: any) => `${a.credential_type}:${a.action}:${a.actor_username}`);

  describe('SEO credentials', () => {
    const api = '/api/v1/seo-credentials';
    const createCred = async (website = 3, password = SECRET) =>
      (await as('manager').post(api).send({ website, platform: 'Twitter', username: 'acme', password }).expect(201)).body;

    it('stores gcm1 bound to the record; create and list never return the password', async () => {
      const created = await createCred();
      expect(created.password).toBe(MASK);
      expect(clean(created)).toBe(true);
      const stored = prisma.state().creds[0].password;
      expect(crypto.decrypt(stored, { table: 'seo_credential', field: 'password', recordId: created.id })).toBe(SECRET);
      expect(() => crypto.decrypt(stored, { table: 'seo_credential', field: 'password', recordId: created.id + 1 })).toThrow();
      for (const user of ['manager', 'exec', 'super']) {
        const list = await as(user).get(api).expect(200);
        expect(clean(list.body)).toBe(true);
        expect(list.body.find((c: any) => c.id === created.id)?.password).toBe(MASK);
      }
      expect(actions()).toEqual(['seo:CREATE:manager']);
    });

    it('keeps NOT NULL: a credential without a password is stored as \'\'', async () => {
      const created = await createCred(3, '');
      expect(prisma.state().creds[0].password).toBe('');
      expect(created.password).toBe('');
    });

    it('update: omitted, null or mask keeps; \'\' clears to \'\'; a new value replaces; never echoed', async () => {
      const { id } = await createCred();
      const stored = prisma.state().creds[0].password;
      for (const body of [{ platform: 'X' }, { password: null }, { password: MASK }]) {
        const res = await as('manager').put(`${api}/${id}`).send(body).expect(200);
        expect(res.body.password).toBe(MASK);
      }
      expect(prisma.state().creds[0].password).toBe(stored);
      const replaced = await as('manager').put(`${api}/${id}`).send({ password: 'Rotated-1' }).expect(200);
      expect(JSON.stringify(replaced.body)).not.toMatch(/Rotated-1|gcm1/);
      expect(crypto.decrypt(prisma.state().creds[0].password, { table: 'seo_credential', field: 'password', recordId: id })).toBe('Rotated-1');
      await as('manager').put(`${api}/${id}`).send({ password: '' }).expect(200);
      expect(prisma.state().creds[0].password).toBe('');
      expect(actions()).toEqual(['seo:CREATE:manager', 'seo:UPDATE_SECRET:manager', 'seo:UPDATE_SECRET:manager']);
    });

    it('missing ids return 404 on update and delete; delete is audited', async () => {
      await as('manager').put(`${api}/999`).send({ platform: 'X' }).expect(404);
      await as('manager').delete(`${api}/999`).expect(404);
      const { id } = await createCred();
      await as('manager').delete(`${api}/${id}`).expect(204);
      expect(actions()).toEqual(['seo:CREATE:manager', 'seo:DELETE:manager']);
    });

    it('create/update/delete stay SEO manager or super admin only (unchanged)', async () => {
      const { id } = await createCred();
      for (const user of ['exec', 'client', 'member']) {
        await as(user).post(api).send({ website: 3, platform: 'X', username: 'u', password: 'p' }).expect(403);
        await as(user).put(`${api}/${id}`).send({ password: 'p' }).expect(403);
        await as(user).delete(`${api}/${id}`).expect(403);
      }
      await as('super').put(`${api}/${id}`).send({ notes: 'ok' }).expect(200);
    });

    it('reveal: REVEAL_CREDENTIALS plus SEO scope; no-store and no-cache; audited before return', async () => {
      const { id } = await createCred(3);
      for (const user of ['manager', 'exec', 'super']) {
        const res = await as(user).post(`${api}/${id}/reveal`).expect(200);
        expect(res.body).toEqual({ password: SECRET });
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers.pragma).toBe('no-cache');
      }
      expect(actions().filter((a: string) => a.includes(':REVEAL:'))).toEqual(['seo:REVEAL:manager', 'seo:REVEAL:exec', 'seo:REVEAL:owner']);
    });

    it('reveal refusals are audited and leak neither the secret nor the record', async () => {
      const { id } = await createCred(3);
      await as('managerNoReveal').post(`${api}/${id}/reveal`).expect(403);
      await as('execNoReveal').post(`${api}/${id}/reveal`).expect(403);
      // Has REVEAL_CREDENTIALS but outside the SEO scope: answered like a missing record
      const outside = await as('otherExec').post(`${api}/${id}/reveal`).expect(404);
      const missing = await as('otherExec').post(`${api}/999/reveal`).expect(404);
      expect(outside.body).toEqual(missing.body);
      await as('client').post(`${api}/${id}/reveal`).expect(404);
      await as('member').post(`${api}/${id}/reveal`).expect(404);
      expect(actions().filter((a: string) => a.includes('REVEAL_DENIED'))).toEqual([
        'seo:REVEAL_DENIED:manager-noreveal',
        'seo:REVEAL_DENIED:exec-noreveal',
        'seo:REVEAL_DENIED:other-exec',
        'seo:REVEAL_DENIED:client',
        'seo:REVEAL_DENIED:member',
      ]);
      expect(JSON.stringify(prisma.state().audits)).not.toMatch(/seo-Secret|gcm1/);
    });

    it('reads legacy static-key and Django Fernet values without rewriting them', async () => {
      const { id } = await createCred();
      for (const legacy of [STATIC_LEGACY, FERNET_LEGACY]) {
        prisma.state().creds[0].password = legacy.stored;
        const res = await as('manager').post(`${api}/${id}/reveal`).expect(200);
        expect(res.body.password).toBe(legacy.plaintext);
        expect(prisma.state().creds[0].password).toBe(legacy.stored);
      }
    });

    it.each([
      ['plaintext', () => 'stored-in-plaintext'],
      ['a tampered value', (s: string) => s.slice(0, -2) + (s.endsWith('A') ? 'BA' : 'AA')],
      ['a value from another record', (_s: string, c: CredentialCryptoService) => c.encrypt(SECRET, { table: 'seo_credential', field: 'password', recordId: 999 })],
    ])('refuses %s with 422 and never returns it', async (_label, make: any) => {
      const { id } = await createCred();
      const bad = make(prisma.state().creds[0].password, crypto);
      prisma.state().creds[0].password = bad;
      const res = await as('manager').post(`${api}/${id}/reveal`).expect(422);
      expect(JSON.stringify(res.body)).not.toContain(bad);
      expect(actions().some((a: string) => a.includes(':REVEAL:'))).toBe(false);
    });

    it('does not return the secret when the REVEAL audit cannot be written', async () => {
      const { id } = await createCred();
      prisma.credentialAuditLog.create.mockRejectedValueOnce(new Error('audit table missing'));
      const res = await as('manager').post(`${api}/${id}/reveal`).expect(500);
      expect(clean(res.body)).toBe(true);
    });

    it('rolls back a new credential when encryption fails (no plaintext stored)', async () => {
      jest.spyOn(crypto, 'encrypt').mockImplementation(() => { throw new Error('encryption failure'); });
      await as('manager').post(api).send({ website: 3, platform: 'X', username: 'u', password: 'never-stored' }).expect(500);
      expect(prisma.state().creds).toEqual([]);
      expect(prisma.state().audits).toEqual([]);
    });
  });

  describe('work-log item passwords', () => {
    const api = '/api/v1/seo-daily-logs';
    const createLog = async (user = 'exec') =>
      (
        await as(user)
          .post(api)
          .send({ website: 3, log_date: '2026-10-20', status: 'draft', items: [{ activity_type: 1, username: 'acc1', password: SECRET }, { activity_type: 1 }] })
          .expect(201)
      ).body;

    it('create: each item password is gcm1 bound to its item id; responses never carry it', async () => {
      const log = await createLog();
      expect(clean(log)).toBe(true);
      expect(log.items.map((i: any) => i.password)).toEqual([MASK, '']);
      expect(log.items.every((i: any) => !('decrypted_password' in i))).toBe(true);
      const [withPw, withoutPw] = prisma.state().items;
      expect(crypto.decrypt(withPw.password, { table: 'seo_daily_work_log_item', field: 'password', recordId: withPw.id })).toBe(SECRET);
      expect(withoutPw.password).toBeNull();
      expect(actions()).toEqual(['seo_work_log:CREATE:exec']);
      // Detail for the owner: masked; for a client: blank, as before
      const detail = await as('exec').get(`${api}/${log.id}`).expect(200);
      expect(detail.body.items[0].password).toBe(MASK);
      expect(clean(detail.body)).toBe(true);
    });

    it('add-items to an existing log encrypts the new item for its id', async () => {
      const log = await createLog();
      const res = await as('exec').post(`${api}/add-items`).send({ website: 3, log_date: '2026-10-20', items: [{ activity_type: 1, password: 'Second-2' }] }).expect(201);
      expect(JSON.stringify(res.body)).not.toMatch(/Second-2|gcm1/);
      const added = prisma.state().items.find((i: any) => i.work_log_id === log.id && i.id === 3);
      expect(crypto.decrypt(added.password, { table: 'seo_daily_work_log_item', field: 'password', recordId: 3 })).toBe('Second-2');
    });

    it('reveal: the log executive and SEO managers with REVEAL_CREDENTIALS; no-store and no-cache', async () => {
      const log = await createLog();
      const itemId = log.items[0].id;
      for (const user of ['exec', 'manager', 'super']) {
        const res = await as(user).post(`${api}/${log.id}/items/${itemId}/reveal`).expect(200);
        expect(res.body).toEqual({ password: SECRET });
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers.pragma).toBe('no-cache');
      }
      expect(actions().filter((a: string) => a.includes(':REVEAL:'))).toEqual([
        'seo_work_log:REVEAL:exec',
        'seo_work_log:REVEAL:manager',
        'seo_work_log:REVEAL:owner',
      ]);
    });

    it('reveal refusals: other executives, clients and other staff never; missing permission is 403', async () => {
      const log = await createLog();
      const url = `${api}/${log.id}/items/${log.items[0].id}/reveal`;
      await as('execNoReveal').post(url).expect(403);
      await as('managerNoReveal').post(url).expect(403);
      for (const user of ['otherExec', 'client', 'member']) await as(user).post(url).expect(404);
      // An item id paired with the wrong log is not found either
      await as('exec').post(`${api}/999/items/${log.items[0].id}/reveal`).expect(404);
      expect(actions().filter((a: string) => a.includes('REVEAL_DENIED'))).toEqual([
        'seo_work_log:REVEAL_DENIED:exec-noreveal',
        'seo_work_log:REVEAL_DENIED:manager-noreveal',
        'seo_work_log:REVEAL_DENIED:other-exec',
        'seo_work_log:REVEAL_DENIED:client',
        'seo_work_log:REVEAL_DENIED:member',
      ]);
    });

    it('reads legacy item values; refuses plaintext with 422', async () => {
      const log = await createLog();
      const url = `${api}/${log.id}/items/${log.items[0].id}/reveal`;
      prisma.state().items[0].password = FERNET_LEGACY.stored;
      expect((await as('exec').post(url).expect(200)).body.password).toBe(FERNET_LEGACY.plaintext);
      prisma.state().items[0].password = 'plain-item-password';
      const res = await as('exec').post(url).expect(422);
      expect(JSON.stringify(res.body)).not.toContain('plain-item-password');
    });

    it('rolls back the whole new log when an item password cannot be encrypted', async () => {
      jest.spyOn(crypto, 'encrypt').mockImplementation(() => { throw new Error('encryption failure'); });
      await as('exec').post(api).send({ website: 3, log_date: '2026-10-21', items: [{ activity_type: 1, password: 'x' }] }).expect(500);
      expect(prisma.state().logs).toEqual([]);
      expect(prisma.state().items).toEqual([]);
    });

    it('rolls back when the CREATE audit row cannot be written', async () => {
      prisma.credentialAuditLog.create.mockRejectedValueOnce(new Error('audit table missing'));
      await as('exec').post(api).send({ website: 3, log_date: '2026-10-22', items: [{ activity_type: 1, password: 'x' }] }).expect(500);
      expect(prisma.state().logs).toEqual([]);
      expect(prisma.state().items).toEqual([]);
    });

    it('deleting a log audits DELETE for each item password it held', async () => {
      const log = await createLog();
      await as('exec').delete(`${api}/${log.id}`).expect(204);
      expect(actions()).toEqual(['seo_work_log:CREATE:exec', 'seo_work_log:DELETE:exec']);
      expect(prisma.state().items).toEqual([]);
    });
  });
});
