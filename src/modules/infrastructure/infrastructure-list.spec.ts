import { CredentialCryptoService } from '../../core/credential-crypto.service';
import { CredentialAuditService } from '../credential-audit/credential-audit.service';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { InfrastructureService } from './infrastructure.service';
import { PrismaService } from '../../core/prisma.service';
import {
  EXPIRY_ALERT_WINDOW_DAYS,
  expiryFilterWhere,
  expiryOrderBy,
  parseToday,
  searchTerm,
} from './infrastructure-list.util';

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('infrastructure list helpers', () => {
  describe('parseToday (calendar day, no timezone shift)', () => {
    it('uses the client date as UTC midnight (the DATE column format)', () => {
      expect(parseToday('2026-10-19')).toEqual(day('2026-10-19'));
    });

    it('falls back to the local calendar date at any time of day', () => {
      expect(parseToday(undefined, new Date(2026, 9, 19, 0, 5))).toEqual(day('2026-10-19'));
      expect(parseToday('', new Date(2026, 9, 19, 23, 55))).toEqual(day('2026-10-19'));
    });

    it('rejects invalid dates', () => {
      for (const bad of ['2026-02-30', '19/10/2026', 'today', '2026-10-19T10:00']) {
        expect(() => parseToday(bad)).toThrow(BadRequestException);
      }
    });
  });

  describe('expiryFilterWhere', () => {
    const today = day('2026-10-19');

    it('expired: strictly before today (expiring today is not expired)', () => {
      expect(expiryFilterWhere('expired', today)).toEqual({ expiry_date: { lt: today } });
    });

    it('within_7 / within_30: today through today + N days, inclusive; uses the 30-day alert window', () => {
      expect(EXPIRY_ALERT_WINDOW_DAYS).toBe(30);
      expect(expiryFilterWhere('within_7', today)).toEqual({ expiry_date: { gte: today, lte: day('2026-10-26') } });
      expect(expiryFilterWhere('within_30', today)).toEqual({ expiry_date: { gte: today, lte: day('2026-11-18') } });
    });

    it('none: no expiry date; empty or "all": no filter', () => {
      expect(expiryFilterWhere('none', today)).toEqual({ expiry_date: null });
      expect(expiryFilterWhere(undefined, today)).toBeUndefined();
      expect(expiryFilterWhere('', today)).toBeUndefined();
      expect(expiryFilterWhere('all', today)).toBeUndefined();
    });

    it('rejects unknown filters', () => {
      expect(() => expiryFilterWhere('soon', today)).toThrow(BadRequestException);
    });
  });

  describe('expiryOrderBy', () => {
    it('defaults to earliest first; missing dates last; stable tie-break', () => {
      expect(expiryOrderBy(undefined)).toEqual([{ expiry_date: { sort: 'asc', nulls: 'last' } }, { id: 'desc' }]);
      expect(expiryOrderBy('expiry_date')).toEqual(expiryOrderBy(undefined));
    });

    it('descending keeps missing dates last too', () => {
      expect(expiryOrderBy('-expiry_date')).toEqual([{ expiry_date: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }]);
    });

    it('rejects other orderings (no arbitrary column sorting)', () => {
      expect(() => expiryOrderBy('password')).toThrow(BadRequestException);
    });
  });

  it('searchTerm trims and drops empty terms', () => {
    expect(searchTerm('  tre ')).toBe('tre');
    expect(searchTerm('   ')).toBeUndefined();
    expect(searchTerm(undefined)).toBeUndefined();
  });
});

