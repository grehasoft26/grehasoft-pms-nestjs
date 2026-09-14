import { Controller, Get, Post, Put, Patch, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus, Res, Req } from '@nestjs/common';
import { Response } from 'express';
import { InvoicesService } from './invoices.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import { Public } from '../../core/decorators/public.decorator';

@Controller('api/v1/invoices')
@UseGuards(JwtAuthGuard)
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  async findAll(@CurrentUser() user: any, @Query() query: any) {
    return this.invoicesService.findAll(user, query);
  }

  @Get('next-number')
  async nextNumber() {
    const invoiceNumber = await this.invoicesService.getNextInvoiceNumber();
    return { invoice_number: invoiceNumber };
  }

  @Get('analytics')
  async getAnalytics(@CurrentUser() user: any) {
    return this.invoicesService.getAnalytics(user);
  }

  @Public()
  @Get(['public/:token/download', 'public/:token/download/'])
  async downloadPublicPdf(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    const { pdfBuffer, filename } = await this.invoicesService.generatePdfStreamFromPublicToken(token);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  }

  @Get([':id/secure-link', ':id/secure-link/'])
  async getSecureLink(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.invoicesService.generateSecureLink(id, req);
  }

  @Get([':id/download', ':id/download/'])
  async downloadPdf(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Res() res: Response,
  ) {
    const invoice = await this.invoicesService.findOne(id, user);
    const pdfBuffer = await this.invoicesService.generatePdfStream(id, user);
    const filename = `invoice_${(invoice.invoice_number || 'INV').replace(/\//g, '_')}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  }

  @Post(['preview', 'preview/'])
  async previewPdf(@Body() body: any, @Res() res: Response) {
    const pdfBuffer = await this.invoicesService.previewPdf(body);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="invoice_preview.pdf"');
    res.send(pdfBuffer);
  }

  @Get([':id', ':id/'])
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.invoicesService.findOne(id, user);
  }

  @Post()
  async create(@CurrentUser() user: any, @Body() body: any) {
    return this.invoicesService.create(user, body);
  }

  @Put([':id', ':id/'])
  @Patch([':id', ':id/'])
  async update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: any,
  ) {
    return this.invoicesService.update(id, user, body);
  }


  @Delete([':id', ':id/'])
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.invoicesService.remove(id, user);
  }

  @Post([':id/send_email', ':id/send-email', ':id/send_email/', ':id/send-email/'])
  async sendEmail(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.invoicesService.sendEmail(id, user);
  }
}
