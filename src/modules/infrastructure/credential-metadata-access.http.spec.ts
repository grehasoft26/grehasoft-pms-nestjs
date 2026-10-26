import { Test } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import * as request from 'supertest';
import {
  CredentialsController,
  InfrastructureSummaryController,
  ServersController,
} from './infrastructure.controller';
import { InfrastructureService } from './infrastructure.service';
import { WebsiteCredentialsService } from './website-credentials.service';
import { AssetRenewalsService } from './asset-renewals.service';
import { PrismaService } from '../../core/prisma.service';
import { CredentialCryptoService } from '../../core/credential-crypto.service';
import { CredentialAuditService } from '../credential-audit/credential-audit.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import {
  CREDENTIAL_METADATA_PERMISSIONS,
  canReadCredentialMetadata,
} from '../../core/utils/credential-access.util';

/**
 * Credential Vault metadata access, policy B (finding M2):
 * - website-credential and server records (list and detail: usernames, admin/cPanel URLs, FTP hosts,
 *   emails, IPs) need MANAGE_INFRASTRUCTURE, MANAGE_CREDENTIALS or REVEAL_CREDENTIALS (super admins
 *   always); everyone else, client-portal users included, gets 403;
 * - the permission never widens the scope: records stay limited to the caller's projects;
 * - GET /infrastructure/servers?fields=expiry (id, name, expiry_date) stays open to every signed-in
 *   user for the notification center, still scoped; GET /infrastructure/summary stays counts only;
 * - no response contains a password or ciphertext, for anyone.
 */
const CIPHERTEXT = 'gcm1:1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:c2VjcmV0';
const role = (name: string, permissions: string[]) => ({
  name,
  permissions,
  deleted_at: null,
});
const USERS: Record<string, any> = {
  super: {
    id: 1,
    username: 'owner',
    is_superuser: true,
    role: role('SUPER_ADMIN', []),
  },
  infra: {
    id: 2,
    username: 'ops',
    role: role('OPS', ['MANAGE_INFRASTRUCTURE']),
  }, // project 10
  manager: {
    id: 3,
    username: 'vault-manager',
    role: role('CREDENTIAL_MANAGER', ['MANAGE_CREDENTIALS']),
  }, // project 10
  revealer: {
    id: 4,
    username: 'revealer',
    role: role('SEO_MANAGER', ['REVEAL_CREDENTIALS', 'VIEW_DASHBOARD']),
  }, // project 10
  member: {
    id: 5,
    username: 'dev',
    role: role('TEAM_MEMBER', ['VIEW_TASKS', 'VIEW_DASHBOARD']),
  }, // project 10, none of the three
  infraOutsider: {
    id: 6,
    username: 'ops-other',
    role: role('OPS', ['MANAGE_INFRASTRUCTURE']),
  }, // project 20 only
  revealerNoProjects: {
    id: 7,
    username: 'revealer-np',
    role: role('VAULT_READER', ['REVEAL_CREDENTIALS']),
  }, // no projects
  client: {
    id: 8,
    username: 'portal',
    role: role('CLIENT', ['VIEW_DASHBOARD']),
  }, // no projects
  clientMember: {
    id: 9,
    username: 'portal-member',
    role: role('CLIENT', ['VIEW_DASHBOARD']),
  }, // member of project 10
  deletedRoleRevealer: {
    id: 10,
    username: 'old',
    role: {
      name: 'VAULT_READER',
      permissions: ['REVEAL_CREDENTIALS'],
      deleted_at: new Date(),
    },
  },
};
const MEMBERSHIP: Record<number, number[]> = {
  2: [10],
  3: [10],
  4: [10],
  5: [10],
  6: [20],
  9: [10],
  10: [10],
};
const METADATA_READERS = ['infra', 'manager', 'revealer'];
const DENIED = ['member', 'client', 'clientMember', 'deletedRoleRevealer'];

