import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
  Req,
  Res,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { Public } from '../../core/decorators/public.decorator';
import { HrService } from './hr.service';

// -------------------------------------------------------------
// 1. EMPLOYEES CONTROLLER (/api/v1/employees/)
// -------------------------------------------------------------
@Controller('api/v1/employees')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions('GENERATE_HR_DOCS')
export class EmployeesController {
  constructor(private readonly hrService: HrService) {}

  @Get()
  async findAll() {
    return this.hrService.getEmployees();
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.hrService.getEmployeeById(id);
  }

  @Post()
  async create(@Body() body: any) {
    return this.hrService.createEmployee(body);
  }

  @Put(':id')
  async updatePut(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.hrService.updateEmployee(id, body);
  }

  @Patch(':id')
  async updatePatch(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.hrService.updateEmployee(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.hrService.deleteEmployee(id);
  }
}

// -------------------------------------------------------------
// 2. HR DOCUMENTS CONTROLLER (/api/v1/hr-documents/)
// -------------------------------------------------------------
@Controller('api/v1/hr-documents')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions('GENERATE_HR_DOCS')
export class HrDocumentsController {
  constructor(private readonly hrService: HrService) {}

  @Get()
  async findAll() {
    return this.hrService.getHrDocuments();
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.hrService.getHrDocumentById(id);
  }

  @Post()
  async create(@Request() req: any, @Body() body: any) {
    return this.hrService.createHrDocument(req.user, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.hrService.deleteHrDocument(id);
  }

  // ---------------- GENERATION ENDPOINTS ----------------

  @Public()
  @Get([
    'public/offer-letter/:token',
    'public/offer-letter/:token/',
    'public/offer-letter/:token/download',
    'public/offer-letter/:token/download/',
  ])
  async downloadPublicOfferLetter(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    const { pdfBuffer, filename } = await this.hrService.generateOfferLetterPdfFromPublicToken(token);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  }

  @Post('offer-letter')
  @HttpCode(200)
  async generateOfferLetter(@Body() body: any, @Res() res: Response) {
    const pdfBuffer = await this.hrService.generateOfferLetterPdf(body);
    res.status(200).set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="offer_letter.pdf"',
    });
    res.send(pdfBuffer);
  }

  @Post(['offer-letter/secure-link', 'offer-letter/secure-link/'])
  @HttpCode(200)
  async generateOfferLetterSecureLink(@Body() body: any, @Req() req: any) {
    return this.hrService.generateOfferLetterSecureLink(body, req);
  }

  @Post(['offer-letter/send-email', 'offer-letter/send-email/'])
  @HttpCode(200)
  async sendOfferLetterEmail(@Body() body: any) {
    return this.hrService.sendOfferLetterEmail(body);
  }

  @Post('appraisal-letter')
  @HttpCode(200)
  async generateAppraisalLetter(@Body() body: any, @Res() res: Response) {
    const pdfBuffer = await this.hrService.generateAppraisalLetterPdf(body);
    res.status(200).set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="appraisal_letter.pdf"',
    });
    res.send(pdfBuffer);
  }

  @Post('experience-certificate')
  @HttpCode(200)
  async generateExperienceCertificate(@Body() body: any, @Res() res: Response) {
    const pdfBuffer = await this.hrService.generateExperienceCertificatePdf(body);
    res.status(200).set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="experience_certificate.pdf"',
    });
    res.send(pdfBuffer);
  }

  @Post('salary-certificate')
  @HttpCode(200)
  async generateSalaryCertificate(@Body() body: any, @Res() res: Response) {
    const pdfBuffer = await this.hrService.generateSalaryCertificatePdf(body);
    res.status(200).set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="salary_certificate.pdf"',
    });
    res.send(pdfBuffer);
  }

  @Post('internship-certificate')
  @HttpCode(200)
  async generateInternshipCertificate(@Body() body: any, @Res() res: Response) {
    const pdfBuffer = await this.hrService.generateInternshipCertificatePdf(body);
    res.status(200).set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="internship_certificate.pdf"',
    });
    res.send(pdfBuffer);
  }
}
