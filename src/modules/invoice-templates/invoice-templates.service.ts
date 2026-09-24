import { Injectable, BadRequestException, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { CreateInvoiceTemplateDto } from './dto/create-invoice-template.dto';
import { UpdateInvoiceTemplateDto } from './dto/update-invoice-template.dto';

@Injectable()
export class InvoiceTemplatesService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedInitialTemplates();
  }

  async seedInitialTemplates() {
    const count = await this.prisma.invoiceDescriptionTemplate.count();
    if (count > 0) return;

    const initialTemplates = [
      {
        name: 'SEO Services',
        description: 'SEO Services for website optimization including keyword research, on-page SEO and reporting',
        rate: 0,
        is_active: true,
      },
      {
        name: 'Website Development',
        description: 'Website design and development services',
        rate: 0,
        is_active: true,
      },
      {
        name: 'Website Hosting',
        description: 'Website hosting and server maintenance',
        rate: 0,
        is_active: true,
      },
      {
        name: 'Digital Marketing',
        description: 'Digital marketing and campaign management',
        rate: 0,
        is_active: true,
      },
    ];

    for (const template of initialTemplates) {
      await this.prisma.invoiceDescriptionTemplate.create({
        data: template,
      });
    }
  }

  async findAll(query: { search?: string; all?: string; activeOnly?: string } = {}) {
    const where: any = {};

    if (query.activeOnly === 'true' || query.all !== 'true') {
      where.is_active = true;
    }

    if (query.search) {
      where.OR = [
        { name: { contains: query.search } },
        { description: { contains: query.search } },
      ];
    }

    const templates = await this.prisma.invoiceDescriptionTemplate.findMany({
      where,
      orderBy: { id: 'asc' },
    });

    return templates;
  }

  async findOne(id: number) {
    const template = await this.prisma.invoiceDescriptionTemplate.findUnique({
      where: { id },
    });
    if (!template) {
      throw new NotFoundException(`Invoice template with ID ${id} not found.`);
    }
    return template;
  }

  async create(dto: CreateInvoiceTemplateDto) {
    const name = (dto.name || '').trim();
    if (!name) {
      throw new BadRequestException({ error: 'Template name is required.' });
    }

    const description = (dto.description || '').trim();
    if (!description) {
      throw new BadRequestException({ error: 'Template description is required.' });
    }

    if (dto.rate === undefined || dto.rate === null || isNaN(Number(dto.rate)) || Number(dto.rate) < 0) {
      throw new BadRequestException({ error: 'A valid non-negative rate is required.' });
    }

    const existing = await this.prisma.invoiceDescriptionTemplate.findFirst({
      where: {
        name: { equals: name },
      },
    });

    if (existing) {
      throw new BadRequestException({ error: 'An invoice template with this name already exists.' });
    }

    return this.prisma.invoiceDescriptionTemplate.create({
      data: {
        name,
        description,
        rate: Number(dto.rate),
        is_active: dto.is_active !== undefined ? Boolean(dto.is_active) : true,
      },
    });
  }

  async update(id: number, dto: UpdateInvoiceTemplateDto) {
    await this.findOne(id);
    const data: any = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException({ error: 'Template name cannot be empty.' });
      }

      const existing = await this.prisma.invoiceDescriptionTemplate.findFirst({
        where: {
          name: { equals: name },
          id: { not: id },
        },
      });

      if (existing) {
        throw new BadRequestException({ error: 'An invoice template with this name already exists.' });
      }
      data.name = name;
    }

    if (dto.description !== undefined) {
      const description = dto.description.trim();
      if (!description) {
        throw new BadRequestException({ error: 'Template description cannot be empty.' });
      }
      data.description = description;
    }

    if (dto.rate !== undefined) {
      if (dto.rate === null || isNaN(Number(dto.rate)) || Number(dto.rate) < 0) {
        throw new BadRequestException({ error: 'A valid non-negative rate is required.' });
      }
      data.rate = Number(dto.rate);
    }

    if (dto.is_active !== undefined) {
      data.is_active = Boolean(dto.is_active);
    }

    return this.prisma.invoiceDescriptionTemplate.update({
      where: { id },
      data,
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    // Soft deactivate per requirements
    return this.prisma.invoiceDescriptionTemplate.update({
      where: { id },
      data: { is_active: false },
    });
  }
}
