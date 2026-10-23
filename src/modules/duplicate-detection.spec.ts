import { Test } from '@nestjs/testing';
import { BadRequestException, CanActivate, ConflictException, ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import * as request from 'supertest';
import { InfrastructureService } from './infrastructure/infrastructure.service';
import { ServersController } from './infrastructure/infrastructure.controller';
import { AssetRenewalsService } from './infrastructure/asset-renewals.service';
import { ClientsService } from './projects/clients.service';
import { ClientsController } from './projects/clients.controller';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';

/**
 * Live duplicate detection for the Add/Edit Client, Domain and Server forms:
 * - domains: normalized names (case, spaces, trailing dot, pasted http(s) URL); exact duplicates
 *   are rejected on save; "www." stays distinct;
 * - clients: an exact company name is rejected on save (as before); email / GST matches are
 *   warnings only;
 * - servers: name / IP matches are warnings only; saving is never blocked.
 * The checks return booleans only. In-memory stores evaluate the SQL each check sends.
 */
const admin = { id: 1, username: 'owner', is_superuser: true, role: { name: 'SUPER_ADMIN', permissions: [] } };
const infra = (prisma: any) => new (InfrastructureService as any)(prisma, {}, { record: jest.fn() }) as InfrastructureService;

describe('Domain names: normalization', () => {
  const service = infra({});
  it.each([
    ['  Example.COM  ', 'Example.COM'],
    ['example.com.', 'example.com'],
    ['https://Example.com/path/page?q=1#top', 'Example.com'],
    ['http://example.com', 'example.com'],
    ['HTTPS://example.com.', 'example.com'],
    ['http://user:secret@example.com:8080/admin', 'example.com'],
    ['example.com/some/path', 'example.com'],
    ['www.example.com', 'www.example.com'],
    ['https://www.example.com/', 'www.example.com'],
    ['sub.domain.example.co.uk', 'sub.domain.example.co.uk'],
  ])('%j -> %j', (input, expected) => {
    expect(service.normalizeDomainName(input)).toBe(expected);
  });

  it.each([[''], ['   '], ['https://'], ['http:///path'], ['.']])('%j is required (400)', (input) => {
    expect(() => service.normalizeDomainName(input)).toThrow(BadRequestException);
  });

  it('other schemes are rejected, not mangled (400)', () => {
    expect(() => service.normalizeDomainName('ftp://example.com')).toThrow(/http:\/\/ or https:\/\//);
  });
});

describe('Domain names: duplicates on save and in the live check', () => {
  // Stored rows; key = LOWER(TRIM(TRAILING '.' FROM TRIM(domain_name))), as the SQL computes it
  let rows: Array<{ id: number; domain_name: string }>;
  let service: InfrastructureService;
  let sqls: string[];
  const key = (name: string) => name.trim().replace(/\.$/, '').toLowerCase();
  beforeEach(() => {
    rows = [
      { id: 1, domain_name: 'example.com' },
      { id: 2, domain_name: 'legacy.org.' }, // saved before the trailing-dot rule
    ];
    sqls = [];
    const client: any = {
      $queryRaw: jest.fn(async (sql: any) => {
        sqls.push(sql.sql);
        const [k, excludeId] = sql.values;
        return rows.filter((r) => key(r.domain_name) === k && (excludeId === undefined || r.id !== excludeId)).map((r) => ({ id: r.id }));
      }),
      domain: {
        create: jest.fn(async ({ data }: any) => {
          const row = { id: rows.length + 1, ...data };
          rows.push(row);
          return { ...row, project: null, server: null };
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const row: any = rows.find((r) => r.id === where.id);
          Object.entries(data).forEach(([k, v]) => v !== undefined && (row[k] = v));
          return { ...row, project: null, server: null };
        }),
        findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
      },
    };
    client.$transaction = jest.fn(async (fn: any) => fn(client));
    service = infra(client);
  });
  const conflict = async (promise: Promise<unknown>) => {
    const error: any = await promise.then(() => null, (e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ domain_name: 'Domain already exists.' });
  };

  it.each([['EXAMPLE.COM'], ['example.com.'], ['https://Example.com/pricing'], ['  http://example.com:443/ ']])('create %j is a duplicate of example.com (409)', async (name) => {
    await conflict(service.createDomain(admin, { domain_name: name }));
  });

  it('a stored name with a trailing dot still counts', async () => {
    await conflict(service.createDomain(admin, { domain_name: 'LEGACY.org' }));
  });

  it('similar but distinct names are allowed, and saved normalized', async () => {
    for (const name of ['www.example.com', 'example.co', 'my-example.com', 'example.com.au']) {
      await expect(service.createDomain(admin, { domain_name: name })).resolves.toBeDefined();
    }
    const created: any = await service.createDomain(admin, { domain_name: 'https://New-Site.io/home' });
    expect(created.domain_name).toBe('New-Site.io');
  });

  it('live check uses the same rule and excludes the record being edited', async () => {
    await expect(service.checkDomainName('HTTPS://example.com/', undefined)).resolves.toEqual({ exists: true });
    await expect(service.checkDomainName('https://example.com/', '1')).resolves.toEqual({ exists: false });
    await expect(service.checkDomainName('www.example.com', undefined)).resolves.toEqual({ exists: false });
  });

  it('editing a record without a real rename is never a conflict; renaming onto another is', async () => {
    await expect(service.updateDomain(admin, 1, { domain_name: 'https://EXAMPLE.com/', notes: 'n' })).resolves.toBeDefined();
    await expect(service.updateDomain(admin, 2, { domain_name: 'legacy.org', notes: 'n' })).resolves.toBeDefined();
    await conflict(service.updateDomain(admin, 2, { domain_name: 'example.com.' }));
  });

  it('the save check is a locking read inside the save transaction (concurrent saves wait)', async () => {
    await service.createDomain(admin, { domain_name: 'fresh.dev' });
    expect(sqls.some((s) => /FOR UPDATE/.test(s) && /TRIM\(TRAILING '\.' FROM TRIM\(domain_name\)\)/.test(s))).toBe(true);
  });
});

describe('Client duplicate checks', () => {
  const CLIENTS = [
    { id: 1, company_name: 'Royal Kangan Jewellers', email: 'Accounts@RoyalKangan.com ', gst_no: ' 32abcde1234f1z5', deleted_at: null },
    { id: 2, company_name: 'Old Traders', email: 'old@traders.in', gst_no: '29XYZ', deleted_at: new Date('2026-01-01') },
  ];
  let created: any[];
  let service: ClientsService;
  beforeEach(() => {
    created = [];
    const prisma: any = {
      client: {
        // Collation: company_name equality ignores case
        findFirst: jest.fn(async ({ where }: any) => {
          const match = CLIENTS.find(
            (c) =>
              c.company_name.toLowerCase() === String(where.company_name).toLowerCase() &&
              c.deleted_at === null &&
              (!where.id?.not || c.id !== where.id.not),
          );
          return match ? { id: match.id } : null;
        }),
        create: jest.fn(async ({ data }: any) => {
          const row = { id: 10 + created.length, ...data, portal_users: [] };
          created.push(row);
          return row;
        }),
      },
      $queryRaw: jest.fn(async (sql: any) => {
        const [value, excludeId] = sql.values;
        const column = /LOWER\(TRIM\(email\)\)/.test(sql.sql) ? 'email' : 'gst_no';
        const norm = (v: string) => (column === 'email' ? v.trim().toLowerCase() : v.trim().toUpperCase());
        return CLIENTS.filter((c) => c.deleted_at === null && norm((c as any)[column]) === value && (excludeId === undefined || c.id !== excludeId)).map((c) => ({ id: c.id }));
      }),
      $queryRawUnsafe: jest.fn(async (sql: string) => (/GET_LOCK/.test(sql) ? [{ lock_result: 1 }] : [{}])),
    };
    service = new ClientsService(prisma);
  });

  it('exact company name (any case and spacing) is reported; partial names are not duplicates', async () => {
    expect(await service.checkDuplicates({ company_name: '  royal KANGAN jewellers ' })).toEqual({ company_name: true, email: false, gst_no: false });
    expect((await service.checkDuplicates({ company_name: 'Royal Kangan' })).company_name).toBe(false);
  });

  it('email and GST matches (ignoring case and spaces) are reported', async () => {
    expect(await service.checkDuplicates({ email: 'accounts@royalkangan.COM', gst_no: '32ABCDE1234F1Z5 ' })).toEqual({ company_name: false, email: true, gst_no: true });
  });

  it('the client being edited is excluded', async () => {
    expect(await service.checkDuplicates({ company_name: 'Royal Kangan Jewellers', email: 'accounts@royalkangan.com', gst_no: '32ABCDE1234F1Z5', exclude: '1' })).toEqual({
      company_name: false,
      email: false,
      gst_no: false,
    });
  });

  it("a deleted client's name, email or GST does not count (as on save)", async () => {
    expect(await service.checkDuplicates({ company_name: 'Old Traders', email: 'old@traders.in', gst_no: '29xyz' })).toEqual({ company_name: false, email: false, gst_no: false });
  });

  it('empty values are not checked; a bad exclude is a 400', async () => {
    expect(await service.checkDuplicates({})).toEqual({ company_name: false, email: false, gst_no: false });
    await expect(service.checkDuplicates({ company_name: 'x', exclude: 'abc' })).rejects.toThrow(BadRequestException);
  });

  it('a matching email or GST does not block creating a client (warning only)', async () => {
    await expect(service.create({ company_name: 'Kangan Exports', email: 'accounts@royalkangan.com', gst_number: '32ABCDE1234F1Z5' })).resolves.toMatchObject({ company_name: 'Kangan Exports' });
    expect(created).toHaveLength(1);
  });

  it('an exact company-name duplicate is still rejected on save (existing rule)', async () => {
    await expect(service.create({ company_name: 'ROYAL KANGAN JEWELLERS' })).rejects.toThrow(BadRequestException);
    expect(created).toHaveLength(0);
  });
});

describe('Server duplicate warnings and suggestion list', () => {
  const SERVERS = [
    { id: 1, name: 'Prod-Web', provider: 'Hetzner', owner: 'Grehasoft', ip_address: ' 203.0.113.10 ', server_ip: '', username: 'root', password: 'gcm1:secret' },
    { id: 2, name: 'Legacy Mail', provider: 'OVH', owner: '', ip_address: null, server_ip: '198.51.100.7', username: 'admin', password: '' },
  ];
  let prisma: any;
  let service: InfrastructureService;
  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn(async (sql: any) => {
        // The IP query uses the value twice (ip_address, server_ip); the exclude id is the number
        const value = sql.values[0];
        const excludeId = sql.values.find((v: unknown) => typeof v === 'number');
        const hits = SERVERS.filter((s) =>
          /LOWER\(TRIM\(name\)\)/.test(sql.sql) ? s.name.trim().toLowerCase() === value : (s.ip_address ?? '').trim() === value || (s.server_ip ?? '').trim() === value,
        );
        return hits.filter((s) => excludeId === undefined || s.id !== excludeId).map((s) => ({ id: s.id }));
      }),
      server: {
        count: jest.fn(async () => SERVERS.length),
        findMany: jest.fn(async ({ select }: any) =>
          SERVERS.map((s) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, (s as any)[k]])) : { ...s })),
        ),
        create: jest.fn(async ({ data }: any) => ({ id: 99, ...data })),
        update: jest.fn(),
      },
      projectMember: { findMany: jest.fn(async () => [{ project_id: 5 }]) },
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    service = infra(prisma);
  });

  it('same name (any case, spaces) and same IP in ip_address or server_ip are reported', async () => {
    await expect(service.checkServerDuplicates({ name: '  prod-WEB ', ip: '203.0.113.10' })).resolves.toEqual({ name: true, ip: true });
    await expect(service.checkServerDuplicates({ ip: '198.51.100.7' })).resolves.toEqual({ name: false, ip: true });
    await expect(service.checkServerDuplicates({ name: 'Prod', ip: '203.0.113' })).resolves.toEqual({ name: false, ip: false });
  });

  it('the server being edited is excluded; a bad exclude is a 400', async () => {
    await expect(service.checkServerDuplicates({ name: 'Prod-Web', ip: '203.0.113.10', exclude: '1' })).resolves.toEqual({ name: false, ip: false });
    await expect(service.checkServerDuplicates({ name: 'x', exclude: '-3' })).rejects.toThrow(BadRequestException);
  });

  it('a server with a duplicate name and IP can still be created (warnings never block)', async () => {
    await expect(service.createServer(admin, { name: 'Prod-Web', ip_address: '203.0.113.10' })).resolves.toMatchObject({ name: 'Prod-Web' });
  });

  it('fields=summary returns only name, provider, owner and IP columns (no username or password)', async () => {
    const res: any = await service.getServers(admin, { fields: 'summary', search: 'prod', limit: '5' });
    expect(prisma.server.findMany.mock.calls.at(-1)[0].select).toEqual({ id: true, name: true, provider: true, owner: true, ip_address: true, server_ip: true });
    for (const row of res.results) {
      expect(row).not.toHaveProperty('username');
      expect(row).not.toHaveProperty('password');
    }
    const all: any = await service.getServers(admin, { fields: 'summary', all: 'true' });
    expect(all.every((r: any) => !('username' in r) && !('password' in r))).toBe(true);
  });

  it('the summary list keeps the project scope for non-admins', async () => {
    await service.getServers({ id: 7, role: { name: 'DEVELOPER', permissions: [] } }, { fields: 'summary', search: 'prod' });
    expect(prisma.server.findMany.mock.calls.at(-1)[0].where).toMatchObject({ domains: { some: { project_id: { in: [5] } } }, OR: expect.any(Array) });
  });
});

