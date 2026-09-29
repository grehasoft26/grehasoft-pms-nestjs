import { Injectable, BadRequestException, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { CreateInvoiceTemplateDto } from './dto/create-invoice-template.dto';
import { UpdateInvoiceTemplateDto } from './dto/update-invoice-template.dto';
import { CreateInvoiceServiceDto } from './dto/create-invoice-service.dto';
import { UpdateInvoiceServiceDto } from './dto/update-invoice-service.dto';

@Injectable()
export class InvoiceTemplatesService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedInitialTemplates();
  }

  async seedInitialTemplates() {
    const initialTemplatesWithServices = [
      {
        name: 'SEO Services',
        description: 'SEO Services for website optimization including keyword research, on-page SEO and reporting',
        rate: 0,
        is_active: true,
        services: [
          { name: 'SEO Services', description: 'Comprehensive SEO package', rate: 5000 },
          { name: 'Google Business Profile Creation', description: 'GBP creation and Google Maps setup', rate: 3000 },
          { name: 'Google Business Profile Optimization', description: 'GBP profile optimization & geo-tagging', rate: 2500 },
          { name: 'Keyword Research', description: 'Keyword research and strategy document', rate: 2000 },
          { name: 'On-Page SEO', description: 'On-page optimization & meta tags setup', rate: 4000 },
          { name: 'Local SEO Package', description: 'Local citation building and rank tracking', rate: 4500 },
          { name: 'Technical SEO Audit', description: 'In-depth website audit and fixes', rate: 5000 },
        ],
      },
      {
        name: 'Meta Ads',
        description: 'Meta Ads setup, lead generation and campaign management',
        rate: 0,
        is_active: true,
        services: [
          { name: 'Meta Ads Campaign Creation', description: 'Facebook & Instagram ad campaign setup', rate: 4000 },
          { name: 'Meta Ads Campaign Management', description: 'Monthly optimization and reporting', rate: 6000 },
          { name: 'Meta Ads Lead Generation', description: 'Lead form ad setup and targeting', rate: 5000 },
          { name: 'Meta Ads Poster Design', description: 'Ad creative poster design', rate: 1500 },
          { name: 'Social Media Marketing', description: 'Organic & paid social media promotion', rate: 8000 },
        ],
      },
      {
        name: 'Website Development',
        description: 'Website design and development services',
        rate: 0,
        is_active: true,
        services: [
          { name: 'Business Website', description: 'Corporate business website development', rate: 15000 },
          { name: 'Corporate Website', description: 'Full enterprise corporate portal', rate: 25000 },
          { name: 'Custom Website', description: 'Custom full-stack web application', rate: 30000 },
          { name: 'Landing Page', description: 'High-converting sales landing page', rate: 8000 },
          { name: 'WordPress Website', description: 'Custom WordPress theme & content setup', rate: 12000 },
          { name: 'Website Maintenance', description: 'Monthly security and updates maintenance', rate: 5000 },
          { name: 'Website Speed Optimization', description: 'Core Web Vitals speed optimization', rate: 3500 },
        ],
      },
      {
        name: 'Website Hosting',
        description: 'Website hosting and server maintenance',
        rate: 0,
        is_active: true,
        services: [
          { name: 'Web Hosting', description: 'Shared Linux web hosting (annual)', rate: 3000 },
          { name: 'Cloud Hosting', description: 'Managed Cloud VPS hosting', rate: 6000 },
          { name: 'Domain Registration', description: 'Domain registration / renewal setup', rate: 1200 },
          { name: 'SSL Certificate', description: 'SSL Certificate installation & configuration', rate: 1500 },
          { name: 'Business Email', description: 'Professional Google Workspace / MX setup', rate: 2000 },
          { name: 'Backup Solution', description: 'Automated off-site cloud backups', rate: 2500 },
        ],
      },
      {
        name: 'Digital Marketing',
        description: 'Digital marketing and campaign management',
        rate: 0,
        is_active: true,
        services: [
          { name: 'Digital Marketing Package', description: 'Comprehensive digital marketing campaign', rate: 10000 },
          { name: 'Google Ads Campaign', description: 'Google Search & Display PPC setup', rate: 5000 },
          { name: 'Email Marketing', description: 'Newsletter design and campaign broadcast', rate: 3000 },
          { name: 'Content Marketing', description: 'SEO blog writing & content strategy', rate: 4000 },
        ],
      },
    ];

    for (const item of initialTemplatesWithServices) {
      let template = await this.prisma.invoiceDescriptionTemplate.findFirst({
        where: { name: item.name },
      });

      if (!template) {
        template = await this.prisma.invoiceDescriptionTemplate.create({
          data: {
            name: item.name,
            description: item.description,
            rate: item.rate,
            is_active: item.is_active,
          },
        });
      }

      // Check if child services exist for this template
      const serviceCount = await this.prisma.invoiceService.count({
        where: { template_id: template.id },
      });

      if (serviceCount === 0 && item.services) {
        for (const s of item.services) {
          await this.prisma.invoiceService.create({
            data: {
              template_id: template.id,
              name: s.name,
              description: s.description,
              rate: s.rate,
              is_active: true,
            },
          });
        }
      }
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
      include: {
        services: {
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
    });

    return templates;
  }

  async findOne(id: number) {
    const template = await this.prisma.invoiceDescriptionTemplate.findUnique({
      where: { id },
      include: {
        services: {
          orderBy: { id: 'asc' },
        },
      },
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

    return this.prisma.invoiceDescriptionTemplate.create({
      data: {
        name,
        description,
        rate: dto.rate !== undefined && dto.rate !== null && !isNaN(Number(dto.rate)) ? Number(dto.rate) : 0,
        is_active: dto.is_active !== undefined ? Boolean(dto.is_active) : true,
      },
      include: {
        services: true,
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

    if (dto.rate !== undefined && dto.rate !== null) {
      data.rate = Number(dto.rate);
    }

    if (dto.is_active !== undefined) {
      data.is_active = Boolean(dto.is_active);
    }

    return this.prisma.invoiceDescriptionTemplate.update({
      where: { id },
      data,
      include: {
        services: true,
      },
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.invoiceDescriptionTemplate.update({
      where: { id },
      data: { is_active: false },
    });
  }

  // ==========================================
  // INVOICE SERVICE METHODS
  // ==========================================

  async findServicesByTemplate(templateId: number, activeOnly = false) {
    await this.findOne(templateId);
    const where: any = { template_id: templateId };
    if (activeOnly) {
      where.is_active = true;
    }
    return this.prisma.invoiceService.findMany({
      where,
      orderBy: { id: 'asc' },
    });
  }

  async createService(templateId: number, dto: CreateInvoiceServiceDto) {
    await this.findOne(templateId);
    const name = (dto.name || '').trim();
    if (!name) {
      throw new BadRequestException({ error: 'Service name is required.' });
    }

    const rate = dto.rate !== undefined && dto.rate !== null ? Number(dto.rate) : 0;
    if (isNaN(rate) || rate < 0) {
      throw new BadRequestException({ error: 'Rate must be a non-negative number.' });
    }

    return this.prisma.invoiceService.create({
      data: {
        template_id: templateId,
        name,
        description: dto.description ? dto.description.trim() : null,
        rate,
        is_active: dto.is_active !== undefined ? Boolean(dto.is_active) : true,
      },
    });
  }

  async updateService(id: number, dto: UpdateInvoiceServiceDto) {
    const existing = await this.prisma.invoiceService.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Invoice service with ID ${id} not found.`);
    }

    const data: any = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException({ error: 'Service name cannot be empty.' });
      }
      data.name = name;
    }

    if (dto.description !== undefined) {
      data.description = dto.description ? dto.description.trim() : null;
    }

    if (dto.rate !== undefined) {
      const rate = Number(dto.rate);
      if (isNaN(rate) || rate < 0) {
        throw new BadRequestException({ error: 'Rate must be a non-negative number.' });
      }
      data.rate = rate;
    }

    if (dto.is_active !== undefined) {
      data.is_active = Boolean(dto.is_active);
    }

    return this.prisma.invoiceService.update({
      where: { id },
      data,
    });
  }

  async removeService(id: number) {
    const existing = await this.prisma.invoiceService.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Invoice service with ID ${id} not found.`);
    }

    return this.prisma.invoiceService.update({
      where: { id },
      data: { is_active: false },
    });
  }
}
