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
} from '@nestjs/common';
import { InvoiceTemplatesService } from './invoice-templates.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CreateInvoiceTemplateDto } from './dto/create-invoice-template.dto';
import { UpdateInvoiceTemplateDto } from './dto/update-invoice-template.dto';
import { CreateInvoiceServiceDto } from './dto/create-invoice-service.dto';
import { UpdateInvoiceServiceDto } from './dto/update-invoice-service.dto';

@Controller('api/v1')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InvoiceTemplatesController {
  constructor(private readonly invoiceTemplatesService: InvoiceTemplatesService) {}

  @Get('invoice-templates')
  @Permissions('VIEW_INVOICES')
  async findAll(@Query() query: { search?: string; all?: string; activeOnly?: string }) {
    return this.invoiceTemplatesService.findAll(query);
  }

  @Get('invoice-templates/:id')
  @Permissions('VIEW_INVOICES')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.invoiceTemplatesService.findOne(id);
  }

  @Post('invoice-templates')
  @Permissions('MANAGE_INVOICES')
  async create(@Body() createDto: CreateInvoiceTemplateDto) {
    return this.invoiceTemplatesService.create(createDto);
  }

  @Patch('invoice-templates/:id')
  @Permissions('MANAGE_INVOICES')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateDto: UpdateInvoiceTemplateDto,
  ) {
    return this.invoiceTemplatesService.update(id, updateDto);
  }

  @Delete('invoice-templates/:id')
  @Permissions('MANAGE_INVOICES')
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.invoiceTemplatesService.remove(id);
  }

  // ==========================================
  // INVOICE SERVICE ROUTES
  // ==========================================

  @Get('invoice-templates/:templateId/services')
  @Permissions('VIEW_INVOICES')
  async findServicesByTemplate(
    @Param('templateId', ParseIntPipe) templateId: number,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.invoiceTemplatesService.findServicesByTemplate(templateId, activeOnly === 'true');
  }

  @Post('invoice-templates/:templateId/services')
  @Permissions('MANAGE_INVOICES')
  async createService(
    @Param('templateId', ParseIntPipe) templateId: number,
    @Body() createDto: CreateInvoiceServiceDto,
  ) {
    return this.invoiceTemplatesService.createService(templateId, createDto);
  }

  @Patch('invoice-services/:id')
  @Permissions('MANAGE_INVOICES')
  async updateService(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateDto: UpdateInvoiceServiceDto,
  ) {
    return this.invoiceTemplatesService.updateService(id, updateDto);
  }

  @Delete('invoice-services/:id')
  @Permissions('MANAGE_INVOICES')
  async removeService(@Param('id', ParseIntPipe) id: number) {
    return this.invoiceTemplatesService.removeService(id);
  }
}
