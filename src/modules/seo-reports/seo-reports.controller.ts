import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SeoReportsService } from './seo-reports.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
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

@Controller('api/v1/seo-reports')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SeoReportsController {
  constructor(private readonly seoReportsService: SeoReportsService) {}

  // -------------------------------------------------------------
  // REPORT CRUD
  // -------------------------------------------------------------
  @Get()
  @Permissions('VIEW_SEO_REPORTS')
  async findAll(@CurrentUser() user: any, @Query() query: any) {
    return this.seoReportsService.findAll(user, query);
  }

  @Get(':id')
  @Permissions('VIEW_SEO_REPORTS')
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.seoReportsService.findOne(id, user);
  }

  @Post()
  @Permissions('MANAGE_SEO_REPORTS')
  async create(@CurrentUser() user: any, @Body() body: CreateSeoReportDto) {
    return this.seoReportsService.create(user, body);
  }

  @Patch(':id')
  @Permissions('MANAGE_SEO_REPORTS')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: UpdateSeoReportDto,
  ) {
    return this.seoReportsService.update(id, user, body);
  }

  @Delete(':id')
  @Permissions('MANAGE_SEO_REPORTS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.seoReportsService.remove(id, user);
  }

  // -------------------------------------------------------------
  // DEDICATED WORKFLOW ENDPOINTS
  // -------------------------------------------------------------
  @Post(':id/submit')
  @Permissions('MANAGE_SEO_REPORTS')
  async submitForReview(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.seoReportsService.submitForReview(id, user);
  }

  @Post(':id/approve')
  @Permissions('MANAGE_SEO_REPORTS')
  async approveReport(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.seoReportsService.approveReport(id, user);
  }

  @Post(':id/reopen')
  @Permissions('MANAGE_SEO_REPORTS')
  async reopenReport(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.seoReportsService.reopenReport(id, user);
  }

  @Post(':id/publish')
  @Permissions('PUBLISH_SEO_REPORTS')
  async publishReport(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.seoReportsService.publishReport(id, user);
  }

  @Post(':id/generate-pdf')
  @Permissions('MANAGE_SEO_REPORTS')
  async generatePdf(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.seoReportsService.generatePdf(id, user);
  }

  @Get(':id/pdf')
  @Permissions('VIEW_SEO_REPORTS')
  async downloadPdf(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Res() res: any,
  ) {
    const pdfData = await this.seoReportsService.getReportPdf(id, user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${pdfData.filename}"`);
    res.setHeader('Content-Length', pdfData.fileSize);
    return res.sendFile(pdfData.filePath);
  }

  // -------------------------------------------------------------
  // CHILD DATA: KEYWORDS
  // -------------------------------------------------------------
  @Post(':reportId/keywords')
  @Permissions('MANAGE_SEO_REPORTS')
  async addKeyword(
    @Param('reportId', ParseIntPipe) reportId: number,
    @CurrentUser() user: any,
    @Body() body: CreateSeoReportKeywordDto,
  ) {
    return this.seoReportsService.addKeyword(reportId, user, body);
  }

  @Patch('keywords/:id')
  @Permissions('MANAGE_SEO_REPORTS')
  async updateKeyword(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: UpdateSeoReportKeywordDto,
  ) {
    return this.seoReportsService.updateKeyword(id, user, body);
  }

  @Delete('keywords/:id')
  @Permissions('MANAGE_SEO_REPORTS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeKeyword(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.seoReportsService.removeKeyword(id, user);
  }

  // -------------------------------------------------------------
  // CHILD DATA: TOP QUERIES
  // -------------------------------------------------------------
  @Post(':reportId/top-queries')
  @Permissions('MANAGE_SEO_REPORTS')
  async addTopQuery(
    @Param('reportId', ParseIntPipe) reportId: number,
    @CurrentUser() user: any,
    @Body() body: CreateSeoReportTopQueryDto,
  ) {
    return this.seoReportsService.addTopQuery(reportId, user, body);
  }

  @Patch('top-queries/:id')
  @Permissions('MANAGE_SEO_REPORTS')
  async updateTopQuery(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: UpdateSeoReportTopQueryDto,
  ) {
    return this.seoReportsService.updateTopQuery(id, user, body);
  }

  @Delete('top-queries/:id')
  @Permissions('MANAGE_SEO_REPORTS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeTopQuery(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.seoReportsService.removeTopQuery(id, user);
  }

  // -------------------------------------------------------------
  // CHILD DATA: TRAFFIC SOURCES
  // -------------------------------------------------------------
  @Post(':reportId/traffic-sources')
  @Permissions('MANAGE_SEO_REPORTS')
  async addTrafficSource(
    @Param('reportId', ParseIntPipe) reportId: number,
    @CurrentUser() user: any,
    @Body() body: CreateSeoReportTrafficSourceDto,
  ) {
    return this.seoReportsService.addTrafficSource(reportId, user, body);
  }

  @Patch('traffic-sources/:id')
  @Permissions('MANAGE_SEO_REPORTS')
  async updateTrafficSource(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: UpdateSeoReportTrafficSourceDto,
  ) {
    return this.seoReportsService.updateTrafficSource(id, user, body);
  }

  @Delete('traffic-sources/:id')
  @Permissions('MANAGE_SEO_REPORTS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeTrafficSource(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.seoReportsService.removeTrafficSource(id, user);
  }

  // -------------------------------------------------------------
  // CHILD DATA: ACTIVITY SUMMARIES
  // -------------------------------------------------------------
  @Post(':reportId/activity-summaries')
  @Permissions('MANAGE_SEO_REPORTS')
  async addActivitySummary(
    @Param('reportId', ParseIntPipe) reportId: number,
    @CurrentUser() user: any,
    @Body() body: CreateSeoReportActivitySummaryDto,
  ) {
    return this.seoReportsService.addActivitySummary(reportId, user, body);
  }

  @Patch('activity-summaries/:id')
  @Permissions('MANAGE_SEO_REPORTS')
  async updateActivitySummary(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: UpdateSeoReportActivitySummaryDto,
  ) {
    return this.seoReportsService.updateActivitySummary(id, user, body);
  }

  @Delete('activity-summaries/:id')
  @Permissions('MANAGE_SEO_REPORTS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeActivitySummary(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.seoReportsService.removeActivitySummary(id, user);
  }

  // -------------------------------------------------------------
  // EVIDENCE FILES
  // -------------------------------------------------------------
  @Post(':reportId/files')
  @Permissions('MANAGE_SEO_REPORTS')
  @UseInterceptors(FileInterceptor('file'))
  async uploadEvidenceFile(
    @Param('reportId', ParseIntPipe) reportId: number,
    @CurrentUser() user: any,
    @Body() body: any,
    @UploadedFile() file?: any,
  ) {
    return this.seoReportsService.uploadEvidenceFile(reportId, user, body, file);
  }

  @Get(':reportId/files')
  @Permissions('VIEW_SEO_REPORTS')
  async getEvidenceFiles(
    @Param('reportId', ParseIntPipe) reportId: number,
    @CurrentUser() user: any,
  ) {
    return this.seoReportsService.getEvidenceFiles(reportId, user);
  }

  @Delete('files/:id')
  @Permissions('MANAGE_SEO_REPORTS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeEvidenceFile(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.seoReportsService.removeEvidenceFile(id, user);
  }
}