describe('check-duplicates routes: permissions (real controllers and guards)', () => {
  const role = (name: string, permissions: string[]) => ({ name, permissions, deleted_at: null });
  const USERS: Record<string, any> = {
    staff: { id: 2, username: 'staff', role: role('ACCOUNTS', ['VIEW_CLIENTS']) },
    infra: { id: 3, username: 'ops', role: role('OPS', ['MANAGE_INFRASTRUCTURE']) },
    portal: { id: 4, username: 'client', role: role('CLIENT', []), client_id: 1 },
    member: { id: 5, username: 'member', role: role('TEAM_MEMBER', ['VIEW_TASKS']) },
  };
  class TestAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest();
      const user = USERS[req.headers['x-test-user']];
      if (!user) throw new UnauthorizedException();
      req.user = user;
      return true;
    }
  }
  let app: INestApplication;
  const clients = { checkDuplicates: jest.fn(async () => ({ company_name: true, email: false, gst_no: false })) };
  const servers = { checkServerDuplicates: jest.fn(async () => ({ name: true, ip: false })) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ClientsController, ServersController],
      providers: [
        { provide: ClientsService, useValue: clients },
        { provide: InfrastructureService, useValue: servers },
        { provide: AssetRenewalsService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestAuthGuard)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  const get = (url: string, user?: string) => {
    const req = request(app.getHttpServer()).get(url);
    return user ? req.set('x-test-user', user) : req;
  };

  it('clients: VIEW_CLIENTS gets booleans only; portal users and others are refused', async () => {
    const res = await get('/api/v1/clients/check-duplicates?company_name=Royal&email=a@b.c&exclude=3', 'staff').expect(200);
    expect(res.body).toEqual({ company_name: true, email: false, gst_no: false });
    expect(clients.checkDuplicates).toHaveBeenLastCalledWith(expect.objectContaining({ company_name: 'Royal', email: 'a@b.c', exclude: '3' }));
    await get('/api/v1/clients/check-duplicates?company_name=Royal', 'portal').expect(403);
    await get('/api/v1/clients/check-duplicates?company_name=Royal', 'member').expect(403);
    await get('/api/v1/clients/check-duplicates?company_name=Royal').expect(401);
  });

  it('servers: MANAGE_INFRASTRUCTURE gets booleans only; others are refused', async () => {
    const res = await get('/api/v1/infrastructure/servers/check-duplicates?name=Prod&ip=1.2.3.4', 'infra').expect(200);
    expect(res.body).toEqual({ name: true, ip: false });
    await get('/api/v1/infrastructure/servers/check-duplicates?name=Prod', 'staff').expect(403);
    await get('/api/v1/infrastructure/servers/check-duplicates?name=Prod').expect(401);
  });
});
