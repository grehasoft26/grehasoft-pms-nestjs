import * as fs from 'fs';
import * as path from 'path';
import { UsersService } from './users/users.service';
import { DepartmentsService } from './departments/departments.service';
import { TaskTypesService } from './tasks/task-types.service';
import { ProjectsService } from './projects/projects.service';
import { TasksService } from './tasks/tasks.service';
import { LeadsService } from './crm/leads.service';
import { ProposalsService } from './proposals/proposals.service';
import { SeoService } from './seo/seo.service';

/**
 * List searches in eight services. On MySQL/MariaDB, Prisma has no `mode: 'insensitive'` (it threw
 * "Unknown argument `mode`", so every search failed with a 500); plain `contains` is already a
 * case-insensitive partial match because the searched columns use utf8mb4_unicode_ci. Each service
 * runs against a Prisma mock that records the `where` it receives.
 */

/** Prisma mock: every model's list/count calls are recorded; lookups return nothing. */
const buildPrisma = (overrides: Record<string, any> = {}) => {
  const models: Record<string, any> = {};
  const model = () => ({
    findMany: jest.fn(async () => []),
    count: jest.fn(async () => 0),
    findFirst: jest.fn(async () => null),
    findUnique: jest.fn(async () => null),
  });
  return new Proxy(overrides, {
    get: (target, name: string) => target[name] ?? (models[name] ??= model()),
  }) as any;
};

// SeoService's other dependencies (credential encryption and audit) are not used by keyword search
const seoService = (prisma: any): SeoService => new (SeoService as any)(prisma, {}, {});

const superAdmin = { id: 1, username: 'owner', is_superuser: true, role: { name: 'SUPER_ADMIN', permissions: [] } };
const staff = { id: 7, username: 'dev', role: { name: 'DEVELOPER', permissions: [] } };

interface Case {
  name: string;
  file: string;
  model: string;
  make: (prisma: any) => any;
  list: (svc: any, query: Record<string, any>) => Promise<unknown>;
  /** The text filter part of `where` for a term */
  filter: (term: string) => Record<string, unknown>;
}

const anyOf = (...fields: string[]) => (term: string) => ({
  OR: fields.map((f) => {
    const [first, second] = f.split('.');
    return second ? { [first]: { [second]: { contains: term } } } : { [first]: { contains: term } };
  }),
});

const CASES: Case[] = [
  {
    name: 'users',
    file: 'users/users.service.ts',
    model: 'user',
    make: (p) => new UsersService(p),
    list: (s, q) => s.findAll(q),
    filter: anyOf('name', 'username', 'email'),
  },
  {
    name: 'departments',
    file: 'departments/departments.service.ts',
    model: 'department',
    make: (p) => new DepartmentsService(p),
    list: (s, q) => s.findAll(q),
    filter: (term) => ({ name: { contains: term } }),
  },
  {
    name: 'task types',
    file: 'tasks/task-types.service.ts',
    model: 'taskType',
    make: (p) => new TaskTypesService(p),
    list: (s, q) => s.findAll(q),
    filter: anyOf('name', 'description'),
  },
  {
    name: 'projects',
    file: 'projects/projects.service.ts',
    model: 'project',
    make: (p) => new ProjectsService(p),
    list: (s, q) => s.findAll(superAdmin, q),
    filter: anyOf('name', 'description', 'client.name', 'client.company_name'),
  },
  {
    name: 'tasks',
    file: 'tasks/tasks.service.ts',
    model: 'task',
    make: (p) => new TasksService(p, {} as any, {} as any),
    list: (s, q) => s.findAll(superAdmin, q),
    filter: anyOf('title', 'description'),
  },
  {
    name: 'leads',
    file: 'crm/leads.service.ts',
    model: 'lead',
    make: (p) => new LeadsService(p),
    list: (s, q) => s.findAll(superAdmin, q),
    filter: anyOf('name', 'company_name', 'email', 'phone'),
  },
  {
    name: 'proposals',
    file: 'proposals/proposals.service.ts',
    model: 'proposal',
    make: (p) => new ProposalsService(p, {} as any, {} as any),
    list: (s, q) => s.findAll(superAdmin, q),
    filter: anyOf('title', 'description'),
  },
  {
    name: 'SEO keywords',
    file: 'seo/seo.service.ts',
    model: 'sEOKeyword',
    make: (p) => seoService(p),
    list: (s, q) => s.getKeywords(superAdmin, q),
    filter: (term) => ({ keyword: { contains: term } }),
  },
];

/** Every `where` the model's findMany and count received. */
const wheres = (prisma: any, modelName: string) =>
  [...prisma[modelName].findMany.mock.calls, ...prisma[modelName].count.mock.calls].map(([args]: any) => args?.where);
const hasMode = (value: unknown) => /"mode"\s*:/.test(JSON.stringify(value));

