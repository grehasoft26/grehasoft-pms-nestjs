import { ProjectsService } from './projects/projects.service';
import { LeadsService } from './crm/leads.service';
import { TaskTypesService } from './tasks/task-types.service';
import { ClientsService } from './projects/clients.service';
import { InfrastructureService } from './infrastructure/infrastructure.service';

/**
 * Pickers and shared lists in the frontend now ask for the complete list (search audit, batch 5):
 * `all=true` for projects, leads, task types, website credentials, domains and servers, and every
 * page of the paginated clients list (`limit=100`). These checks pin what makes that safe: the
 * complete list uses exactly the same `where` (access scope included) as the paginated list the
 * user can already page through, only without the 5-row page, and credential passwords stay masked.
 */
const admin = {
  id: 1,
  is_superuser: true,
  role: { name: 'SUPER_ADMIN', permissions: [] },
  role_name: 'SUPER_ADMIN',
};
const staff = {
  id: 7,
  is_superuser: false,
  role: { name: 'DEVELOPER', permissions: [] },
  role_name: 'DEVELOPER',
};
const salesExec = {
  id: 9,
  is_superuser: false,
  role: { name: 'SALES_EXECUTIVE', permissions: [] },
  role_name: 'SALES_EXECUTIVE',
};

/** A Prisma model whose findMany returns `rows` and records its arguments. */
const model = (rows: any[] = []) => ({
  findMany: jest.fn(async (args: any = {}) =>
    args.take !== undefined
      ? rows.slice(args.skip ?? 0, (args.skip ?? 0) + args.take)
      : rows,
  ),
  count: jest.fn(async () => rows.length),
});
const lastArgs = (m: any) => m.findMany.mock.calls.at(-1)[0];

/** Calls the paginated and the complete list for the same user and returns both findMany calls. */
const both = async (m: any, list: (all: boolean) => Promise<any>) => {
  await list(false);
  const paged = lastArgs(m);
  const full = await list(true);
  return { paged, all: lastArgs(m), full };
};

describe("complete lists for pickers keep the paginated list's access scope", () => {
  it('projects: same scoped where for staff and admins; no page limit', async () => {
    const prisma: any = { project: model() };
    const service = new ProjectsService(prisma);
    for (const user of [staff, admin]) {
      const { paged, all } = await both(prisma.project, (full) =>
        service.findAll(user, full ? { all: 'true' } : {}),
      );
      expect(all.where).toEqual(paged.where);
      expect(paged.take).toBe(5);
      expect(all.take).toBeUndefined();
    }
    // Staff are scoped (members, managers, creators); the complete list keeps it
    await service.findAll(staff, { all: 'true' });
    expect(lastArgs(prisma.project).where.AND).toBeDefined();
  });

  it('leads: a sales executive still gets only assigned leads', async () => {
    const prisma: any = { lead: model() };
    const service = new LeadsService(prisma);
    const { paged, all } = await both(prisma.lead, (full) =>
      service.findAll(salesExec, full ? { all: 'true' } : {}),
    );
    expect(all.where).toEqual(paged.where);
    expect(all.where.assignments).toEqual({ some: { sales_exec_id: 9 } });
    expect(all.take).toBeUndefined();
  });

  it('task types: same filter (non-deleted), every type returned', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      name: `Type ${i + 1}`,
    }));
    const prisma: any = { taskType: model(rows) };
    const service = new TaskTypesService(prisma);
    const { paged, all, full } = await both(prisma.taskType, (f) =>
      service.findAll(f ? { all: 'true' } : {}),
    );
    expect(all.where).toEqual(paged.where);
    expect(full).toHaveLength(8);
  });

  it('domains and servers: project scope kept for staff, every record returned, server passwords masked', async () => {
    const domains = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      domain_name: `d${i}.com`,
      project_id: 3,
      server_id: null,
      project: { id: 3, name: 'P' },
      server: null,
    }));
    const servers = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      name: `s${i}`,
      password: 'gcm1:secret',
    }));
    const prisma: any = {
      domain: model(domains),
      server: model(servers),
      projectMember: { findMany: jest.fn(async () => [{ project_id: 3 }]) },
    };
    const service = new (InfrastructureService as any)(
      prisma,
      {},
      { record: jest.fn() },
    ) as InfrastructureService;

    const d = await both(prisma.domain, (f) =>
      service.getDomains(staff, f ? { all: 'true' } : {}),
    );
    expect(d.all.where).toEqual(d.paged.where);
    expect(d.all.where.project_id).toEqual({ in: [3] });
    expect(d.full).toHaveLength(8);

    const s = await both(prisma.server, (f) =>
      service.getServers(staff, f ? { all: 'true' } : {}),
    );
    expect(s.all.where).toEqual(s.paged.where);
    expect(s.all.where.domains).toEqual({ some: { project_id: { in: [3] } } });
    expect(s.full).toHaveLength(8);
    expect(JSON.stringify(s.full)).not.toContain('gcm1:secret');
  });

  it('clients: the shared list pages through the normal list (limit=100), the same rows the Clients page shows', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      company_name: `Client ${i + 1}`,
      name: `C${i + 1}`,
      portal_users: [],
    }));
    const prisma: any = { client: model(rows) };
    const service = new ClientsService(prisma);
    const page1: any = await service.findAll(admin, {
      page: '1',
      limit: '100',
    });
    expect(lastArgs(prisma.client).take).toBe(100);
    expect(page1.count).toBe(8);
    expect(page1.results).toHaveLength(8); // beyond the default 5
    // Same where as the default page of the Clients page
    await service.findAll(admin, {});
    const defaultWhere = lastArgs(prisma.client).where;
    await service.findAll(admin, { page: '1', limit: '100' });
    expect(lastArgs(prisma.client).where).toEqual(defaultWhere);
  });
});
