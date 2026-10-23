import { SeoService } from './seo.service';

/**
 * SEO Tasks list (GET /seo-tasks) and its stats share one access scope: an SEO executive only
 * ever sees their own tasks. `?executive=` cannot replace that scope, and a status filter (which
 * makes the stats cover every status) cannot drop it. Managers keep filtering by executive.
 * The fake evaluates each `where` like the database would.
 */
const matchWhere = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([key, cond]: [string, any]) => {
    if (key === 'OR') return cond.some((c: any) => matchWhere(row, c));
    if (key === 'NOT') return !matchWhere(row, cond);
    const value = row?.[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('contains' in cond)
        return String(value ?? '')
          .toLowerCase()
          .includes(String(cond.contains).toLowerCase());
      if ('lt' in cond) return value < cond.lt;
      return matchWhere(value ?? {}, cond); // relation filter
    }
    return value === cond;
  });

const role = (name: string) => ({
  role: { name, permissions: [] },
  role_name: name,
});
const manager = { id: 1, ...role('SEO_MANAGER') };
const admin = { id: 2, is_superuser: true, ...role('SUPER_ADMIN') };
const execA = { id: 21, ...role('SEO_EXECUTIVE') };

const task = (
  id: number,
  executiveId: number,
  status: string,
  extra: any = {},
) => ({
  id,
  title: `Task ${id}`,
  description: '',
  status,
  priority: 'medium',
  website_id: 1,
  activity_type_id: null,
  due_date: new Date('2099-01-01'),
  assigned_executive_id: executiveId,
  website: { website_name: 'Royal Store' },
  assigned_executive: {
    name: `Exec ${executiveId}`,
    username: `exec${executiveId}`,
  },
  ...extra,
});
const ROWS = [
  task(1, 21, 'pending'),
  task(2, 21, 'completed', { priority: 'high' }),
  task(3, 22, 'pending', { website_id: 2 }),
  task(4, 22, 'in_progress'),
  task(5, 22, 'pending', { priority: 'high' }),
];

