import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CompanyCredentialsService } from './company-credentials.service';
import { PrismaService } from '../../core/prisma.service';
import { EncryptionService } from '../../core/encryption.service';

describe('CompanyCredentialsService', () => {
  let service: CompanyCredentialsService;
  let encryption: EncryptionService;

  const mockPrismaService = {
    companyCredential: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    websiteCredential: {
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };

  const superAdmin = { id: 1, role: { name: 'SUPER_ADMIN' } };
  const infraManager = { id: 2, role: { name: 'OPS', permissions: ['MANAGE_INFRASTRUCTURE'] } };

  const echoRow = (args: any) =>
    Promise.resolve({ id: 5, category: 'OTHER', created_at: new Date(), updated_at: new Date(), ...args.data });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompanyCredentialsService,
        EncryptionService,
        { provide: ConfigService, useValue: { get: () => 'unit-test-secret' } },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get(CompanyCredentialsService);
    encryption = module.get(EncryptionService);

    jest.clearAllMocks();
    mockPrismaService.companyCredential.create.mockImplementation(echoRow);
    mockPrismaService.companyCredential.update.mockImplementation(echoRow);
  });

  describe('create', () => {
    it('stores the password encrypted and never returns it', async () => {
      const result: any = await service.create({
        name: 'Company Gmail',
        category: 'EMAIL',
        provider: 'Google',
        login_url: 'https://mail.google.com',
        username: 'ops@grehasoft.com',
        password: 'p@ss-123',
        notes: 'Main inbox',
      });

      const data = mockPrismaService.companyCredential.create.mock.calls[0][0].data;
      expect(data.password).not.toBe('p@ss-123');
      expect(data.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]+$/);
      expect(encryption.decrypt(data.password)).toBe('p@ss-123');
      expect(data.category).toBe('EMAIL');

      expect(result.password).toBeUndefined();
      expect(result.has_password).toBe(true);
    });

    it('uses a random IV so equal passwords encrypt differently', async () => {
      await service.create({ name: 'A', password: 'same' });
      await service.create({ name: 'B', password: 'same' });

      const [first, second] = mockPrismaService.companyCredential.create.mock.calls.map((c) => c[0].data.password);
      expect(first).not.toBe(second);
    });

    it('defaults category to OTHER and optional fields to null', async () => {
      const result: any = await service.create({ name: '  Figma  ' });

      const data = mockPrismaService.companyCredential.create.mock.calls[0][0].data;
      expect(data).toEqual({
        name: 'Figma',
        category: 'OTHER',
        provider: null,
        login_url: null,
        username: null,
        password: null,
        notes: null,
      });
      expect(result.has_password).toBe(false);
    });

    it('accepts category case-insensitively', async () => {
      await service.create({ name: 'GoDaddy', category: 'domain_registrar' });

      expect(mockPrismaService.companyCredential.create.mock.calls[0][0].data.category).toBe('DOMAIN_REGISTRAR');
    });

    it('requires a name', async () => {
      await expect(service.create({ name: '   ' })).rejects.toThrow('Credential name is required.');
      await expect(service.create({})).rejects.toThrow(BadRequestException);
    });

    it('rejects unknown categories', async () => {
      await expect(service.create({ name: 'X', category: 'SOCIAL' })).rejects.toThrow(BadRequestException);
    });

    it('rejects non-http login URLs', async () => {
      await expect(service.create({ name: 'X', login_url: 'not a url' })).rejects.toThrow(BadRequestException);
      await expect(service.create({ name: 'X', login_url: 'javascript:alert(1)' })).rejects.toThrow(BadRequestException);
      await expect(service.create({ name: 'X', login_url: 'ftp://files.example.com' })).rejects.toThrow(BadRequestException);
    });

    it('rejects over-long values', async () => {
      await expect(service.create({ name: 'x'.repeat(256) })).rejects.toThrow(BadRequestException);
      await expect(service.create({ name: 'X', username: 'u'.repeat(256) })).rejects.toThrow(BadRequestException);
    });

    it('never touches client WebsiteCredential records', async () => {
      await service.create({ name: 'Hosting', password: 'x' });

      expect(mockPrismaService.websiteCredential.create).not.toHaveBeenCalled();
      expect(mockPrismaService.websiteCredential.update).not.toHaveBeenCalled();
      expect(mockPrismaService.websiteCredential.delete).not.toHaveBeenCalled();
    });
  });

  describe('findAll / findOne', () => {
    const storedRow = () => ({ id: 5, name: 'Hostinger', category: 'HOSTING', password: encryption.encrypt('secret') });

    it('returns paginated results without passwords', async () => {
      mockPrismaService.companyCredential.count.mockResolvedValue(1);
      mockPrismaService.companyCredential.findMany.mockResolvedValue([storedRow()]);

      const res: any = await service.findAll({});

      expect(res.count).toBe(1);
      expect(res.results[0].password).toBeUndefined();
      expect(res.results[0].has_password).toBe(true);
    });

    it('searches across name, provider, username, login URL and notes', async () => {
      mockPrismaService.companyCredential.count.mockResolvedValue(0);
      mockPrismaService.companyCredential.findMany.mockResolvedValue([]);

      await service.findAll({ search: ' host ' });

      const where = mockPrismaService.companyCredential.findMany.mock.calls[0][0].where;
      expect(where.OR.map((c: any) => Object.keys(c)[0])).toEqual(['name', 'provider', 'username', 'login_url', 'notes']);
      expect(where.OR[0].name.contains).toBe('host');
    });

    it('filters by category', async () => {
      mockPrismaService.companyCredential.count.mockResolvedValue(0);
      mockPrismaService.companyCredential.findMany.mockResolvedValue([]);

      await service.findAll({ category: 'hosting' });

      expect(mockPrismaService.companyCredential.findMany.mock.calls[0][0].where.category).toBe('HOSTING');
    });

    it('returns a single credential without its password', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue(storedRow());

      const res: any = await service.findOne(5);

      expect(res.password).toBeUndefined();
      expect(res.has_password).toBe(true);
    });

    it('throws NotFoundException for a missing credential', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue(null);

      await expect(service.findOne(404)).rejects.toThrow(NotFoundException);
    });
  });

  describe('revealPassword', () => {
    it('returns the decrypted password to super admins', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5, password: encryption.encrypt('secret') });

      await expect(service.revealPassword(superAdmin, 5)).resolves.toEqual({ password: 'secret' });
    });

    it('also allows is_superuser accounts', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5, password: encryption.encrypt('secret') });

      await expect(service.revealPassword({ id: 9, is_superuser: true }, 5)).resolves.toEqual({ password: 'secret' });
    });

    it('refuses non-super-admins even with MANAGE_INFRASTRUCTURE', async () => {
      await expect(service.revealPassword(infraManager, 5)).rejects.toThrow(ForbiddenException);
      expect(mockPrismaService.companyCredential.findUnique).not.toHaveBeenCalled();
    });

    it('returns an empty string when no password is stored', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5, password: null });

      await expect(service.revealPassword(superAdmin, 5)).resolves.toEqual({ password: '' });
    });
  });

  describe('update', () => {
    beforeEach(() => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5, name: 'Old', password: 'stored' });
    });

    it('keeps the stored password when none or an empty one is sent', async () => {
      await service.update(5, { name: 'Renamed' });
      await service.update(5, { name: 'Renamed', password: '' });

      for (const call of mockPrismaService.companyCredential.update.mock.calls) {
        expect(call[0].data.password).toBeUndefined();
      }
    });

    it('replaces the password with a new encrypted value', async () => {
      await service.update(5, { password: 'new-secret' });

      const data = mockPrismaService.companyCredential.update.mock.calls[0][0].data;
      expect(encryption.decrypt(data.password)).toBe('new-secret');
    });

    it('clears the password when clear_password is true', async () => {
      await service.update(5, { clear_password: true });

      expect(mockPrismaService.companyCredential.update.mock.calls[0][0].data.password).toBeNull();
    });

    it('only updates fields that were sent', async () => {
      await service.update(5, { notes: '' });

      const data = mockPrismaService.companyCredential.update.mock.calls[0][0].data;
      expect(data.notes).toBeNull();
      expect(data.name).toBeUndefined();
      expect(data.category).toBeUndefined();
      expect(data.provider).toBeUndefined();
    });

    it('validates the name when it is sent', async () => {
      await expect(service.update(5, { name: '' })).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for a missing credential', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue(null);

      await expect(service.update(404, { name: 'X' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes an existing credential', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5 });

      await service.remove(5);

      expect(mockPrismaService.companyCredential.delete).toHaveBeenCalledWith({ where: { id: 5 } });
      expect(mockPrismaService.websiteCredential.delete).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a missing credential', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue(null);

      await expect(service.remove(404)).rejects.toThrow(NotFoundException);
      expect(mockPrismaService.companyCredential.delete).not.toHaveBeenCalled();
    });
  });
});
