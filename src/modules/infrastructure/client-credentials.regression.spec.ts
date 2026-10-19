import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { InfrastructureService } from './infrastructure.service';
import { PrismaService } from '../../core/prisma.service';

/**
 * Regression tests for the existing client (website) credentials behaviour,
 * added alongside the separate Grehasoft credentials module to confirm it is unchanged.
 */
describe('InfrastructureService - Client Credentials (regression)', () => {
  let service: InfrastructureService;

  const mockPrismaService = {
    websiteCredential: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    projectMember: { findMany: jest.fn() },
  };

  const admin = { id: 1, role: { name: 'SUPER_ADMIN' } };
  const member = { id: 2, role: { name: 'TEAM_MEMBER' } };
  const MASK = '••••••••';

  const encrypt = (text: string) => (service as any).encryptPassword(text);

  const storedRow = () => ({
    id: 11,
    project_id: 3,
    domain_id: 4,
    admin_url: 'https://example.com/wp-admin',
    admin_username: 'admin',
    admin_password: encrypt('wp-pass'),
    cpanel_password: encrypt('cp-pass'),
    ftp_password: '',
    client_email_password: '',
    business_email_password: null,
    project: { id: 3, name: 'Acme Site' },
    domain: { id: 4, domain_name: 'example.com' },
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [InfrastructureService, { provide: PrismaService, useValue: mockPrismaService }],
    }).compile();

    service = module.get(InfrastructureService);
    jest.clearAllMocks();
  });

  it('creates a client credential with encrypted passwords', async () => {
    mockPrismaService.websiteCredential.create.mockImplementation(async ({ data }: any) => ({
      id: 11,
      ...data,
      project: { name: 'Acme Site' },
      domain: { domain_name: 'example.com' },
    }));

    const res: any = await service.createCredential(admin, {
      project: 3,
      domain: 4,
      admin_url: 'https://example.com/wp-admin',
      admin_username: 'admin',
      admin_password: 'wp-pass',
    });

    const data = mockPrismaService.websiteCredential.create.mock.calls[0][0].data;
    expect(data.project_id).toBe(3);
    expect(data.domain_id).toBe(4);
    expect(data.admin_password).not.toBe('wp-pass');
    expect((service as any).decryptPassword(data.admin_password)).toBe('wp-pass');
    expect(res).toMatchObject({ project: 3, domain: 4, project_name: 'Acme Site', domain_name: 'example.com', admin_password: 'wp-pass' });
  });

  it('lists credentials with decrypted passwords for admins', async () => {
    mockPrismaService.websiteCredential.count.mockResolvedValue(1);
    mockPrismaService.websiteCredential.findMany.mockResolvedValue([storedRow()]);

    const res: any = await service.getCredentials(admin, {});

    expect(Object.keys(res).sort()).toEqual(['count', 'next', 'previous', 'results']);
    expect(res.results[0]).toMatchObject({ admin_password: 'wp-pass', cpanel_password: 'cp-pass', project_name: 'Acme Site' });
  });

  it('masks passwords and scopes by project membership for non-admins', async () => {
    mockPrismaService.projectMember.findMany.mockResolvedValue([{ project_id: 3 }]);
    mockPrismaService.websiteCredential.count.mockResolvedValue(1);
    mockPrismaService.websiteCredential.findMany.mockResolvedValue([storedRow()]);

    const res: any = await service.getCredentials(member, {});

    expect(mockPrismaService.websiteCredential.findMany.mock.calls[0][0].where.project_id).toEqual({ in: [3] });
    expect(res.results[0].admin_password).toBe(MASK);
    expect(res.results[0].cpanel_password).toBe(MASK);
  });

  it('returns an empty list to non-admins without projects', async () => {
    mockPrismaService.projectMember.findMany.mockResolvedValue([]);

    await expect(service.getCredentials(member, {})).resolves.toEqual({ count: 0, next: null, previous: null, results: [] });
  });

  it('views a single credential (decrypted for admins, masked otherwise)', async () => {
    mockPrismaService.websiteCredential.findUnique.mockResolvedValue(storedRow());
    expect(((await service.getCredentialById(admin, 11)) as any).admin_password).toBe('wp-pass');

    // Non-admins must be members of the credential's project (Phase 2.2 record scoping)
    mockPrismaService.projectMember.findMany.mockResolvedValue([{ project_id: 3 }]);
    mockPrismaService.websiteCredential.findUnique.mockResolvedValue(storedRow());
    expect(((await service.getCredentialById(member, 11)) as any).admin_password).toBe(MASK);
  });

  it('Phase 2.2: a non-member cannot read a credential by ID (404)', async () => {
    mockPrismaService.projectMember.findMany.mockResolvedValue([{ project_id: 99 }]);
    mockPrismaService.websiteCredential.findUnique.mockResolvedValue(storedRow());
    await expect(service.getCredentialById(member, 11)).rejects.toThrow(NotFoundException);
  });

  it('updates a credential and re-encrypts a changed password', async () => {
    mockPrismaService.websiteCredential.findUnique.mockResolvedValue(storedRow());
    mockPrismaService.websiteCredential.update.mockImplementation(async ({ data }: any) => ({ id: 11, project_id: 3, domain_id: 4, ...data }));

    await service.updateCredential(admin, 11, { admin_username: 'root', admin_password: 'new-pass' });

    const data = mockPrismaService.websiteCredential.update.mock.calls[0][0].data;
    expect(data.admin_username).toBe('root');
    expect((service as any).decryptPassword(data.admin_password)).toBe('new-pass');
    expect(data.cpanel_password).toBeUndefined();
  });

  it('deletes a credential', async () => {
    mockPrismaService.websiteCredential.findUnique.mockResolvedValue(storedRow());

    await service.deleteCredential(admin, 11);

    expect(mockPrismaService.websiteCredential.delete).toHaveBeenCalledWith({ where: { id: 11 } });
  });

  it('throws NotFoundException for missing credentials', async () => {
    mockPrismaService.websiteCredential.findUnique.mockResolvedValue(null);

    await expect(service.getCredentialById(admin, 99)).rejects.toThrow(NotFoundException);
    await expect(service.updateCredential(admin, 99, {})).rejects.toThrow(NotFoundException);
    await expect(service.deleteCredential(admin, 99)).rejects.toThrow(NotFoundException);
  });
});
