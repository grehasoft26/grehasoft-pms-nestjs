import { SeoReportsService } from './seo-reports/seo-reports.service';
import { SeoService } from './seo/seo.service';
import { InfrastructureService } from './infrastructure/infrastructure.service';

/**
 * Search fields the list UIs promise (search inventory, batch 3):
 * - SEO reports "Search title, client, domain...": also the company name and the domain URL;
 * - SEO tasks "Search by task title, website, or executive...": also the executive's name/username;
 * - Servers: also server_ip (an IP may be stored there instead of ip_address).
 * The fake evaluates each `where` like MySQL with utf8mb4_unicode_ci (LIKE '%term%' ignoring case).
 */
const like = (value: unknown, term: unknown) => String(value ?? '').toLowerCase().includes(String(term).toLowerCase());
const matchWhere = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([key, cond]: [string, any]) => {
    if (key === 'OR') return cond.some((c: any) => matchWhere(row, c));
    if (key === 'AND') return cond.every((c: any) => matchWhere(row, c));
    if (key === 'NOT') return !matchWhere(row, cond);
    const value = row?.[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('contains' in cond) return like(value, cond.contains);
      if ('in' in cond) return cond.in.includes(value);
      if ('lt' in cond) return value < cond.lt;
      if ('not' in cond) return value !== cond.not;
      return matchWhere(value ?? {}, cond); // relation filter
    }
    return value === cond;
  });
const fakeModel = (rows: any[]) => ({
  count: jest.fn(async ({ where }: any = {}) => rows.filter((r) => matchWhere(r, where)).length),
  findMany: jest.fn(async ({ where, skip = 0, take }: any = {}) => {
    const hits = rows.filter((r) => matchWhere(r, where));
    return take === undefined ? hits : hits.slice(skip, skip + take);
  }),
});
const ids = (list: any[]) => list.map((r) => r.id).sort((a, b) => a - b);

const manager = { id: 1, is_superuser: true, role: { name: 'SUPER_ADMIN', permissions: [] }, role_name: 'SUPER_ADMIN' };

describe('SEO reports search: title, client/company name, website name/domain', () => {
  const clientA = { id: 10, name: 'Ravi Kumar', company_name: 'Al Bayan Trading LLC' };
  const clientB = { id: 11, name: 'Meera', company_name: 'Royal Kangan Jewellers' };
  const reportRow = (id: number, client: any, website: any, title: string, status = 'published') => ({
    id,
    client_id: client.id,
    website_id: website.id,
    report_title: title,
    status,
    report_month: '2026-09',
    client,
    website,
    created_by: { id: 1, name: 'Admin' },
    approved_by: null,
  });
  const ROWS = [
    reportRow(1, clientA, { id: 100, website_name: 'Battery Experts', domain_url: 'batteryexpertsuae.com' }, 'September SEO Report'),
    reportRow(2, clientB, { id: 101, website_name: 'Royal Store', domain_url: 'RoyalKangan.com' }, 'Monthly Report'),
    reportRow(3, clientB, { id: 102, website_name: 'Kangan Blog', domain_url: 'blog.example.org' }, 'Blog Report', 'draft'),
  ];
  let prisma: any;
  let service: SeoReportsService;
  beforeEach(() => {
    prisma = { sEOReport: fakeModel(ROWS), client: { findFirst: jest.fn(async () => clientB) } };
    service = new (SeoReportsService as any)(prisma, {});
  });
  const search = async (user: any, query: any) => ids(((await service.findAll(user, query)) as any).results);

  it.each([
    ['domain URL, partial and mixed case', 'kanGAN.COM', [2]],
    ['domain URL, other report', 'batteryexperts', [1]],
    ['company name, partial and mixed case', 'al BAYAN', [1]],
    ['company name, other client', 'jewellers', [2, 3]],
    ['client name (as before)', 'meera', [2, 3]],
    ['report title (as before)', 'september', [1]],
    ['website name (as before)', 'kangan blog', [3]],
  ])('%s: "%s"', async (_label, term, expected) => {
    expect(await search(manager, { search: term })).toEqual(expected);
  });

  it('trims the term; an empty or blank term applies no text filter', async () => {
    expect(await search(manager, { search: '  bayan  ' })).toEqual([1]);
    for (const term of ['', '   ', undefined]) expect(await search(manager, { search: term })).toEqual([1, 2, 3]);
    expect(prisma.sEOReport.findMany.mock.calls.at(-1)[0].where).toEqual({});
  });

  it('keeps the other filters next to the search', async () => {
    expect(await search(manager, { search: 'kangan', status: 'draft' })).toEqual([3]);
    expect(await search(manager, { search: 'report', website_id: '101' })).toEqual([2]);
  });

  it('CLIENT users still see only their own published reports, whatever they search', async () => {
    const clientUser = { id: 50, client_id: 11, role: { name: 'CLIENT', permissions: [] }, role_name: 'CLIENT' };
    expect(await search(clientUser, { search: 'kangan' })).toEqual([2]); // report 3 is a draft
    expect(await search(clientUser, { search: 'bayan' })).toEqual([]); // another client's report
    expect(await search(clientUser, { search: 'kangan', client_id: '10' })).toEqual([2]); // cannot widen
  });

  it('count and page use the same filter', async () => {
    const res: any = await service.findAll(manager, { search: 'kangan' });
    expect(res.count).toBe(res.results.length);
    expect(prisma.sEOReport.count.mock.calls.at(-1)[0].where).toEqual(prisma.sEOReport.findMany.mock.calls.at(-1)[0].where);
  });
});

