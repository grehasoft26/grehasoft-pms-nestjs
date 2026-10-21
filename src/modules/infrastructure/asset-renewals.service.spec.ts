import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AssetRenewalsService } from './asset-renewals.service';
import { InfrastructureService } from './infrastructure.service';
import { businessToday } from '../../core/utils/date-only.util';

/**
 * Renewals against an in-memory fake of the database that models what the service relies on:
 *  - SELECT ... FOR UPDATE takes a row lock held until the transaction ends (as InnoDB does);
 *  - unique indexes on asset_renewals.idempotency_key and cycle_key raise Prisma's P2002;
 *  - a failed transaction is rolled back (every write in it is undone).
 */
const tick = () => new Promise((r) => setTimeout(r, 5));
const day = (key: string) => new Date(`${key}T00:00:00.000Z`);
const key = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : d);

const buildFake = (opts: { honourLocks?: boolean } = {}) => {
  const honourLocks = opts.honourLocks ?? true;
  const db = {
    domain: [
      { id: 10, domain_name: 'example.com', expiry_date: day('2026-10-21') as Date | null, renewal_period_value: null as number | null, renewal_period_unit: null as string | null },
      { id: 11, domain_name: 'no-expiry.test', expiry_date: null, renewal_period_value: null, renewal_period_unit: null },
    ],
    server: [
      { id: 7, name: 'Prod', expiry_date: day('2026-10-21') as Date | null, renewal_period_value: 1 as number | null, renewal_period_unit: 'month' as string | null },
      { id: 8, name: 'No period', expiry_date: day('2026-10-21'), renewal_period_value: null, renewal_period_unit: null },
    ],
    assetRenewal: [] as any[],
    reminder: [
      // reminders.domain_id / server_id link a reminder to its asset
      { id: 5, user_id: 1, is_completed: false, title: 'Domain Renewal: example.com', domain_id: 10, server_id: null },
      { id: 6, user_id: 99, is_completed: false, title: 'Domain Renewal: example.com', domain_id: 10, server_id: null },
      { id: 12, user_id: 1, is_completed: false, title: 'Call Acme about the invoice', domain_id: null, server_id: null },
      { id: 13, user_id: 1, is_completed: false, title: 'Renew no-expiry.test', domain_id: 11, server_id: null },
      { id: 14, user_id: 1, is_completed: true, title: 'Domain Renewal: example.com', domain_id: 10, server_id: null },
      // legacy reminder not yet linked by the backfill: its title alone is not enough
      { id: 15, user_id: 1, is_completed: false, title: 'Domain Renewal: example.com', domain_id: null, server_id: null },
      { id: 16, user_id: 1, is_completed: false, title: 'Renew Prod server', domain_id: null, server_id: 7 },
    ],
  };
  let nextId = 1;
  const failures = { assetUpdate: false, reminderUpdate: false, deadlocks: 0 };

  // Row locks (FOR UPDATE): one holder per row until its transaction ends
  const holders = new Map<string, symbol>();
  const waiters: Array<() => void> = [];
  const acquire = async (row: string, txId: symbol) => {
    while (holders.has(row) && holders.get(row) !== txId) await new Promise<void>((r) => waiters.push(r));
    holders.set(row, txId);
  };
  const releaseAll = (txId: symbol) => {
    for (const [row, holder] of [...holders]) if (holder === txId) holders.delete(row);
    waiters.splice(0).forEach((w) => w());
  };

  const uniqueError = (field: string) =>
    Object.assign(new Error(`Unique constraint failed on the constraint: asset_renewals_${field}_key`), {
      code: 'P2002',
      meta: { target: `asset_renewals_${field}_key` },
    });

  const client = (txId?: symbol, journal?: Array<() => void>): any => {
    const update = (rows: any[], fail: () => boolean) => async ({ where, data }: any) => {
      await tick();
      if (fail()) throw new Error('simulated write failure');
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      const before = { ...row };
      journal?.push(() => Object.assign(row, before));
      // As Prisma: undefined means "leave unchanged"
      for (const [field, value] of Object.entries(data)) if (value !== undefined) row[field] = value;
      return { ...row };
    };
    return {
      $queryRaw: jest.fn(async (sql: any) => {
        // Reminder link check: domains with this normalized name
        if (/LOWER\(TRIM\(domain_name\)\)/.test(sql.sql)) {
          return db.domain.filter((d) => d.domain_name.trim().toLowerCase() === sql.values[0]).map((d) => ({ id: d.id }));
        }
        const table = /FROM (domains|servers)/.exec(sql.sql)![1];
        const id = sql.values[0];
        if (honourLocks && txId && /FOR UPDATE/.test(sql.sql)) await acquire(`${table}:${id}`, txId);
        await tick(); // let concurrent requests interleave
        const row = (table === 'domains' ? db.domain : db.server).find((r: any) => r.id === id) as any;
        if (!row) return [];
        return [{ id: row.id, name: row.domain_name ?? row.name, expiry_date: row.expiry_date, renewal_period_value: row.renewal_period_value, renewal_period_unit: row.renewal_period_unit }];
      }),
      assetRenewal: {
        findUnique: jest.fn(async ({ where }: any) => db.assetRenewal.find((r) => r.idempotency_key === where.idempotency_key) ?? null),
        findMany: jest.fn(async ({ where }: any) =>
          db.assetRenewal
            .filter((r) => r.asset_type === where.asset_type && r.asset_id === where.asset_id)
            .sort((a, b) => b.id - a.id),
        ),
        create: jest.fn(async ({ data }: any) => {
          await tick();
          if (data.idempotency_key && db.assetRenewal.some((r) => r.idempotency_key === data.idempotency_key)) throw uniqueError('idempotency_key');
          if (data.cycle_key && db.assetRenewal.some((r) => r.cycle_key === data.cycle_key)) throw uniqueError('cycle_key');
          const row = { id: nextId++, created_at: new Date(), ...data };
          db.assetRenewal.push(row);
          journal?.push(() => db.assetRenewal.splice(db.assetRenewal.indexOf(row), 1));
          return { ...row };
        }),
      },
      domain: {
        // Plain reads see committed and in-flight writes alike; the row lock is what orders writers
        findUnique: jest.fn(async ({ where }: any) => {
          const row = db.domain.find((d) => d.id === where.id);
          return row ? { ...row, project: null, server: null } : null;
        }),
        update: jest.fn(async (args: any) => ({ ...(await update(db.domain, () => !!txId && failures.assetUpdate)(args)), project: null, server: null })),
        count: jest.fn(async ({ where }: any) => db.domain.filter((d) => d.id === where.id).length),
      },
      server: {
        findUnique: jest.fn(async ({ where }: any) => {
          const row = db.server.find((s) => s.id === where.id);
          return row ? { ...row } : null;
        }),
        update: jest.fn(update(db.server, () => !!txId && failures.assetUpdate)),
        count: jest.fn(async ({ where }: any) => db.server.filter((s) => s.id === where.id).length),
      },
      reminder: {
        findFirst: jest.fn(async ({ where }: any) => db.reminder.find((r) => r.id === where.id && r.user_id === where.user_id) ?? null),
        update: jest.fn(update(db.reminder, () => failures.reminderUpdate)),
      },
    };
  };

  const prisma: any = {
    ...client(),
    $transaction: jest.fn(async (fn: any) => {
      if (failures.deadlocks > 0) {
        failures.deadlocks--;
        throw Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), { code: 'P2034' });
      }
      const txId = Symbol('tx');
      const journal: Array<() => void> = [];
      try {
        return await fn(client(txId, journal)); // commit
      } catch (error) {
        journal.reverse().forEach((undo) => undo()); // rollback
        throw error;
      } finally {
        releaseAll(txId);
      }
    }),
  };
  return { prisma, db, failures };
};

