import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InfrastructureService } from './infrastructure.service';
import { PrismaService } from '../../core/prisma.service';

describe('InfrastructureService - Domains', () => {
  let service: InfrastructureService;

  const mockPrismaService = {
    domain: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    projectMember: {
      findMany: jest.fn(),
    },
    reminder: {
      create: jest.fn(),
    },
    // Manual expiry changes are recorded in the renewal history
    assetRenewal: {
      create: jest.fn(async (args: any) => ({ id: 1, ...args.data })),
    },
    // Domain writes run the duplicate-name check (raw query, no clash here) in a transaction;
    // expiry changes lock the row (SELECT id, expiry_date ... FOR UPDATE), answered from the stored domain
    $queryRaw: jest.fn(async (sql: any): Promise<any[]> => {
      if (!/expiry_date FROM domains/.test(sql.sql)) return [];
      const row = await mockPrismaService.domain.findUnique({ where: { id: sql.values[0] } });
      return row ? [{ id: row.id, expiry_date: row.expiry_date ?? null }] : [];
    }),
    $transaction: jest.fn(async (fn: any) => fn(mockPrismaService)),
  };

  const mockUser = { id: 1, name: 'Admin User', role: { name: 'SUPER_ADMIN' } };

  const buildDomain = (overrides: any = {}) => ({
    id: 10,
    project_id: 3,
    server_id: null,
    domain_name: 'example.com',
    expiry_date: new Date('2026-12-15'),
    project: { id: 3, name: 'Project A' },
    server: null,
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InfrastructureService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<InfrastructureService>(InfrastructureService);

    jest.clearAllMocks();
  });

  describe('searching domains (GET /infrastructure/domains?search=)', () => {
    const PARTIAL = (term: string) => [
      { domain_name: { contains: term } },
      { provider: { contains: term } },
      { project: { name: { contains: term } } },
      { server: { name: { contains: term } } },
    ];
    const lastWhere = () => mockPrismaService.domain.findMany.mock.calls.at(-1)[0].where;

    beforeEach(() => {
      mockPrismaService.domain.findMany.mockResolvedValue([buildDomain({ domain_name: 'tresbonelectrolysis.com' })]);
      mockPrismaService.domain.count.mockResolvedValue(1);
    });

    it.each(['tre', 'TRES', 'electro'])('"%s": partial match on domain name, provider, project name and server name', async (term) => {
      const res: any = await service.getDomains(mockUser, { search: term });
      expect(lastWhere()).toEqual({ OR: PARTIAL(term) });
      expect(res.results.map((d: any) => d.domain_name)).toEqual(['tresbonelectrolysis.com']);
    });

    it('never uses mode: "insensitive" (Prisma rejects it on MySQL; the collation is case-insensitive)', async () => {
      await service.getDomains(mockUser, { search: 'Tre' });
      await service.getDomains(mockUser, { search: 'tre', all: 'true' });
      for (const [args] of mockPrismaService.domain.findMany.mock.calls) expect(JSON.stringify(args.where)).not.toContain('mode');
      for (const [args] of mockPrismaService.domain.count.mock.calls) expect(JSON.stringify(args.where)).not.toContain('mode');
    });

    it('trims the term; an empty or blank search (cleared box) lists every domain', async () => {
      await service.getDomains(mockUser, { search: '  tre ' });
      expect(lastWhere()).toEqual({ OR: PARTIAL('tre') });
      for (const search of ['', '   ', undefined]) {
        await service.getDomains(mockUser, { search });
        expect(lastWhere()).toEqual({});
      }
    });

    it('no match returns an empty page (not an error)', async () => {
      mockPrismaService.domain.findMany.mockResolvedValue([]);
      mockPrismaService.domain.count.mockResolvedValue(0);
      await expect(service.getDomains(mockUser, { search: 'zzz-no-match' })).resolves.toMatchObject({ count: 0, results: [] });
    });

    it('keeps pagination and the non-admin project scope', async () => {
      const staff = { id: 2, role: { name: 'DEVELOPER' } };
      mockPrismaService.projectMember.findMany.mockResolvedValue([{ project_id: 3 }]);
      await service.getDomains(staff, { search: 'tre', page: '2', limit: '5' });
      const args = mockPrismaService.domain.findMany.mock.calls.at(-1)[0];
      expect(args.where).toEqual({ project_id: { in: [3] }, OR: PARTIAL('tre') });
      expect(args).toMatchObject({ skip: 5, take: 5 });
      expect(mockPrismaService.domain.count).toHaveBeenLastCalledWith({ where: args.where });
    });
  });

  describe('createDomain', () => {
    it('stores the actual expiry date and does not create a 30-day renewal reminder', async () => {
      mockPrismaService.domain.create.mockResolvedValue(buildDomain());

      const result = await service.createDomain(mockUser, {
        project: 3,
        domain_name: 'example.com',
        expiry_date: '2026-12-15',
      });

      const createArgs = mockPrismaService.domain.create.mock.calls[0][0];
      expect(createArgs.data.expiry_date.toISOString().split('T')[0]).toBe('2026-12-15');
      expect(mockPrismaService.reminder.create).not.toHaveBeenCalled();
      expect(result.project_name).toBe('Project A');
    });
  });

  describe('updateDomain', () => {
    it('updates the expiry date without creating renewal reminders', async () => {
      mockPrismaService.domain.findUnique.mockResolvedValue(buildDomain());
      mockPrismaService.domain.update.mockResolvedValue(
        buildDomain({ expiry_date: new Date('2027-01-20') }),
      );

      await service.updateDomain(mockUser, 10, { expiry_date: '2027-01-20' });

      const updateArgs = mockPrismaService.domain.update.mock.calls[0][0];
      expect(updateArgs.data.expiry_date.toISOString().split('T')[0]).toBe('2027-01-20');
      expect(mockPrismaService.reminder.create).not.toHaveBeenCalled();
    });

    it('does not create duplicate reminders when saved repeatedly', async () => {
      mockPrismaService.domain.findUnique.mockResolvedValue(buildDomain());
      mockPrismaService.domain.update.mockResolvedValue(buildDomain());

      await service.updateDomain(mockUser, 10, { notes: 'first save' });
      await service.updateDomain(mockUser, 10, { notes: 'second save' });

      expect(mockPrismaService.reminder.create).not.toHaveBeenCalled();
    });

    it('keeps the existing expiry date when expiry_date is not provided', async () => {
      const existing = buildDomain();
      mockPrismaService.domain.findUnique.mockResolvedValue(existing);
      mockPrismaService.domain.update.mockResolvedValue(existing);

      await service.updateDomain(mockUser, 10, { notes: 'note only' });

      // Not written at all (previously the value read at the start was written back, which could
      // undo a renewal committed in between); the stored date is kept
      const updateArgs = mockPrismaService.domain.update.mock.calls[0][0];
      expect(updateArgs.data.expiry_date).toBeUndefined();
    });

    it('throws NotFoundException for a missing domain', async () => {
      mockPrismaService.domain.findUnique.mockResolvedValue(null);

      await expect(service.updateDomain(mockUser, 999, {})).rejects.toThrow(NotFoundException);
    });
  });

  describe('domain dates (date-only, same parsing as servers)', () => {
    const createData = () => mockPrismaService.domain.create.mock.calls[0][0].data;
    const updateData = () => mockPrismaService.domain.update.mock.calls[0][0].data;
    const day = (d: Date | null) => (d ? d.toISOString() : d);

    beforeEach(() => {
      mockPrismaService.domain.create.mockResolvedValue(buildDomain());
      mockPrismaService.domain.findUnique.mockResolvedValue(
        buildDomain({ purchase_date: new Date('2025-10-21'), expiry_date: new Date('2026-10-21') }),
      );
      mockPrismaService.domain.update.mockResolvedValue(buildDomain());
    });

    it('stores purchase and expiry dates as UTC midnight of the selected day', async () => {
      await service.createDomain(mockUser, { domain_name: 'a.test', purchase_date: '2025-10-21', expiry_date: '2026-10-21' });
      expect(day(createData().purchase_date)).toBe('2025-10-21T00:00:00.000Z');
      expect(day(createData().expiry_date)).toBe('2026-10-21T00:00:00.000Z');
    });

    it('accepts the ISO timestamp the API returns for a DATE (the calendar day is kept)', async () => {
      await service.updateDomain(mockUser, 10, { expiry_date: '2027-10-21T00:00:00.000Z' });
      expect(day(updateData().expiry_date)).toBe('2027-10-21T00:00:00.000Z');
    });

    it.each(['not-a-date', '2026-02-30', '2026-13-01', '21-10-2026'])('rejects the invalid expiry date %s with 400 and saves nothing', async (value) => {
      await expect(service.createDomain(mockUser, { domain_name: 'a.test', expiry_date: value })).rejects.toThrow(
        'Expiry date must be a valid date (YYYY-MM-DD).',
      );
      await expect(service.updateDomain(mockUser, 10, { expiry_date: value })).rejects.toThrow(BadRequestException);
      expect(mockPrismaService.domain.create).not.toHaveBeenCalled();
      expect(mockPrismaService.domain.update).not.toHaveBeenCalled();
    });

    it('rejects an invalid purchase date with 400', async () => {
      await expect(service.createDomain(mockUser, { domain_name: 'a.test', purchase_date: '2026-02-29' })).rejects.toThrow(
        'Purchase date must be a valid date (YYYY-MM-DD).',
      );
    });

    it('accepts 29 February in a leap year', async () => {
      await service.createDomain(mockUser, { domain_name: 'a.test', expiry_date: '2028-02-29' });
      expect(day(createData().expiry_date)).toBe('2028-02-29T00:00:00.000Z');
    });

    it('null or "" clears a date; leaving it out keeps it', async () => {
      await service.updateDomain(mockUser, 10, { expiry_date: '', purchase_date: null });
      expect(updateData().expiry_date).toBeNull();
      expect(updateData().purchase_date).toBeNull();

      mockPrismaService.domain.update.mockClear();
      await service.updateDomain(mockUser, 10, { notes: 'x' });
      expect(updateData().purchase_date).toBeUndefined();
      expect(updateData().expiry_date).toBeUndefined(); // not written: the stored date is kept
    });

    it('refuses an expiry date earlier than the purchase date (create and update, against the stored date)', async () => {
      await expect(
        service.createDomain(mockUser, { domain_name: 'a.test', purchase_date: '2026-10-21', expiry_date: '2026-10-20' }),
      ).rejects.toThrow('Expiry date cannot be earlier than purchase date.');
      // stored purchase date is 2025-10-21
      await expect(service.updateDomain(mockUser, 10, { expiry_date: '2025-10-20' })).rejects.toThrow(
        'Expiry date cannot be earlier than purchase date.',
      );
    });

    it('records a manual expiry change in the renewal history inside a transaction', async () => {
      mockPrismaService.domain.update.mockResolvedValue(buildDomain({ domain_name: 'example.com' }));
      await service.updateDomain(mockUser, 10, { expiry_date: '2027-10-21' });
      expect(mockPrismaService.$transaction).toHaveBeenCalledTimes(1);
      const entry = mockPrismaService.assetRenewal.create.mock.calls[0][0].data;
      expect(entry).toMatchObject({ asset_type: 'domain', asset_id: 10, domain_id: 10, asset_name: 'example.com', event: 'manual_change', performed_by_id: 1 });
      expect(day(entry.previous_expiry_date)).toBe('2026-10-21T00:00:00.000Z');
      expect(day(entry.new_expiry_date)).toBe('2027-10-21T00:00:00.000Z');
    });

    it('writes no history (and uses no transaction) when the expiry is unchanged or not sent', async () => {
      await service.updateDomain(mockUser, 10, { notes: 'x' });
      await service.updateDomain(mockUser, 10, { expiry_date: '2026-10-21T00:00:00.000Z' });
      expect(mockPrismaService.assetRenewal.create).not.toHaveBeenCalled();
      expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
    });

    it('records the change in the rename transaction when the domain is renamed at the same time', async () => {
      await service.updateDomain(mockUser, 10, { domain_name: 'renamed.test', expiry_date: '2027-10-21' });
      expect(mockPrismaService.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrismaService.assetRenewal.create).toHaveBeenCalledTimes(1);
    });

    it('stores and validates the default renewal period', async () => {
      await service.createDomain(mockUser, { domain_name: 'a.test', renewal_period_value: 2, renewal_period_unit: 'year' });
      expect(createData()).toMatchObject({ renewal_period_value: 2, renewal_period_unit: 'year' });
      await expect(service.updateDomain(mockUser, 10, { renewal_period_value: 11, renewal_period_unit: 'year' })).rejects.toThrow(BadRequestException);
    });

    it('does not re-check stored dates when no date is being saved', async () => {
      mockPrismaService.domain.findUnique.mockResolvedValue(
        buildDomain({ purchase_date: new Date('2026-10-21'), expiry_date: new Date('2026-01-01') }),
      );
      await expect(service.updateDomain(mockUser, 10, { notes: 'legacy record' })).resolves.toBeDefined();
    });
  });

  describe('domain server (server_id), as the Edit Domain form sends it', () => {
    const updateData = () => mockPrismaService.domain.update.mock.calls[0][0].data;
    beforeEach(() => {
      mockPrismaService.domain.findUnique.mockResolvedValue(buildDomain({ server_id: 2 }));
      mockPrismaService.domain.update.mockResolvedValue(buildDomain());
    });

    it('server_id sets the server', async () => {
      // (Providers are a fixed list since the Domain Status/Provider change)
      await service.updateDomain(mockUser, 10, { server_id: 6, provider: 'Grehasoft Hostinger 1', notes: 'x' });
      expect(updateData()).toMatchObject({ server_id: 6, provider: 'Grehasoft Hostinger 1', notes: 'x' });
    });

    it('server_id null clears it; not sent leaves it unchanged', async () => {
      await service.updateDomain(mockUser, 10, { server_id: null });
      expect(updateData().server_id).toBeNull();
      mockPrismaService.domain.update.mockClear();
      await service.updateDomain(mockUser, 10, { notes: 'only notes' });
      expect(updateData().server_id).toBeUndefined();
    });
  });

  describe('optional project', () => {
    const createData = () => mockPrismaService.domain.create.mock.calls[0][0].data;
    const updateData = () => mockPrismaService.domain.update.mock.calls[0][0].data;

    beforeEach(() => {
      mockPrismaService.domain.create.mockResolvedValue(buildDomain({ project_id: null, project: null }));
      mockPrismaService.domain.findUnique.mockResolvedValue(buildDomain());
      mockPrismaService.domain.update.mockResolvedValue(buildDomain({ project_id: null, project: null }));
    });

    it('creates a domain without a project', async () => {
      const result = await service.createDomain(mockUser, { domain_name: 'example.com' });

      expect(createData().project_id).toBeNull();
      expect(result.project).toBeNull();
      expect(result.project_name).toBeNull();
    });

    it('treats an empty or null project as no project on create', async () => {
      await service.createDomain(mockUser, { domain_name: 'a.com', project: '' });
      await service.createDomain(mockUser, { domain_name: 'b.com', project: null });

      expect(mockPrismaService.domain.create.mock.calls.map((c) => c[0].data.project_id)).toEqual([null, null]);
    });

    it('still saves a selected project (project or project_id, number or string)', async () => {
      await service.createDomain(mockUser, { domain_name: 'a.com', project: '3' });
      await service.createDomain(mockUser, { domain_name: 'b.com', project_id: 4 });

      expect(mockPrismaService.domain.create.mock.calls.map((c) => c[0].data.project_id)).toEqual([3, 4]);
    });

    it('rejects an invalid project id', async () => {
      await expect(service.createDomain(mockUser, { domain_name: 'a.com', project: 'abc' })).rejects.toThrow(BadRequestException);
      await expect(service.createDomain(mockUser, { domain_name: 'a.com', project: 0 })).rejects.toThrow(BadRequestException);
      expect(mockPrismaService.domain.create).not.toHaveBeenCalled();
    });

    it('clears the project on edit when null or empty is sent', async () => {
      await service.updateDomain(mockUser, 10, { project: null });

      expect(updateData().project_id).toBeNull();
    });

    it('keeps the existing project on edit when project is not sent', async () => {
      await service.updateDomain(mockUser, 10, { notes: 'note only' });

      expect(updateData().project_id).toBeUndefined();
    });

    it('changes the project on edit', async () => {
      await service.updateDomain(mockUser, 10, { project: 7 });

      expect(updateData().project_id).toBe(7);
    });

    it('leaves server, provider, dates and notes handling unchanged', async () => {
      await service.createDomain(mockUser, {
        domain_name: 'a.com',
        provider: 'GoDaddy',
        server: 2,
        purchase_date: '2026-01-15',
        expiry_date: '2027-01-15',
        notes: 'n',
      });

      expect(createData()).toMatchObject({ provider: 'GoDaddy', server_id: 2, notes: 'n', project_id: null });
      expect(createData().expiry_date.toISOString().split('T')[0]).toBe('2027-01-15');
    });
  });
});