describe('SEO tasks search: title, description, website, executive name/username', () => {
  const execA = { id: 21, name: 'Anjali Nair', username: 'anjali.n' };
  const execB = { id: 22, name: '', username: 'vishnu_seo' };
  const taskRow = (id: number, exec: any, title: string, website_name: string, priority = 'medium') => ({
    id,
    title,
    description: '',
    priority,
    status: 'pending',
    due_date: new Date('2030-01-01'),
    website_id: id,
    assigned_executive_id: exec.id,
    activity_type_id: null,
    website: { id, website_name },
    assigned_executive: exec,
    created_by: { id: 1, name: 'Admin', username: 'admin' },
    activity_type: null,
  });
  const ROWS = [
    taskRow(1, execA, 'Fix meta tags', 'Battery Experts', 'high'),
    taskRow(2, execB, 'Backlinks', 'Royal Store'),
    taskRow(3, execA, 'GBP posts', 'Royal Store'),
  ];
  let prisma: any;
  let service: SeoService;
  beforeEach(() => {
    prisma = { sEOTask: fakeModel(ROWS) };
    // Only Prisma is used by getTasks (the constructor's other dependencies vary by branch)
    service = new (SeoService as any)(prisma, {}, {});
  });
  const search = async (user: any, query: any) => ids(((await service.getTasks(user, query)) as any).results);

  it.each([
    ['executive name, partial and mixed case', 'ANJALI', [1, 3]],
    ['executive surname', 'nair', [1, 3]],
    ['executive username (shown when the name is empty)', 'Vishnu', [2]],
    ['title (as before)', 'meta', [1]],
    ['website (as before)', 'royal', [2, 3]],
  ])('%s: "%s"', async (_label, term, expected) => {
    expect(await search(manager, { search: term })).toEqual(expected);
  });

  it('trims the term; an empty or blank term applies no text filter', async () => {
    expect(await search(manager, { search: '\t anjali ' })).toEqual([1, 3]);
    for (const term of ['', '  ', undefined]) expect(await search(manager, { search: term })).toEqual([1, 2, 3]);
  });

  it('keeps the website, executive and priority filters next to the search', async () => {
    expect(await search(manager, { search: 'anjali', priority: 'high' })).toEqual([1]);
    expect(await search(manager, { search: 'royal', executive: '22' })).toEqual([2]);
  });

  it("an SEO executive still sees only their own tasks, even when searching another executive's name", async () => {
    const executive = { id: 21, role: { name: 'SEO_EXECUTIVE', permissions: [] }, role_name: 'SEO_EXECUTIVE' };
    expect(await search(executive, { search: 'vishnu' })).toEqual([]);
    expect(await search(executive, { search: 'royal' })).toEqual([3]);
  });

  it('the summary counts use the same search', async () => {
    const res: any = await service.getTasks(manager, { search: 'anjali' });
    expect(res.count).toBe(2);
    expect(res.stats).toMatchObject({ total: 2, pending: 2, in_progress: 0, completed: 0 });
  });
});

describe('Servers search: server_ip as well as ip_address', () => {
  const ROWS = [
    { id: 1, name: 'Prod-Web', provider: 'Hetzner', notes: '', owner: 'Grehasoft', ip_address: '203.0.113.10', server_ip: '', expiry_date: null },
    { id: 2, name: 'Legacy-Mail', provider: 'OVH', notes: '', owner: '', ip_address: '', server_ip: '198.51.100.7', expiry_date: null },
    { id: 3, name: 'Staging', provider: 'DigitalOcean', notes: 'old box', owner: '', ip_address: null, server_ip: null, expiry_date: null },
  ];
  let service: InfrastructureService;
  beforeEach(() => {
    // $queryRaw: the name-ignoring-spaces match (server-name-search.spec); none of these terms need it
    service = new (InfrastructureService as any)(
      { server: fakeModel(ROWS), $queryRaw: async () => [] },
      {},
      {},
    );
  });
  const search = async (term: any) => ids(((await service.getServers(manager, { search: term, limit: '50' })) as any).results);

  it('finds a server whose IP is only in server_ip (partial)', async () => {
    expect(await search('198.51')).toEqual([2]);
    expect(await search('100.7')).toEqual([2]);
  });

  it('still finds ip_address, name and the other fields (mixed case, trimmed)', async () => {
    expect(await search('203.0.113')).toEqual([1]);
    expect(await search('  prod-WEB ')).toEqual([1]);
    expect(await search('OLD BOX')).toEqual([3]);
    expect(await search('   ')).toEqual([1, 2, 3]);
  });
});