describe("SEO tasks: list and stats keep the caller's access scope", () => {
  let prisma: any;
  let service: SeoService;
  beforeEach(() => {
    prisma = {
      sEOTask: {
        count: jest.fn(
          async ({ where }: any = {}) =>
            ROWS.filter((r) => matchWhere(r, where)).length,
        ),
        findMany: jest.fn(async ({ where, skip = 0, take }: any = {}) => {
          const hits = ROWS.filter((r) => matchWhere(r, where));
          return take === undefined ? hits : hits.slice(skip, skip + take);
        }),
      },
    };
    // Only Prisma is used by getTasks
    service = new (SeoService as any)(prisma, {}, {});
  });
  const list = async (user: any, query: any) => {
    const res: any = await service.getTasks(user, query);
    return {
      ids: res.results.map((t: any) => t.id).sort(),
      count: res.count,
      stats: res.stats,
    };
  };

  it("an SEO executive asking for another executive's tasks still gets only their own", async () => {
    const res = await list(execA, { executive: '22' });
    expect(res.ids).toEqual([1, 2]);
    expect(res.count).toBe(2);
    expect(res.stats).toMatchObject({
      total: 2,
      pending: 1,
      completed: 1,
      in_progress: 0,
    });
    // No task of executive 22 can be reached through any combination of filters
    for (const query of [
      { executive: '22', status: 'pending' },
      { executive: '22', priority: 'high' },
      { executive: '22', search: 'exec22' },
    ]) {
      expect(
        (await list(execA, query)).ids.every((id: number) =>
          [1, 2].includes(id),
        ),
      ).toBe(true);
    }
  });

  it("with a status filter the stats stay within the executive's own tasks", async () => {
    const res = await list(execA, { status: 'pending' });
    expect(res.ids).toEqual([1]);
    expect(res.stats).toMatchObject({
      total: 2,
      pending: 1,
      in_progress: 0,
      completed: 1,
    });
    const viaOther = await list(execA, { status: 'pending', executive: '22' });
    expect(viaOther.ids).toEqual([1]);
    expect(viaOther.stats).toMatchObject({
      total: 2,
      pending: 1,
      in_progress: 0,
      completed: 1,
    });
  });

  it('managers and admins can still filter by executive', async () => {
    for (const user of [manager, admin]) {
      const res = await list(user, { executive: '22' });
      expect(res.ids).toEqual([3, 4, 5]);
      expect(res.count).toBe(3);
      expect(res.stats).toMatchObject({
        total: 3,
        pending: 2,
        in_progress: 1,
        completed: 0,
      });
    }
  });

  it('existing filters and counts are unchanged for managers (including all-status stats with a status filter)', async () => {
    expect((await list(manager, {})).ids).toEqual([1, 2, 3, 4, 5]);
    expect((await list(manager, { website: '2' })).ids).toEqual([3]);
    expect((await list(manager, { priority: 'high' })).ids).toEqual([2, 5]);
    expect(
      (await list(manager, { executive: '22', priority: 'high' })).ids,
    ).toEqual([5]);
    const byStatus = await list(manager, { status: 'pending' });
    expect(byStatus.ids).toEqual([1, 3, 5]);
    expect(byStatus.count).toBe(3);
    // As before: with a status filter a manager's stats cover all tasks
    expect(byStatus.stats).toMatchObject({
      total: 5,
      pending: 3,
      in_progress: 1,
      completed: 1,
    });
    const paged: any = await service.getTasks(manager, {
      page: '2',
      page_size: '2',
    });
    expect(paged.count).toBe(5);
    expect(paged.results).toHaveLength(2);
  });

  const lastFindMany = () => prisma.sEOTask.findMany.mock.calls.at(-1)[0];

  it.each([
    ['newest', [{ created_at: 'desc' }, { id: 'desc' }]],
    ['oldest', [{ created_at: 'asc' }, { id: 'asc' }]],
    ['due_date', [{ due_date: 'asc' }, { id: 'desc' }]],
    ['priority', [{ priority: 'desc' }, { due_date: 'asc' }, { id: 'desc' }]],
    ['title', [{ title: 'asc' }, { id: 'desc' }]],
  ])('ordering=%s sorts in the database', async (ordering, orderBy) => {
    await service.getTasks(manager, { ordering });
    expect(lastFindMany().orderBy).toEqual(orderBy);
  });

  it('a missing or unsupported ordering uses the default (newest first)', async () => {
    for (const ordering of [
      undefined,
      '',
      'password',
      'constructor',
      '__proto__',
      'toString',
      ['title'],
    ]) {
      await service.getTasks(manager, { ordering });
      const expected = Array.isArray(ordering)
        ? [{ title: 'asc' }, { id: 'desc' }]
        : [{ created_at: 'desc' }, { id: 'desc' }];
      expect({ ordering, orderBy: lastFindMany().orderBy }).toEqual({
        ordering,
        orderBy: expected,
      });
    }
  });

  it('ordering keeps the executive scope and the filters', async () => {
    const res = await list(execA, { ordering: 'priority', executive: '22' });
    expect(res.ids).toEqual([1, 2]);
    expect(lastFindMany().where).toEqual({ assigned_executive_id: 21 });
  });

  it('each task carries the labels the cards show; user relations are limited to id, name and username', async () => {
    const res: any = await service.getTasks(manager, {});
    expect(res.results.find((t: any) => t.id === 1)).toMatchObject({
      assigned_executive_name: 'Exec 21',
      website_name: 'Royal Store',
      activity_type_name: null,
    });
    const include = lastFindMany().include;
    expect(include.assigned_executive).toEqual({
      select: { id: true, name: true, username: true },
    });
    expect(include.created_by).toEqual({
      select: { id: true, name: true, username: true },
    });
  });

  it('the executive label falls back to the username, and the activity type name is returned', async () => {
    prisma.sEOTask.findMany.mockResolvedValueOnce([
      {
        ...task(9, 21, 'pending'),
        assigned_executive: { name: '', username: 'anjali.n' },
        activity_type: { name: 'Guest Posting' },
      },
      { ...task(10, 21, 'pending'), assigned_executive: null, website: null },
    ]);
    const res: any = await service.getTasks(manager, {});
    expect(res.results[0]).toMatchObject({
      assigned_executive_name: 'anjali.n',
      activity_type_name: 'Guest Posting',
    });
    expect(res.results[1]).toMatchObject({
      assigned_executive_name: '',
      website_name: '',
      activity_type_name: null,
    });
  });
});
