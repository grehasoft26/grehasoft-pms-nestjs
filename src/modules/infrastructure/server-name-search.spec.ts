import { InfrastructureService } from './infrastructure.service';
import { compactLikePattern } from './infrastructure-list.util';

/**
 * Server search (Servers table and the Add/Edit Server suggestions, fields=summary) also matches
 * the name with spaces ignored: "server1" finds "server 1" and the other way round. Only the name;
 * the other fields keep their substring match, the project scope still applies, and the exact
 * duplicate warning (checkServerDuplicates) still treats "server1" and "server 1" as different.
 * The fake evaluates each `where` like MySQL (LIKE '%term%' ignoring case) and the raw SQL's
 * REPLACE(LOWER(name), ' ', '') LIKE <pattern> ESCAPE '!'.
 */
const like = (value: unknown, term: unknown) =>
  String(value ?? '')
    .toLowerCase()
    .includes(String(term).toLowerCase());
const matchWhere = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([key, cond]: [string, any]) => {
    if (key === 'OR') return cond.some((c: any) => matchWhere(row, c));
    if (key === 'AND') return cond.every((c: any) => matchWhere(row, c));
    const value = row?.[key];
    if ('contains' in cond) return like(value, cond.contains);
    if ('in' in cond) return cond.in.includes(value);
    if ('some' in cond)
      return (value ?? []).some((r: any) => matchWhere(r, cond.some));
    throw new Error(`unexpected condition ${key}`);
  });
/** MySQL LIKE with ESCAPE '!' as a RegExp ('%' any run, '_' one character, '!x' a literal x). */
const likeRegExp = (pattern: string) => {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '!')
      source += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '%') source += '.*';
    else if (c === '_') source += '.';
    else source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
};

const SERVERS = [
  {
    id: 1,
    name: 'server 1',
    provider: 'Hetzner',
    notes: '',
    owner: '',
    ip_address: '203.0.113.10',
    server_ip: '',
    username: 'root',
    password: 'gcm1:secret',
    domains: [{ project_id: 3 }],
  },
  {
    id: 2,
    name: 'Server2',
    provider: 'OVH',
    notes: 'mail box',
    owner: '',
    ip_address: '',
    server_ip: '198.51.100.7',
    username: 'admin',
    password: 'gcm1:other',
    domains: [{ project_id: 3 }],
  },
  {
    id: 3,
    name: 'server 1 backup',
    provider: 'OVH',
    notes: '',
    owner: '',
    ip_address: null,
    server_ip: null,
    username: null,
    password: null,
    domains: [{ project_id: 9 }],
  },
  {
    id: 4,
    name: 'disk_01',
    provider: '',
    notes: '',
    owner: '',
    ip_address: null,
    server_ip: null,
    username: null,
    password: null,
    domains: [],
  },
  {
    id: 5,
    name: 'diskX01',
    provider: '',
    notes: '',
    owner: '',
    ip_address: null,
    server_ip: null,
    username: null,
    password: null,
    domains: [],
  },
  {
    id: 6,
    name: '50% off',
    provider: '',
    notes: '',
    owner: '',
    ip_address: null,
    server_ip: null,
    username: null,
    password: null,
    domains: [],
  },
  {
    id: 7,
    name: '50 boxes off',
    provider: '',
    notes: '',
    owner: '',
    ip_address: null,
    server_ip: null,
    username: null,
    password: null,
    domains: [],
  },
  {
    id: 8,
    name: 'back\\slash',
    provider: '',
    notes: '',
    owner: '',
    ip_address: null,
    server_ip: null,
    username: null,
    password: null,
    domains: [],
  },
  {
    id: 9,
    name: 'backslash',
    provider: '',
    notes: '',
    owner: '',
    ip_address: null,
    server_ip: null,
    username: null,
    password: null,
    domains: [],
  },
];

const admin = {
  id: 1,
  is_superuser: true,
  role: { name: 'SUPER_ADMIN', permissions: [] },
};
const staff = { id: 7, role: { name: 'DEVELOPER', permissions: [] } };

