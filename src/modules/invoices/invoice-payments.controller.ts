import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { InvoicePaymentsService } from './invoice-payments.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@Controller('api/v1/invoice-payments')
@UseGuards(JwtAuthGuard)
export class InvoicePaymentsController {
  constructor(private readonly invoicePaymentsService: InvoicePaymentsService) {}

  @Get()
  async findAll(@CurrentUser() user: any, @Query() query: any) {
    return this.invoicePaymentsService.findAll(user, query);
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.invoicePaymentsService.findOne(id, user);
  }

  @Post()
  async create(@CurrentUser() user: any, @Body() body: any) {
    return this.invoicePaymentsService.create(user, body);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: any,
  ) {
    return this.invoicePaymentsService.update(id, user, body);
  }

  @Get(':id/receipt')
  async downloadReceipt(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.invoicePaymentsService.generateReceiptPdfStream(id, user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.invoicePaymentsService.remove(id, user);
  }
}
