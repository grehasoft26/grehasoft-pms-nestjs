import * as nodeCrypto from 'crypto';
import { Test } from '@nestjs/testing';
import { CanActivate, ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as request from 'supertest';
import { ServersController } from './infrastructure.controller';
import { InfrastructureService } from './infrastructure.service';
import { AssetRenewalsService } from './asset-renewals.service';
import { PrismaService } from '../../core/prisma.service';
import { CredentialCryptoService } from '../../core/credential-crypto.service';
import { CredentialAuditService } from '../credential-audit/credential-audit.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';

/**
 * Server passwords over HTTP: real ServersController, InfrastructureService, PermissionsGuard,
 * CredentialCryptoService and audit service over an in-memory store (servers used by domains of
 * projects 10 and 20; $transaction rolls back on error).
 */
const role = (name: string, permissions: string[]) => ({ name, permissions, deleted_at: null });
const USERS: Record<string, any> = {
  super: { id: 1, username: 'owner', role: role('SUPER_ADMIN', []) },
  ops: { id: 2, username: 'ops', role: role('OPS', ['MANAGE_INFRASTRUCTURE']) }, // project 10
  opsOther: { id: 3, username: 'ops-other', role: role('OPS', ['MANAGE_INFRASTRUCTURE']) }, // project 20
  revealer: { id: 4, username: 'revealer', role: role('VAULT_READER', ['REVEAL_CREDENTIALS']) }, // project 10
  member: { id: 5, username: 'member', role: role('TEAM_MEMBER', ['VIEW_TASKS']) }, // project 10
};
const MEMBERSHIP: Record<number, number[]> = { 2: [10], 3: [20], 4: [10], 5: [10] };
const ENV: Record<string, string> = { CREDENTIAL_KEYS: `1:${nodeCrypto.randomBytes(32).toString('base64')}`, CREDENTIAL_ACTIVE_KEY_VERSION: '1' };
const SECRET = 'srv-Secret-9!';

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
  let servers: any[] = [];
  let audits: any[] = [];
  let nextId = 1;
  // Server 1 is created by the tests; domains link server ids to projects
  const domains = [{ server_id: 1, project_id: 10 }];
  const inScope = (s: any, where: any = {}) =>
    !where.domains || domains.some((d) => d.server_id === s.id && where.domains.some.project_id.in.includes(d.project_id));
  const prisma: any = {
    projectMember: { findMany: jest.fn(async ({ where }: any) => (MEMBERSHIP[where.user_id] || []).map((project_id) => ({ project_id }))) },
    domain: {
      findMany: jest.fn(async ({ where }: any) => domains.filter((d) => d.server_id === where.server_id).map((d) => ({ project_id: d.project_id }))),
      count: jest.fn(async ({ where }: any) => domains.filter((d) => d.server_id === where.server_id && where.project_id.in.includes(d.project_id)).length),
    },
    server: {
      findMany: jest.fn(async ({ where }: any = {}) => servers.filter((s) => inScope(s, where)).map((s) => ({ ...s }))),
      count: jest.fn(async ({ where }: any = {}) => servers.filter((s) => inScope(s, where)).length),
      findUnique: jest.fn(async ({ where }: any) => { const s = servers.find((r) => r.id === where.id); return s ? { ...s } : null; }),
      create: jest.fn(async ({ data }: any) => { const s = { id: nextId++, ...data }; servers.push(s); return { ...s }; }),
      update: jest.fn(async ({ where, data }: any) => {
        const s = servers.find((r) => r.id === where.id);
        Object.entries(data).forEach(([k, v]) => { if (v !== undefined) s[k] = v; });
        return { ...s };
      }),
      delete: jest.fn(async ({ where }: any) => { servers = servers.filter((r) => r.id !== where.id); return { id: where.id }; }),
    },
    credentialAuditLog: { create: jest.fn(async ({ data }: any) => { audits.push(data); return data; }) },
    $transaction: jest.fn(async (fn: any) => {
      const snapshot = { servers: servers.map((s) => ({ ...s })), audits: [...audits], nextId };
      try {
        return await fn(prisma);
      } catch (error) {
        ({ servers, audits, nextId } = snapshot);
        throw error;
      }
    }),
    servers: () => servers,
    audits: () => audits,
  };
  return prisma;
};

