import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ClientPortalService } from './client-portal.service';

/**
 * Client document vault (GET /dashboard/documents): search, type, date range and pagination on
 * the server, always limited to the user's own client. The fake evaluates the service's `where`
 * like MySQL with utf8mb4_unicode_ci (LIKE '%term%' ignoring case) and applies order/skip/take.
 */
const like = (value: unknown, term: unknown) => String(value ?? '').toLowerCase().includes(String(term).toLowerCase());
const matchWhere = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([key, cond]: [string, any]) => {
    if (key === 'OR') return cond.some((c: any) => matchWhere(row, c));
    if (key === 'AND') return cond.every((c: any) => matchWhere(row, c));
    const value = row?.[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('contains' in cond) return like(value, cond.contains);
      if ('in' in cond) return cond.in.includes(value);
      if ('gte' in cond || 'lt' in cond) return (!cond.gte || value >= cond.gte) && (!cond.lt || value < cond.lt);
      return matchWhere(value ?? {}, cond); // relation filter
    }
    return value === cond;
  });

const PROJECTS: any[] = [
  { id: 1, client_id: 10, name: 'Royal Kangan Website', deleted_at: null },
  { id: 2, client_id: 10, name: 'Mobile App', deleted_at: null },
  { id: 3, client_id: 20, name: 'Other Corp Portal', deleted_at: null },
  // Soft-deleted project of client 10 (its file 26 must never be listed)
  { id: 4, client_id: 10, name: 'Archived Site', deleted_at: new Date('2026-09-01') },
];
const project = (id: number) => PROJECTS.find((p) => p.id === id)!;
// 25 files: ids 1-22 belong to client 10 (projects 1 and 2), 23-25 to client 20 (project 3).
// Uploaded one day apart from 2026-10-01, newest last.
const FILES = Array.from({ length: 25 }, (_, i) => {
  const id = i + 1;
  const projectId = id > 22 ? 3 : id % 2 ? 1 : 2;
  return {
    id,
    file: `task_files/task_${id}_1760000000000_abc${id}.pdf`,
    file_path: id === 7 ? 'Homepage-Design-FINAL.pdf' : id === 24 ? 'Secret-Contract.pdf' : `deliverable-${id}.pdf`,
    uploaded_at: new Date(Date.UTC(2026, 9, 1 + i, 10, 30)),
    deleted_at: null as Date | null,
    task: { id: 100 + id, project_id: projectId, deleted_at: null as Date | null, project: project(projectId) },
  };
});
// Soft-deleted rows of client 10 that must never be listed: a deleted file (27), a file of a
// deleted task (28), and a file of a deleted project (26)
const hiddenRow = (id: number, projectId: number, extra: any) => ({
  id,
  file: `task_files/task_${id}_1760000000000_hidden.pdf`,
  file_path: `hidden-${id}-royal.pdf`,
  uploaded_at: new Date(Date.UTC(2026, 9, 5, 12)),
  deleted_at: null as Date | null,
  task: { id: 100 + id, project_id: projectId, deleted_at: null as Date | null, project: project(projectId) },
  ...extra,
});
FILES.push(
  hiddenRow(26, 4, {}),
  hiddenRow(27, 1, { deleted_at: new Date('2026-10-06') }),
  { ...hiddenRow(28, 1, {}), task: { id: 128, project_id: 1, deleted_at: new Date('2026-10-06'), project: project(1) } },
);

const buildPrisma = () => ({
  client: { findFirst: jest.fn(async ({ where }: any) => [{ id: 10 }, { id: 20 }].find((c) => c.id === where.id) ?? null) },
  project: { findMany: jest.fn(async ({ where }: any) => PROJECTS.filter((p) => matchWhere(p, where))) },
  taskFile: {
    count: jest.fn(async ({ where }: any) => FILES.filter((f) => matchWhere(f, where)).length),
    findMany: jest.fn(async ({ where, skip = 0, take }: any) => {
      const hits = FILES.filter((f) => matchWhere(f, where)).sort(
        (a, b) => b.uploaded_at.getTime() - a.uploaded_at.getTime() || b.id - a.id,
      );
      return take === undefined ? hits : hits.slice(skip, skip + take);
    }),
  },
});

const clientUser = { id: 50, client_id: 10, role: { name: 'CLIENT', permissions: [] } };
const ids = (res: any) => res.results.map((d: any) => Number(String(d.id).replace('taskfile-', '')));

