import * as nodeCrypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebsiteCredentialsService, PASSWORD_MASK, WEBSITE_PASSWORD_FIELDS } from './website-credentials.service';
import { PrismaService } from '../../core/prisma.service';
import { CredentialCryptoService } from '../../core/credential-crypto.service';
import { CredentialAuditContext, CredentialAuditService } from '../credential-audit/credential-audit.service';

/**
 * Client (website) credentials, service level. Previously super admins received decrypted
 * passwords in every response; now nobody does (reveal is a separate audited endpoint).
 */
const ENV: Record<string, string> = {
  CREDENTIAL_KEYS: `1:${nodeCrypto.randomBytes(32).toString('base64')}`,
  CREDENTIAL_ACTIVE_KEY_VERSION: '1',
};
const CTX: CredentialAuditContext = { actorId: 1, actorUsername: 'owner', ipAddress: '127.0.0.1', userAgent: 'jest' };
const aad = (id: number, field: string) => ({ table: 'website_credentials', field, recordId: id });

describe('WebsiteCredentialsService - Client Credentials (regression)', () => {
  let service: WebsiteCredentialsService;
  let crypto: CredentialCryptoService;

  const mockPrisma: any = {
    websiteCredential: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    projectMember: { findMany: jest.fn() },
    domain: { findUnique: jest.fn() },
    credentialAuditLog: { create: jest.fn() },
    $transaction: jest.fn((fn: any) => fn(mockPrisma)),
  };

  const admin = { id: 1, role: { name: 'SUPER_ADMIN' } };
  const member = { id: 2, role: { name: 'TEAM_MEMBER', permissions: ['MANAGE_INFRASTRUCTURE'] } };

  const storedRow = () => ({
    id: 11,
    project_id: 3,
    domain_id: 4,
    admin_url: 'https://example.com/wp-admin',
    admin_username: 'admin',
    admin_password: crypto.encrypt('wp-pass', aad(11, 'admin_password')),
    cpanel_password: crypto.encrypt('cp-pass', aad(11, 'cpanel_password')),
    ftp_password: '',
    client_email_password: '',
    business_email_password: null,
    project: { id: 3, name: 'Acme Site' },
    domain: { id: 4, domain_name: 'example.com' },
  });

  const build = async (env = ENV) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebsiteCredentialsService,
        CredentialCryptoService,
        CredentialAuditService,
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(WebsiteCredentialsService);
    crypto = module.get(CredentialCryptoService);
  };

  beforeEach(async () => {
    await build();
    jest.clearAllMocks();
    mockPrisma.domain.findUnique.mockResolvedValue({ id: 4, project_id: 3 });
    mockPrisma.credentialAuditLog.create.mockResolvedValue({});
    mockPrisma.websiteCredential.create.mockImplementation(async ({ data }: any) => ({ id: 11, ...data, project: { name: 'Acme Site' }, domain: { domain_name: 'example.com' } }));
    mockPrisma.websiteCredential.update.mockImplementation(async ({ where, data }: any) => ({
      id: where.id,
      project_id: 3,
      domain_id: 4,
      ...data,
      project: { name: 'Acme Site' },
      domain: { domain_name: 'example.com' },
    }));
  });

  it('creates a client credential: row first, then each password as gcm1 bound to its record and field', async () => {
    const res: any = await service.createCredential(admin, { project: 3, domain: 4, admin_url: 'https://example.com/wp-admin', admin_username: 'admin', admin_password: 'wp-pass' }, CTX);

    const created = mockPrisma.websiteCredential.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ project_id: 3, domain_id: 4, admin_password: '', business_email_password: null });
    const stored = mockPrisma.websiteCredential.update.mock.calls[0][0].data;
    expect(Object.keys(stored)).toEqual(['admin_password']);
    expect(stored.admin_password).toMatch(/^gcm1:1:/);
    expect(crypto.decrypt(stored.admin_password, aad(11, 'admin_password'))).toBe('wp-pass');
    expect(() => crypto.decrypt(stored.admin_password, aad(11, 'cpanel_password'))).toThrow();
    expect(res).toMatchObject({ project: 3, domain: 4, project_name: 'Acme Site', domain_name: 'example.com', admin_password: PASSWORD_MASK });
    expect(JSON.stringify(res)).not.toMatch(/wp-pass|gcm1/);
  });

  it('lists credentials with masked passwords, even for super admins', async () => {
    mockPrisma.websiteCredential.count.mockResolvedValue(1);
    mockPrisma.websiteCredential.findMany.mockResolvedValue([storedRow()]);

    const res: any = await service.getCredentials(admin, {});

    expect(Object.keys(res).sort()).toEqual(['count', 'next', 'previous', 'results']);
    expect(res.results[0]).toMatchObject({ admin_password: PASSWORD_MASK, cpanel_password: PASSWORD_MASK, ftp_password: '', business_email_password: null, project_name: 'Acme Site' });
    expect(JSON.stringify(res)).not.toMatch(/wp-pass|cp-pass|gcm1/);
  });

  it('scopes the list by project membership for non-admins', async () => {
    mockPrisma.projectMember.findMany.mockResolvedValue([{ project_id: 3 }]);
    mockPrisma.websiteCredential.count.mockResolvedValue(1);
    mockPrisma.websiteCredential.findMany.mockResolvedValue([storedRow()]);

    const res: any = await service.getCredentials(member, {});

    expect(mockPrisma.websiteCredential.findMany.mock.calls[0][0].where.project_id).toEqual({ in: [3] });
    expect(res.results[0].admin_password).toBe(PASSWORD_MASK);
  });

  it('returns an empty list to non-admins without projects', async () => {
    mockPrisma.projectMember.findMany.mockResolvedValue([]);
    await expect(service.getCredentials(member, {})).resolves.toEqual({ count: 0, next: null, previous: null, results: [] });
  });

  it('searches real columns and relation names without Prisma `mode` (MySQL/MariaDB)', async () => {
    mockPrisma.websiteCredential.count.mockResolvedValue(0);
    mockPrisma.websiteCredential.findMany.mockResolvedValue([]);

    await service.getCredentials(admin, { search: '  Acme  ' });

    const where = mockPrisma.websiteCredential.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).not.toContain('mode');
    expect(JSON.stringify(where)).not.toContain('password');
    const fields = where.OR.map((c: any) => Object.keys(c)[0]);
    expect(fields).toEqual(expect.arrayContaining(['admin_url', 'admin_username', 'cpanel_username', 'ftp_username', 'client_email', 'project', 'domain']));
    expect(fields).not.toContain('url');
    expect(fields).not.toContain('username');
    expect(where.OR[0].admin_url.contains).toBe('Acme');
    expect(mockPrisma.websiteCredential.count.mock.calls[0][0].where).toEqual(where);
  });

  it('views a single credential masked; non-members get 404', async () => {
    mockPrisma.websiteCredential.findUnique.mockResolvedValue(storedRow());
    expect(((await service.getCredentialById(admin, 11)) as any).admin_password).toBe(PASSWORD_MASK);

    mockPrisma.projectMember.findMany.mockResolvedValue([{ project_id: 3 }]);
    expect(((await service.getCredentialById(member, 11)) as any).admin_password).toBe(PASSWORD_MASK);

    mockPrisma.projectMember.findMany.mockResolvedValue([{ project_id: 99 }]);
    await expect(service.getCredentialById(member, 11)).rejects.toThrow(NotFoundException);
  });

  it('updates: changed password encrypted for this record, placeholder and omitted fields kept, empty clears', async () => {
    mockPrisma.websiteCredential.findUnique.mockResolvedValue(storedRow());

    const res: any = await service.updateCredential(admin, 11, { admin_username: 'root', admin_password: 'new-pass', cpanel_password: PASSWORD_MASK, ftp_password: '' }, CTX);

    const data = mockPrisma.websiteCredential.update.mock.calls[0][0].data;
    expect(data.admin_username).toBe('root');
    expect(crypto.decrypt(data.admin_password, aad(11, 'admin_password'))).toBe('new-pass');
    expect(data.cpanel_password).toBeUndefined();
    expect(data.ftp_password).toBe('');
    expect(data.client_email_password).toBeUndefined();
    expect(mockPrisma.credentialAuditLog.create.mock.calls.map((c: any) => c[0].data.action)).toEqual(['UPDATE_SECRET']);
    expect(JSON.stringify(res)).not.toMatch(/new-pass|gcm1/);
  });

  it('a metadata-only update is not audited as a secret change', async () => {
    mockPrisma.websiteCredential.findUnique.mockResolvedValue(storedRow());
    await service.updateCredential(admin, 11, { notes: 'moved', admin_password: PASSWORD_MASK }, CTX);
    expect(mockPrisma.credentialAuditLog.create).not.toHaveBeenCalled();
  });

  it('refuses new passwords without key configuration and writes nothing', async () => {
    await build({});
    mockPrisma.websiteCredential.findUnique.mockResolvedValue({ id: 11, project_id: 3, domain_id: 4, admin_password: '' });
    await expect(service.createCredential(admin, { project: 3, domain: 4, admin_password: 'x' }, CTX)).rejects.toThrow(ServiceUnavailableException);
    await expect(service.updateCredential(admin, 11, { ftp_password: 'x' }, CTX)).rejects.toThrow(ServiceUnavailableException);
    expect(mockPrisma.websiteCredential.create).not.toHaveBeenCalled();
    expect(mockPrisma.websiteCredential.update).not.toHaveBeenCalled();
  });

  it('validates project and domain on create', async () => {
    await expect(service.createCredential(admin, { project: 'x', domain: 4 }, CTX)).rejects.toThrow(BadRequestException);
    mockPrisma.domain.findUnique.mockResolvedValue({ id: 4, project_id: 8 });
    await expect(service.createCredential(admin, { project: 3, domain: 4 }, CTX)).rejects.toThrow('The domain belongs to a different project.');
    mockPrisma.domain.findUnique.mockResolvedValue(null);
    await expect(service.createCredential(admin, { project: 3, domain: 4 }, CTX)).rejects.toThrow('Domain not found.');
  });

  it('deletes a credential and audits DELETE', async () => {
    mockPrisma.websiteCredential.findUnique.mockResolvedValue(storedRow());
    await service.deleteCredential(admin, 11, CTX);
    expect(mockPrisma.websiteCredential.delete).toHaveBeenCalledWith({ where: { id: 11 } });
    expect(mockPrisma.credentialAuditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'DELETE', credential_type: 'website', credential_id: 11 });
  });

  it('throws NotFoundException for missing credentials', async () => {
    mockPrisma.websiteCredential.findUnique.mockResolvedValue(null);
    await expect(service.getCredentialById(admin, 99)).rejects.toThrow(NotFoundException);
    await expect(service.updateCredential(admin, 99, {}, CTX)).rejects.toThrow(NotFoundException);
    await expect(service.deleteCredential(admin, 99, CTX)).rejects.toThrow(NotFoundException);
  });

  it('covers exactly the five password columns', () => {
    expect(WEBSITE_PASSWORD_FIELDS).toEqual(['admin_password', 'cpanel_password', 'ftp_password', 'client_email_password', 'business_email_password']);
  });
});
