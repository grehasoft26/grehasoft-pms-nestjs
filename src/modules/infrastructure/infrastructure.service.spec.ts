import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InfrastructureService } from './infrastructure.service';
import { PrismaService } from '../../core/prisma.service';

describe('InfrastructureService - Domains', () => {
  let service: InfrastructureService;

  const mockPrismaService = {
    domain: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    reminder: {
      create: jest.fn(),
    },
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

      const updateArgs = mockPrismaService.domain.update.mock.calls[0][0];
      expect(updateArgs.data.expiry_date).toBe(existing.expiry_date);
    });

    it('throws NotFoundException for a missing domain', async () => {
      mockPrismaService.domain.findUnique.mockResolvedValue(null);

      await expect(service.updateDomain(mockUser, 999, {})).rejects.toThrow(NotFoundException);
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

    it('masks the password for non-admins', async () => {
      mockPrismaService.server.findUnique.mockResolvedValue(storedRow());

      const server = await service.getServerById(staffUser, 7);

      expect(server.password).toBe(MASK);
    });

    it('masks passwords in the paginated list for non-admins', async () => {
      mockPrismaService.projectMember.findMany.mockResolvedValue([{ project_id: 3 }]);
      mockPrismaService.server.count.mockResolvedValue(1);
      mockPrismaService.server.findMany.mockResolvedValue([storedRow()]);

      const res: any = await service.getServers(staffUser, {});

      expect(res.results[0].password).toBe(MASK);
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
});
