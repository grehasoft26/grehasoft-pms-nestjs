import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { CreateSeoReportDto } from './dto/create-seo-report.dto';
import { UpdateSeoReportDto } from './dto/update-seo-report.dto';
import {
  CreateSeoReportKeywordDto,
  UpdateSeoReportKeywordDto,
  CreateSeoReportTopQueryDto,
  UpdateSeoReportTopQueryDto,
  CreateSeoReportTrafficSourceDto,
  UpdateSeoReportTrafficSourceDto,
  CreateSeoReportActivitySummaryDto,
  UpdateSeoReportActivitySummaryDto,
} from './dto/child-seo-report.dto';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class SeoReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
  ) {}


  // -------------------------------------------------------------
  // HELPER: ROLE CHECKS
  // -------------------------------------------------------------
  private isPrivileged(user: any): boolean {
    const role = user?.role?.name || user?.role_name;
    return user?.is_superuser || role === 'SUPER_ADMIN' || role === 'SEO_MANAGER' || role === 'ADMIN';
  }

  private isClient(user: any): boolean {
    const role = user?.role?.name || user?.role_name;
    return role === 'CLIENT';
  }

  private isExecutive(user: any): boolean {
    const role = user?.role?.name || user?.role_name;
    return role === 'SEO_EXECUTIVE';
  }

  // -------------------------------------------------------------
  // HELPER: RESPONSE FORMATTER
  // -------------------------------------------------------------
  public formatReport(report: any) {
    if (!report) return null;
    const client = report.client;
    const web = report.website;
    const creator = report.created_by;
    const approver = report.approved_by;

    return {
      ...report,
      client_name: client ? client.name || client.company_name : '',
      company_name: client ? client.company_name || client.name : '',
      website_name: web ? web.website_name : '',
      domain_url: web ? web.domain_url : '',
      created_by_name: creator ? (creator.name || creator.username) : '',
      approved_by_name: approver ? (approver.name || approver.username) : '',
    };
  }

  // -------------------------------------------------------------
  // 1. CREATE REPORT (100% MANUAL BUILDER)
  // -------------------------------------------------------------
  async create(user: any, dto: CreateSeoReportDto) {
    if (this.isClient(user)) {
      throw new ForbiddenException('Clients do not have permission to create SEO reports.');
    }

    const clientId = Number(dto.client_id);
    const websiteId = Number(dto.website_id);

    // 1. Verify client exists
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      throw new NotFoundException(`Client with ID ${clientId} not found.`);
    }

    // 2. Verify website exists
    const website = await this.prisma.sEOWebsite.findUnique({ where: { id: websiteId } });
    if (!website) {
      throw new NotFoundException(`Website with ID ${websiteId} not found.`);
    }

    // 3. Verify website belongs to client
    if (website.client_id !== clientId) {
      throw new BadRequestException('Selected website does not belong to the selected client.');
    }

    // 4. Validate report month format (YYYY-MM)
    if (!dto.report_month || !/^\d{4}-\d{2}$/.test(dto.report_month)) {
      throw new BadRequestException('Invalid report_month format. Must be YYYY-MM (e.g. 2026-08).');
    }

    // 5. Check duplicate report for website + month
    const existing = await this.prisma.sEOReport.findFirst({
      where: { website_id: websiteId, report_month: dto.report_month },
    });
    if (existing) {
      throw new ConflictException(`An SEO report for website "${website.website_name}" and month ${dto.report_month} already exists.`);
    }

    // 6. Validate dates
    const startDate = new Date(dto.period_start_date);
    const endDate = new Date(dto.period_end_date);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new BadRequestException('Invalid start or end date format.');
    }
    if (startDate > endDate) {
      throw new BadRequestException('Period start date must be before or equal to period end date.');
    }

    // Create report snapshot
    const created = await this.prisma.sEOReport.create({
      data: {
        client_id: clientId,
        website_id: websiteId,
        report_title: dto.report_title || `${website.website_name} — ${dto.report_month} SEO Report`,
        report_month: dto.report_month,
        period_start_date: startDate,
        period_end_date: endDate,
        status: 'draft',
        data_source: 'manual',
        created_by_id: user.id,

        executive_summary: dto.executive_summary || null,
        key_achievements: dto.key_achievements || [],
        challenges_notes: dto.challenges_notes || null,
        recommendations: dto.recommendations || [],
        next_month_plan: dto.next_month_plan || [],

        domain_authority: Number(dto.domain_authority || 0),
        previous_da: Number(dto.previous_da || 0),
        page_authority: Number(dto.page_authority || 0),
        spam_score: Number(dto.spam_score || 0),
        health_score: Number(dto.health_score || 100),
        total_indexed_pages: Number(dto.total_indexed_pages || 0),
        total_backlinks: Number(dto.total_backlinks || 0),

        gsc_clicks: Number(dto.gsc_clicks || 0),
        gsc_prev_clicks: Number(dto.gsc_prev_clicks || 0),
        gsc_impressions: Number(dto.gsc_impressions || 0),
        gsc_prev_impressions: Number(dto.gsc_prev_impressions || 0),
        gsc_avg_ctr: Number(dto.gsc_avg_ctr || 0.0),
        gsc_prev_avg_ctr: Number(dto.gsc_prev_avg_ctr || 0.0),
        gsc_avg_position: Number(dto.gsc_avg_position || 0.0),
        gsc_prev_avg_position: Number(dto.gsc_prev_avg_position || 0.0),

        ga4_organic_users: Number(dto.ga4_organic_users || 0),
        ga4_prev_users: Number(dto.ga4_prev_users || 0),
        ga4_new_users: Number(dto.ga4_new_users || 0),
        ga4_sessions: Number(dto.ga4_sessions || 0),
        ga4_prev_sessions: Number(dto.ga4_prev_sessions || 0),
        ga4_engagement_rate: Number(dto.ga4_engagement_rate || 0.0),
        ga4_avg_session_duration: dto.ga4_avg_session_duration || null,

        gbp_profile_views: Number(dto.gbp_profile_views || 0),
        gbp_prev_views: Number(dto.gbp_prev_views || 0),
        gbp_interactions: Number(dto.gbp_interactions || 0),
        gbp_phone_calls: Number(dto.gbp_phone_calls || 0),
        gbp_direction_requests: Number(dto.gbp_direction_requests || 0),
        gbp_website_clicks: Number(dto.gbp_website_clicks || 0),

        manually_edited: true,
      },
      include: {
        client: true,
        website: true,
        created_by: true,
        approved_by: true,
        keywords: true,
        top_queries: true,
        traffic_sources: true,
        activity_summaries: true,
        evidence_files: true,
      },
    });

    return this.formatReport(created);
  }

  // -------------------------------------------------------------
  // 2. FIND ALL REPORTS (WITH FILTERS & CLIENT ISOLATION)
  // -------------------------------------------------------------
  async findAll(user: any, query: any = {}) {
    const where: any = {};

    if (this.isClient(user)) {
      // Find client record belonging to user
      const client = await this.prisma.client.findFirst({
        where: {
          OR: [
            { portal_users: { some: { id: user.id } } },
            { email: user.email },
            { id: user.client_id || 0 },
          ],
        },
      });
      if (!client) return { count: 0, results: [] };
      where.client_id = client.id;
      where.status = 'published'; // CLIENT users only see published reports
    }

    if (query.client_id || query.client) where.client_id = Number(query.client_id || query.client);
    if (query.website_id || query.website) where.website_id = Number(query.website_id || query.website);
    if (query.report_month) where.report_month = query.report_month;
    if (query.status && !this.isClient(user)) where.status = query.status;

    if (query.search) {
      where.OR = [
        { report_title: { contains: query.search } },
        { website: { website_name: { contains: query.search } } },
        { client: { name: { contains: query.search } } },
      ];
    }

    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.max(1, Number(query.limit || query.page_size || 10));
    const skip = (page - 1) * limit;

    const [total, reports] = await Promise.all([
      this.prisma.sEOReport.count({ where }),
      this.prisma.sEOReport.findMany({
        where,
        include: {
          client: true,
          website: true,
          created_by: true,
          approved_by: true,
          keywords: true,
          top_queries: true,
          traffic_sources: true,
          activity_summaries: true,
          evidence_files: true,
        },
        orderBy: [{ report_month: 'desc' }, { created_at: 'desc' }],
        skip,
        take: limit,
      }),
    ]);

    return {
      count: total,
      page,
      limit,
      results: reports.map((r) => this.formatReport(r)),
    };
  }

  // -------------------------------------------------------------
  // 3. FIND ONE REPORT DETAIL
  // -------------------------------------------------------------
  async findOne(id: number, user: any) {
    const report = await this.prisma.sEOReport.findUnique({
      where: { id },
      include: {
        client: true,
        website: true,
        created_by: true,
        approved_by: true,
        keywords: true,
        top_queries: true,
        traffic_sources: true,
        activity_summaries: true,
        evidence_files: true,
      },
    });

    if (!report) throw new NotFoundException(`SEO Report #${id} not found.`);

    if (this.isClient(user)) {
      const client = await this.prisma.client.findFirst({
        where: {
          OR: [
            { portal_users: { some: { id: user.id } } },
            { email: user.email },
            { id: user.client_id || 0 },
          ],
        },
      });
      if (!client || report.client_id !== client.id || report.status !== 'published') {
        throw new ForbiddenException('You do not have access to view this report.');
      }
    }

    return this.formatReport(report);
  }

  // -------------------------------------------------------------
  // 4. UPDATE DRAFT/UNDER_REVIEW REPORT
  // -------------------------------------------------------------
  async update(id: number, user: any, dto: UpdateSeoReportDto) {
    if (this.isClient(user)) {
      throw new ForbiddenException('Clients do not have permission to update SEO reports.');
    }

    const report = await this.prisma.sEOReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException(`SEO Report #${id} not found.`);

    if (['approved', 'generated', 'published'].includes(report.status)) {
      throw new ForbiddenException('Report is locked. Only Draft or Under Review reports can be edited. Reopen the report to make changes.');
    }

    const updatePayload: any = { manually_edited: true };
    if (dto.report_title !== undefined) updatePayload.report_title = dto.report_title;
    if (dto.report_month !== undefined) updatePayload.report_month = dto.report_month;
    if (dto.period_start_date !== undefined) updatePayload.period_start_date = new Date(dto.period_start_date);
    if (dto.period_end_date !== undefined) updatePayload.period_end_date = new Date(dto.period_end_date);

    if (dto.executive_summary !== undefined) updatePayload.executive_summary = dto.executive_summary;
    if (dto.key_achievements !== undefined) updatePayload.key_achievements = dto.key_achievements;
    if (dto.challenges_notes !== undefined) updatePayload.challenges_notes = dto.challenges_notes;
    if (dto.recommendations !== undefined) updatePayload.recommendations = dto.recommendations;
    if (dto.next_month_plan !== undefined) updatePayload.next_month_plan = dto.next_month_plan;

    if (dto.domain_authority !== undefined) updatePayload.domain_authority = Number(dto.domain_authority);
    if (dto.previous_da !== undefined) updatePayload.previous_da = Number(dto.previous_da);
    if (dto.page_authority !== undefined) updatePayload.page_authority = Number(dto.page_authority);
    if (dto.spam_score !== undefined) updatePayload.spam_score = Number(dto.spam_score);
    if (dto.health_score !== undefined) updatePayload.health_score = Number(dto.health_score);
    if (dto.total_indexed_pages !== undefined) updatePayload.total_indexed_pages = Number(dto.total_indexed_pages);
    if (dto.total_backlinks !== undefined) updatePayload.total_backlinks = Number(dto.total_backlinks);

    if (dto.gsc_clicks !== undefined) updatePayload.gsc_clicks = Number(dto.gsc_clicks);
    if (dto.gsc_prev_clicks !== undefined) updatePayload.gsc_prev_clicks = Number(dto.gsc_prev_clicks);
    if (dto.gsc_impressions !== undefined) updatePayload.gsc_impressions = Number(dto.gsc_impressions);
    if (dto.gsc_prev_impressions !== undefined) updatePayload.gsc_prev_impressions = Number(dto.gsc_prev_impressions);
    if (dto.gsc_avg_ctr !== undefined) updatePayload.gsc_avg_ctr = Number(dto.gsc_avg_ctr);
    if (dto.gsc_prev_avg_ctr !== undefined) updatePayload.gsc_prev_avg_ctr = Number(dto.gsc_prev_avg_ctr);
    if (dto.gsc_avg_position !== undefined) updatePayload.gsc_avg_position = Number(dto.gsc_avg_position);
    if (dto.gsc_prev_avg_position !== undefined) updatePayload.gsc_prev_avg_position = Number(dto.gsc_prev_avg_position);

    if (dto.ga4_organic_users !== undefined) updatePayload.ga4_organic_users = Number(dto.ga4_organic_users);
    if (dto.ga4_prev_users !== undefined) updatePayload.ga4_prev_users = Number(dto.ga4_prev_users);
    if (dto.ga4_new_users !== undefined) updatePayload.ga4_new_users = Number(dto.ga4_new_users);
    if (dto.ga4_sessions !== undefined) updatePayload.ga4_sessions = Number(dto.ga4_sessions);
    if (dto.ga4_prev_sessions !== undefined) updatePayload.ga4_prev_sessions = Number(dto.ga4_prev_sessions);
    if (dto.ga4_engagement_rate !== undefined) updatePayload.ga4_engagement_rate = Number(dto.ga4_engagement_rate);
    if (dto.ga4_avg_session_duration !== undefined) updatePayload.ga4_avg_session_duration = dto.ga4_avg_session_duration;

    if (dto.gbp_profile_views !== undefined) updatePayload.gbp_profile_views = Number(dto.gbp_profile_views);
    if (dto.gbp_prev_views !== undefined) updatePayload.gbp_prev_views = Number(dto.gbp_prev_views);
    if (dto.gbp_interactions !== undefined) updatePayload.gbp_interactions = Number(dto.gbp_interactions);
    if (dto.gbp_phone_calls !== undefined) updatePayload.gbp_phone_calls = Number(dto.gbp_phone_calls);
    if (dto.gbp_direction_requests !== undefined) updatePayload.gbp_direction_requests = Number(dto.gbp_direction_requests);
    if (dto.gbp_website_clicks !== undefined) updatePayload.gbp_website_clicks = Number(dto.gbp_website_clicks);

    const updated = await this.prisma.sEOReport.update({
      where: { id },
      data: updatePayload,
      include: {
        client: true,
        website: true,
        created_by: true,
        approved_by: true,
        keywords: true,
        top_queries: true,
        traffic_sources: true,
        activity_summaries: true,
        evidence_files: true,
      },
    });

    return this.formatReport(updated);
  }

  // -------------------------------------------------------------
  // 5. DELETE DRAFT REPORT
  // -------------------------------------------------------------
  async remove(id: number, user: any) {
    if (this.isClient(user)) {
      throw new ForbiddenException('Clients do not have permission to delete SEO reports.');
    }

    const report = await this.prisma.sEOReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException(`SEO Report #${id} not found.`);

    if (report.status !== 'draft') {
      throw new ForbiddenException('Only Draft reports can be deleted. Approved or Published reports cannot be deleted.');
    }

    await this.prisma.sEOReport.delete({ where: { id } });
    return null;
  }

  // -------------------------------------------------------------
  // 6. WORKFLOW ENDPOINTS (Submit, Approve, Reopen, Publish)
  // -------------------------------------------------------------
  async submitForReview(id: number, user: any) {
    if (this.isClient(user)) {
      throw new ForbiddenException('Clients do not have permission to submit SEO reports.');
    }
    const report = await this.prisma.sEOReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException(`SEO Report #${id} not found.`);

    if (report.status !== 'draft') {
      throw new BadRequestException(`Report #${id} is currently in '${report.status}' status and cannot be submitted.`);
    }

    const updated = await this.prisma.sEOReport.update({
      where: { id },
      data: { status: 'under_review' },
    });
    return { status: updated.status, message: 'Report submitted for manager review.' };
  }

  async approveReport(id: number, user: any) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can approve reports.');
    }

    const report = await this.prisma.sEOReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException(`SEO Report #${id} not found.`);

    if (['approved', 'generated', 'published'].includes(report.status)) {
      throw new BadRequestException(`Report #${id} is already approved or published.`);
    }

    const updated = await this.prisma.sEOReport.update({
      where: { id },
      data: {
        status: 'approved',
        approved_by_id: user.id,
        approved_at: new Date(),
      },
    });

    return { status: updated.status, message: 'Report successfully approved and locked.' };
  }

  async reopenReport(id: number, user: any) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can reopen reports for revision.');
    }

    const report = await this.prisma.sEOReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException(`SEO Report #${id} not found.`);

    const updated = await this.prisma.sEOReport.update({
      where: { id },
      data: {
        status: 'draft',
        pdf_file_path: null,
        pdf_filename: null,
        pdf_file_size: 0,
        pdf_generated_at: null,
      },
    });

    return { status: updated.status, message: 'Report reopened for revision. Form unlocked.' };
  }

  async publishReport(id: number, user: any) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can publish reports.');
    }

    const report = await this.prisma.sEOReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException(`SEO Report #${id} not found.`);

    if (!['approved', 'generated'].includes(report.status)) {
      throw new BadRequestException('Only Approved or Generated reports can be published to the Client Portal.');
    }

    const updated = await this.prisma.sEOReport.update({
      where: { id },
      data: {
        status: 'published',
        published_at: new Date(),
      },
    });

    return { status: updated.status, message: 'Report successfully published to Client Portal.' };
  }

  // -------------------------------------------------------------
  // PDF GENERATION & DOWNLOAD
  // -------------------------------------------------------------
  async markGenerated(
    id: number,
    pdfData: {
      pdf_file_path: string;
      pdf_filename: string;
      pdf_file_size: number;
      pdf_generated_at?: Date;
    },
  ) {
    const report = await this.prisma.sEOReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException(`SEO Report #${id} not found.`);

    return this.prisma.sEOReport.update({
      where: { id },
      data: {
        status: 'generated',
        pdf_file_path: pdfData.pdf_file_path,
        pdf_filename: pdfData.pdf_filename,
        pdf_file_size: pdfData.pdf_file_size,
        pdf_generated_at: pdfData.pdf_generated_at || new Date(),
      },
    });
  }

  async generatePdf(id: number, user: any) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can generate report PDFs.');
    }

    const report = await this.prisma.sEOReport.findUnique({
      where: { id },
      include: {
        client: true,
        website: true,
        created_by: true,
        approved_by: true,
        keywords: { orderBy: { id: 'asc' } },
        top_queries: { orderBy: { clicks: 'desc' } },
        traffic_sources: { orderBy: { id: 'asc' } },
        activity_summaries: { orderBy: { id: 'asc' } },
        evidence_files: { orderBy: { display_order: 'asc' } },
      },
    });

    if (!report) throw new NotFoundException(`SEO Report #${id} not found.`);

    if (!['approved', 'generated'].includes(report.status)) {
      throw new BadRequestException(`Report #${id} must be approved before PDF generation (current status: '${report.status}').`);
    }

    const formattedPayload = this.formatReport(report);

    // Render PDF buffer using PdfService
    const pdfBuffer = await this.pdfService.generateSeoReportPdf(formattedPayload);

    // Build persistent file path
    const companyStr = formattedPayload.company_name || formattedPayload.client_name || 'Client';
    const sanitizedCompany = companyStr.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_');
    const monthStr = report.report_month || '2026-00';
    const sanitizedMonth = monthStr.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const pdfFilename = `seo_report_${sanitizedMonth}_${sanitizedCompany}.pdf`;

    const pdfDir = path.join(process.cwd(), 'media', 'seo_reports', 'pdfs');
    if (!fs.existsSync(pdfDir)) {
      fs.mkdirSync(pdfDir, { recursive: true });
    }

    const pdfPath = path.join(pdfDir, pdfFilename);
    fs.writeFileSync(pdfPath, pdfBuffer);

    const relativePath = path.relative(process.cwd(), pdfPath).replace(/\\/g, '/');

    // Update status to 'generated' and record PDF metadata
    const updated = await this.markGenerated(id, {
      pdf_file_path: relativePath,
      pdf_filename: pdfFilename,
      pdf_file_size: pdfBuffer.length,
      pdf_generated_at: new Date(),
    });

    return this.formatReport(updated);
  }

  async getReportPdf(id: number, user: any) {
    const report = await this.prisma.sEOReport.findUnique({
      where: { id },
      include: { client: true },
    });

    if (!report) throw new NotFoundException(`SEO Report #${id} not found.`);

    if (this.isClient(user)) {
      if (report.status !== 'published') {
        throw new ForbiddenException('Clients can only download published SEO reports.');
      }
      if (user.client_id && report.client_id !== user.client_id) {
        throw new ForbiddenException('You do not have permission to access this SEO report.');
      }
    } else if (!this.isPrivileged(user) && !this.isExecutive(user)) {
      throw new ForbiddenException('You do not have permission to access this SEO report.');
    }

    if (!report.pdf_file_path) {
      throw new NotFoundException(`PDF artifact has not been generated yet for report #${id}.`);
    }

    const absolutePath = path.resolve(process.cwd(), report.pdf_file_path);
    if (!fs.existsSync(absolutePath)) {
      throw new NotFoundException(`PDF file not found on server at ${report.pdf_file_path}.`);
    }

    return {
      filePath: absolutePath,
      filename: report.pdf_filename || `seo_report_${report.id}.pdf`,
      fileSize: report.pdf_file_size || fs.statSync(absolutePath).size,
    };
  }

  // -------------------------------------------------------------
  // 7. CHILD DATA APIs (Keywords, Top Queries, Traffic, Activities)
  // -------------------------------------------------------------


  // KEYWORDS
  async addKeyword(reportId: number, user: any, dto: CreateSeoReportKeywordDto) {
    const report = await this.prisma.sEOReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException(`Report #${reportId} not found.`);

    if (['approved', 'generated', 'published'].includes(report.status)) {
      throw new ForbiddenException('Report is locked. Cannot modify keywords.');
    }

    const initRank = Number(dto.initial_rank || 0);
    const currRank = Number(dto.current_rank || 0);
    const prevRank = Number(dto.previous_rank || 0);
    const change = prevRank > 0 && currRank > 0 ? prevRank - currRank : 0;

    return this.prisma.sEOReportKeyword.create({
      data: {
        report_id: reportId,
        keyword: dto.keyword,
        target_url: dto.target_url || null,
        search_engine: dto.search_engine || 'Google',
        initial_rank: initRank,
        previous_rank: prevRank,
        current_rank: currRank,
        target_rank: Number(dto.target_rank || 1),
        rank_change: dto.rank_change !== undefined ? Number(dto.rank_change) : change,
      },
    });
  }

  async updateKeyword(keywordId: number, user: any, dto: UpdateSeoReportKeywordDto) {
    const kw = await this.prisma.sEOReportKeyword.findUnique({
      where: { id: keywordId },
      include: { report: true },
    });
    if (!kw) throw new NotFoundException(`Keyword record #${keywordId} not found.`);

    if (['approved', 'generated', 'published'].includes(kw.report.status)) {
      throw new ForbiddenException('Report is locked. Cannot modify keywords.');
    }

    const prevRank = dto.previous_rank !== undefined ? Number(dto.previous_rank) : kw.previous_rank || 0;
    const currRank = dto.current_rank !== undefined ? Number(dto.current_rank) : kw.current_rank || 0;
    const change = dto.rank_change !== undefined ? Number(dto.rank_change) : (prevRank > 0 && currRank > 0 ? prevRank - currRank : 0);

    return this.prisma.sEOReportKeyword.update({
      where: { id: keywordId },
      data: {
        keyword: dto.keyword !== undefined ? dto.keyword : kw.keyword,
        target_url: dto.target_url !== undefined ? dto.target_url : kw.target_url,
        search_engine: dto.search_engine !== undefined ? dto.search_engine : kw.search_engine,
        initial_rank: dto.initial_rank !== undefined ? Number(dto.initial_rank) : kw.initial_rank,
        previous_rank: prevRank,
        current_rank: currRank,
        target_rank: dto.target_rank !== undefined ? Number(dto.target_rank) : kw.target_rank,
        rank_change: change,
      },
    });
  }

  async removeKeyword(keywordId: number, user: any) {
    const kw = await this.prisma.sEOReportKeyword.findUnique({
      where: { id: keywordId },
      include: { report: true },
    });
    if (!kw) throw new NotFoundException(`Keyword record #${keywordId} not found.`);

    if (['approved', 'generated', 'published'].includes(kw.report.status)) {
      throw new ForbiddenException('Report is locked. Cannot modify keywords.');
    }

    await this.prisma.sEOReportKeyword.delete({ where: { id: keywordId } });
    return null;
  }

  // TOP QUERIES
  async addTopQuery(reportId: number, user: any, dto: CreateSeoReportTopQueryDto) {
    const report = await this.prisma.sEOReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException(`Report #${reportId} not found.`);

    if (['approved', 'generated', 'published'].includes(report.status)) {
      throw new ForbiddenException('Report is locked. Cannot modify top queries.');
    }

    return this.prisma.sEOReportTopQuery.create({
      data: {
        report_id: reportId,
        query_text: dto.query_text,
        clicks: Number(dto.clicks || 0),
        impressions: Number(dto.impressions || 0),
        ctr: Number(dto.ctr || 0.0),
        average_position: Number(dto.average_position || 0.0),
      },
    });
  }

  async updateTopQuery(queryId: number, user: any, dto: UpdateSeoReportTopQueryDto) {
    const q = await this.prisma.sEOReportTopQuery.findUnique({
      where: { id: queryId },
      include: { report: true },
    });
    if (!q) throw new NotFoundException(`Top query #${queryId} not found.`);

    if (['approved', 'generated', 'published'].includes(q.report.status)) {
      throw new ForbiddenException('Report is locked. Cannot modify top queries.');
    }

    return this.prisma.sEOReportTopQuery.update({
      where: { id: queryId },
      data: {
        query_text: dto.query_text !== undefined ? dto.query_text : q.query_text,
        clicks: dto.clicks !== undefined ? Number(dto.clicks) : q.clicks,
        impressions: dto.impressions !== undefined ? Number(dto.impressions) : q.impressions,
        ctr: dto.ctr !== undefined ? Number(dto.ctr) : q.ctr,
        average_position: dto.average_position !== undefined ? Number(dto.average_position) : q.average_position,
      },
    });
  }

  async removeTopQuery(queryId: number, user: any) {
    const q = await this.prisma.sEOReportTopQuery.findUnique({
      where: { id: queryId },
      include: { report: true },
    });
    if (!q) throw new NotFoundException(`Top query #${queryId} not found.`);

    if (['approved', 'generated', 'published'].includes(q.report.status)) {
      throw new ForbiddenException('Report is locked. Cannot modify top queries.');
    }

    await this.prisma.sEOReportTopQuery.delete({ where: { id: queryId } });
    return null;
  }

  // TRAFFIC SOURCES
  async addTrafficSource(reportId: number, user: any, dto: CreateSeoReportTrafficSourceDto) {
    const report = await this.prisma.sEOReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException(`Report #${reportId} not found.`);

    if (['approved', 'generated', 'published'].includes(report.status)) {
      throw new ForbiddenException('Report is locked.');
    }

    return this.prisma.sEOReportTrafficSource.create({
      data: {
        report_id: reportId,
        channel_group: dto.channel_group,
        users_count: Number(dto.users_count || 0),
        percentage: Number(dto.percentage || 0.0),
      },
    });
  }

  async updateTrafficSource(sourceId: number, user: any, dto: UpdateSeoReportTrafficSourceDto) {
    const s = await this.prisma.sEOReportTrafficSource.findUnique({
      where: { id: sourceId },
      include: { report: true },
    });
    if (!s) throw new NotFoundException(`Traffic source #${sourceId} not found.`);

    if (['approved', 'generated', 'published'].includes(s.report.status)) {
      throw new ForbiddenException('Report is locked.');
    }

    return this.prisma.sEOReportTrafficSource.update({
      where: { id: sourceId },
      data: {
        channel_group: dto.channel_group !== undefined ? dto.channel_group : s.channel_group,
        users_count: dto.users_count !== undefined ? Number(dto.users_count) : s.users_count,
        percentage: dto.percentage !== undefined ? Number(dto.percentage) : s.percentage,
      },
    });
  }

  async removeTrafficSource(sourceId: number, user: any) {
    const s = await this.prisma.sEOReportTrafficSource.findUnique({
      where: { id: sourceId },
      include: { report: true },
    });
    if (!s) throw new NotFoundException(`Traffic source #${sourceId} not found.`);

    if (['approved', 'generated', 'published'].includes(s.report.status)) {
      throw new ForbiddenException('Report is locked.');
    }

    await this.prisma.sEOReportTrafficSource.delete({ where: { id: sourceId } });
    return null;
  }

  // ACTIVITY SUMMARIES
  async addActivitySummary(reportId: number, user: any, dto: CreateSeoReportActivitySummaryDto) {
    const report = await this.prisma.sEOReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException(`Report #${reportId} not found.`);

    if (['approved', 'generated', 'published'].includes(report.status)) {
      throw new ForbiddenException('Report is locked.');
    }

    return this.prisma.sEOReportActivitySummary.create({
      data: {
        report_id: reportId,
        activity_name: dto.activity_name,
        completed_count: Number(dto.completed_count || 0),
        notes: dto.notes || null,
      },
    });
  }

  async updateActivitySummary(summaryId: number, user: any, dto: UpdateSeoReportActivitySummaryDto) {
    const act = await this.prisma.sEOReportActivitySummary.findUnique({
      where: { id: summaryId },
      include: { report: true },
    });
    if (!act) throw new NotFoundException(`Activity summary #${summaryId} not found.`);

    if (['approved', 'generated', 'published'].includes(act.report.status)) {
      throw new ForbiddenException('Report is locked.');
    }

    return this.prisma.sEOReportActivitySummary.update({
      where: { id: summaryId },
      data: {
        activity_name: dto.activity_name !== undefined ? dto.activity_name : act.activity_name,
        completed_count: dto.completed_count !== undefined ? Number(dto.completed_count) : act.completed_count,
        notes: dto.notes !== undefined ? dto.notes : act.notes,
      },
    });
  }

  async removeActivitySummary(summaryId: number, user: any) {
    const act = await this.prisma.sEOReportActivitySummary.findUnique({
      where: { id: summaryId },
      include: { report: true },
    });
    if (!act) throw new NotFoundException(`Activity summary #${summaryId} not found.`);

    if (['approved', 'generated', 'published'].includes(act.report.status)) {
      throw new ForbiddenException('Report is locked.');
    }

    await this.prisma.sEOReportActivitySummary.delete({ where: { id: summaryId } });
    return null;
  }

  // -------------------------------------------------------------
  // 8. EVIDENCE FILES UPLOAD & MANAGE
  // -------------------------------------------------------------
  async uploadEvidenceFile(
    reportId: number,
    user: any,
    body: any,
    file?: any,
  ) {
    const report = await this.prisma.sEOReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException(`Report #${reportId} not found.`);

    if (['approved', 'generated', 'published'].includes(report.status)) {
      throw new ForbiddenException('Report is locked. Cannot upload evidence to an approved report.');
    }

    const sectionName = body.section_name || body.section || 'general';
    const caption = body.caption || null;
    const displayOrder = Number(body.display_order || 0);

    let filePath = body.file_path || body.file || '';
    let originalFilename = body.original_filename || 'evidence_screenshot.png';
    let mimeType = body.mime_type || 'image/png';
    let fileSize = Number(body.file_size || 0);

    if (file) {
      originalFilename = file.originalname || file.filename;
      mimeType = file.mimetype || 'image/png';
      fileSize = file.size || 0;

      // Save file to media/seo_reports/evidence/
      const targetDir = path.join(process.cwd(), 'media', 'seo_reports', 'evidence');
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const safeFilename = `ev_${Date.now()}_${Math.random().toString(36).substring(7)}_${originalFilename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const fullPath = path.join(targetDir, safeFilename);
      
      if (file.buffer) {
        fs.writeFileSync(fullPath, file.buffer);
      }
      filePath = `media/seo_reports/evidence/${safeFilename}`;
    }

    return this.prisma.sEOReportFile.create({
      data: {
        report_id: reportId,
        section_name: sectionName,
        file_path: filePath,
        original_filename: originalFilename,
        mime_type: mimeType,
        file_size: fileSize,
        caption,
        display_order: displayOrder,
        uploaded_by_id: user.id,
      },
    });
  }

  async getEvidenceFiles(reportId: number, user: any) {
    await this.findOne(reportId, user); // Validates access
    return this.prisma.sEOReportFile.findMany({
      where: { report_id: reportId },
      orderBy: [{ section_name: 'asc' }, { display_order: 'asc' }],
    });
  }

  async removeEvidenceFile(fileId: number, user: any) {
    const file = await this.prisma.sEOReportFile.findUnique({
      where: { id: fileId },
      include: { report: true },
    });
    if (!file) throw new NotFoundException(`Evidence file #${fileId} not found.`);

    if (['approved', 'generated', 'published'].includes(file.report.status)) {
      throw new ForbiddenException('Report is locked. Cannot delete evidence from an approved report.');
    }

    await this.prisma.sEOReportFile.delete({ where: { id: fileId } });
    return null;
  }
}