const CREDENTIALS = [
  {
    id: 1,
    project_id: 10,
    domain_id: 100,
    admin_url: 'https://acme.test/wp-admin',
    admin_username: 'acme-admin',
    cpanel_url: 'https://cp.acme.test',
    cpanel_username: 'acmecp',
    ftp_host: 'ftp.acme.test',
    ftp_username: 'acmeftp',
    client_email: 'owner@acme.test',
    business_email: null,
    admin_password: CIPHERTEXT,
    cpanel_password: CIPHERTEXT,
    ftp_password: '',
    client_email_password: CIPHERTEXT,
    business_email_password: null,
  },
  {
    id: 2,
    project_id: 20,
    domain_id: 200,
    admin_url: 'https://globex.test/admin',
    admin_username: 'globex-admin',
    cpanel_url: '',
    cpanel_username: '',
    ftp_host: 'ftp.globex.test',
    ftp_username: 'gftp',
    client_email: '',
    business_email: null,
    admin_password: CIPHERTEXT,
    cpanel_password: '',
    ftp_password: '',
    client_email_password: '',
    business_email_password: null,
  },
];
const SERVERS = [
  {
    id: 1,
    name: 'acme-web',
    provider: 'Hetzner',
    owner: '',
    ip_address: '203.0.113.10',
    server_ip: '',
    notes: '',
    username: 'root',
    password: CIPHERTEXT,
    expiry_date: new Date('2027-01-01'),
    domains: [{ project_id: 10 }],
  },
  {
    id: 2,
    name: 'globex-db',
    provider: 'OVH',
    owner: '',
    ip_address: '198.51.100.7',
    server_ip: '',
    notes: '',
    username: 'admin',
    password: CIPHERTEXT,
    expiry_date: new Date('2027-02-01'),
    domains: [{ project_id: 20 }],
  },
];
const PROJECTS: Record<number, string> = { 10: 'Acme', 20: 'Globex' };
const DOMAIN_NAMES: Record<number, string> = {
  100: 'acme.test',
  200: 'globex.test',
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

const inProjects = (projectId: number, where: any) =>
  !where?.project_id?.in || where.project_id.in.includes(projectId);
const serverInScope = (s: any, where: any) =>
  !where?.domains ||
  s.domains.some((d: any) =>
    where.domains.some.project_id.in.includes(d.project_id),
  );
/** A server row as Prisma returns it (the fake's `domains` relation is not a column). */
const serverRow = (s: any) => {
  const row = { ...s };
  delete row.domains;
  return row;
};
const pick = (row: any, select?: any) =>
  select
    ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]))
    : { ...row };
const withRelations = (c: any) => ({
  ...c,
  project: { id: c.project_id, name: PROJECTS[c.project_id] },
  domain: { id: c.domain_id, domain_name: DOMAIN_NAMES[c.domain_id] },
});
const prisma: any = {
  projectMember: {
    findMany: jest.fn(async ({ where }: any) =>
      (MEMBERSHIP[where.user_id] || []).map((project_id) => ({ project_id })),
    ),
  },
  websiteCredential: {
    findMany: jest.fn(async ({ where }: any = {}) =>
      CREDENTIALS.filter((c) => inProjects(c.project_id, where)).map(
        withRelations,
      ),
    ),
    count: jest.fn(
      async ({ where }: any = {}) =>
        CREDENTIALS.filter((c) => inProjects(c.project_id, where)).length,
    ),
    findUnique: jest.fn(async ({ where }: any) => {
      const c = CREDENTIALS.find((r) => r.id === where.id);
      return c ? withRelations(c) : null;
    }),
  },
  server: {
    findMany: jest.fn(async ({ where, select }: any = {}) =>
      SERVERS.filter((s) => serverInScope(s, where)).map((s) =>
        pick(serverRow(s), select),
      ),
    ),
    count: jest.fn(
      async ({ where }: any = {}) =>
        SERVERS.filter((s) => serverInScope(s, where)).length,
    ),
    findUnique: jest.fn(async ({ where }: any) => {
      const s = SERVERS.find((r) => r.id === where.id);
      return s ? serverRow(s) : null;
    }),
  },
  domain: {
    count: jest.fn(async ({ where }: any = {}) => {
      if (where?.server_id) {
        const s = SERVERS.find((r) => r.id === where.server_id);
        return s
          ? s.domains.filter((d) => where.project_id.in.includes(d.project_id))
              .length
          : 0;
      }
      return Object.keys(DOMAIN_NAMES).filter((id) =>
        inProjects(Number(id) === 100 ? 10 : 20, where),
      ).length;
    }),
  },
};

