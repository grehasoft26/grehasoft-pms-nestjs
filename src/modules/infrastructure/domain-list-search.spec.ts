import { InfrastructureService } from './infrastructure.service';

/**
 * GET /infrastructure/domains?search= (used by the Domains page and the /infrastructure page):
 * partial, case-insensitive matching over every visible domain, not only the requested page. The
 * fake evaluates the service's `where` like MySQL with the utf8mb4_unicode_ci collation (LIKE
 * '%term%' ignoring case) and applies skip/take.
 */
const admin = { id: 1, is_superuser: true, role: { name: 'SUPER_ADMIN', permissions: [] } };
const staff = { id: 7, role: { name: 'DEVELOPER', permissions: [] } };

// 12 domains in expiry order; royalkangan.com is the 11th, i.e. on page 3 of 5 per page
const NAMES = ['alpha.com', 'beta.io', 'gamma.net', 'delta.org', 'epsilon.in', 'zeta.com', 'eta.dev', 'theta.app', 'iota.ae', 'kappa.uk', 'royalkangan.com', 'lambda.co'];
const ROWS = NAMES.map((domain_name, i) => ({
  id: i + 1,
  domain_name,
  provider: i % 2 ? 'GoDaddy' : 'Grehasoft Cloud',
  status: i === 10 ? 'expired' : 'active',
  project_id: i < 6 ? 100 : 200,
  project: { id: i < 6 ? 100 : 200, name: i < 6 ? 'Retail Site' : 'Royal Portal' },
  server: { id: 9, name: 'Hetzner-1' },
  server_id: 9,
  expiry_date: new Date(Date.UTC(2027, 0, 1 + i)),
}));

const like = (value: unknown, term: string) => String(value ?? '').toLowerCase().includes(term.toLowerCase());
const matches = (row: any, where: any): boolean =>
  (!where.status || row.status === where.status) &&
  (!where.project_id?.in || where.project_id.in.includes(row.project_id)) &&
  (!where.OR ||
    where.OR.some(
      (c: any) =>
        (c.domain_name && like(row.domain_name, c.domain_name.contains)) ||
        (c.provider && like(row.provider, c.provider.contains)) ||
        (c.project && like(row.project?.name, c.project.name.contains)) ||
        (c.server && like(row.server?.name, c.server.name.contains)),
    )) &&
  (!where.AND || where.AND.every((c: any) => !c.expiry_date?.lt || row.expiry_date < c.expiry_date.lt));

const buildPrisma = () => ({
  domain: {
    count: jest.fn(async ({ where }: any) => ROWS.filter((r) => matches(r, where)).length),
    findMany: jest.fn(async ({ where, skip = 0, take }: any) => {
      const hits = ROWS.filter((r) => matches(r, where));
      return take === undefined ? hits : hits.slice(skip, skip + take);
    }),
  },
  projectMember: { findMany: jest.fn(async () => [{ project_id: 200 }]) },
});

describe('Domain list search across all pages', () => {
  let prisma: ReturnType<typeof buildPrisma>;
  let service: InfrastructureService;
  beforeEach(() => {
    prisma = buildPrisma();
    // Only Prisma is used by getDomains (the constructor's other dependencies vary by branch)
    service = new (InfrastructureService as any)(prisma, {}, {});
  });
  const names = (res: any) => res.results.map((d: any) => d.domain_name);

  it('the target is beyond the first page when nothing is searched', async () => {
    const page1: any = await service.getDomains(admin, { page: '1', limit: '5' });
    expect(page1.count).toBe(12);
    expect(names(page1)).not.toContain('royalkangan.com');
    expect(names(await service.getDomains(admin, { page: '3', limit: '5' }))).toContain('royalkangan.com');
  });

  it.each([['royal'], ['kangan'], ['KANGAN'], ['RoyalKangan'], ['  kangan  ']])('"%s" finds royalkangan.com on page 1 (partial, case-insensitive, trimmed)', async (search) => {
    const res: any = await service.getDomains(admin, { page: '1', limit: '5', search });
    expect(names(res)).toContain('royalkangan.com');
    // "royal" also matches the "Royal Portal" project: the count covers every match, not one page
    const term = search.trim();
    expect(res.count).toBe(ROWS.filter((r) => [r.domain_name, r.provider, r.project.name, r.server.name].some((v) => like(v, term))).length);
  });

  it('matches every searched field: domain, provider, project and server name', async () => {
    expect((await service.getDomains(admin, { page: '1', limit: '50', search: 'godaddy' }) as any).count).toBe(6);
    expect((await service.getDomains(admin, { page: '1', limit: '50', search: 'retail' }) as any).count).toBe(6);
    expect((await service.getDomains(admin, { page: '1', limit: '50', search: 'hetzner' }) as any).count).toBe(12);
  });

  it('an empty or blank search lists everything, paginated', async () => {
    for (const search of ['', '   ', undefined]) {
      const res: any = await service.getDomains(admin, { page: '1', limit: '5', search } as any);
      expect(res.count).toBe(12);
      expect(res.results).toHaveLength(5);
    }
  });

  it('paginates the matches: count, pages and next link cover matching domains only', async () => {
    // Expected matches computed from the fixture
    const expected = ROWS.filter((r) => [r.domain_name, r.provider, r.project.name, r.server.name].some((v) => like(v, 'ta'))).length;
    const page1: any = await service.getDomains(admin, { page: '1', limit: '5', search: 'ta' });
    expect(page1.count).toBe(expected);
    const all: string[] = [];
    for (let p = 1; p <= Math.ceil(expected / 5); p++) all.push(...names(await service.getDomains(admin, { page: String(p), limit: '5', search: 'ta' })));
    expect(all).toHaveLength(expected);
    expect(new Set(all).size).toBe(expected);
  });

  it('combines with the status and expiry filters', async () => {
    expect(names(await service.getDomains(admin, { page: '1', limit: '5', search: 'royal', status: 'expired' }))).toEqual(['royalkangan.com']);
    expect((await service.getDomains(admin, { page: '1', limit: '5', search: 'royal', status: 'active' }) as any).results.map((d: any) => d.domain_name)).not.toContain('royalkangan.com');
    // Expired before 2027-01-05: the first four domains; none matches "royal"
    expect((await service.getDomains(admin, { page: '1', limit: '5', search: 'royal', expiry: 'expired', today: '2027-01-05' }) as any).count).toBe(0);
  });

  it('keeps the project scope for non-admins: only their projects are searched', async () => {
    const res: any = await service.getDomains(staff, { page: '1', limit: '50', search: 'a' });
    expect(res.results.every((d: any) => d.project_id === 200)).toBe(true);
    expect(prisma.domain.findMany.mock.calls.at(-1)![0].where).toMatchObject({ project_id: { in: [200] }, OR: expect.any(Array) });
    // A domain outside the user's projects is not found, even by exact name
    expect((await service.getDomains(staff, { page: '1', limit: '5', search: 'alpha.com' }) as any).count).toBe(0);
  });
});
