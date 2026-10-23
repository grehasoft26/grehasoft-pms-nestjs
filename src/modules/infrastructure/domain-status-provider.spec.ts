import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { InfrastructureService } from './infrastructure.service';
import { PrismaService } from '../../core/prisma.service';
import { DOMAIN_PROVIDERS, parseDomainProvider, parseDomainStatus } from './domain-options';

/**
 * Domain Status (Active/Expired) and Provider (fixed list) on create and update, over an in-memory
 * domains table. Status is whatever the user chose; it is never derived from the expiry date.
 */
const admin = { id: 1, role: { name: 'SUPER_ADMIN' } };

const buildFake = () => {
  // Domain 1 was saved before the provider list existed
  const domains: any[] = [{ id: 1, domain_name: 'legacy.example', provider: 'GoDaddy1', status: 'active', project_id: null, server_id: null, expiry_date: null, purchase_date: null }];
  let nextId = 2;
  const client: any = {
    $queryRaw: jest.fn(async (sql: any) => {
      const [key, excludeId] = sql.values;
      return domains.filter((d) => d.domain_name.trim().toLowerCase() === key && (excludeId === undefined || d.id !== excludeId)).map((d) => ({ id: d.id }));
    }),
    domain: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: nextId++, status: 'active', ...data }; // column default, as in the migration
        domains.push(row);
        return { ...row, project: null, server: null };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = domains.find((d) => d.id === where.id);
        for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
        return { ...row, project: null, server: null };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const row = domains.find((d) => d.id === where.id);
        return row ? { ...row } : null;
      }),
    },
  };
  client.$transaction = jest.fn(async (fn: any) => fn(client));
  return { prisma: client, domains };
};