describe('Credential Vault metadata access (policy B)', () => {
  let app: INestApplication;
  const get = (url: string, user?: string) => {
    const req = request(app.getHttpServer()).get(url);
    return user ? req.set('x-test-user', user) : req;
  };
  const ids = (res: any) =>
    (Array.isArray(res.body) ? res.body : res.body.results).map(
      (r: any) => r.id,
    );
  /** No password or ciphertext anywhere in a response. */
  const expectNoSecrets = (res: any) => {
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('gcm1:');
    expect(json).not.toContain('c2VjcmV0');
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        CredentialsController,
        ServersController,
        InfrastructureSummaryController,
      ],
      providers: [
        WebsiteCredentialsService,
        InfrastructureService,
        { provide: AssetRenewalsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        {
          provide: CredentialCryptoService,
          useValue: { assertReady: () => undefined },
        },
        { provide: CredentialAuditService, useValue: { record: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestAuthGuard)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('the rule: any one of MANAGE_INFRASTRUCTURE, MANAGE_CREDENTIALS, REVEAL_CREDENTIALS (or super admin)', () => {
    expect([...CREDENTIAL_METADATA_PERMISSIONS]).toEqual([
      'MANAGE_INFRASTRUCTURE',
      'MANAGE_CREDENTIALS',
      'REVEAL_CREDENTIALS',
    ]);
    for (const user of ['super', ...METADATA_READERS])
      expect({ user, ok: canReadCredentialMetadata(USERS[user]) }).toEqual({
        user,
        ok: true,
      });
    for (const user of DENIED)
      expect({ user, ok: canReadCredentialMetadata(USERS[user]) }).toEqual({
        user,
        ok: false,
      });
  });

  describe('website credentials (GET /infrastructure/credentials)', () => {
    const api = '/api/v1/infrastructure/credentials';

    it.each(METADATA_READERS)(
      '%s (one of the three permissions) reads the metadata of their projects',
      async (user) => {
        const list = await get(`${api}/?all=true`, user);
        expect(list.status).toBe(200);
        expect(ids(list)).toEqual([1]);
        expect(list.body[0]).toMatchObject({
          admin_username: 'acme-admin',
          ftp_host: 'ftp.acme.test',
        });
        expect(ids(await get(`${api}/?page=1`, user))).toEqual([1]);
        expect((await get(`${api}/1`, user)).status).toBe(200);
      },
    );

    it('super admins read every record', async () => {
      expect(ids(await get(`${api}/?all=true`, 'super'))).toEqual([1, 2]);
    });

    it.each(DENIED)(
      '%s (none of the three permissions; client-portal users included) gets 403 for list and detail',
      async (user) => {
        for (const url of [`${api}/`, `${api}/?all=true`, `${api}/1`]) {
          const res = await get(url, user);
          expect({ url, status: res.status }).toEqual({ url, status: 403 });
          expectNoSecrets(res);
        }
      },
    );

    it('the permission does not widen the scope: other projects stay hidden', async () => {
      expect(ids(await get(`${api}/?all=true`, 'infraOutsider'))).toEqual([2]);
      expect((await get(`${api}/1`, 'infraOutsider')).status).toBe(404);
      expect((await get(`${api}/2`, 'revealer')).status).toBe(404);
      expect(ids(await get(`${api}/?all=true`, 'revealerNoProjects'))).toEqual(
        [],
      );
    });

    it('unauthenticated requests get 401', async () => {
      expect((await get(`${api}/`)).status).toBe(401);
    });

    it('no response contains a password or ciphertext (mask or empty only)', async () => {
      for (const user of ['super', ...METADATA_READERS]) {
        const list = await get(`${api}/?all=true`, user);
        expectNoSecrets(list);
        for (const row of list.body) {
          for (const field of [
            'admin_password',
            'cpanel_password',
            'ftp_password',
            'client_email_password',
            'business_email_password',
          ]) {
            expect(['••••••••', '', null]).toContain(row[field]);
          }
        }
        expectNoSecrets(await get(`${api}/?page=1`, user));
        expectNoSecrets(await get(`${api}/1`, user));
      }
    });
  });

  describe('servers (GET /infrastructure/servers)', () => {
    const api = '/api/v1/infrastructure/servers';

    it.each(METADATA_READERS)(
      '%s reads server records of their projects (list, all, detail, form suggestions)',
      async (user) => {
        expect(ids(await get(`${api}/?all=true`, user))).toEqual([1]);
        expect(ids(await get(`${api}/?page=1`, user))).toEqual([1]);
        expect((await get(`${api}/1`, user)).status).toBe(200);
        expect((await get(`${api}/2`, user)).status).toBe(404); // project 20
        const suggestions = await get(`${api}/?fields=summary&limit=5`, user);
        expect(Object.keys(suggestions.body.results[0]).sort()).toEqual([
          'id',
          'ip_address',
          'name',
          'owner',
          'provider',
          'server_ip',
        ]);
      },
    );

    it.each(DENIED)(
      '%s gets 403 for server records (list, all, detail, form suggestions)',
      async (user) => {
        for (const url of [
          `${api}/`,
          `${api}/?all=true`,
          `${api}/1`,
          `${api}/?fields=summary&limit=5`,
        ]) {
          const res = await get(url, user);
          expect({ url, status: res.status }).toEqual({ url, status: 403 });
          expectNoSecrets(res);
        }
      },
    );

    it('fields=expiry stays open to every signed-in user, still scoped, with only id, name and expiry_date', async () => {
      for (const user of DENIED) {
        const res = await get(`${api}/?fields=expiry`, user);
        expect({ user, status: res.status }).toEqual({ user, status: 200 });
        expectNoSecrets(res);
      }
      const member = await get(`${api}/?fields=expiry`, 'member');
      expect(member.body.map((r: any) => r.id)).toEqual([1]);
      expect(Object.keys(member.body[0]).sort()).toEqual([
        'expiry_date',
        'id',
        'name',
      ]);
      expect((await get(`${api}/?fields=expiry`, 'client')).body).toEqual([]);
      expect((await get(`${api}/?fields=expiry`)).status).toBe(401);
    });

    it('no server response contains the password or ciphertext', async () => {
      for (const user of ['super', ...METADATA_READERS]) {
        for (const url of [
          `${api}/?all=true`,
          `${api}/?page=1`,
          `${api}/1`,
          `${api}/?fields=expiry`,
          `${api}/?fields=summary`,
        ]) {
          expectNoSecrets(await get(url, user));
        }
      }
    });
  });

  describe('summary (GET /infrastructure/summary)', () => {
    it('stays counts only, for every signed-in user (dashboard), within their scope', async () => {
      const member = await get('/api/v1/infrastructure/summary', 'member');
      expect(member.status).toBe(200);
      expect(Object.keys(member.body).sort()).toEqual([
        'credentials',
        'domains',
        'servers',
      ]);
      expect(member.body).toMatchObject({ servers: 1, credentials: 1 });
      expect(
        (await get('/api/v1/infrastructure/summary', 'client')).body,
      ).toEqual({ servers: 0, domains: 0, credentials: 0 });
      expectNoSecrets(member);
    });
  });
});
