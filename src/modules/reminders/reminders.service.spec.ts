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

describe('RemindersService due_date validation (create / update)', () => {
  const build = () => {
    const prisma = {
      reminder: {
        create: jest.fn(async (args: any) => ({ id: 1, ...args.data })),
        findFirst: jest.fn(async () => ({ id: 5, user_id: 42 })),
        update: jest.fn(async (args: any) => ({ id: 5, ...args.data })),
      },
    };
    return { service: new RemindersService(prisma as any), prisma };
  };

  it('stores the due date as UTC midnight of the selected day', async () => {
    const { service, prisma } = build();
    await service.createReminder(user, { title: 'Renew', due_date: '2026-10-21' });
    expect(prisma.reminder.create.mock.calls[0][0].data.due_date.toISOString()).toBe('2026-10-21T00:00:00.000Z');
  });

  it.each([undefined, null, ''])('refuses a missing due date (%p) with 400 instead of a database error', async (due_date) => {
    const { service, prisma } = build();
    await expect(service.createReminder(user, { title: 'Renew', due_date })).rejects.toThrow('Due date is required.');
    expect(prisma.reminder.create).not.toHaveBeenCalled();
  });

  it.each(['soon', '2026-02-30', '2026-13-01'])('refuses the invalid due date %p on create and update', async (due_date) => {
    const { service, prisma } = build();
    await expect(service.createReminder(user, { title: 'Renew', due_date })).rejects.toThrow('Due date must be a valid date (YYYY-MM-DD).');
    await expect(service.updateReminder(user, 5, { due_date })).rejects.toThrow('Due date must be a valid date (YYYY-MM-DD).');
    expect(prisma.reminder.create).not.toHaveBeenCalled();
    expect(prisma.reminder.update).not.toHaveBeenCalled();
  });

  it('completing a reminder (no due_date sent) leaves the due date unchanged', async () => {
    const { service, prisma } = build();
    await service.updateReminder(user, 5, { is_completed: true });
    const data = prisma.reminder.update.mock.calls[0][0].data;
    expect(data.due_date).toBeUndefined();
    expect(data.is_completed).toBe(true);
  });

  it('an update cannot clear the (required) due date', async () => {
    const { service } = build();
    await expect(service.updateReminder(user, 5, { due_date: null })).rejects.toThrow('Due date is required.');
  });
});