describe.each(CASES)('$name list search (MySQL-compatible)', (c) => {
  let prisma: any;
  let service: any;
  beforeEach(() => {
    prisma = buildPrisma();
    service = c.make(prisma);
  });

  it.each([['paginated', { page: '1' }], ['all=true', { all: 'true' }]])('%s: partial match on every searched field, no `mode`', async (_label, extra) => {
    await c.list(service, { ...extra, search: 'royal' });
    const seen = wheres(prisma, c.model);
    expect(seen.length).toBeGreaterThan(0);
    for (const where of seen) {
      expect(where).toMatchObject(c.filter('royal'));
      expect(hasMode(where)).toBe(false);
    }
  });

  it('trims the term (the database collation handles case)', async () => {
    await c.list(service, { page: '1', search: '  KanGan \t' });
    for (const where of wheres(prisma, c.model)) expect(where).toMatchObject(c.filter('KanGan'));
  });

  it.each([[undefined], [''], ['   ']])('applies no text filter for search %p', async (search) => {
    await c.list(service, { page: '1', search });
    const seen = wheres(prisma, c.model);
    expect(seen.length).toBeGreaterThan(0);
    for (const where of seen) expect(JSON.stringify(where ?? {})).not.toContain('"contains"');
  });

  it('count and page use the same `where` (result counts match the filtered rows)', async () => {
    await c.list(service, { page: '1', search: 'royal' });
    const [countWhere] = prisma[c.model].count.mock.calls.map(([args]: any) => args?.where);
    const [listWhere] = prisma[c.model].findMany.mock.calls.map(([args]: any) => args?.where);
    if (countWhere !== undefined) expect(countWhere).toEqual(listWhere);
  });
});

describe('existing filters and scoping are kept next to the search', () => {
  const lastWhere = (prisma: any, model: string) => prisma[model].findMany.mock.calls.at(-1)[0].where;

  it('users: active flag and role filter', async () => {
    const prisma = buildPrisma();
    await new UsersService(prisma).findAll({ page: '1', search: 'ann', is_active: 'true', role_name: 'DEVELOPER, DESIGNER' });
    expect(lastWhere(prisma, 'user')).toMatchObject({ is_active: true, role: { name: { in: ['DEVELOPER', 'DESIGNER'] } }, OR: expect.any(Array) });
  });

  it('departments and task types: soft-deleted rows stay excluded', async () => {
    const p1 = buildPrisma();
    await new DepartmentsService(p1).findAll({ page: '1', search: 'ops' });
    expect(lastWhere(p1, 'department')).toEqual({ deleted_at: null, name: { contains: 'ops' } });
    const p2 = buildPrisma();
    await new TaskTypesService(p2).findAll({ page: '1', search: 'bug' });
    expect(lastWhere(p2, 'taskType')).toMatchObject({ deleted_at: null, OR: expect.any(Array) });
  });

  it('projects: status, client and the staff project scope', async () => {
    const prisma = buildPrisma();
    await new ProjectsService(prisma).findAll(staff, { page: '1', search: 'royal', status: 'in_progress', client: '4' });
    expect(lastWhere(prisma, 'project')).toMatchObject({
      status: 'in_progress',
      client_id: 4,
      OR: anyOf('name', 'description', 'client.name', 'client.company_name')('royal').OR,
      AND: [{ OR: [{ members: { some: { user_id: 7 } } }, { project_manager_id: 7 }, { created_by_id: 7 }] }],
    });
  });

  it('tasks: project, status, priority and the staff project scope', async () => {
    const prisma = buildPrisma();
    await new TasksService(prisma, {} as any, {} as any).findAll(staff, { page: '1', search: 'fix', project: '3', status: 'todo', priority: 'high' });
    expect(lastWhere(prisma, 'task')).toMatchObject({
      deleted_at: null,
      project_id: 3,
      status: 'todo',
      priority: 'high',
      OR: [{ title: { contains: 'fix' } }, { description: { contains: 'fix' } }],
      project: { OR: expect.any(Array) },
    });
  });

  it('leads: status and the sales executive assignment scope', async () => {
    const prisma = buildPrisma();
    const exec = { id: 12, role: { name: 'SALES_EXECUTIVE', permissions: [] } };
    await new LeadsService(prisma).findAll(exec, { page: '1', search: '98765', status: 'new' });
    expect(lastWhere(prisma, 'lead')).toMatchObject({
      deleted_at: null,
      status: 'new',
      OR: expect.arrayContaining([{ phone: { contains: '98765' } }]),
      assignments: { some: { sales_exec_id: 12 } },
    });
  });

  it('proposals: lead, status and the client scope', async () => {
    const prisma = buildPrisma({ client: { findFirst: jest.fn(async () => ({ id: 5 })) } });
    const clientUser = { id: 30, role: { name: 'CLIENT', permissions: [] } };
    await new ProposalsService(prisma, {} as any, {} as any).findAll(clientUser, { page: '1', search: 'seo', status: 'sent', lead: '9' });
    expect(lastWhere(prisma, 'proposal')).toMatchObject({ lead_id: 9, status: 'sent', client_id: 5, OR: expect.any(Array) });
  });

  it('SEO keywords: website filter and executive / client scope', async () => {
    const p1 = buildPrisma();
    await seoService(p1).getKeywords({ id: 8, role: { name: 'SEO_EXECUTIVE' } }, { page: '1', search: 'battery', website: '2' });
    expect(lastWhere(p1, 'sEOKeyword')).toEqual({ website_id: 2, keyword: { contains: 'battery' }, website: { assigned_executive_id: 8 } });

    const p2 = buildPrisma();
    await seoService(p2).getKeywords({ id: 9, role: { name: 'CLIENT' }, client_id: 4 }, { page: '1', search: 'battery' });
    expect(lastWhere(p2, 'sEOKeyword')).toEqual({ keyword: { contains: 'battery' }, website: { client_id: 4 } });
  });
});

it("none of the eight search implementations uses Prisma's unsupported `mode: 'insensitive'`", () => {
  for (const { file } of CASES) {
    // Comments may mention it; code may not
    const code = fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect({ file, usesMode: /mode\s*:\s*['"]insensitive['"]/.test(code) }).toEqual({ file, usesMode: false });
  }
});