describe('Server search: name with spaces ignored', () => {
  let prisma: any;
  let service: InfrastructureService;
  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn(async (sql: any) => {
        if (
          /REPLACE\(LOWER\(name\), ' ', ''\) LIKE \? ESCAPE '!'/.test(sql.sql)
        ) {
          const re = likeRegExp(sql.values[0]);
          return SERVERS.filter((s) =>
            re.test(s.name.toLowerCase().replace(/ /g, '')),
          ).map((s) => ({ id: s.id }));
        }
        if (/LOWER\(TRIM\(name\)\) = \?/.test(sql.sql)) {
          return SERVERS.filter(
            (s) => s.name.trim().toLowerCase() === sql.values[0],
          ).map((s) => ({ id: s.id }));
        }
        return [];
      }),
      server: {
        count: jest.fn(
          async ({ where }: any) =>
            SERVERS.filter((s) => matchWhere(s, where)).length,
        ),
        findMany: jest.fn(async ({ where, select, skip = 0, take }: any) => {
          const hits = SERVERS.filter((s) => matchWhere(s, where)).slice(
            skip,
            take === undefined ? undefined : skip + take,
          );
          return hits.map((s) =>
            select
              ? Object.fromEntries(
                  Object.keys(select).map((k) => [k, (s as any)[k]]),
                )
              : { ...s },
          );
        }),
      },
      projectMember: { findMany: jest.fn(async () => [{ project_id: 3 }]) },
    };
    service = new (InfrastructureService as any)(
      prisma,
      { decrypt: (v: string) => v },
      { record: jest.fn() },
    );
  });

  const table = async (user: any, term: string) =>
    (
      ((await service.getServers(user, { search: term, limit: '50' })) as any)
        .results as any[]
    )
      .map((r) => r.id)
      .sort((a, b) => a - b);
  const suggestions = async (user: any, term: string) =>
    (
      (
        (await service.getServers(user, {
          search: term,
          limit: '50',
          fields: 'summary',
        })) as any
      ).results as any[]
    )
      .map((r) => r.id)
      .sort((a, b) => a - b);

  it('"server1", "SERVER 1" and "server 1" find both "server 1" and a name stored without the space', async () => {
    expect(await table(admin, 'server1')).toEqual([1, 3]);
    expect(await table(admin, 'SERVER 1')).toEqual([1, 3]);
    expect(await table(admin, 'SeRvEr2')).toEqual([2]);
    expect(await table(admin, 'server 2')).toEqual([2]);
    expect(await table(admin, '  server   2 ')).toEqual([2]);
  });

  it('the Servers table and the form suggestions (fields=summary, all=true) return the same matches', async () => {
    for (const term of [
      'server1',
      'SERVER 1',
      'server 2',
      'disk_01',
      '198.51',
    ]) {
      expect(await suggestions(admin, term)).toEqual(await table(admin, term));
    }
    const all = (await service.getServers(admin, {
      search: 'server1',
      fields: 'summary',
      all: 'true',
    })) as any[];
    expect(all.map((r) => r.id).sort()).toEqual([1, 3]);
  });

  it('suggestion rows contain no username, password or other credential values', async () => {
    const res: any = await service.getServers(admin, {
      search: 'server1',
      limit: '5',
      fields: 'summary',
    });
    expect(res.results.length).toBeGreaterThan(0);
    for (const row of res.results) {
      expect(Object.keys(row).sort()).toEqual([
        'id',
        'ip_address',
        'name',
        'owner',
        'provider',
        'server_ip',
      ]);
    }
    expect(JSON.stringify(res)).not.toMatch(/gcm1|root|password|username/);
  });

  it("keeps the non-admin project scope: a matching server outside the user's projects is not returned", async () => {
    expect(await table(staff, 'server1')).toEqual([1]); // "server 1 backup" belongs to project 9
    expect(await suggestions(staff, 'server 1')).toEqual([1]);
    expect(prisma.server.findMany.mock.calls.at(-1)[0].where.domains).toEqual({
      some: { project_id: { in: [3] } },
    });
    prisma.projectMember.findMany.mockResolvedValueOnce([]);
    await expect(
      service.getServers(staff, { search: 'server1' }),
    ).resolves.toEqual({ count: 0, next: null, previous: null, results: [] });
  });

  it('%, _ and backslash in the term match literally', async () => {
    expect(await table(admin, 'disk_01')).toEqual([4]);
    expect(await table(admin, '50%off')).toEqual([6]);
    expect(await table(admin, 'back\\slash')).toEqual([8]);
    expect(compactLikePattern(' 50% off_\\! ')).toBe('%50!%off!_\\!!%');
  });

  it('the query is parameterized: the term is a bound value, never part of the SQL text; only ids are read', async () => {
    await service.getServers(admin, { search: "x' OR 1=1 --" });
    const sql = prisma.$queryRaw.mock.calls.at(-1)[0];
    expect(sql.sql).toBe(
      "SELECT id FROM servers WHERE REPLACE(LOWER(name), ' ', '') LIKE ? ESCAPE '!'",
    );
    expect(sql.values).toEqual(["%x'or1=1--%"]);
  });

  it('runs only when at least 2 characters remain without spaces', async () => {
    await service.getServers(admin, { search: ' s ' });
    await service.getServers(admin, {});
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    await service.getServers(admin, { search: 's 1' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.calls[0][0].values).toEqual(['%s1%']);
  });

  it('the other fields keep their substring match (IPs, notes, provider)', async () => {
    expect(await table(admin, '203.0.113')).toEqual([1]);
    expect(await table(admin, '198.51')).toEqual([2]);
    expect(await table(admin, 'MAIL BOX')).toEqual([2]);
    expect(await table(admin, 'mailbox')).toEqual([]); // notes are not compared without spaces
    expect(await table(admin, 'Hetzner')).toEqual([1]);
  });

  it('the exact duplicate warning still treats "server1" and "server 1" as different names', async () => {
    await expect(
      service.checkServerDuplicates({ name: 'server1' }),
    ).resolves.toEqual({ name: false, ip: false });
    await expect(
      service.checkServerDuplicates({ name: ' SERVER 1 ' }),
    ).resolves.toEqual({ name: true, ip: false });
    await expect(
      service.checkServerDuplicates({ name: 'server 2' }),
    ).resolves.toEqual({ name: false, ip: false });
  });
});