describe('InfrastructureService list sorting, search and expiry filters', () => {
  let service: InfrastructureService;
  const prisma: any = {
    server: { findMany: jest.fn(), count: jest.fn() },
    domain: { findMany: jest.fn(), count: jest.fn() },
    projectMember: { findMany: jest.fn() },
    // Server names ignoring spaces (server-name-search.spec); no such matches here
    $queryRaw: jest.fn(),
  };
  const admin = { id: 1, role: { name: 'SUPER_ADMIN' } };
  const staff = { id: 2, role: { name: 'DEVELOPER' } };
  const lastFindMany = (model: 'server' | 'domain') => prisma[model].findMany.mock.calls.at(-1)[0];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InfrastructureService,
        { provide: PrismaService, useValue: prisma },
        // Server passwords are not exercised here
        { provide: CredentialCryptoService, useValue: {} },
        { provide: CredentialAuditService, useValue: {} },
      ],
    }).compile();
    service = module.get(InfrastructureService);
    jest.clearAllMocks();
    prisma.server.findMany.mockResolvedValue([]);
    prisma.server.count.mockResolvedValue(12);
    prisma.domain.findMany.mockResolvedValue([]);
    prisma.domain.count.mockResolvedValue(12);
    prisma.$queryRaw.mockResolvedValue([]);
  });

  describe('servers', () => {
    it('searches name, provider, notes (and owner, IP as before) partially without mode; never credentials', async () => {
      await service.getServers(admin, { search: ' Prod ' });
      const { where } = lastFindMany('server');
      expect(where.OR).toEqual([
        { name: { contains: 'Prod' } },
        { provider: { contains: 'Prod' } },
        { notes: { contains: 'Prod' } },
        { owner: { contains: 'Prod' } },
        { ip_address: { contains: 'Prod' } },
        { server_ip: { contains: 'Prod' } },
      ]);
      const json = JSON.stringify(where);
      expect(json).not.toContain('mode');
      expect(json).not.toContain('password');
      expect(json).not.toContain('username');
    });

    it('sorts the whole dataset in the database (default earliest first, nulls last) and pages after sorting', async () => {
      await service.getServers(admin, { page: '3', limit: '5' });
      expect(lastFindMany('server')).toMatchObject({ orderBy: expiryOrderBy(undefined), skip: 10, take: 5 });
      await service.getServers(admin, { ordering: '-expiry_date' });
      expect(lastFindMany('server').orderBy).toEqual(expiryOrderBy('-expiry_date'));
    });

    it('applies the expiry filter to both the count and the page', async () => {
      await service.getServers(admin, { expiry: 'within_30', today: '2026-10-19' });
      const expected = { AND: [{ expiry_date: { gte: day('2026-10-19'), lte: day('2026-11-18') } }] };
      expect(lastFindMany('server').where).toEqual(expected);
      expect(prisma.server.count).toHaveBeenLastCalledWith({ where: expected });
    });

    it('keeps the non-admin project scope alongside search and filters', async () => {
      prisma.projectMember.findMany.mockResolvedValue([{ project_id: 3 }]);
      await service.getServers(staff, { search: 'web', expiry: 'expired', today: '2026-10-19' });
      const { where } = lastFindMany('server');
      expect(where.domains).toEqual({ some: { project_id: { in: [3] } } });
      expect(where.AND).toEqual([{ expiry_date: { lt: day('2026-10-19') } }]);
      expect(where.OR).toHaveLength(6); // name, provider, notes, owner, ip_address, server_ip
    });

    it('bad ordering, filter or date values are rejected before any query', async () => {
      await expect(service.getServers(admin, { ordering: 'name' })).rejects.toThrow(BadRequestException);
      await expect(service.getServers(admin, { expiry: 'later' })).rejects.toThrow(BadRequestException);
      await expect(service.getServers(admin, { expiry: 'expired', today: '2026-13-01' })).rejects.toThrow(BadRequestException);
      expect(prisma.server.findMany).not.toHaveBeenCalled();
    });

    it('the expiry-only list (notifications) is unchanged when no filter is sent', async () => {
      await service.getServers(admin, { fields: 'expiry' });
      expect(lastFindMany('server')).toEqual({
        where: { expiry_date: { not: null } },
        select: { id: true, name: true, expiry_date: true },
        orderBy: { expiry_date: 'asc' },
      });
    });
  });

  describe('domains', () => {
    it('search covers domain name, provider, project name and server name', async () => {
      await service.getDomains(admin, { search: 'tre' });
      expect(lastFindMany('domain').where.OR).toEqual([
        { domain_name: { contains: 'tre' } },
        { provider: { contains: 'tre' } },
        { project: { name: { contains: 'tre' } } },
        { server: { name: { contains: 'tre' } } },
      ]);
    });

    it('sorts in the database before paging; descending keeps missing dates last', async () => {
      await service.getDomains(admin, { ordering: '-expiry_date', page: '2', limit: '5' });
      expect(lastFindMany('domain')).toMatchObject({ orderBy: expiryOrderBy('-expiry_date'), skip: 5, take: 5 });
    });

    it.each([
      ['expired', { expiry_date: { lt: day('2026-10-19') } }],
      ['within_7', { expiry_date: { gte: day('2026-10-19'), lte: day('2026-10-26') } }],
      ['none', { expiry_date: null }],
    ])('expiry=%s filters count and page', async (expiry, condition) => {
      await service.getDomains(admin, { expiry, today: '2026-10-19' });
      expect(lastFindMany('domain').where).toEqual({ AND: [condition] });
      expect(prisma.domain.count).toHaveBeenLastCalledWith({ where: { AND: [condition] } });
    });

    it('keeps the non-admin project scope', async () => {
      prisma.projectMember.findMany.mockResolvedValue([{ project_id: 3 }]);
      await service.getDomains(staff, { expiry: 'none' });
      expect(lastFindMany('domain').where).toEqual({ project_id: { in: [3] }, AND: [{ expiry_date: null }] });
    });
  });
});
