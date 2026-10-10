import { Test, TestingModule } from '@nestjs/testing';
import { SeoReportsService } from './seo-reports.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import * as fs from 'fs';

describe('SeoReportsService', () => {
  let service: SeoReportsService;
  let prisma: any;
  let pdfService: any;

  const mockUserAdmin = { id: 1, name: 'Admin', role_name: 'SUPER_ADMIN', is_superuser: true };
  const mockUserExecutive = { id: 2, name: 'Executive', role_name: 'SEO_EXECUTIVE' };
  const mockUserClient = { id: 3, name: 'Client User', role_name: 'CLIENT', client_id: 10 };

  const mockClient = { id: 10, name: 'Al Bayan Corp', company_name: 'Al Bayan' };
  const mockWebsite = { id: 100, client_id: 10, website_name: 'Al Bayan UAE', domain_url: 'batteryexpertesuae.com' };
  const mockMismatchedWebsite = { id: 101, client_id: 99, website_name: 'Other Domain', domain_url: 'other.com' };

  const mockReport = {
    id: 1,
    client_id: 10,
    website_id: 100,
    report_title: 'Al Bayan UAE — 2026-08 SEO Report',
    report_month: '2026-08',
    period_start_date: new Date('2026-08-01'),
    period_end_date: new Date('2026-08-31'),
    status: 'draft',
    data_source: 'manual',
    created_by_id: 1,
    client: mockClient,
    website: mockWebsite,
    created_by: mockUserAdmin,
    approved_by: null,
    keywords: [],
    top_queries: [],
    traffic_sources: [],
    activity_summaries: [],
    evidence_files: [],
  };

  beforeEach(async () => {
    prisma = {
      client: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      sEOWebsite: {
        findUnique: jest.fn(),
      },
      sEOReport: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      sEOReportKeyword: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      sEOReportTopQuery: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      sEOReportTrafficSource: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      sEOReportActivitySummary: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      sEOReportFile: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
    };

    pdfService = {
      generateSeoReportPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 Mock SEO Report PDF Content')),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SeoReportsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PdfService, useValue: pdfService },
      ],
    }).compile();

    service = module.get<SeoReportsService>(SeoReportsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // 1. Create Report Success
  it('1. should create an SEO report successfully', async () => {
    prisma.client.findUnique.mockResolvedValue(mockClient);
    prisma.sEOWebsite.findUnique.mockResolvedValue(mockWebsite);
    prisma.sEOReport.findFirst.mockResolvedValue(null);
    prisma.sEOReport.create.mockResolvedValue(mockReport);

    const result = await service.create(mockUserAdmin, {
      client_id: 10,
      website_id: 100,
      report_title: 'Al Bayan August Report',
      report_month: '2026-08',
      period_start_date: '2026-08-01',
      period_end_date: '2026-08-31',
    });

    expect(result).toBeDefined();
    expect(result.report_month).toBe('2026-08');
  });

  // 2. Reject invalid client
  it('2. should reject report creation if client does not exist', async () => {
    prisma.client.findUnique.mockResolvedValue(null);

    await expect(
      service.create(mockUserAdmin, {
        client_id: 999,
        website_id: 100,
        report_title: 'Test Report',
        report_month: '2026-08',
        period_start_date: '2026-08-01',
        period_end_date: '2026-08-31',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  // 3. Reject invalid website
  it('3. should reject report creation if website does not exist', async () => {
    prisma.client.findUnique.mockResolvedValue(mockClient);
    prisma.sEOWebsite.findUnique.mockResolvedValue(null);

    await expect(
      service.create(mockUserAdmin, {
        client_id: 10,
        website_id: 999,
        report_title: 'Test Report',
        report_month: '2026-08',
        period_start_date: '2026-08-01',
        period_end_date: '2026-08-31',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  // 4. Reject website/client mismatch
  it('4. should reject report creation if website does not belong to client', async () => {
    prisma.client.findUnique.mockResolvedValue(mockClient);
    prisma.sEOWebsite.findUnique.mockResolvedValue(mockMismatchedWebsite);

    await expect(
      service.create(mockUserAdmin, {
        client_id: 10,
        website_id: 101,
        report_title: 'Test Report',
        report_month: '2026-08',
        period_start_date: '2026-08-01',
        period_end_date: '2026-08-31',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // 5. Reject duplicate website/month
  it('5. should reject creation of duplicate report for same website and month', async () => {
    prisma.client.findUnique.mockResolvedValue(mockClient);
    prisma.sEOWebsite.findUnique.mockResolvedValue(mockWebsite);
    prisma.sEOReport.findFirst.mockResolvedValue(mockReport);

    await expect(
      service.create(mockUserAdmin, {
        client_id: 10,
        website_id: 100,
        report_title: 'Test Duplicate',
        report_month: '2026-08',
        period_start_date: '2026-08-01',
        period_end_date: '2026-08-31',
      }),
    ).rejects.toThrow(ConflictException);
  });

  // 6. Get report detail
  it('6. should return report details for manager', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue(mockReport);

    const result = await service.findOne(1, mockUserAdmin);
    expect(result.id).toBe(1);
    expect(result.client_name).toBe('Al Bayan Corp');
  });

  // 7. Update draft report
  it('7. should update draft report fields', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue(mockReport);
    prisma.sEOReport.update.mockResolvedValue({ ...mockReport, domain_authority: 45 });

    const result = await service.update(1, mockUserAdmin, { domain_authority: 45 });
    expect(result.domain_authority).toBe(45);
  });

  // 8. Reject update of approved report
  it('8. should reject editing an approved report', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue({ ...mockReport, status: 'approved' });

    await expect(
      service.update(1, mockUserAdmin, { domain_authority: 50 }),
    ).rejects.toThrow(ForbiddenException);
  });

  // 9. Create keyword
  it('9. should add a keyword to a draft report', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue(mockReport);
    prisma.sEOReportKeyword.create.mockResolvedValue({ id: 1, keyword: 'car battery uae', current_rank: 3 });

    const kw = await service.addKeyword(1, mockUserAdmin, { keyword: 'car battery uae', current_rank: 3 });
    expect(kw.keyword).toBe('car battery uae');
  });

  // 10. Create top query
  it('10. should add a top query to a draft report', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue(mockReport);
    prisma.sEOReportTopQuery.create.mockResolvedValue({ id: 1, query_text: 'battery replacement', clicks: 120 });

    const query = await service.addTopQuery(1, mockUserAdmin, { query_text: 'battery replacement', clicks: 120 });
    expect(query.clicks).toBe(120);
  });

  // 11. Create traffic source
  it('11. should add a traffic source to a draft report', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue(mockReport);
    prisma.sEOReportTrafficSource.create.mockResolvedValue({ id: 1, channel_group: 'Organic Search', users_count: 500 });

    const source = await service.addTrafficSource(1, mockUserAdmin, { channel_group: 'Organic Search', users_count: 500 });
    expect(source.channel_group).toBe('Organic Search');
  });

  // 12. Create activity summary
  it('12. should add an activity summary to a draft report', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue(mockReport);
    prisma.sEOReportActivitySummary.create.mockResolvedValue({ id: 1, activity_name: 'Directory Submissions', completed_count: 50 });

    const act = await service.addActivitySummary(1, mockUserAdmin, { activity_name: 'Directory Submissions', completed_count: 50 });
    expect(act.completed_count).toBe(50);
  });

  // 13. Delete child record
  it('13. should delete a keyword child record', async () => {
    prisma.sEOReportKeyword.findUnique.mockResolvedValue({ id: 1, report: mockReport });
    prisma.sEOReportKeyword.delete.mockResolvedValue({});

    const result = await service.removeKeyword(1, mockUserAdmin);
    expect(result).toBeNull();
  });

  // 14. Submit draft
  it('14. should submit draft for review', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue(mockReport);
    prisma.sEOReport.update.mockResolvedValue({ ...mockReport, status: 'under_review' });

    const res = await service.submitForReview(1, mockUserAdmin);
    expect(res.status).toBe('under_review');
  });

  // 15. Approve under_review
  it('15. should approve an under_review report', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue({ ...mockReport, status: 'under_review' });
    prisma.sEOReport.update.mockResolvedValue({ ...mockReport, status: 'approved' });

    const res = await service.approveReport(1, mockUserAdmin);
    expect(res.status).toBe('approved');
  });

  // 16. Reject unauthorized approval
  it('16. should reject approval by non-manager', async () => {
    await expect(
      service.approveReport(1, mockUserExecutive),
    ).rejects.toThrow(ForbiddenException);
  });

  // 17. Reopen approved report
  it('17. should reopen an approved report back to draft', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue({ ...mockReport, status: 'approved' });
    prisma.sEOReport.update.mockResolvedValue({ ...mockReport, status: 'draft', pdf_file_path: null });

    const res = await service.reopenReport(1, mockUserAdmin);
    expect(res.status).toBe('draft');
  });

  // 18. Reopen invalidates PDF metadata
  it('18. should reset pdf metadata when reopening a report', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue({ ...mockReport, status: 'published', pdf_file_path: 'media/test.pdf' });
    prisma.sEOReport.update.mockResolvedValue({ ...mockReport, status: 'draft', pdf_file_path: null });

    await service.reopenReport(1, mockUserAdmin);
    expect(prisma.sEOReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'draft',
          pdf_file_path: null,
          pdf_filename: null,
          pdf_file_size: 0,
          pdf_generated_at: null,
        }),
      }),
    );
  });

  // 19. Reject invalid status transition
  it('19. should reject publishing an unapproved draft report', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue(mockReport); // status is 'draft'

    await expect(
      service.publishReport(1, mockUserAdmin),
    ).rejects.toThrow(BadRequestException);
  });

  // 20. Client cannot view unpublished report
  it('20. should forbid client from viewing an unpublished report', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue(mockReport); // status is 'draft'
    prisma.client.findFirst.mockResolvedValue(mockClient);

    await expect(
      service.findOne(1, mockUserClient),
    ).rejects.toThrow(ForbiddenException);
  });

  // 21. Client can view published report belonging to client
  it('21. should allow client to view published report belonging to client', async () => {
    const publishedReport = { ...mockReport, status: 'published' };
    prisma.sEOReport.findUnique.mockResolvedValue(publishedReport);
    prisma.client.findFirst.mockResolvedValue(mockClient);

    const res = await service.findOne(1, mockUserClient);
    expect(res.id).toBe(1);
  });

  // 22. Client cannot view another client's report
  it('22. should forbid client from viewing report of another client', async () => {
    const publishedOtherReport = { ...mockReport, status: 'published', client_id: 99 };
    prisma.sEOReport.findUnique.mockResolvedValue(publishedOtherReport);
    prisma.client.findFirst.mockResolvedValue(mockClient); // user client_id is 10

    await expect(
      service.findOne(1, mockUserClient),
    ).rejects.toThrow(ForbiddenException);
  });

  // 23. Evidence upload authorization
  it('23. should allow uploading evidence file to a draft report', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue(mockReport);
    prisma.sEOReportFile.create.mockResolvedValue({ id: 1, section_name: 'keywords', file_path: 'media/test.png' });

    const fileRecord = await service.uploadEvidenceFile(
      1,
      mockUserAdmin,
      { section_name: 'keywords', file_path: 'media/test.png', original_filename: 'test.png' },
    );
    expect(fileRecord.section_name).toBe('keywords');
  });

  // 24. Evidence deletion authorization
  it('24. should delete evidence file from a draft report', async () => {
    prisma.sEOReportFile.findUnique.mockResolvedValue({ id: 1, report: mockReport });
    prisma.sEOReportFile.delete.mockResolvedValue({});

    const res = await service.removeEvidenceFile(1, mockUserAdmin);
    expect(res).toBeNull();
  });

  // 25. Report detail includes child data
  it('25. should format and return report detail with child arrays', async () => {
    const reportWithChildren = {
      ...mockReport,
      keywords: [{ id: 1, keyword: 'car battery' }],
      top_queries: [{ id: 1, query_text: 'battery seller' }],
      traffic_sources: [{ id: 1, channel_group: 'Organic Search' }],
      activity_summaries: [{ id: 1, activity_name: 'Directory Submissions' }],
      evidence_files: [{ id: 1, section_name: 'gsc' }],
    };
    prisma.sEOReport.findUnique.mockResolvedValue(reportWithChildren);

    const detail = await service.findOne(1, mockUserAdmin);
    expect(detail.keywords.length).toBe(1);
    expect(detail.top_queries.length).toBe(1);
    expect(detail.traffic_sources.length).toBe(1);
    expect(detail.activity_summaries.length).toBe(1);
    expect(detail.evidence_files.length).toBe(1);
  });

  // 26. Generate PDF for approved report
  it('26. should generate PDF for an approved report and update status to generated', async () => {
    const approvedReport = { ...mockReport, status: 'approved' };
    const generatedReport = { ...approvedReport, status: 'generated', pdf_filename: 'seo_report_2026-08_Al_Bayan.pdf' };
    
    prisma.sEOReport.findUnique.mockResolvedValue(approvedReport);
    prisma.sEOReport.update.mockResolvedValue(generatedReport);

    const result = await service.generatePdf(1, mockUserAdmin);

    expect(pdfService.generateSeoReportPdf).toHaveBeenCalled();
    expect(prisma.sEOReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          status: 'generated',
          pdf_filename: 'seo_report_2026-08_Al_Bayan.pdf',
        }),
      }),
    );
    expect(result.status).toBe('generated');
  });

  // 27. Reject PDF generation for draft report
  it('27. should reject PDF generation if report is in draft status', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue({ ...mockReport, status: 'draft' });

    await expect(
      service.generatePdf(1, mockUserAdmin),
    ).rejects.toThrow(BadRequestException);
  });

  // 28. Client download PDF restriction
  it('28. should forbid client from downloading PDF if report is not published', async () => {
    prisma.sEOReport.findUnique.mockResolvedValue({ ...mockReport, status: 'generated', pdf_file_path: 'media/seo_reports/pdfs/test.pdf' });

    await expect(
      service.getReportPdf(1, mockUserClient),
    ).rejects.toThrow(ForbiddenException);
  });

  // 29. Client download PDF belonging client success
  it('29. should return PDF metadata for published report belonging to client', async () => {
    const publishedPdfReport = {
      ...mockReport,
      status: 'published',
      pdf_file_path: 'media/test.pdf',
      pdf_filename: 'seo_report_2026-08_Al_Bayan.pdf',
      pdf_file_size: 1024,
    };
    prisma.sEOReport.findUnique.mockResolvedValue(publishedPdfReport);
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);

    const pdfInfo = await service.getReportPdf(1, mockUserClient);

    expect(pdfInfo.filename).toBe('seo_report_2026-08_Al_Bayan.pdf');
    expect(pdfInfo.fileSize).toBe(1024);
  });
});
