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
import { INVOICE_TEMPLATE_PERMISSION } from '../../core/utils/permission-catalog';
import { CreateInvoiceTemplateDto } from './dto/create-invoice-template.dto';
import { UpdateInvoiceTemplateDto } from './dto/update-invoice-template.dto';
import { CreateInvoiceServiceDto } from './dto/create-invoice-service.dto';
import { UpdateInvoiceServiceDto } from './dto/update-invoice-service.dto';

// Invoice templates and services: every route (reads included) needs MANAGE_INVOICES; VIEW_INVOICES and
// VIEW_LEADS give invoice read access only, never template access.
@Controller('api/v1')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InvoiceTemplatesController {
  constructor(private readonly invoiceTemplatesService: InvoiceTemplatesService) {}

  @Get('invoice-templates')
  @Permissions(INVOICE_TEMPLATE_PERMISSION)
  async findAll(@Query() query: { search?: string; all?: string; activeOnly?: string }) {
    return this.invoiceTemplatesService.findAll(query);
  }

  @Get('invoice-templates/:id')
  @Permissions(INVOICE_TEMPLATE_PERMISSION)
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.invoiceTemplatesService.findOne(id);
  }

  @Post('invoice-templates')
  @Permissions(INVOICE_TEMPLATE_PERMISSION)
  async create(@Body() createDto: CreateInvoiceTemplateDto) {
    return this.invoiceTemplatesService.create(createDto);
  }

  @Patch('invoice-templates/:id')
  @Permissions(INVOICE_TEMPLATE_PERMISSION)
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateDto: UpdateInvoiceTemplateDto,
  ) {
    return this.invoiceTemplatesService.update(id, updateDto);
  }

  @Delete('invoice-templates/:id')
  @Permissions(INVOICE_TEMPLATE_PERMISSION)
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.invoiceTemplatesService.remove(id);
  }

  // ==========================================
  // INVOICE SERVICE ROUTES
  // ==========================================

  @Get('invoice-templates/:templateId/services')
  @Permissions(INVOICE_TEMPLATE_PERMISSION)
  async findServicesByTemplate(
    @Param('templateId', ParseIntPipe) templateId: number,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.invoiceTemplatesService.findServicesByTemplate(templateId, activeOnly === 'true');
  }

  @Post('invoice-templates/:templateId/services')
  @Permissions(INVOICE_TEMPLATE_PERMISSION)
  async createService(
    @Param('templateId', ParseIntPipe) templateId: number,
    @Body() createDto: CreateInvoiceServiceDto,
  ) {
    return this.invoiceTemplatesService.createService(templateId, createDto);
  }

  @Patch('invoice-services/:id')
  @Permissions(INVOICE_TEMPLATE_PERMISSION)
  async updateService(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateDto: UpdateInvoiceServiceDto,
  ) {
    return this.invoiceTemplatesService.updateService(id, updateDto);
  }

  @Delete('invoice-services/:id')
  @Permissions(INVOICE_TEMPLATE_PERMISSION)
  async removeService(@Param('id', ParseIntPipe) id: number) {
    return this.invoiceTemplatesService.removeService(id);
  }
}
