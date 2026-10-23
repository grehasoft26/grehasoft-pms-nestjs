import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { InfrastructureService } from './infrastructure.service';
import { PrismaService } from '../../core/prisma.service';

/**
 * Domain names are unique ignoring case and surrounding spaces. The in-memory fake evaluates the
 * service's duplicate-check SQL (LOWER(TRIM(TRAILING '.' FROM TRIM(domain_name))) = ? [AND id <> ?] [FOR UPDATE]) and
 * models FOR UPDATE as a lock held until the transaction ends, as InnoDB does (verified against
 * the local MySQL: a second locking read waits for the first transaction).
 */
const tick = () => new Promise((r) => setTimeout(r, 5));

const buildFake = (opts: { honourLocks?: boolean } = {}) => {
  const honourLocks = opts.honourLocks ?? true;
  const domains: Array<{ id: number; domain_name: string; [k: string]: any }> = [
    { id: 1, domain_name: 'tresbonelectrolysis.com', project_id: null, server_id: null },
    { id: 2, domain_name: 'grehasoft.com', project_id: null, server_id: null },
  ];
  let nextId = 3;
  const txQueries: string[] = [];
  // FOR UPDATE: one holder at a time; others wait until it commits
  let holder: symbol | null = null;
  const waiters: Array<() => void> = [];
  const acquire = async (txId: symbol) => {
    while (holder && holder !== txId) await new Promise<void>((r) => waiters.push(r));
    holder = txId;
  };
  const release = (txId: symbol) => {
    if (holder === txId) {
      holder = null;
      waiters.splice(0).forEach((w) => w());
    }
  };

  const client = (txId?: symbol): any => ({
    $queryRaw: jest.fn(async (sql: any) => {
      const [key, excludeId] = sql.values;
      if (txId) txQueries.push(sql.sql);
      if (honourLocks && txId && /FOR UPDATE/.test(sql.sql)) await acquire(txId);
      await tick(); // let concurrent requests interleave
      return domains
        .filter((d) => d.domain_name.trim().toLowerCase() === key && (excludeId === undefined || d.id !== excludeId))
        .map((d) => ({ id: d.id }));
    }),
    domain: {
      create: jest.fn(async ({ data }: any) => {
        await tick();
        const row = { id: nextId++, ...data };
        domains.push(row);
        return { ...row, project: null, server: null };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = domains.find((d) => d.id === where.id)!;
        for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
        return { ...row, project: null, server: null };
      }),
      findUnique: jest.fn(async ({ where }: any) => domains.find((d) => d.id === where.id) ?? null),
    },
  });

  const prisma: any = {
    ...client(),
    $transaction: jest.fn(async (fn: any) => {
      const txId = Symbol('tx');
      try {
        return await fn(client(txId));
      } finally {
        release(txId); // commit / rollback
      }
    }),
  };
  return { prisma, domains, txQueries };
};

const admin = { id: 1, role: { name: 'SUPER_ADMIN' } };
const MESSAGE = 'Domain already exists.';

