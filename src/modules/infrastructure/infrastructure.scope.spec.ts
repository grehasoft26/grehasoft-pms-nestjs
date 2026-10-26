import { NotFoundException } from '@nestjs/common';
import { InfrastructureService } from './infrastructure.service';

/**
 * Phase 2.2: single-record infrastructure reads follow the list scope (project membership).
 * Client credential scoping and masking moved to WebsiteCredentialsService
 * (website-credentials.http.spec.ts, client-credentials.regression.spec.ts).
 */
const member = { id: 5, role: { name: 'TEAM_MEMBER', permissions: [], deleted_at: null } };
const ops = { id: 6, role: { name: 'OPS', permissions: ['MANAGE_INFRASTRUCTURE'], deleted_at: null } };
const superAdmin = { id: 1, role: { name: 'SUPER_ADMIN', permissions: [], deleted_at: null } };

const buildPrisma = () => ({
  projectMember: { findMany: jest.fn(async ({ where }: any) => (where.user_id === member.id ? [{ project_id: 10 }] : [])) },
  domain: {
    findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, project_id: where.id === 1 ? 10 : 20, project: null, server: null })),
  },
});

describe('InfrastructureService record scope (Phase 2.2)', () => {
  let prisma: ReturnType<typeof buildPrisma>;
  let service: InfrastructureService;

  beforeEach(() => {
    prisma = buildPrisma();
    service = new InfrastructureService(prisma as any, {} as any, {} as any);
  });

  it('domains of a member project are readable; other projects return 404', async () => {
    await expect(service.getDomainById(member, 1)).resolves.toMatchObject({ id: 1 });
    await expect(service.getDomainById(member, 2)).rejects.toThrow(NotFoundException);
    await expect(service.getDomainById(ops, 1)).rejects.toThrow(NotFoundException);
    await expect(service.getDomainById(superAdmin, 2)).resolves.toMatchObject({ id: 2 });
  });
});