describe('InfrastructureService - Servers', () => {
  let service: InfrastructureService;

  const mockPrismaService = {
    server: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    projectMember: {
      findMany: jest.fn(),
    },
    domain: {
      count: jest.fn(),
    },
    // Manual expiry changes: update + renewal history entry in one transaction
    assetRenewal: {
      create: jest.fn(async (args: any) => ({ id: 1, ...args.data })),
    },
    $transaction: jest.fn(async (fn: any): Promise<any> => fn(mockPrismaService)),
    // Row lock for expiry changes (SELECT id, expiry_date ... FOR UPDATE), answered from the stored server
    $queryRaw: jest.fn(async (sql: any): Promise<any[]> => {
      const row = await mockPrismaService.server.findUnique({ where: { id: sql.values[0] } });
      return row ? [{ id: row.id, expiry_date: row.expiry_date ?? null }] : [];
    }),
  };

  const adminUser = { id: 1, role: { name: 'SUPER_ADMIN' } };
  const staffUser = { id: 2, role: { name: 'DEVELOPER' } };
  const MASK = '••••••••';

  // Echo create/update payloads back as the stored row
  const echoRow = (args: any) => Promise.resolve({ id: 7, created_at: new Date(), ...args.data });

  const dateKey = (d: Date) => d.toISOString().split('T')[0];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InfrastructureService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<InfrastructureService>(InfrastructureService);

    jest.clearAllMocks();
    mockPrismaService.server.create.mockImplementation(echoRow);
    mockPrismaService.server.update.mockImplementation(echoRow);
  });

  describe('createServer', () => {
    it('saves new fields, encrypts the password and stores date-only values', async () => {
      const result = await service.createServer(adminUser, {
        name: 'Prod',
        username: 'root',
        password: 's3cret!',
        phone_number: ' +91 98765 43210 ',
        purchase_date: '2026-01-15',
        expiry_date: '2027-01-15',
      });

      const data = mockPrismaService.server.create.mock.calls[0][0].data;
      expect(data.username).toBe('root');
      expect(data.password).not.toBe('s3cret!');
      expect(data.password).toMatch(/^[0-9a-f]+$/);
      expect(data.phone_number).toBe('+91 98765 43210');
      expect(dateKey(data.purchase_date)).toBe('2026-01-15');
      expect(dateKey(data.expiry_date)).toBe('2027-01-15');

      // Admin receives the decrypted password back
      expect(result.password).toBe('s3cret!');
    });

    it('keeps the new fields optional', async () => {
      await service.createServer(adminUser, { name: 'Minimal', purchase_date: '', expiry_date: '' });

      const data = mockPrismaService.server.create.mock.calls[0][0].data;
      expect(data.password).toBe('');
      expect(data.purchase_date).toBeNull();
      expect(data.expiry_date).toBeNull();
    });

    it('accepts ISO timestamps without shifting the calendar day', async () => {
      await service.createServer(adminUser, { name: 'S', expiry_date: '2026-12-15T00:00:00.000Z' });

      const data = mockPrismaService.server.create.mock.calls[0][0].data;
      expect(dateKey(data.expiry_date)).toBe('2026-12-15');
    });

    it('rejects an invalid date', async () => {
      await expect(service.createServer(adminUser, { name: 'S', purchase_date: '2026-02-30' })).rejects.toThrow(BadRequestException);
      await expect(service.createServer(adminUser, { name: 'S', expiry_date: 'tomorrow' })).rejects.toThrow(BadRequestException);
      expect(mockPrismaService.server.create).not.toHaveBeenCalled();
    });

    it('rejects an expiry date before the purchase date', async () => {
      await expect(
        service.createServer(adminUser, { name: 'S', purchase_date: '2026-05-01', expiry_date: '2026-04-30' }),
      ).rejects.toThrow('Expiry date cannot be earlier than purchase date.');
    });

    it('rejects an invalid phone number', async () => {
      await expect(service.createServer(adminUser, { name: 'S', phone_number: 'call me' })).rejects.toThrow(BadRequestException);
    });
  });

  describe('reading servers', () => {
    const storedRow = () => ({
      id: 7,
      name: 'Prod',
      password: (service as any).encryptPassword('s3cret!'),
      expiry_date: new Date('2027-01-15'),
    });

    it('returns the decrypted password to admins', async () => {
      mockPrismaService.server.findUnique.mockResolvedValue(storedRow());

      const server = await service.getServerById(adminUser, 7);

      expect(server.password).toBe('s3cret!');
    });

    it('masks the password for non-admins (who are members of a linked project)', async () => {
      mockPrismaService.projectMember.findMany.mockResolvedValue([{ project_id: 3 }]);
      mockPrismaService.domain.count.mockResolvedValue(1);
      mockPrismaService.server.findUnique.mockResolvedValue(storedRow());

      const server = await service.getServerById(staffUser, 7);

      expect(server.password).toBe(MASK);
    });

    it('Phase 2.2: non-admins cannot read a server outside their projects (404)', async () => {
      mockPrismaService.projectMember.findMany.mockResolvedValue([{ project_id: 3 }]);
      mockPrismaService.domain.count.mockResolvedValue(0);
      mockPrismaService.server.findUnique.mockResolvedValue(storedRow());

      await expect(service.getServerById(staffUser, 7)).rejects.toThrow(NotFoundException);
    });

    it('masks passwords in the paginated list for non-admins', async () => {
      mockPrismaService.projectMember.findMany.mockResolvedValue([{ project_id: 3 }]);
      mockPrismaService.server.count.mockResolvedValue(1);
      mockPrismaService.server.findMany.mockResolvedValue([storedRow()]);

      const res: any = await service.getServers(staffUser, {});

      expect(res.results[0].password).toBe(MASK);
    });

    describe('fields=expiry (expiry notifications)', () => {
      const expiryRow = { id: 7, name: 'Prod', expiry_date: new Date('2027-01-15') };

      it('selects only id, name and expiry_date, never the password, and skips servers without a date', async () => {
        mockPrismaService.server.findMany.mockResolvedValue([expiryRow]);

        const res: any = await service.getServers(adminUser, { fields: 'expiry' });

        const args = mockPrismaService.server.findMany.mock.calls[0][0];
        expect(args.select).toEqual({ id: true, name: true, expiry_date: true });
        expect(args.where).toEqual({ expiry_date: { not: null } });
        expect(res).toEqual([expiryRow]);
        expect(res[0]).not.toHaveProperty('password');
        expect(mockPrismaService.server.count).not.toHaveBeenCalled();
      });

      it('does not decrypt passwords for super admins', async () => {
        const decrypt = jest.spyOn(service as any, 'decryptPassword');
        mockPrismaService.server.findMany.mockResolvedValue([expiryRow]);

        await service.getServers(adminUser, { fields: 'expiry', all: 'true' });

        expect(decrypt).not.toHaveBeenCalled();
      });

      it('keeps the non-admin project scope', async () => {
        mockPrismaService.projectMember.findMany.mockResolvedValue([{ project_id: 3 }]);
        mockPrismaService.server.findMany.mockResolvedValue([expiryRow]);

        await service.getServers(staffUser, { fields: 'expiry' });

        const args = mockPrismaService.server.findMany.mock.calls[0][0];
        expect(args.where).toEqual({ domains: { some: { project_id: { in: [3] } } }, expiry_date: { not: null } });
        expect(args.select).toEqual({ id: true, name: true, expiry_date: true });
      });

      it('returns an empty list for non-admins without projects', async () => {
        mockPrismaService.projectMember.findMany.mockResolvedValue([]);

        await expect(service.getServers(staffUser, { fields: 'expiry' })).resolves.toEqual([]);
        expect(mockPrismaService.server.findMany).not.toHaveBeenCalled();
      });

      it('leaves the normal all=true response unchanged', async () => {
        mockPrismaService.server.findMany.mockResolvedValue([storedRow()]);

        const res: any = await service.getServers(adminUser, { all: 'true' });

        expect(mockPrismaService.server.findMany.mock.calls[0][0].select).toBeUndefined();
        expect(res[0].password).toBe('s3cret!');
      });
    });
  });

  describe('updateServer', () => {
    const existing = {
      id: 7,
      name: 'Prod',
      password: 'stored-cipher',
      purchase_date: new Date('2026-01-15'),
      expiry_date: new Date('2027-01-15'),
    };

    beforeEach(() => {
      mockPrismaService.server.findUnique.mockResolvedValue(existing);
    });

    it('updates the new fields', async () => {
      await service.updateServer(adminUser, 7, {
        username: 'admin',
        password: 'new-pass',
        phone_number: '0123 456 789',
        expiry_date: '2028-01-15',
      });

      const data = mockPrismaService.server.update.mock.calls[0][0].data;
      expect(data.username).toBe('admin');
      expect((service as any).decryptPassword(data.password)).toBe('new-pass');
      expect(data.phone_number).toBe('0123 456 789');
      expect(dateKey(data.expiry_date)).toBe('2028-01-15');
      expect(data.purchase_date).toBeUndefined();
    });

    it('does not overwrite the password with the masked placeholder', async () => {
      await service.updateServer(staffUser, 7, { name: 'Prod', password: MASK });

      expect(mockPrismaService.server.update.mock.calls[0][0].data.password).toBeUndefined();
    });

    it('leaves the password unchanged when it is not sent', async () => {
      await service.updateServer(adminUser, 7, { name: 'Prod' });

      expect(mockPrismaService.server.update.mock.calls[0][0].data.password).toBeUndefined();
    });

    it('clears dates when empty values are sent', async () => {
      await service.updateServer(adminUser, 7, { purchase_date: '', expiry_date: '' });

      const data = mockPrismaService.server.update.mock.calls[0][0].data;
      expect(data.purchase_date).toBeNull();
      expect(data.expiry_date).toBeNull();
    });

    it('validates date order against the existing purchase date', async () => {
      await expect(service.updateServer(adminUser, 7, { expiry_date: '2025-12-31' })).rejects.toThrow(BadRequestException);
      expect(mockPrismaService.server.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a missing server', async () => {
      mockPrismaService.server.findUnique.mockResolvedValue(null);

      await expect(service.updateServer(adminUser, 999, {})).rejects.toThrow(NotFoundException);
    });
  });

  describe('renewal period and manual expiry audit', () => {
    const existing = { id: 7, name: 'Prod', purchase_date: null, expiry_date: new Date('2027-01-15') };
    beforeEach(() => mockPrismaService.server.findUnique.mockResolvedValue(existing));

    it('stores a validated default renewal period on create and update', async () => {
      await service.createServer(adminUser, { name: 'New', renewal_period_value: '3', renewal_period_unit: 'Month' });
      expect(mockPrismaService.server.create.mock.calls[0][0].data).toMatchObject({ renewal_period_value: 3, renewal_period_unit: 'month' });

      await service.updateServer(adminUser, 7, { renewal_period_value: null, renewal_period_unit: null });
      expect(mockPrismaService.server.update.mock.calls[0][0].data).toMatchObject({ renewal_period_value: null, renewal_period_unit: null });
    });

    it('leaves the renewal period unchanged when it is not sent', async () => {
      await service.updateServer(adminUser, 7, { name: 'Prod' });
      expect(mockPrismaService.server.update.mock.calls[0][0].data).not.toHaveProperty('renewal_period_value');
    });

    it('rejects an invalid renewal period with 400 and saves nothing', async () => {
      await expect(service.updateServer(adminUser, 7, { renewal_period_value: 0, renewal_period_unit: 'year' })).rejects.toThrow(BadRequestException);
      await expect(service.createServer(adminUser, { name: 'X', renewal_period_value: 1, renewal_period_unit: 'week' })).rejects.toThrow(BadRequestException);
      expect(mockPrismaService.server.update).not.toHaveBeenCalled();
      expect(mockPrismaService.server.create).not.toHaveBeenCalled();
    });

    it('records a manual expiry change in the renewal history, in the same transaction', async () => {
      await service.updateServer({ ...adminUser, name: 'Admin User' }, 7, { expiry_date: '2028-01-15' });
      expect(mockPrismaService.$transaction).toHaveBeenCalledTimes(1);
      const entry = mockPrismaService.assetRenewal.create.mock.calls[0][0].data;
      expect(entry).toMatchObject({ asset_type: 'server', asset_id: 7, server_id: 7, asset_name: 'Prod', event: 'manual_change', performed_by_id: 1, performed_by_name: 'Admin User' });
      expect(dateKey(entry.previous_expiry_date)).toBe('2027-01-15');
      expect(dateKey(entry.new_expiry_date)).toBe('2028-01-15');
      expect(entry.cycle_key).toBeUndefined(); // a manual change never claims a renewal cycle
    });

    it('records clearing the expiry date', async () => {
      await service.updateServer(adminUser, 7, { expiry_date: '' });
      expect(mockPrismaService.assetRenewal.create.mock.calls[0][0].data).toMatchObject({ event: 'manual_change', new_expiry_date: null });
    });

    it('writes no history when the expiry date is not sent or unchanged', async () => {
      await service.updateServer(adminUser, 7, { name: 'Renamed' });
      await service.updateServer(adminUser, 7, { expiry_date: '2027-01-15' });
      expect(mockPrismaService.assetRenewal.create).not.toHaveBeenCalled();
      expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
    });

    it('if the history entry cannot be written, the update fails too', async () => {
      mockPrismaService.assetRenewal.create.mockRejectedValueOnce(new Error('history write failed'));
      await expect(service.updateServer(adminUser, 7, { expiry_date: '2028-01-15' })).rejects.toThrow('history write failed');
    });
  });
});

