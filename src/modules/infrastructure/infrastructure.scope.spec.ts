import { NotFoundException } from '@nestjs/common';
import { InfrastructureService } from './infrastructure.service';

/**
 * Phase 2.2: single-record infrastructure reads follow the list scope (project membership),
 * and credential updates never store the masked placeholder or return ciphertext.
 */
const MASK = '••••••••';
const member = { id: 5, role: { name: 'TEAM_MEMBER', permissions: [], deleted_at: null } };
const ops = { id: 6, role: { name: 'OPS', permissions: ['MANAGE_INFRASTRUCTURE'], deleted_at: null } };
const superAdmin = { id: 1, role: { name: 'SUPER_ADMIN', permissions: [], deleted_at: null } };

const buildPrisma = () => ({
  projectMember: { findMany: jest.fn(async ({ where }: any) => (where.user_id === member.id ? [{ project_id: 10 }] : [])) },
  domain: {
    findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, project_id: where.id === 1 ? 10 : 20, project: null, server: null })),
  },
  websiteCredential: {
    findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, project_id: 10, admin_password: 'stored' })),
    update: jest.fn(async ({ where, data }: any) => ({ id: where.id, project_id: 10, project: null, domain: null, ...data })),
  },
});

describe('InfrastructureService record scope (Phase 2.2)', () => {
  let prisma: ReturnType<typeof buildPrisma>;
  let service: InfrastructureService;

  beforeEach(() => {
    prisma = buildPrisma();
    service = new InfrastructureService(prisma as any);
  });

  it('domains of a member project are readable; other projects return 404', async () => {
    await expect(service.getDomainById(member, 1)).resolves.toMatchObject({ id: 1 });
    await expect(service.getDomainById(member, 2)).rejects.toThrow(NotFoundException);
    await expect(service.getDomainById(ops, 1)).rejects.toThrow(NotFoundException);
    await expect(service.getDomainById(superAdmin, 2)).resolves.toMatchObject({ id: 2 });
  });

  it('the masked placeholder does not overwrite stored credential passwords', async () => {
    await service.updateCredential(ops, 3, { admin_password: MASK, ftp_password: 'new-ftp' });
    const data = prisma.websiteCredential.update.mock.calls[0][0].data;
    expect(data.admin_password).toBeUndefined();
    expect(data.ftp_password).toBeTruthy();
    expect(data.ftp_password).not.toBe('new-ftp');
  });

  it('credential update responses are masked for non-super-admins and decrypted for super admins', async () => {
    const forOps: any = await service.updateCredential(ops, 3, { ftp_password: 'new-ftp' });
    expect(forOps.ftp_password).toBe(MASK);

    const forSuper: any = await service.updateCredential(superAdmin, 3, { ftp_password: 'new-ftp' });
    expect(forSuper.ftp_password).toBe('new-ftp');
  });
});