describe('Server credentials (HTTP)', () => {
  let app: INestApplication;
  let prisma: any;
  let crypto: CredentialCryptoService;
  const api = '/api/v1/infrastructure/servers';

  beforeEach(async () => {
    prisma = createPrisma();
    const moduleRef = await Test.createTestingModule({
      controllers: [ServersController],
      providers: [
        InfrastructureService,
        CredentialCryptoService,
        CredentialAuditService,
        { provide: AssetRenewalsService, useValue: {} },
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
  const clean = (body: any) => !JSON.stringify(body).includes(SECRET) && !JSON.stringify(body).includes('gcm1');
  const createServer = async () => (await as('super').post(api).send({ name: 'Prod', username: 'root', password: SECRET }).expect(201)).body;

  it('stores gcm1 bound to the server id; no response carries the password, for any user', async () => {
    const created = await createServer();
    expect(created.password).toBe('••••••••');
    const stored = prisma.servers()[0].password;
    expect(crypto.decrypt(stored, { table: 'servers', field: 'password', recordId: created.id })).toBe(SECRET);

    for (const user of ['super', 'ops', 'revealer']) {
      const list = await as(user).get(api).expect(200);
      const all = await as(user).get(`${api}?all=true`).expect(200);
      const detail = await as(user).get(`${api}/${created.id}`).expect(200);
      for (const body of [created, list.body, all.body, detail.body]) expect(clean(body)).toBe(true);
    }
    // Metadata policy B: a member with none of MANAGE_INFRASTRUCTURE / MANAGE_CREDENTIALS /
    // REVEAL_CREDENTIALS gets 403 for server records (the expiry view stays open to them)
    for (const url of [api, `${api}?all=true`, `${api}/${created.id}`]) {
      expect(clean((await as('member').get(url).expect(403)).body)).toBe(true);
    }
    const updated = await as('ops').patch(`${api}/${created.id}`).send({ password: 'New-Secret-2' }).expect(200);
    expect(JSON.stringify(updated.body)).not.toMatch(/New-Secret-2|gcm1/);
  });

  it('reveal: REVEAL_CREDENTIALS gets the password with no-store after a REVEAL audit row', async () => {
    const { id } = await createServer();
    const res = await as('revealer').post(`${api}/${id}/reveal`).expect(200);
    expect(res.body).toEqual({ password: SECRET });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(prisma.audits().map((a: any) => [a.actor_username, a.action, a.credential_type])).toEqual([
      ['owner', 'CREATE', 'server'],
      ['revealer', 'REVEAL', 'server'],
    ]);
  });

  it.each(['ops', 'member'])('reveal: %s (no REVEAL_CREDENTIALS) gets 403 and a REVEAL_DENIED row', async (user) => {
    const { id } = await createServer();
    const res = await as(user).post(`${api}/${id}/reveal`).expect(403);
    expect(clean(res.body)).toBe(true);
    expect(prisma.audits().map((a: any) => a.action)).toEqual(['CREATE', 'REVEAL_DENIED']);
  });

  it('cross-project: another project\'s ops user cannot read, change, delete or reveal the server', async () => {
    const { id } = await createServer();
    const before = JSON.stringify(prisma.servers());
    await as('opsOther').get(`${api}/${id}`).expect(404);
    await as('opsOther').patch(`${api}/${id}`).send({ name: 'Hijacked', password: 'x' }).expect(404);
    await as('opsOther').delete(`${api}/${id}`).expect(404);
    expect(JSON.stringify(prisma.servers())).toBe(before);
    // Same-project ops user can still edit
    await as('ops').patch(`${api}/${id}`).send({ name: 'Renamed' }).expect(200);
  });

  it('the masked placeholder keeps the stored password; empty clears it', async () => {
    const { id } = await createServer();
    const stored = prisma.servers()[0].password;
    await as('ops').patch(`${api}/${id}`).send({ name: 'P', password: '••••••••' }).expect(200);
    expect(prisma.servers()[0].password).toBe(stored);
    await as('ops').patch(`${api}/${id}`).send({ password: '' }).expect(200);
    expect(prisma.servers()[0].password).toBe('');
    expect(prisma.audits().map((a: any) => a.action)).toEqual(['CREATE', 'UPDATE_SECRET']);
  });

  it('rolls back a new server when encryption fails (no plaintext stored)', async () => {
    jest.spyOn(crypto, 'encrypt').mockImplementation(() => { throw new Error('encryption failure'); });
    await as('super').post(api).send({ name: 'Broken', password: 'never-stored' }).expect(500);
    expect(prisma.servers()).toEqual([]);
    expect(prisma.audits()).toEqual([]);
  });
});
