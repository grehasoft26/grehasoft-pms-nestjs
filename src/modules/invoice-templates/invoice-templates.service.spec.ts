import { Test, TestingModule } from '@nestjs/testing';
import { InvoiceTemplatesService } from './invoice-templates.service';
import { PrismaService } from '../../core/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('InvoiceTemplatesService', () => {
  let service: InvoiceTemplatesService;
  let prisma: PrismaService;

  const mockPrismaService = {
    invoiceDescriptionTemplate: {
      count: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceTemplatesService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<InvoiceTemplatesService>(InvoiceTemplatesService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  describe('seedInitialTemplates', () => {
    it('should seed 4 initial templates if count is 0', async () => {
      mockPrismaService.invoiceDescriptionTemplate.count.mockResolvedValue(0);
      mockPrismaService.invoiceDescriptionTemplate.create.mockResolvedValue({});

      await service.seedInitialTemplates();

      expect(mockPrismaService.invoiceDescriptionTemplate.count).toHaveBeenCalled();
      expect(mockPrismaService.invoiceDescriptionTemplate.create).toHaveBeenCalledTimes(4);
    });

    it('should not seed templates if count > 0', async () => {
      mockPrismaService.invoiceDescriptionTemplate.count.mockResolvedValue(4);

      await service.seedInitialTemplates();

      expect(mockPrismaService.invoiceDescriptionTemplate.create).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('should return active templates by default', async () => {
      const mockTemplates = [
        { id: 1, name: 'SEO Services', is_active: true },
      ];
      mockPrismaService.invoiceDescriptionTemplate.findMany.mockResolvedValue(mockTemplates);

      const result = await service.findAll({});

      expect(mockPrismaService.invoiceDescriptionTemplate.findMany).toHaveBeenCalledWith({
        where: { is_active: true },
        orderBy: { id: 'asc' },
      });
      expect(result).toEqual(mockTemplates);
    });

    it('should return all templates if query.all === true', async () => {
      await service.findAll({ all: 'true' });

      expect(mockPrismaService.invoiceDescriptionTemplate.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { id: 'asc' },
      });
    });
  });

  describe('create', () => {
    it('should create a template successfully', async () => {
      const dto = {
        name: 'Custom Service',
        description: 'Custom Service Description',
        rate: 5000,
      };

      mockPrismaService.invoiceDescriptionTemplate.findFirst.mockResolvedValue(null);
      mockPrismaService.invoiceDescriptionTemplate.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 10, ...data }),
      );

      const result = await service.create(dto);

      expect(result.name).toBe('Custom Service');
      expect(result.rate).toBe(5000);
    });

    it('should throw BadRequestException if name is missing', async () => {
      await expect(
        service.create({ name: '', description: 'Desc', rate: 100 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if description is missing', async () => {
      await expect(
        service.create({ name: 'Test', description: '', rate: 100 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if rate is negative or invalid', async () => {
      await expect(
        service.create({ name: 'Test', description: 'Desc', rate: -10 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if template name already exists', async () => {
      mockPrismaService.invoiceDescriptionTemplate.findFirst.mockResolvedValue({ id: 1, name: 'Test' });

      await expect(
        service.create({ name: 'Test', description: 'Desc', rate: 100 }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('update', () => {
    it('should update template successfully', async () => {
      mockPrismaService.invoiceDescriptionTemplate.findUnique.mockResolvedValue({
        id: 1,
        name: 'SEO Services',
        description: 'Old desc',
        rate: 1000,
        is_active: true,
      });
      mockPrismaService.invoiceDescriptionTemplate.findFirst.mockResolvedValue(null);
      mockPrismaService.invoiceDescriptionTemplate.update.mockResolvedValue({
        id: 1,
        name: 'SEO Services Updated',
        rate: 2000,
      });

      const result = await service.update(1, { name: 'SEO Services Updated', rate: 2000 });

      expect(result.name).toBe('SEO Services Updated');
      expect(result.rate).toBe(2000);
    });
  });

  describe('remove', () => {
    it('should soft deactivate template', async () => {
      mockPrismaService.invoiceDescriptionTemplate.findUnique.mockResolvedValue({
        id: 1,
        name: 'SEO Services',
      });
      mockPrismaService.invoiceDescriptionTemplate.update.mockResolvedValue({
        id: 1,
        is_active: false,
      });

      const result = await service.remove(1);

      expect(mockPrismaService.invoiceDescriptionTemplate.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { is_active: false },
      });
      expect(result.is_active).toBe(false);
    });
  });
});