const make = async (prisma: any) => {
  const module: TestingModule = await Test.createTestingModule({
    providers: [InfrastructureService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return module.get(InfrastructureService);
};

const expectDuplicate = async (promise: Promise<unknown>) => {
  const error: any = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(ConflictException);
  expect(error.getStatus()).toBe(409);
  expect(error.getResponse()).toMatchObject({ message: MESSAGE, domain_name: MESSAGE });
};

describe('Domain name uniqueness', () => {
  let fake: ReturnType<typeof buildFake>;
  let service: InfrastructureService;

  beforeEach(async () => {
    fake = buildFake();
    service = await make(fake.prisma);
  });

  describe('create', () => {
    it('1. a new unique domain is created (trimmed, case kept)', async () => {
      const created: any = await service.createDomain(admin, { domain_name: '  Example.org ' });
      expect(created.domain_name).toBe('Example.org');
      expect(fake.domains.map((d) => d.domain_name)).toContain('Example.org');
    });

    it('2. an exact duplicate is rejected with 409 "Domain already exists."', async () => {
      await expectDuplicate(service.createDomain(admin, { domain_name: 'tresbonelectrolysis.com' }));
    });

    it('3. a duplicate with different capitalization is rejected', async () => {
      await expectDuplicate(service.createDomain(admin, { domain_name: 'TRESBONELECTROLYSIS.COM' }));
    });

    it('4. leading/trailing whitespace does not bypass the check', async () => {
      await expectDuplicate(service.createDomain(admin, { domain_name: ' Tresbonelectrolysis.com ' }));
      await expectDuplicate(service.createDomain(admin, { domain_name: '\tgrehasoft.com\n' }));
      expect(fake.domains).toHaveLength(2);
    });

    it('genuinely different names are allowed (no prefix/suffix matching)', async () => {
      for (const name of ['tresbonelectrolysis.co', 'www.tresbonelectrolysis.com', 'grehasoft.com.au']) {
        await service.createDomain(admin, { domain_name: name });
      }
      expect(fake.domains).toHaveLength(5);
    });

    it('a blank name is a 400, not a duplicate', async () => {
      await expect(service.createDomain(admin, { domain_name: '   ' })).rejects.toThrow(BadRequestException);
    });
  });

  describe('update', () => {
    it('5. saving a domain without changing its name succeeds (no self-clash; other spacing/case ok)', async () => {
      await service.updateDomain(admin, 1, { domain_name: 'tresbonelectrolysis.com', notes: 'renewed' });
      await service.updateDomain(admin, 1, { domain_name: ' TresbonElectrolysis.com ', notes: 'again' });
      await service.updateDomain(admin, 1, { notes: 'name not sent' });
      expect(fake.domains.find((d) => d.id === 1)!.notes).toBe('name not sent');
    });

    it('6. renaming a domain to another existing domain is rejected', async () => {
      await expectDuplicate(service.updateDomain(admin, 2, { domain_name: 'TRESBONELECTROLYSIS.com' }));
      expect(fake.domains.find((d) => d.id === 2)!.domain_name).toBe('grehasoft.com');
    });

    it('renaming to a free name succeeds and is checked excluding the record itself', async () => {
      await service.updateDomain(admin, 2, { domain_name: 'grehasoft.in' });
      expect(fake.domains.find((d) => d.id === 2)!.domain_name).toBe('grehasoft.in');
    });

    it('an existing duplicate pair can still be edited without renaming', async () => {
      fake.domains.push({ id: 9, domain_name: 'TRESBONELECTROLYSIS.COM', project_id: null, server_id: null });
      await service.updateDomain(admin, 9, { domain_name: 'TRESBONELECTROLYSIS.COM', notes: 'kept' });
      expect(fake.domains).toHaveLength(3);
    });
  });

  describe('7. concurrent creation', () => {
    it('two simultaneous creates of the same name persist only one record', async () => {
      const results = await Promise.allSettled([
        service.createDomain(admin, { domain_name: 'race.example' }),
        service.createDomain(admin, { domain_name: 'RACE.example ' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ConflictException);
      expect(fake.domains.filter((d) => d.domain_name.trim().toLowerCase() === 'race.example')).toHaveLength(1);
    });

    it('control: without the lock the same race would store two records (the test can detect it)', async () => {
      const unlocked = buildFake({ honourLocks: false });
      const unsafe = await make(unlocked.prisma);
      await Promise.allSettled([
        unsafe.createDomain(admin, { domain_name: 'race.example' }),
        unsafe.createDomain(admin, { domain_name: 'race.example' }),
      ]);
      expect(unlocked.domains.filter((d) => d.domain_name === 'race.example')).toHaveLength(2);
    });

    it('the check is a locking read inside the same transaction as the insert', async () => {
      await service.createDomain(admin, { domain_name: 'locked.example' });
      expect(fake.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(fake.txQueries).toHaveLength(1);
      // (Stored names are compared without a trailing dot too, see duplicate-detection.spec)
      expect(fake.txQueries[0]).toMatch(/^SELECT id FROM domains WHERE LOWER\(TRIM\(TRAILING '\.' FROM TRIM\(domain_name\)\)\) = \? FOR UPDATE$/);
      // the insert ran on the transaction client, not outside the transaction
      expect(fake.prisma.domain.create).not.toHaveBeenCalled();
      await service.updateDomain(admin, 2, { domain_name: 'renamed.example' });
      expect(fake.txQueries[1]).toMatch(/LOWER\(TRIM\(TRAILING '\.' FROM TRIM\(domain_name\)\)\) = \? AND id <> \? FOR UPDATE$/);
    });

    it('a deadlock between concurrent saves is retried; a UNIQUE violation maps to 409', async () => {
      let calls = 0;
      fake.prisma.$transaction.mockImplementation(async (fn: any) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'P2034' });
        return fn(fake.prisma);
      });
      await service.createDomain(admin, { domain_name: 'retry.example' });
      expect(calls).toBe(2);

      fake.prisma.$transaction.mockImplementation(async () => {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      });
      await expectDuplicate(service.createDomain(admin, { domain_name: 'after-constraint.example' }));
    });
  });

  describe('availability check (form)', () => {
    it('reports existing names case-/space-insensitively and honours the excluded record', async () => {
      await expect(service.checkDomainName(' TRESBONELECTROLYSIS.COM ')).resolves.toEqual({ exists: true });
      await expect(service.checkDomainName('new.example')).resolves.toEqual({ exists: false });
      await expect(service.checkDomainName('tresbonelectrolysis.com', '1')).resolves.toEqual({ exists: false });
      await expect(service.checkDomainName('tresbonelectrolysis.com', 'x')).rejects.toThrow(BadRequestException);
    });
  });

  describe('9. existing duplicates', () => {
    it('are reported by the check without modifying or deleting either record', async () => {
      fake.domains.push({ id: 9, domain_name: 'tresbonelectrolysis.com', project_id: null, server_id: null });
      await expect(service.checkDomainName('tresbonelectrolysis.com', '1')).resolves.toEqual({ exists: true });
      await expect(service.checkDomainName('tresbonelectrolysis.com', '9')).resolves.toEqual({ exists: true });
      expect(fake.domains.filter((d) => d.domain_name === 'tresbonelectrolysis.com').map((d) => d.id)).toEqual([1, 9]);
      expect(fake.prisma.domain.update).not.toHaveBeenCalled();
    });
  });
});
