import * as nodeCrypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CompanyCredentialsService } from './company-credentials.service';
import { PrismaService } from '../../core/prisma.service';
import { EncryptionService } from '../../core/encryption.service';
import { CredentialCryptoService } from '../../core/credential-crypto.service';
import { CredentialAuditContext, CredentialAuditService } from '../credential-audit/credential-audit.service';

const TEST_ENV: Record<string, string> = {
  CREDENTIAL_KEYS: `1:${nodeCrypto.randomBytes(32).toString('base64')}`,
  CREDENTIAL_ACTIVE_KEY_VERSION: '1',
  SECRET_KEY: 'unit-test-secret',
};
const configOf = (env: Record<string, string>) => ({ get: (k: string) => env[k] }) as unknown as ConfigService;
const AAD = (id: number) => ({ table: 'company_credentials', field: 'password', recordId: id });
const CTX: CredentialAuditContext = { actorId: 1, actorUsername: 'owner', ipAddress: '127.0.0.1', userAgent: 'jest' };

describe('CompanyCredentialsService', () => {
  let service: CompanyCredentialsService;
  let crypto: CredentialCryptoService;
  const legacy = new EncryptionService(configOf({ SECRET_KEY: TEST_ENV.SECRET_KEY }));

  const mockPrismaService: any = {
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
    credentialAuditLog: { create: jest.fn() },
    $transaction: jest.fn((fn: any) => fn(mockPrismaService)),
  };

  const superAdmin = { id: 1, role: { name: 'SUPER_ADMIN' } };
  const revealer = { id: 6, role: { name: 'VAULT', permissions: ['REVEAL_CREDENTIALS'] } };
  const infraManager = { id: 2, role: { name: 'OPS', permissions: ['MANAGE_INFRASTRUCTURE', 'MANAGE_CREDENTIALS'] } };

  const echoRow = (args: any) =>
    Promise.resolve({ id: args.where?.id ?? 5, category: 'OTHER', created_at: new Date(), updated_at: new Date(), ...args.data });
  const auditActions = () => mockPrismaService.credentialAuditLog.create.mock.calls.map((c: any) => c[0].data);
  const storedPasswords = () =>
    [...mockPrismaService.companyCredential.create.mock.calls, ...mockPrismaService.companyCredential.update.mock.calls]
      .map((c: any) => c[0].data.password)
      .filter((p: any) => p !== undefined && p !== null);

  const build = async (env: Record<string, string> = TEST_ENV) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompanyCredentialsService,
        CredentialCryptoService,
        CredentialAuditService,
        { provide: ConfigService, useValue: configOf(env) },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();
    service = module.get(CompanyCredentialsService);
    crypto = module.get(CredentialCryptoService);
  };

  beforeEach(async () => {
    await build();
    jest.clearAllMocks();
    mockPrismaService.companyCredential.create.mockImplementation(echoRow);
    mockPrismaService.companyCredential.update.mockImplementation(echoRow);
    mockPrismaService.credentialAuditLog.create.mockResolvedValue({});
  });

  describe('create', () => {
    it('stores the password as gcm1 bound to the new record id and never returns it', async () => {
      const result: any = await service.create(
        {
          name: 'Company Gmail',
          category: 'EMAIL',
          provider: 'Google',
          login_url: 'https://mail.google.com',
          username: 'ops@grehasoft.com',
          password: 'p@ss-123',
          notes: 'Main inbox',
        },
        CTX,
      );

      // Row first (no secret), then the encrypted secret for that id, in one transaction
      expect(mockPrismaService.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrismaService.companyCredential.create.mock.calls[0][0].data.password).toBeNull();
      const stored = mockPrismaService.companyCredential.update.mock.calls[0][0].data.password;
      expect(stored).toMatch(/^gcm1:1:/);
      expect(stored).not.toContain('p@ss-123');
      expect(crypto.decrypt(stored, AAD(5))).toBe('p@ss-123');
      expect(() => crypto.decrypt(stored, AAD(6))).toThrow();

      expect(result.password).toBeUndefined();
      expect(result.has_password).toBe(true);
      expect(JSON.stringify(result)).not.toContain('p@ss-123');
    });

    it('audits CREATE without any secret', async () => {
      await service.create({ name: 'Slack', password: 'top-secret' }, CTX);

      expect(auditActions()).toEqual([
        { actor_id: 1, actor_username: 'owner', credential_type: 'company', credential_id: 5, action: 'CREATE', ip_address: '127.0.0.1', user_agent: 'jest' },
      ]);
      expect(JSON.stringify(auditActions())).not.toMatch(/top-secret|gcm1/);
    });

    it('uses a fresh IV so equal passwords encrypt differently', async () => {
      await service.create({ name: 'A', password: 'same' }, CTX);
      await service.create({ name: 'B', password: 'same' }, CTX);

      const [first, second] = storedPasswords();
      expect(first).not.toBe(second);
    });

    it('never writes anything when encryption keys are not configured', async () => {
      await build({ SECRET_KEY: 'unit-test-secret' });
      await expect(service.create({ name: 'X', password: 'plain' }, CTX)).rejects.toThrow(ServiceUnavailableException);
      expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
      expect(mockPrismaService.companyCredential.create).not.toHaveBeenCalled();
    });

    it('never stores plaintext when encryption fails inside the transaction', async () => {
      jest.spyOn(crypto, 'encrypt').mockImplementation(() => {
        throw new Error('boom');
      });
      await expect(service.create({ name: 'X', password: 'plain-secret' }, CTX)).rejects.toThrow('boom');
      expect(storedPasswords()).toEqual([]);
      expect(mockPrismaService.credentialAuditLog.create).not.toHaveBeenCalled();
    });

    it('still creates credentials without a password when keys are missing', async () => {
      await build({});
      const result: any = await service.create({ name: 'No secret' }, CTX);
      expect(result.has_password).toBe(false);
    });

    it('defaults category to OTHER and optional fields to null', async () => {
      const result: any = await service.create({ name: '  Figma  ' }, CTX);

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
      expect(mockPrismaService.companyCredential.update).not.toHaveBeenCalled();
      expect(result.has_password).toBe(false);
    });

    it('accepts category case-insensitively', async () => {
      await service.create({ name: 'GoDaddy', category: 'domain_registrar' }, CTX);

      expect(mockPrismaService.companyCredential.create.mock.calls[0][0].data.category).toBe('DOMAIN_REGISTRAR');
    });

    it('requires a name', async () => {
      await expect(service.create({ name: '   ' }, CTX)).rejects.toThrow('Credential name is required.');
      await expect(service.create({}, CTX)).rejects.toThrow(BadRequestException);
    });

    it('rejects unknown categories', async () => {
      await expect(service.create({ name: 'X', category: 'SOCIAL' }, CTX)).rejects.toThrow(BadRequestException);
    });

    it('rejects non-http login URLs', async () => {
      await expect(service.create({ name: 'X', login_url: 'not a url' }, CTX)).rejects.toThrow(BadRequestException);
      await expect(service.create({ name: 'X', login_url: 'javascript:alert(1)' }, CTX)).rejects.toThrow(BadRequestException);
      await expect(service.create({ name: 'X', login_url: 'ftp://files.example.com' }, CTX)).rejects.toThrow(BadRequestException);
    });

    it('rejects over-long values', async () => {
      await expect(service.create({ name: 'x'.repeat(256) }, CTX)).rejects.toThrow(BadRequestException);
      await expect(service.create({ name: 'X', username: 'u'.repeat(256) }, CTX)).rejects.toThrow(BadRequestException);
    });

    it('never touches client WebsiteCredential records', async () => {
      await service.create({ name: 'Hosting', password: 'x' }, CTX);

      expect(mockPrismaService.websiteCredential.create).not.toHaveBeenCalled();
      expect(mockPrismaService.websiteCredential.update).not.toHaveBeenCalled();
      expect(mockPrismaService.websiteCredential.delete).not.toHaveBeenCalled();
    });
  });

  describe('findAll / findOne', () => {
    const storedRow = () => ({ id: 5, name: 'Hostinger', category: 'HOSTING', password: crypto.encrypt('secret', AAD(5)) });

    it('returns paginated results without passwords or ciphertext', async () => {
      mockPrismaService.companyCredential.count.mockResolvedValue(1);
      mockPrismaService.companyCredential.findMany.mockResolvedValue([storedRow()]);

      const res: any = await service.findAll({});

      expect(res.count).toBe(1);
      expect(res.results[0].password).toBeUndefined();
      expect(res.results[0].has_password).toBe(true);
      expect(JSON.stringify(res)).not.toContain('gcm1');
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
    it('returns a gcm1 password to REVEAL_CREDENTIALS holders and audits REVEAL', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5, password: crypto.encrypt('secret', AAD(5)) });

      await expect(service.revealPassword(revealer, 5, CTX)).resolves.toEqual({ password: 'secret' });
      expect(auditActions()).toMatchObject([{ action: 'REVEAL', credential_id: 5, credential_type: 'company' }]);
      expect(JSON.stringify(auditActions())).not.toContain('secret');
    });

    it('allows super admins and is_superuser accounts (existing bypass)', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5, password: crypto.encrypt('secret', AAD(5)) });

      await expect(service.revealPassword(superAdmin, 5, CTX)).resolves.toEqual({ password: 'secret' });
      await expect(service.revealPassword({ id: 9, is_superuser: true }, 5, CTX)).resolves.toEqual({ password: 'secret' });
    });

    it('still reads existing EncryptionService (legacy) values', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5, password: legacy.encrypt('legacy-secret') });

      await expect(service.revealPassword(revealer, 5, CTX)).resolves.toEqual({ password: 'legacy-secret' });
    });

    it('refuses users without REVEAL_CREDENTIALS (even MANAGE_CREDENTIALS) and audits REVEAL_DENIED', async () => {
      await expect(service.revealPassword(infraManager, 5, CTX)).rejects.toThrow(ForbiddenException);
      expect(mockPrismaService.companyCredential.findUnique).not.toHaveBeenCalled();
      expect(auditActions()).toMatchObject([{ action: 'REVEAL_DENIED', credential_id: 5, actor_id: 1 }]);
    });

    it('still refuses when the denial cannot be audited', async () => {
      mockPrismaService.credentialAuditLog.create.mockRejectedValue(new Error('audit table missing'));
      await expect(service.revealPassword(infraManager, 5, CTX)).rejects.toThrow(ForbiddenException);
    });

    it('does not return the password when the REVEAL audit cannot be written', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5, password: crypto.encrypt('secret', AAD(5)) });
      mockPrismaService.credentialAuditLog.create.mockRejectedValue(new Error('audit table missing'));
      await expect(service.revealPassword(revealer, 5, CTX)).rejects.toThrow('audit table missing');
    });

    it.each([
      ['a tampered value', (s: string) => s.slice(0, -2) + (s.endsWith('A') ? 'BA' : 'AA')],
      ['a value from another record (AAD mismatch)', () => crypto.encrypt('secret', AAD(6))],
      ['a plaintext value', () => 'stored-in-plaintext'],
      ['a static-key legacy value (not a company format)', () => 'deadbeef'.repeat(8)],
    ])('refuses %s for manual review without returning it', async (_label, make) => {
      const stored = make(crypto.encrypt('secret', AAD(5)));
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5, password: stored });

      const error = await service.revealPassword(revealer, 5, CTX).catch((e) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(JSON.stringify(error.getResponse())).not.toContain(stored);
      expect(JSON.stringify(error.getResponse())).not.toContain('secret"');
      expect(mockPrismaService.credentialAuditLog.create).not.toHaveBeenCalled();
    });

    it('fails safely with the wrong key', async () => {
      const stored = crypto.encrypt('secret', AAD(5));
      await build({ ...TEST_ENV, CREDENTIAL_KEYS: `1:${nodeCrypto.randomBytes(32).toString('base64')}` });
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5, password: stored });

      await expect(service.revealPassword(revealer, 5, CTX)).rejects.toThrow(UnprocessableEntityException);
    });

    it('reports missing key configuration as 503', async () => {
      const stored = crypto.encrypt('secret', AAD(5));
      await build({});
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5, password: stored });

      await expect(service.revealPassword(revealer, 5, CTX)).rejects.toThrow(ServiceUnavailableException);
    });

    it('returns an empty string when no password is stored', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5, password: null });

      await expect(service.revealPassword(revealer, 5, CTX)).resolves.toEqual({ password: '' });
    });
  });

  describe('update', () => {
    beforeEach(() => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5, name: 'Old', password: 'stored' });
    });

    it('keeps the stored password when none or an empty one is sent, without a secret audit', async () => {
      await service.update(5, { name: 'Renamed' }, CTX);
      await service.update(5, { name: 'Renamed', password: '' }, CTX);

      for (const call of mockPrismaService.companyCredential.update.mock.calls) {
        expect(call[0].data.password).toBeUndefined();
      }
      expect(mockPrismaService.credentialAuditLog.create).not.toHaveBeenCalled();
    });

    it('replaces the password with a gcm1 value for this record and audits UPDATE_SECRET', async () => {
      const result: any = await service.update(5, { password: 'new-secret' }, CTX);

      const data = mockPrismaService.companyCredential.update.mock.calls[0][0].data;
      expect(data.password).toMatch(/^gcm1:/);
      expect(crypto.decrypt(data.password, AAD(5))).toBe('new-secret');
      expect(auditActions()).toMatchObject([{ action: 'UPDATE_SECRET', credential_id: 5 }]);
      expect(JSON.stringify(result)).not.toMatch(/new-secret|gcm1/);
    });

    it('clears the password when clear_password is true and audits UPDATE_SECRET', async () => {
      await service.update(5, { clear_password: true }, CTX);

      expect(mockPrismaService.companyCredential.update.mock.calls[0][0].data.password).toBeNull();
      expect(auditActions()).toMatchObject([{ action: 'UPDATE_SECRET' }]);
    });

    it('refuses a new password without key configuration and writes nothing', async () => {
      await build({});
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5 });
      await expect(service.update(5, { password: 'plain' }, CTX)).rejects.toThrow(ServiceUnavailableException);
      expect(mockPrismaService.companyCredential.update).not.toHaveBeenCalled();
    });

    it('only updates fields that were sent', async () => {
      await service.update(5, { notes: '' }, CTX);

      const data = mockPrismaService.companyCredential.update.mock.calls[0][0].data;
      expect(data.notes).toBeNull();
      expect(data.name).toBeUndefined();
      expect(data.category).toBeUndefined();
      expect(data.provider).toBeUndefined();
    });

    it('validates the name when it is sent', async () => {
      await expect(service.update(5, { name: '' }, CTX)).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for a missing credential', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue(null);

      await expect(service.update(404, { name: 'X' }, CTX)).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes an existing credential and audits DELETE', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue({ id: 5 });

      await service.remove(5, CTX);

      expect(mockPrismaService.companyCredential.delete).toHaveBeenCalledWith({ where: { id: 5 } });
      expect(mockPrismaService.websiteCredential.delete).not.toHaveBeenCalled();
      expect(auditActions()).toMatchObject([{ action: 'DELETE', credential_id: 5 }]);
    });

    it('throws NotFoundException for a missing credential', async () => {
      mockPrismaService.companyCredential.findUnique.mockResolvedValue(null);

      await expect(service.remove(404, CTX)).rejects.toThrow(NotFoundException);
      expect(mockPrismaService.companyCredential.delete).not.toHaveBeenCalled();
    });
  });
});