const admin = { id: 1, name: 'Admin User', role: { name: 'SUPER_ADMIN' } };
const errorOf = (promise: Promise<unknown>) => promise.then(() => null, (e) => e);
const renewBody = (overrides: any = {}) => ({ idempotency_key: 'renew-key-0001', expected_expiry_date: '2026-10-21', ...overrides });

describe('AssetRenewalsService', () => {
  let fake: ReturnType<typeof buildFake>;
  let service: AssetRenewalsService;
  const domain = () => fake.db.domain.find((d) => d.id === 10)!;
  const server = () => fake.db.server.find((s) => s.id === 7)!;

  // "Today" is fixed at 21-10-2026 (11:30 in Asia/Kolkata); only Date is faked, timers stay real
  beforeAll(() => {
    jest.useFakeTimers({ now: new Date('2026-10-21T06:00:00.000Z'), doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask'] });
  });
  afterAll(() => jest.useRealTimers());

  beforeEach(() => {
    fake = buildFake();
    service = new AssetRenewalsService(fake.prisma);
  });

  describe('renewal that would still leave the asset expired (confirmation required)', () => {
    const expired = () => {
      domain().expiry_date = day('2024-03-10'); // + 1 year = 2025-03-10, still before 2026-10-21
    };
    const body = (o: any = {}) => renewBody({ expected_expiry_date: '2024-03-10', ...o });

    it('without confirmation: 422 RENEWAL_STILL_EXPIRED with the dates, and nothing is written', async () => {
      expired();
      const error = await errorOf(service.renew(admin, 'domain', 10, body({ reminder_id: 5 })));
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error.getStatus()).toBe(422);
      expect(error.getResponse()).toMatchObject({
        code: 'RENEWAL_STILL_EXPIRED',
        current_expiry_date: '2024-03-10',
        computed_new_expiry_date: '2025-03-10',
        today: '2026-10-21',
      });
      expect(key(domain().expiry_date)).toBe('2024-03-10');
      expect(fake.db.assetRenewal).toHaveLength(0);
      expect(fake.db.reminder[0].is_completed).toBe(false);
    });

    it('the same request with the confirmed date then succeeds (the idempotency key was not used up)', async () => {
      expired();
      await expect(service.renew(admin, 'domain', 10, body())).rejects.toThrow(UnprocessableEntityException);
      const result = await service.renew(admin, 'domain', 10, body({ confirm_new_expiry_date: '2025-03-10' }));
      expect(result.replayed).toBe(false);
      expect(result.renewal.idempotency_key).toBe('renew-key-0001');
      expect(key(domain().expiry_date)).toBe('2025-03-10');
      // and a retry replays it
      const retry = await service.renew(admin, 'domain', 10, body({ confirm_new_expiry_date: '2025-03-10' }));
      expect(retry.replayed).toBe(true);
      expect(fake.db.assetRenewal).toHaveLength(1);
    });

    it('confirming a different date (e.g. another period was chosen) gets a new 422 with the recalculated date', async () => {
      expired();
      const error = await errorOf(service.renew(admin, 'domain', 10, body({ period_value: 2, period_unit: 'year', confirm_new_expiry_date: '2025-03-10' })));
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error.getResponse()).toMatchObject({ computed_new_expiry_date: '2026-03-10' });
      expect(fake.db.assetRenewal).toHaveLength(0);
    });

    it('a period long enough to reach today or later needs no confirmation', async () => {
      expired();
      await service.renew(admin, 'domain', 10, body({ period_value: 3, period_unit: 'year' })); // -> 2027-03-10
      expect(key(domain().expiry_date)).toBe('2027-03-10');
    });

    it('a new expiry of exactly today is not "still expired"', async () => {
      domain().expiry_date = day('2025-10-21');
      await service.renew(admin, 'domain', 10, renewBody({ expected_expiry_date: '2025-10-21' }));
      expect(key(domain().expiry_date)).toBe('2026-10-21');
    });

    it('the stale-date check comes first: an asset changed meanwhile is 409, even with a confirmation', async () => {
      expired();
      domain().expiry_date = day('2024-06-01'); // edited after the preview was shown
      const error = await errorOf(service.renew(admin, 'domain', 10, body({ confirm_new_expiry_date: '2025-03-10' })));
      expect(error).toBeInstanceOf(ConflictException);
      expect(fake.db.assetRenewal).toHaveLength(0);
    });

    it('rejects an invalid confirmation date with 400', async () => {
      expired();
      await expect(service.renew(admin, 'domain', 10, body({ confirm_new_expiry_date: '2025-02-30' }))).rejects.toThrow(BadRequestException);
    });
  });

  describe('renewal preview (read-only)', () => {
    it('shows the current and computed expiry with the period used, and writes nothing', async () => {
      const preview = await service.preview('domain', 10);
      expect(preview).toEqual({
        asset_type: 'domain',
        asset_id: 10,
        asset_name: 'example.com',
        current_expiry_date: '2026-10-21',
        period_value: 1,
        period_unit: 'year',
        period_source: 'default',
        computed_new_expiry_date: '2027-10-21',
        today: '2026-10-21',
        still_expired: false,
        confirmation_required: false,
      });
      expect(fake.prisma.$transaction).not.toHaveBeenCalled();
      expect(fake.db.assetRenewal).toHaveLength(0);
      expect(key(domain().expiry_date)).toBe('2026-10-21');
    });

    it("uses the request's or the server's period, and flags a renewal that needs confirmation", async () => {
      expect(await service.preview('server', 7)).toMatchObject({ period_source: 'asset', period_unit: 'month', computed_new_expiry_date: '2026-11-21' });
      expect(await service.preview('domain', 10, { period_value: '6', period_unit: 'month' })).toMatchObject({ period_source: 'request', computed_new_expiry_date: '2027-04-21' });
      domain().expiry_date = day('2024-03-10');
      expect(await service.preview('domain', 10)).toMatchObject({ computed_new_expiry_date: '2025-03-10', still_expired: true, confirmation_required: true });
    });

    it('the previewed date is exactly what the confirmed renewal applies', async () => {
      domain().expiry_date = day('2024-03-10');
      const preview = await service.preview('domain', 10);
      await service.renew(admin, 'domain', 10, renewBody({ expected_expiry_date: preview.current_expiry_date, confirm_new_expiry_date: preview.computed_new_expiry_date }));
      expect(key(domain().expiry_date)).toBe(preview.computed_new_expiry_date);
    });

    it('400 for an invalid period, an asset without expiry or a server without period; 404 for unknown ids', async () => {
      await expect(service.preview('domain', 10, { period_value: 0, period_unit: 'year' })).rejects.toThrow(BadRequestException);
      await expect(service.preview('domain', 11)).rejects.toThrow('no expiry date');
      await expect(service.preview('server', 8)).rejects.toThrow('no default renewal period');
      await expect(service.preview('domain', 999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('renewal periods (extend the current expiry date)', () => {
    it('renews a domain for one year by default: 21-10-2026 -> 21-10-2027', async () => {
      const result = await service.renew(admin, 'domain', 10, renewBody());
      expect(key(result.expiry_date)).toBe('2027-10-21');
      expect(key(domain().expiry_date)).toBe('2027-10-21');
      expect(result.replayed).toBe(false);
      expect(result.renewal).toMatchObject({
        asset_type: 'domain',
        asset_id: 10,
        asset_name: 'example.com',
        domain_id: 10,
        event: 'renewed',
        period_value: 1,
        period_unit: 'year',
        performed_by_id: 1,
        performed_by_name: 'Admin User',
        idempotency_key: 'renew-key-0001',
        cycle_key: 'domain:10:2026-10-21',
      });
      expect(key(result.renewal.previous_expiry_date)).toBe('2026-10-21');
      expect(key(result.renewal.new_expiry_date)).toBe('2027-10-21');
    });

    it("renews a server monthly with the server's default period", async () => {
      const result = await service.renew(admin, 'server', 7, renewBody());
      expect(key(server().expiry_date)).toBe('2026-11-21');
      expect(result.renewal).toMatchObject({ asset_type: 'server', period_value: 1, period_unit: 'month', server_id: 7 });
      expect(result.renewal.domain_id).toBeUndefined();
    });

    it('a period sent with the request overrides the default', async () => {
      await service.renew(admin, 'domain', 10, renewBody({ period_value: 3, period_unit: 'year' }));
      expect(key(domain().expiry_date)).toBe('2029-10-21');
    });

    it('a domain with its own default period uses it', async () => {
      Object.assign(domain(), { renewal_period_value: 6, renewal_period_unit: 'month' });
      await service.renew(admin, 'domain', 10, renewBody());
      expect(key(domain().expiry_date)).toBe('2027-04-21');
    });

    it('extends from the current expiry, not from the renewal date (early and late renewals)', async () => {
      // early: renewed months before expiry
      await service.renew(admin, 'domain', 10, renewBody({ renewal_date: '2026-06-01' }));
      expect(key(domain().expiry_date)).toBe('2027-10-21');

      // late: already expired; the new expiry is still in the past, so it needs confirming
      domain().expiry_date = day('2025-01-01');
      await service.renew(admin, 'domain', 10, renewBody({ idempotency_key: 'renew-key-0002', expected_expiry_date: '2025-01-01', confirm_new_expiry_date: '2026-01-01' }));
      expect(key(domain().expiry_date)).toBe('2026-01-01');
    });

    it.each([
      ['2026-01-31', 1, 'month', '2026-02-28'],
      ['2028-01-31', 1, 'month', '2028-02-29'],
      ['2026-03-31', 1, 'month', '2026-04-30'],
      ['2026-08-31', 6, 'month', '2027-02-28'],
      ['2028-02-29', 1, 'year', '2029-02-28'],
      ['2028-02-29', 4, 'year', '2032-02-29'],
      ['2026-12-31', 1, 'month', '2027-01-31'],
      ['2026-10-21', 12, 'month', '2027-10-21'],
    ])('%s + %i %s = %s (month-end and leap-year clamping)', async (from, value, unit, expected) => {
      domain().expiry_date = day(from);
      // confirm_new_expiry_date: some of these dates are already past (it is ignored otherwise)
      await service.renew(admin, 'domain', 10, renewBody({ expected_expiry_date: from, period_value: value, period_unit: unit, confirm_new_expiry_date: expected }));
      expect(key(domain().expiry_date)).toBe(expected);
    });
  });

  describe('validation', () => {
    it.each([
      [{ idempotency_key: undefined }, 'idempotency_key'],
      [{ idempotency_key: 'short' }, 'idempotency_key'],
      [{ idempotency_key: 'has spaces in it' }, 'idempotency_key'],
      [{ expected_expiry_date: undefined }, 'expected_expiry_date'],
      [{ expected_expiry_date: '2026-02-30' }, 'Expected expiry date must be a valid date'],
      [{ period_value: 0, period_unit: 'year' }, 'Renewal period'],
      [{ period_value: 1, period_unit: 'week' }, 'Renewal period unit'],
      [{ period_value: 2 }, 'provided together'],
      [{ renewal_date: '2999-01-01' }, 'cannot be in the future'],
      [{ renewal_date: '21-10-2026' }, 'Renewal date must be a valid date'],
      [{ cost: -1 }, 'Cost'],
      [{ cost: '12.345' }, 'Cost'],
      [{ cost: 'abc' }, 'Cost'],
      [{ payment_reference: 'x'.repeat(256) }, 'Payment reference'],
      [{ reminder_id: 'abc' }, 'reminder_id'],
    ])('rejects %p with 400 and changes nothing', async (overrides, message) => {
      const error = await errorOf(service.renew(admin, 'domain', 10, renewBody(overrides)));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify(error.getResponse())).toContain(message);
      expect(key(domain().expiry_date)).toBe('2026-10-21');
      expect(fake.db.assetRenewal).toHaveLength(0);
    });

    it('a server without a default period needs the period in the request', async () => {
      const error = await errorOf(service.renew(admin, 'server', 8, renewBody()));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toContain('no default renewal period');
      await service.renew(admin, 'server', 8, renewBody({ idempotency_key: 'renew-key-0009', period_value: 1, period_unit: 'year' }));
      expect(key(fake.db.server.find((s) => s.id === 8)!.expiry_date)).toBe('2027-10-21');
    });

    it('an asset without an expiry date cannot be renewed', async () => {
      const error = await errorOf(service.renew(admin, 'domain', 11, renewBody()));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toContain('no expiry date');
    });

    it('404 for an unknown asset', async () => {
      await expect(service.renew(admin, 'domain', 999, renewBody())).rejects.toThrow(NotFoundException);
      await expect(service.renew(admin, 'server', 999, renewBody())).rejects.toThrow(NotFoundException);
    });

    it('stores renewal date, cost, payment reference and notes', async () => {
      const { renewal } = await service.renew(admin, 'domain', 10, renewBody({ renewal_date: '2026-10-01', cost: '1200.50', payment_reference: ' INV-77 ', notes: 'Paid by card' }));
      expect(key(renewal.renewal_date)).toBe('2026-10-01');
      expect(renewal).toMatchObject({ cost: '1200.50', payment_reference: 'INV-77', notes: 'Paid by card' });
    });

    it('the renewal date defaults to today in the business timezone', async () => {
      const { renewal } = await service.renew(admin, 'domain', 10, renewBody());
      expect(key(renewal.renewal_date)).toBe(key(businessToday()));
    });
  });

  describe('duplicates, stale dates and concurrency', () => {
    it('the same idempotency key returns the recorded renewal and does not extend again', async () => {
      const first = await service.renew(admin, 'domain', 10, renewBody());
      const retry = await service.renew(admin, 'domain', 10, renewBody());
      expect(retry.replayed).toBe(true);
      expect(retry.renewal.id).toBe(first.renewal.id);
      expect(key(retry.expiry_date)).toBe('2027-10-21');
      expect(key(domain().expiry_date)).toBe('2027-10-21');
      expect(fake.db.assetRenewal).toHaveLength(1);
    });

    it('an idempotency key used for another asset or action is refused', async () => {
      await service.renew(admin, 'domain', 10, renewBody());
      await expect(service.renew(admin, 'server', 7, renewBody())).rejects.toThrow('idempotency_key was already used for a different request.');
      await expect(service.recordFailure(admin, 'domain', 10, renewBody({ failure_reason: 'x' }))).rejects.toThrow(ConflictException);
      expect(key(server().expiry_date)).toBe('2026-10-21');
    });

    it('a stale expected expiry date is refused with 409 and the current expiry', async () => {
      await service.renew(admin, 'domain', 10, renewBody());
      const error = await errorOf(service.renew(admin, 'domain', 10, renewBody({ idempotency_key: 'renew-key-0002' })));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ current_expiry_date: '2027-10-21' });
      expect(key(domain().expiry_date)).toBe('2027-10-21');
      expect(fake.db.assetRenewal).toHaveLength(1);
    });

    it('two concurrent renewals of the same expiry (different keys): one succeeds, one gets 409', async () => {
      const results = await Promise.allSettled([
        service.renew(admin, 'domain', 10, renewBody({ idempotency_key: 'renew-key-aaaa' })),
        service.renew(admin, 'domain', 10, renewBody({ idempotency_key: 'renew-key-bbbb' })),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ConflictException);
      expect(key(domain().expiry_date)).toBe('2027-10-21');
      expect(fake.db.assetRenewal.filter((r) => r.event === 'renewed')).toHaveLength(1);
    });

    it('two concurrent requests with the same key (double submit): one renewal, the other replays it', async () => {
      const [a, b] = await Promise.all([
        service.renew(admin, 'domain', 10, renewBody()),
        service.renew(admin, 'domain', 10, renewBody()),
      ]);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect(a.renewal.id).toBe(b.renewal.id);
      expect(key(domain().expiry_date)).toBe('2027-10-21');
      expect(fake.db.assetRenewal).toHaveLength(1);
    });

    it('without row locks the cycle_key unique index still prevents a double extension', async () => {
      fake = buildFake({ honourLocks: false });
      service = new AssetRenewalsService(fake.prisma);
      const results = await Promise.allSettled([
        service.renew(admin, 'domain', 10, renewBody({ idempotency_key: 'renew-key-aaaa' })),
        service.renew(admin, 'domain', 10, renewBody({ idempotency_key: 'renew-key-bbbb' })),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ConflictException);
      expect(rejected.reason.message).toContain('already renewed');
      expect(key(fake.db.domain[0].expiry_date)).toBe('2027-10-21');
    });

    it('the same expiry cycle cannot be renewed twice, even after a manual date change back', async () => {
      await service.renew(admin, 'domain', 10, renewBody());
      domain().expiry_date = day('2026-10-21'); // e.g. edited back by hand
      const error = await errorOf(service.renew(admin, 'domain', 10, renewBody({ idempotency_key: 'renew-key-0002' })));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toContain('already renewed');
      expect(key(domain().expiry_date)).toBe('2026-10-21');
    });

    it('a deadlock is retried and the renewal is applied once', async () => {
      fake.failures.deadlocks = 1;
      const result = await service.renew(admin, 'domain', 10, renewBody());
      expect(result.replayed).toBe(false);
      expect(fake.prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(key(domain().expiry_date)).toBe('2027-10-21');
    });
  });

  describe('transaction rollback', () => {
    it('if the expiry update fails, no history row is kept and the expiry is unchanged', async () => {
      fake.failures.assetUpdate = true;
      await expect(service.renew(admin, 'domain', 10, renewBody({ reminder_id: 5 }))).rejects.toThrow('simulated write failure');
      expect(key(domain().expiry_date)).toBe('2026-10-21');
      expect(fake.db.assetRenewal).toHaveLength(0);
      expect(fake.db.reminder[0].is_completed).toBe(false);
    });

    it('if completing the reminder fails, the history row and the new expiry are rolled back', async () => {
      fake.failures.reminderUpdate = true;
      await expect(service.renew(admin, 'domain', 10, renewBody({ reminder_id: 5 }))).rejects.toThrow('simulated write failure');
      expect(key(domain().expiry_date)).toBe('2026-10-21');
      expect(fake.db.assetRenewal).toHaveLength(0);
    });

    it('after a rolled-back attempt the same key can be retried successfully', async () => {
      fake.failures.assetUpdate = true;
      await expect(service.renew(admin, 'domain', 10, renewBody())).rejects.toThrow();
      fake.failures.assetUpdate = false;
      const result = await service.renew(admin, 'domain', 10, renewBody());
      expect(result.replayed).toBe(false);
      expect(key(domain().expiry_date)).toBe('2027-10-21');
    });
  });

  describe('linked reminder', () => {
    it("completes the caller's reminder in the same transaction", async () => {
      const { renewal } = await service.renew(admin, 'domain', 10, renewBody({ reminder_id: 5 }));
      expect(renewal.reminder_id).toBe(5);
      expect(fake.db.reminder[0].is_completed).toBe(true);
    });

    it("refuses another user's reminder and renews nothing", async () => {
      await expect(service.renew(admin, 'domain', 10, renewBody({ reminder_id: 6 }))).rejects.toThrow('Reminder not found.');
      expect(fake.db.reminder[1].is_completed).toBe(false);
      expect(key(domain().expiry_date)).toBe('2026-10-21');
      expect(fake.db.assetRenewal).toHaveLength(0);
    });

    it.each([
      [12, 'not linked to this domain'], // unrelated reminder of the caller
      [13, 'not linked to this domain'], // reminder linked to another domain
      [16, 'not linked to this domain'], // reminder linked to a server
      [15, 'not linked to this domain'], // legacy title matches, but not linked: no inference from titles
      [14, 'already completed'],
      [999, 'Reminder not found.'],
    ])('refuses reminder %i (%s): nothing is renewed or completed', async (reminderId, message) => {
      await expect(service.renew(admin, 'domain', 10, renewBody({ reminder_id: reminderId }))).rejects.toThrow(message);
      expect(key(domain().expiry_date)).toBe('2026-10-21');
      expect(fake.db.assetRenewal).toHaveLength(0);
      expect(fake.db.reminder.filter((r) => r.id !== 14).every((r) => !r.is_completed)).toBe(true);
    });

    it("a server renewal completes the server's linked reminder, and refuses a domain's reminder", async () => {
      await expect(service.renew(admin, 'server', 7, renewBody({ reminder_id: 5 }))).rejects.toThrow('not linked to this server');
      expect(key(server().expiry_date)).toBe('2026-10-21');
      expect(fake.db.assetRenewal).toHaveLength(0);

      const { renewal } = await service.renew(admin, 'server', 7, renewBody({ idempotency_key: 'renew-key-0016', reminder_id: 16 }));
      expect(renewal.reminder_id).toBe(16);
      expect(fake.db.reminder.find((r) => r.id === 16)!.is_completed).toBe(true);
      expect(key(server().expiry_date)).toBe('2026-11-21');
    });

    it('a failed attempt validates the reminder the same way and leaves it open', async () => {
      await expect(service.recordFailure(admin, 'domain', 10, { idempotency_key: 'fail-key-0001', failure_reason: 'x', reminder_id: 12 })).rejects.toThrow(BadRequestException);
      await service.recordFailure(admin, 'domain', 10, { idempotency_key: 'fail-key-0002', failure_reason: 'x', reminder_id: 5 });
      expect(fake.db.reminder[0].is_completed).toBe(false);
    });
  });

  describe('renewals vs. manual expiry edits (PUT/PATCH)', () => {
    let infra: InfrastructureService;
    beforeEach(() => {
      infra = new InfrastructureService(fake.prisma);
    });
    const events = () => fake.db.assetRenewal.map((r) => r.event);

    it('a stale edit form (expiry left as loaded) saves its other fields and keeps a renewal made meanwhile', async () => {
      await service.renew(admin, 'domain', 10, renewBody());
      await infra.updateDomain(admin, 10, { notes: 'edited', expiry_date: '2026-10-21', expected_expiry_date: '2026-10-21' });
      expect(key(domain().expiry_date)).toBe('2027-10-21');
      expect((domain() as any).notes).toBe('edited');
      expect(events()).toEqual(['renewed']); // no manual change recorded
    });

    it('a stale edit form that changes the expiry after a renewal is refused with 409', async () => {
      await service.renew(admin, 'domain', 10, renewBody());
      const error = await errorOf(infra.updateDomain(admin, 10, { expiry_date: '2026-12-01', expected_expiry_date: '2026-10-21' }));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ current_expiry_date: '2027-10-21' });
      expect(key(domain().expiry_date)).toBe('2027-10-21');
      expect(events()).toEqual(['renewed']);
    });

    it('a renewal after a manual change of the expiry is refused with 409 (stale expected date)', async () => {
      await infra.updateDomain(admin, 10, { expiry_date: '2026-12-01', expected_expiry_date: '2026-10-21' });
      const error = await errorOf(service.renew(admin, 'domain', 10, renewBody()));
      expect(error).toBeInstanceOf(ConflictException);
      expect(key(domain().expiry_date)).toBe('2026-12-01');
      expect(events()).toEqual(['manual_change']);
    });

    it.each([
      ['with expected_expiry_date', { expiry_date: '2026-12-01', expected_expiry_date: '2026-10-21' }],
      ['without expected_expiry_date (older clients)', { expiry_date: '2026-12-01' }],
    ])('concurrent renewal and manual edit (%s): exactly one wins, nothing is silently overwritten', async (_label, edit) => {
      const [renewal, manual] = await Promise.allSettled([
        service.renew(admin, 'domain', 10, renewBody()),
        infra.updateDomain(admin, 10, edit),
      ]);
      const outcomes = [renewal.status, manual.status];
      expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
      const loser = (renewal.status === 'rejected' ? renewal : manual) as PromiseRejectedResult;
      expect(loser.reason).toBeInstanceOf(ConflictException);
      // The stored expiry is exactly the winner's result, and the history records only the winner
      if (renewal.status === 'fulfilled') {
        expect(key(domain().expiry_date)).toBe('2027-10-21');
        expect(events()).toEqual(['renewed']);
      } else {
        expect(key(domain().expiry_date)).toBe('2026-12-01');
        expect(events()).toEqual(['manual_change']);
      }
    });

    it('servers: a stale edit cannot undo a renewal; a deliberate edit with the current date works', async () => {
      await service.renew(admin, 'server', 7, renewBody()); // 2026-10-21 -> 2026-11-21
      await expect(infra.updateServer(admin, 7, { expiry_date: '2026-10-25', expected_expiry_date: '2026-10-21' })).rejects.toThrow(ConflictException);
      expect(key(server().expiry_date)).toBe('2026-11-21');

      await infra.updateServer(admin, 7, { expiry_date: '2026-12-01', expected_expiry_date: '2026-11-21' });
      expect(key(server().expiry_date)).toBe('2026-12-01');
      expect(events()).toEqual(['renewed', 'manual_change']);
      const manual = fake.db.assetRenewal[1];
      expect([key(manual.previous_expiry_date), key(manual.new_expiry_date)]).toEqual(['2026-11-21', '2026-12-01']);
    });

    it('an edit that does not send expiry_date never writes the column', async () => {
      await service.renew(admin, 'domain', 10, renewBody());
      await infra.updateDomain(admin, 10, { notes: 'only notes' });
      const calls = fake.prisma.domain.update.mock.calls; // the edit ran without a transaction
      expect(calls).toHaveLength(1);
      expect(calls[0][0].data).not.toHaveProperty('expiry_date', expect.anything());
      expect(key(domain().expiry_date)).toBe('2027-10-21');
    });
  });

  describe('failed renewal attempts', () => {
    const failBody = (overrides: any = {}) => ({ idempotency_key: 'fail-key-0001', failure_reason: 'Card declined', ...overrides });

    it('records the attempt and leaves the expiry date and the reminder unchanged', async () => {
      const result = await service.recordFailure(admin, 'domain', 10, failBody({ reminder_id: 5, cost: 900, payment_reference: 'TXN-1' }));
      expect(result.replayed).toBe(false);
      expect(result.renewal).toMatchObject({ event: 'failed', failure_reason: 'Card declined', new_expiry_date: null, cost: '900', reminder_id: 5 });
      expect(result.renewal.cycle_key).toBeUndefined(); // failures never claim the expiry cycle
      expect(key(result.renewal.previous_expiry_date)).toBe('2026-10-21');
      expect(key(domain().expiry_date)).toBe('2026-10-21');
      expect(fake.db.reminder[0].is_completed).toBe(false);
    });

    it('does not block a later successful renewal of the same expiry', async () => {
      await service.recordFailure(admin, 'domain', 10, failBody());
      await service.renew(admin, 'domain', 10, renewBody());
      expect(key(domain().expiry_date)).toBe('2027-10-21');
    });

    it('is idempotent', async () => {
      await service.recordFailure(admin, 'domain', 10, failBody());
      const retry = await service.recordFailure(admin, 'domain', 10, failBody());
      expect(retry.replayed).toBe(true);
      expect(fake.db.assetRenewal).toHaveLength(1);
    });

    it('requires a reason, and refuses a stale expected expiry date', async () => {
      await expect(service.recordFailure(admin, 'domain', 10, failBody({ failure_reason: '  ' }))).rejects.toThrow('Failure reason is required.');
      await expect(service.recordFailure(admin, 'domain', 10, failBody({ expected_expiry_date: '2026-01-01' }))).rejects.toThrow(ConflictException);
      expect(fake.db.assetRenewal).toHaveLength(0);
    });
  });

  describe('history', () => {
    it('lists the asset history newest first, with a consistent chain of expiry dates', async () => {
      await service.renew(admin, 'domain', 10, renewBody());
      await service.recordFailure(admin, 'domain', 10, { idempotency_key: 'fail-key-0001', failure_reason: 'Registrar outage' });
      await service.renew(admin, 'domain', 10, renewBody({ idempotency_key: 'renew-key-0002', expected_expiry_date: '2027-10-21' }));

      const history = await service.getHistory('domain', 10);
      expect(history.map((h: any) => h.event)).toEqual(['renewed', 'failed', 'renewed']);
      const renewed = history.filter((h: any) => h.event === 'renewed').reverse();
      expect(renewed.map((h: any) => [key(h.previous_expiry_date), key(h.new_expiry_date)])).toEqual([
        ['2026-10-21', '2027-10-21'],
        ['2027-10-21', '2028-10-21'],
      ]);
      expect(key(domain().expiry_date)).toBe('2028-10-21');
      expect(await service.getHistory('server', 7)).toEqual([]);
    });

    it('stays available after the asset is deleted', async () => {
      await service.renew(admin, 'domain', 10, renewBody());
      fake.db.domain.splice(0, 1); // deleted (domain_id becomes NULL in the database)
      const history = await service.getHistory('domain', 10);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ asset_id: 10, asset_name: 'example.com' });
    });

    it('404 when neither the asset nor any history exists', async () => {
      await expect(service.getHistory('domain', 999)).rejects.toThrow(NotFoundException);
    });
  });
});