describe('Domain status and provider', () => {
  let fake: ReturnType<typeof buildFake>;
  let service: InfrastructureService;
  const stored = (id: number) => fake.domains.find((d) => d.id === id);
  const badRequest = async (promise: Promise<unknown>) => {
    const error: any = await promise.then(() => null, (e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getStatus()).toBe(400);
    return error.getResponse();
  };

  beforeEach(async () => {
    fake = buildFake();
    const moduleRef = await Test.createTestingModule({
      providers: [
        InfrastructureService,
        { provide: PrismaService, useValue: fake.prisma },
      ],
    }).compile();
    service = moduleRef.get(InfrastructureService);
  });

  describe('create', () => {
    it.each([
      ['active', 'active'],
      ['expired', 'expired'],
      ['Active', 'active'],
      ['EXPIRED', 'expired'],
    ])('saves status %s as %s', async (status, expected) => {
      const created: any = await service.createDomain(admin, { domain_name: `s-${status}.example`, status, provider: 'Client' });
      expect(created.status).toBe(expected);
      expect(stored(created.id).status).toBe(expected);
    });

    it('defaults to Active when no status is sent (older clients), without looking at the expiry date', async () => {
      const created: any = await service.createDomain(admin, { domain_name: 'old.example', expiry_date: '2020-01-01' });
      expect(stored(created.id)).toMatchObject({ status: 'active', provider: '' });
    });

    it.each([...DOMAIN_PROVIDERS])('saves provider "%s" exactly', async (provider) => {
      const created: any = await service.createDomain(admin, { domain_name: `${provider.replace(/\W/g, '')}.example`, provider, status: 'active' });
      expect(stored(created.id).provider).toBe(provider);
    });

    it('stores the canonical label when the case differs, and "" for no provider', async () => {
      const a: any = await service.createDomain(admin, { domain_name: 'a.example', provider: '  grehasoft cloud ' });
      const b: any = await service.createDomain(admin, { domain_name: 'b.example', provider: '' });
      expect(stored(a.id).provider).toBe('Grehasoft Cloud');
      expect(stored(b.id).provider).toBe('');
    });

    it.each([['pending'], ['inactive'], [' '], [true], [1], [['active']]])('rejects status %p (400) without saving', async (status) => {
      expect(await badRequest(service.createDomain(admin, { domain_name: 'x.example', status }))).toMatchObject({
        message: 'Status must be Active or Expired.',
        status: 'Status must be Active or Expired.',
      });
      expect(fake.prisma.domain.create).not.toHaveBeenCalled();
    });

    it.each([['GoDaddy1'], ['Grehasoft GoDaddy'], ['Hostinger'], ['Grehasoft Hostinger 3'], [42], [{}]])('rejects provider %p (400) without saving', async (provider) => {
      const response: any = await badRequest(service.createDomain(admin, { domain_name: 'x.example', provider }));
      expect(response.message).toBe(`Provider must be one of: ${DOMAIN_PROVIDERS.join(', ')}.`);
      expect(fake.prisma.domain.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('changes status and provider, and the saved values are returned on reload', async () => {
      await service.updateDomain(admin, 1, { status: 'expired', provider: 'Moved' });
      const reloaded = await fake.prisma.domain.findUnique({ where: { id: 1 } });
      expect(reloaded).toMatchObject({ status: 'expired', provider: 'Moved' });
    });

    it('keeps status and provider when they are not sent', async () => {
      await service.updateDomain(admin, 1, { notes: 'renewal due' });
      expect(stored(1)).toMatchObject({ status: 'active', provider: 'GoDaddy1', notes: 'renewal due' });
    });

    it('keeps a provider saved before the list existed when it is re-sent unchanged (edit form)', async () => {
      await service.updateDomain(admin, 1, { provider: 'GoDaddy1', status: 'expired', notes: 'n' });
      expect(stored(1)).toMatchObject({ provider: 'GoDaddy1', status: 'expired' });
    });

    it('rejects changing to a provider outside the list (400) and saves nothing', async () => {
      await badRequest(service.updateDomain(admin, 1, { provider: 'GoDaddy2', notes: 'changed' }));
      expect(stored(1)).toMatchObject({ provider: 'GoDaddy1' });
      expect(stored(1).notes).toBeUndefined();
    });

    it.each([['archived'], [''], [null]])('rejects status %p (400) and saves nothing', async (status) => {
      await badRequest(service.updateDomain(admin, 1, { status }));
      expect(stored(1).status).toBe('active');
      expect(fake.prisma.domain.update).not.toHaveBeenCalled();
    });

    it('can clear the provider', async () => {
      await service.updateDomain(admin, 1, { provider: '' });
      expect(stored(1).provider).toBe('');
    });
  });

  describe('parsers', () => {
    it('status accepts only active/expired', () => {
      expect(parseDomainStatus('Active')).toBe('active');
      expect(() => parseDomainStatus('Moved')).toThrow(BadRequestException);
    });

    it('provider: exact list, an unchanged stored value, or empty', () => {
      expect(parseDomainProvider('Prasanth')).toBe('Prasanth');
      expect(parseDomainProvider('GoDaddy1', 'GoDaddy1')).toBe('GoDaddy1');
      expect(() => parseDomainProvider('GoDaddy1', 'Client')).toThrow(BadRequestException);
      expect(() => parseDomainProvider('GoDaddy1')).toThrow(BadRequestException);
      expect(parseDomainProvider(null)).toBe('');
    });
  });

  describe('"Grehasoft Goddy" renamed to "GoDaddy"', () => {
    it('the list has GoDaddy and no longer the former label', () => {
      expect(DOMAIN_PROVIDERS[0]).toBe('GoDaddy');
      expect(DOMAIN_PROVIDERS).not.toContain('Grehasoft Goddy' as any);
    });

    it('a form loaded before the rename still saves: the former label is stored as GoDaddy', async () => {
      const created: any = await service.createDomain(admin, { domain_name: 'stale-tab.example', provider: 'Grehasoft Goddy' });
      expect(stored(created.id).provider).toBe('GoDaddy');
    });

    it('a domain saved with the former label stays editable and keeps it until changed (no rewrite)', async () => {
      stored(1).provider = 'Grehasoft Goddy';
      await service.updateDomain(admin, 1, { provider: 'Grehasoft Goddy', notes: 'kept' });
      expect(stored(1)).toMatchObject({ provider: 'Grehasoft Goddy', notes: 'kept' });
      await service.updateDomain(admin, 1, { provider: 'GoDaddy' });
      expect(stored(1).provider).toBe('GoDaddy');
    });
  });

  describe('list ?status= filter', () => {
    // 12 domains: ids 1-12, every third one expired; names alternate between two search terms
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      domain_name: `${i % 2 ? 'shop' : 'blog'}-${i + 1}.example`,
      provider: i % 4 === 0 ? 'Client' : 'GoDaddy',
      status: (i + 1) % 3 === 0 ? 'expired' : 'active',
      expiry_date: new Date(2026, 0, 1 + i),
      project_id: null,
      server_id: null,
    }));
    const matches = (row: any, where: any): boolean =>
      (!where.status || row.status === where.status) &&
      (!where.OR ||
        where.OR.some((c: any) =>
          (c.domain_name && row.domain_name.toLowerCase().includes(c.domain_name.contains.toLowerCase())) ||
          (c.provider && row.provider.toLowerCase().includes(c.provider.contains.toLowerCase())),
        )) &&
      (!where.AND || where.AND.every((c: any) => !c.expiry_date?.lt || row.expiry_date < c.expiry_date.lt));
    let listPrisma: any;
    let list: InfrastructureService;

    beforeEach(async () => {
      listPrisma = {
        domain: {
          count: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where)).length),
          findMany: jest.fn(async ({ where, skip = 0, take }: any) => {
            const hits = rows.filter((r) => matches(r, where)).map((r) => ({ ...r, project: null, server: null }));
            return take === undefined ? hits : hits.slice(skip, skip + take);
          }),
        },
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          InfrastructureService,
          { provide: PrismaService, useValue: listPrisma },
        ],
      }).compile();
      list = moduleRef.get(InfrastructureService);
    });
    const ids = (res: any) => (Array.isArray(res) ? res : res.results).map((d: any) => d.id);

    it.each([[undefined], [''], ['all']])('status %p: all statuses', async (status) => {
      const res: any = await list.getDomains(admin, { status, limit: '50' } as any);
      expect(res.count).toBe(12);
    });

    it('Active shows only active domains; Expired only expired ones', async () => {
      const active: any = await list.getDomains(admin, { status: 'active', limit: '50' });
      const expired: any = await list.getDomains(admin, { status: 'expired', limit: '50' });
      expect(active.results.every((d: any) => d.status === 'active')).toBe(true);
      expect(expired.results.every((d: any) => d.status === 'expired')).toBe(true);
      expect(ids(expired)).toEqual([3, 6, 9, 12]);
      expect(active.count + expired.count).toBe(12);
    });

    it('works with the text search', async () => {
      const res: any = await list.getDomains(admin, { status: 'expired', search: 'shop', limit: '50' });
      expect(ids(res)).toEqual([6, 12]); // expired AND name contains "shop"
      expect(listPrisma.domain.findMany.mock.calls[0][0].where).toMatchObject({ status: 'expired', OR: expect.any(Array) });
    });

    it('works with the expiry filter (status is not derived from it)', async () => {
      const res: any = await list.getDomains(admin, { status: 'active', expiry: 'expired', today: '2026-01-06', limit: '50' });
      // expiry date before 6 Jan: ids 1-5; of those, stored status active: 1, 2, 4, 5
      expect(ids(res)).toEqual([1, 2, 4, 5]);
    });

    it('paginates the filtered result (count and pages over matching domains only)', async () => {
      const page1: any = await list.getDomains(admin, { status: 'active', page: '1', limit: '5' });
      const page2: any = await list.getDomains(admin, { status: 'active', page: '2', limit: '5' });
      expect(page1.count).toBe(8);
      expect(ids(page1)).toEqual([1, 2, 4, 5, 7]);
      expect(ids(page2)).toEqual([8, 10, 11]);
      expect(page1.next).not.toBeNull();
      expect(page2.next).toBeNull();
    });

    it('also applies to ?all=true', async () => {
      expect(ids(await list.getDomains(admin, { status: 'expired', all: 'true' }))).toEqual([3, 6, 9, 12]);
    });

    it.each([['pending'], ['Moved'], ['1']])('rejects status %p (400) before querying', async (status) => {
      await expect(list.getDomains(admin, { status })).rejects.toThrow(BadRequestException);
      expect(listPrisma.domain.count).not.toHaveBeenCalled();
      expect(listPrisma.domain.findMany).not.toHaveBeenCalled();
    });
  });
});
