import { NotFoundException } from '@nestjs/common';
import { LeadsService } from './leads.service';

/**
 * Phase 2.2: single-lead reads, edits, deletes and conversion use the same scope as the
 * list: super admins and sales managers see every lead, other staff only assigned ones.
 */
const LEADS = [
  { id: 1, name: 'Assigned', deleted_at: null, status: 'new', email: 'a@x.test', client: null, assignments: [{ sales_exec_id: 20 }] },
  { id: 2, name: 'Unassigned', deleted_at: null, status: 'new', email: 'b@x.test', client: null, assignments: [{ sales_exec_id: 21 }] },
];

const buildPrisma = () => {
  const matches = (lead: any, where: any) =>
    lead.id === where.id &&
    lead.deleted_at === where.deleted_at &&
    (!where.assignments || lead.assignments.some((a: any) => a.sales_exec_id === where.assignments.some.sales_exec_id));
  return {
    lead: {
      findFirst: jest.fn(async ({ where }: any) => LEADS.find((l) => matches(l, where)) ?? null),
      update: jest.fn(async ({ where, data }: any) => ({ ...LEADS.find((l) => l.id === where.id), ...data })),
    },
    client: { findFirst: jest.fn(async () => ({ id: 9 })), create: jest.fn() },
    project: { create: jest.fn(async () => ({ id: 30 })) },
  };
};

const exec = { id: 20, role: { name: 'SALES_EXECUTIVE' } };
const salesManager = { id: 2, role: { name: 'SALES_MANAGER' } };
const superAdmin = { id: 1, role: { name: 'SUPER_ADMIN' } };

describe('LeadsService assignment scope (Phase 2.2)', () => {
  let prisma: ReturnType<typeof buildPrisma>;
  let service: LeadsService;

  beforeEach(() => {
    prisma = buildPrisma();
    service = new LeadsService(prisma as any);
  });

  it('staff read assigned leads and get 404 for others', async () => {
    await expect(service.findOne(1, exec)).resolves.toMatchObject({ id: 1 });
    await expect(service.findOne(2, exec)).rejects.toThrow(NotFoundException);
  });

  it('staff cannot edit or delete leads assigned to someone else', async () => {
    await expect(service.update(2, exec, { status: 'won' })).rejects.toThrow(NotFoundException);
    await expect(service.remove(2, exec)).rejects.toThrow(NotFoundException);
    expect(prisma.lead.update).not.toHaveBeenCalled();
    await expect(service.update(1, exec, { status: 'contacted' })).resolves.toMatchObject({ id: 1 });
  });

  it('staff cannot convert leads assigned to someone else', async () => {
    await expect(service.convertToProject(2, exec, {})).rejects.toThrow(NotFoundException);
    expect(prisma.project.create).not.toHaveBeenCalled();
    await expect(service.convertToProject(1, exec, {})).resolves.toMatchObject({ project_id: 30 });
  });

  it('sales managers and super admins keep access to every lead', async () => {
    await expect(service.findOne(2, salesManager)).resolves.toMatchObject({ id: 2 });
    await expect(service.findOne(2, superAdmin)).resolves.toMatchObject({ id: 2 });
    await expect(service.findOne(2, { id: 3, is_superuser: true, role: null })).resolves.toMatchObject({ id: 2 });
  });
});