describe('Client document vault', () => {
  let prisma: ReturnType<typeof buildPrisma>;
  let service: ClientPortalService;
  beforeEach(() => {
    prisma = buildPrisma();
    service = new ClientPortalService(prisma as any);
  });
  const list = (query: any = {}, user: any = clientUser) => service.getClientDocuments(user, query) as Promise<any>;

  describe('pagination', () => {
    it('returns { count, next, previous, results } with 10 per page, newest first', async () => {
      const page1 = await list({ page: '1' });
      expect(page1.count).toBe(22);
      expect(ids(page1)).toEqual([22, 21, 20, 19, 18, 17, 16, 15, 14, 13]);
      expect(page1.next).toBe('/api/v1/dashboard/documents/?page=2');
      expect(page1.previous).toBeNull();

      const page3 = await list({ page: '3' });
      expect(ids(page3)).toEqual([2, 1]);
      expect(page3.next).toBeNull();
      expect(page3.previous).toBe('/api/v1/dashboard/documents/?page=2');
    });

    it('a missing or invalid page is page 1; pages never overlap', async () => {
      expect(ids(await list({}))).toEqual(ids(await list({ page: 'abc' })));
      const seen = [...ids(await list({ page: '1' })), ...ids(await list({ page: '2' })), ...ids(await list({ page: '3' }))];
      expect(new Set(seen).size).toBe(22);
    });

    it('keeps the item format the page renders', async () => {
      const [first] = (await list({ search: 'homepage' })).results;
      expect(first).toEqual({
        id: 'taskfile-7',
        name: 'task_7_1760000000000_abc7.pdf',
        type: 'Task File',
        project_name: 'Royal Kangan Website',
        date: '2026-10-07',
        // The authenticated download route (GET /dashboard/documents/:id/download), never a storage path
        url: '/api/v1/dashboard/documents/taskfile-7/download/',
        download_url: '/api/v1/dashboard/documents/taskfile-7/download/',
        file_size: 'Unknown',
      });
    });
  });

  describe('search', () => {
    it.each([
      ['original file name, partial and mixed case', 'design-final', [7]],
      ['stored file name (shown in the Name column)', 'TASK_7_', [7]],
      ['project name, partial and mixed case', 'royal KANGAN', [21, 19, 17, 15, 13, 11, 9, 7, 5, 3]],
      ['trimmed', '  Homepage  ', [7]],
    ])('%s: "%s"', async (_label, search, expected) => {
      expect(ids(await list({ search }))).toEqual(expected);
    });

    it('an empty or blank term applies no text filter', async () => {
      for (const search of ['', '   ', undefined]) expect((await list({ search })).count).toBe(22);
    });

    it('paginates the matches', async () => {
      const page1 = await list({ search: 'royal', page: '1' });
      const page2 = await list({ search: 'royal', page: '2' });
      expect(page1.count).toBe(11);
      expect(ids(page2)).toEqual([1]);
    });
  });

  describe('type', () => {
    it('All Types and Task Deliverables list the task files', async () => {
      expect((await list({ type: '' })).count).toBe(22);
      expect((await list({ type: 'taskfile' })).count).toBe(22);
    });

    it.each([['proposal'], ['invoice'], ['seo_report']])('"%s": no documents of that type are in the vault (empty page, no file query)', async (type) => {
      expect(await list({ type, search: 'design' })).toEqual({ count: 0, next: null, previous: null, results: [] });
      expect(prisma.taskFile.findMany).not.toHaveBeenCalled();
    });

    it('rejects an unknown type before querying', async () => {
      await expect(list({ type: 'contracts' })).rejects.toThrow(BadRequestException);
      expect(prisma.taskFile.findMany).not.toHaveBeenCalled();
    });
  });

  describe('date range (inclusive calendar days of the upload date)', () => {
    it('start and end days are both included', async () => {
      expect(ids(await list({ start_date: '2026-10-05', end_date: '2026-10-07' }))).toEqual([7, 6, 5]);
    });

    it('only a start or only an end date', async () => {
      expect(ids(await list({ start_date: '2026-10-21' }))).toEqual([22, 21]);
      expect(ids(await list({ end_date: '2026-10-02' }))).toEqual([2, 1]);
    });

    it('combines with search, type and pagination', async () => {
      const res = await list({ search: 'royal', type: 'taskfile', start_date: '2026-10-01', end_date: '2026-10-09', page: '1' });
      expect(ids(res)).toEqual([9, 7, 5, 3, 1]);
      expect(res.count).toBe(5);
    });

    it.each([
      [{ start_date: '2026-02-30' }],
      [{ end_date: 'yesterday' }],
      [{ start_date: '2026-10-10', end_date: '2026-10-01' }],
    ])('rejects %j (400) before querying', async (query) => {
      await expect(list(query)).rejects.toThrow(BadRequestException);
      expect(prisma.taskFile.findMany).not.toHaveBeenCalled();
    });
  });

  describe('client isolation', () => {
    it("never returns another client's documents, even when searching for them", async () => {
      expect((await list({ search: 'Secret-Contract' })).count).toBe(0);
      expect((await list({ search: 'other corp' })).count).toBe(0);
      expect(ids(await list({ page: '1' }))).not.toEqual(expect.arrayContaining([23]));
    });

    it('client or project ids in the query cannot widen the scope', async () => {
      const res = await list({ client_id: '20', client: '20', project: '3', project_id: '3', search: 'deliverable-23' });
      expect(res.count).toBe(0);
      expect(prisma.project.findMany).toHaveBeenCalledWith({ where: { client_id: 10, deleted_at: null }, select: { id: true } });
    });

    it('the other client sees only its own documents', async () => {
      const other = { id: 60, client_id: 20, role: { name: 'CLIENT', permissions: [] } };
      expect(ids(await list({}, other))).toEqual([25, 24, 23]);
      expect((await list({ search: 'homepage' }, other)).count).toBe(0);
    });

    it('soft-deleted files, files of deleted tasks and files of deleted projects are never listed or found', async () => {
      const all = [...ids(await list({ page: '1' })), ...ids(await list({ page: '2' })), ...ids(await list({ page: '3' }))];
      expect(all).not.toEqual(expect.arrayContaining([26]));
      expect(all.filter((id) => id >= 26)).toEqual([]);
      expect((await list({ search: 'hidden' })).count).toBe(0);
      expect((await list({ search: 'archived' })).count).toBe(0);
      expect((await list({})).count).toBe(22);
    });

    it('a client without projects gets an empty page', async () => {
      prisma.project.findMany.mockResolvedValueOnce([]);
      expect(await list({ search: 'x' })).toEqual({ count: 0, next: null, previous: null, results: [] });
    });

    it('non-client users and unlinked client users are refused, as before', async () => {
      await expect(list({}, { id: 1, role: { name: 'SUPER_ADMIN', permissions: [] } })).rejects.toThrow(ForbiddenException);
      await expect(list({}, { id: 51, role: { name: 'CLIENT', permissions: [] } })).rejects.toThrow(NotFoundException);
    });
  });
});