describe('InfrastructureService - Summary (overview cards)', () => {
  let service: InfrastructureService;

  // In-memory rows; count() applies the same where shapes the service builds
  const servers = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, password: 'enc' }));
  // Domains 1-6 in project 1 (servers 1-3), 7 in project 2 (server 4), 8-9 unassigned
  const domains = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: i + 1, project_id: 1, server_id: (i % 3) + 1 })),
    { id: 7, project_id: 2, server_id: 4 },
    { id: 8, project_id: null, server_id: 5 },
    { id: 9, project_id: null, server_id: null },
  ];
  const credentials = [
    ...Array.from({ length: 7 }, (_, i) => ({ id: i + 1, project_id: 1, password: 'enc' })),
    { id: 8, project_id: 2, password: 'enc' },
  ];
  const inIds = (where: any, row: any) => !where?.project_id || where.project_id.in.includes(row.project_id);

  const prisma = {
    server: {
      count: jest.fn(async (args?: any) =>
        servers.filter((s) => {
          const scope = args?.where?.domains?.some;
          return !scope || domains.some((d) => d.server_id === s.id && inIds(scope, d));
        }).length),
      findMany: jest.fn(),
    },
    domain: { count: jest.fn(async (args?: any) => domains.filter((d) => inIds(args?.where, d)).length), findMany: jest.fn() },
    websiteCredential: { count: jest.fn(async (args?: any) => credentials.filter((c) => inIds(args?.where, c)).length), findMany: jest.fn() },
    projectMember: { findMany: jest.fn() },
  };

  const superAdmin = { id: 1, role: { name: 'SUPER_ADMIN' } };
  const staff = { id: 2, role: { name: 'DEVELOPER' } };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [InfrastructureService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(InfrastructureService);
    jest.clearAllMocks();
  });

  it('super admins get true totals, beyond the old page size of 5', async () => {
    await expect(service.getSummary(superAdmin)).resolves.toEqual({ servers: 8, domains: 9, credentials: 8 });
  });

  it('other users count only what the list endpoints would show them (their projects)', async () => {
    prisma.projectMember.findMany.mockResolvedValue([{ project_id: 1 }]);
    // servers 1-3 (linked to project 1 domains), domains 1-6, credentials 1-7
    await expect(service.getSummary(staff)).resolves.toEqual({ servers: 3, domains: 6, credentials: 7 });
  });

  it('users without projects see zero of everything (no unscoped count)', async () => {
    prisma.projectMember.findMany.mockResolvedValue([]);
    await expect(service.getSummary(staff)).resolves.toEqual({ servers: 0, domains: 0, credentials: 0 });
    expect(prisma.server.count).not.toHaveBeenCalled();
    expect(prisma.domain.count).not.toHaveBeenCalled();
    expect(prisma.websiteCredential.count).not.toHaveBeenCalled();
  });

  it('uses COUNT queries only: no rows (and so no passwords) are read', async () => {
    prisma.projectMember.findMany.mockResolvedValue([{ project_id: 2 }]);
    await service.getSummary(superAdmin);
    await service.getSummary(staff);
    expect(prisma.server.findMany).not.toHaveBeenCalled();
    expect(prisma.domain.findMany).not.toHaveBeenCalled();
    expect(prisma.websiteCredential.findMany).not.toHaveBeenCalled();
  });

  it('the scoped where clauses match the list endpoints', async () => {
    prisma.projectMember.findMany.mockResolvedValue([{ project_id: 2 }]);
    await expect(service.getSummary(staff)).resolves.toEqual({ servers: 1, domains: 1, credentials: 1 });
    expect(prisma.server.count).toHaveBeenCalledWith({ where: { domains: { some: { project_id: { in: [2] } } } } });
    expect(prisma.domain.count).toHaveBeenCalledWith({ where: { project_id: { in: [2] } } });
    expect(prisma.websiteCredential.count).toHaveBeenCalledWith({ where: { project_id: { in: [2] } } });
  });
});
