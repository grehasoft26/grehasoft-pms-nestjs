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

@Controller('api/v1/invoice-templates')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InvoiceTemplatesController {
  constructor(private readonly invoiceTemplatesService: InvoiceTemplatesService) {}

  @Get()
  @Permissions('VIEW_INVOICES')
  async findAll(@Query() query: { search?: string; all?: string; activeOnly?: string }) {
    return this.invoiceTemplatesService.findAll(query);
  }

  @Get(':id')
  @Permissions('VIEW_INVOICES')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.invoiceTemplatesService.findOne(id);
  }

  @Post()
  @Permissions('MANAGE_INVOICES')
  async create(@Body() createDto: CreateInvoiceTemplateDto) {
    return this.invoiceTemplatesService.create(createDto);
  }

  @Patch(':id')
  @Permissions('MANAGE_INVOICES')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateDto: UpdateInvoiceTemplateDto,
  ) {
    return this.invoiceTemplatesService.update(id, updateDto);
  }

  @Delete(':id')
  @Permissions('MANAGE_INVOICES')
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.invoiceTemplatesService.remove(id);
  }
}
