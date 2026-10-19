import { RemindersService } from './reminders.service';

/**
 * GET /reminders listing: search (title, description, category), the pending/completed filter
 * on is_completed, and unchanged pagination / all=true behaviour. Uses a Prisma fake that records
 * the query (no database).
 */
const buildService = () => {
  const prisma = {
    reminder: {
      count: jest.fn(async (_args?: any) => 7),
      findMany: jest.fn(async (_args?: any) => [{ id: 1 }] as any[]),
    },
  };
  return { service: new RemindersService(prisma as any), prisma };
};
const user = { id: 42 };
const whereOf = (prisma: any) => prisma.reminder.findMany.mock.calls[0][0].where;

describe('RemindersService.getReminders', () => {
  it('without filters lists the user\'s reminders, 5 per page (unchanged)', async () => {
    const { service, prisma } = buildService();
    const res: any = await service.getReminders(user, { page: '2' });
    expect(whereOf(prisma)).toEqual({ user_id: 42 });
    expect(prisma.reminder.findMany.mock.calls[0][0]).toMatchObject({ skip: 5, take: 5 });
    expect(res).toMatchObject({ count: 7, results: [{ id: 1 }] });
  });

  it('searches title and description without the MySQL-incompatible insensitive mode', async () => {
    const { service, prisma } = buildService();
    await service.getReminders(user, { search: '  Acme  ' });
    const where = whereOf(prisma);
    expect(where.OR).toEqual([{ title: { contains: 'Acme' } }, { description: { contains: 'Acme' } }]);
    expect(JSON.stringify(where)).not.toContain('insensitive');
    expect(where.user_id).toBe(42); // never widened beyond the user's own reminders
  });

  it('matches the category when the term names a reminder type', async () => {
    const { service, prisma } = buildService();
    await service.getReminders(user, { search: 'Invo' });
    expect(whereOf(prisma).OR).toContainEqual({ type: { in: ['invoice'] } });
  });

  it('filters pending and completed reminders on is_completed', async () => {
    for (const [status, expected] of [['completed', true], ['pending', false], ['COMPLETED', true]] as const) {
      const { service, prisma } = buildService();
      await service.getReminders(user, { status });
      expect(whereOf(prisma).is_completed).toBe(expected);
    }
  });

  it('"all" or unknown status values do not filter', async () => {
    for (const status of ['all', '', 'bogus']) {
      const { service, prisma } = buildService();
      await service.getReminders(user, { status });
      expect(whereOf(prisma)).not.toHaveProperty('is_completed');
    }
  });

  it('search and filter combine, and the count uses the same filter', async () => {
    const { service, prisma } = buildService();
    await service.getReminders(user, { search: 'call', status: 'pending', page: '1' });
    const where = whereOf(prisma);
    expect(where).toMatchObject({ user_id: 42, is_completed: false });
    expect(prisma.reminder.count).toHaveBeenCalledWith({ where });
  });

  it('all=true still returns every reminder (used by notifications)', async () => {
    const { service, prisma } = buildService();
    const res = await service.getReminders(user, { all: 'true' });
    expect(Array.isArray(res)).toBe(true);
    expect(prisma.reminder.findMany.mock.calls[0][0]).not.toHaveProperty('take');
  });
});
