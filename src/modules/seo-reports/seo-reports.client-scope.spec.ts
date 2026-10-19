import { ForbiddenException } from '@nestjs/common';
import { SeoReportsService } from './seo-reports.service';

/**
 * Phase 2.2: CLIENT users only see their own published SEO reports. `?client_id=` cannot
 * widen the list, and the PDF download fails closed when the client cannot be resolved.
 */
const buildPrisma = (report: any = null) => ({
  client: {
    findFirst: jest.fn(async ({ where }: any) => (where.id === 1 ? { id: 1 } : null)),
    findMany: jest.fn(async () => []),
  },
  sEOReport: {
    count: jest.fn(async () => 0),
    findMany: jest.fn(async (_args: any) => [] as any[]),
    findUnique: jest.fn(async () => report),
  },
});

const client = { id: 50, client_id: 1, role: { name: 'CLIENT' } };
const unlinkedClient = { id: 51, email: 'nobody@x.test', role: { name: 'CLIENT' } };
const manager = { id: 2, role: { name: 'SEO_MANAGER' } };

describe('SeoReportsService client scope (Phase 2.2)', () => {
  it('ignores ?client_id= from CLIENT users', async () => {
    const prisma = buildPrisma();
    const service = new SeoReportsService(prisma as any, {} as any);
    await service.findAll(client, { client_id: '2', status: 'draft' });
    expect(prisma.sEOReport.findMany.mock.calls[0][0].where).toMatchObject({ client_id: 1, status: 'published' });
  });

  it('still lets staff filter by client', async () => {
    const prisma = buildPrisma();
    const service = new SeoReportsService(prisma as any, {} as any);
    await service.findAll(manager, { client_id: '2' });
    expect(prisma.sEOReport.findMany.mock.calls[0][0].where).toMatchObject({ client_id: 2 });
  });

  it('returns nothing to a CLIENT user whose client cannot be resolved', async () => {
    const prisma = buildPrisma();
    const service = new SeoReportsService(prisma as any, {} as any);
    await expect(service.findAll(unlinkedClient, {})).resolves.toEqual({ count: 0, results: [] });
    expect(prisma.sEOReport.findMany).not.toHaveBeenCalled();
  });

  it('PDF download: denies other clients and unresolved clients', async () => {
    const report = { id: 9, client_id: 2, status: 'published', pdf_file_path: null };
    const service = new SeoReportsService(buildPrisma(report) as any, {} as any);
    await expect(service.getReportPdf(9, client)).rejects.toThrow(ForbiddenException);
    await expect(service.getReportPdf(9, unlinkedClient)).rejects.toThrow(ForbiddenException);
  });

  it('PDF download: the owning client passes the access check', async () => {
    const report = { id: 9, client_id: 1, status: 'published', pdf_file_path: null };
    const service = new SeoReportsService(buildPrisma(report) as any, {} as any);
    // Passing authorization reaches the "not generated yet" check
    await expect(service.getReportPdf(9, client)).rejects.toThrow(/has not been generated/);
  });
});
