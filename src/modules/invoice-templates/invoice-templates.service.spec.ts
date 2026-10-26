import { Test, TestingModule } from '@nestjs/testing';
import { InvoiceTemplatesService } from './invoice-templates.service';
import { PrismaService } from '../../core/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

// Seeded templates and the number of services each one gets
const SEEDED = [
  ['SEO Services', 7],
  ['Meta Ads', 5],
  ['Website Development', 7],
  ['Website Hosting', 6],
  ['Digital Marketing', 4],
] as const;
const DUPLICATE_NAME = 'An invoice template with this name already exists.';
const INVALID_RATE = 'Rate must be a non-negative number.';

/** The { error } body of a BadRequestException thrown by `promise` (fails if it resolves or throws something else). */
const badRequest = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => { throw new Error('expected a BadRequestException, but the call succeeded'); },
    (e) => e,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  expect(error.getStatus()).toBe(400);
  return error.getResponse();
};

describe('InvoiceTemplatesService', () => {
  let service: InvoiceTemplatesService;
  let prisma: any;

  beforeEach(async () => {
    // A fresh mock per test: no implementation or call history carries over between cases
    prisma = {
      invoiceDescriptionTemplate: {
        count: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      invoiceService: {
        count: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [InvoiceTemplatesService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<InvoiceTemplatesService>(InvoiceTemplatesService);
  });

  describe('seedInitialTemplates (per template, idempotent)', () => {
    /** Templates that "exist": name -> { id, services already stored } */
    const withExisting = (existing: Record<string, { id: number; services: number }>) => {
      let nextId = 100;
      const created: Record<string, number> = {};
      prisma.invoiceDescriptionTemplate.findFirst.mockImplementation(async ({ where }: any) =>
        existing[where.name] ? { id: existing[where.name].id, name: where.name } : null,
      );
      prisma.invoiceDescriptionTemplate.create.mockImplementation(async ({ data }: any) => {
        created[data.name] = nextId;
        return { id: nextId++, ...data };
      });
      prisma.invoiceService.count.mockImplementation(async ({ where }: any) => {
        const found = Object.values(existing).find((t) => t.id === where.template_id);
        return found ? found.services : 0;
      });
      return created;
    };
    const servicesCreatedFor = (templateId: number) =>
      prisma.invoiceService.create.mock.calls.filter(([args]: any) => args.data.template_id === templateId);

    it('creates every missing template with all of its services', async () => {
      const created = withExisting({});

      await service.seedInitialTemplates();

      expect(prisma.invoiceDescriptionTemplate.create).toHaveBeenCalledTimes(5);
      expect(prisma.invoiceDescriptionTemplate.create.mock.calls.map(([args]: any) => args.data.name)).toEqual(SEEDED.map(([name]) => name));
      for (const [args] of prisma.invoiceDescriptionTemplate.create.mock.calls) {
        expect(args.data).toEqual({ name: expect.any(String), description: expect.any(String), rate: 0, is_active: true });
      }
      for (const [name, services] of SEEDED) {
        expect(prisma.invoiceService.count).toHaveBeenCalledWith({ where: { template_id: created[name] } });
        expect(servicesCreatedFor(created[name])).toHaveLength(services);
      }
      expect(prisma.invoiceService.create).toHaveBeenCalledTimes(29);
      expect(prisma.invoiceService.create).toHaveBeenCalledWith({
        data: { template_id: created['SEO Services'], name: 'SEO Services', description: 'Comprehensive SEO package', rate: 5000, is_active: true },
      });
    });

    it('does not duplicate templates that exist and already have services', async () => {
      withExisting(Object.fromEntries(SEEDED.map(([name], i) => [name, { id: i + 1, services: 3 }])));

      await service.seedInitialTemplates();

      expect(prisma.invoiceDescriptionTemplate.findFirst).toHaveBeenCalledTimes(5);
      expect(prisma.invoiceService.count).toHaveBeenCalledTimes(5);
      expect(prisma.invoiceDescriptionTemplate.create).not.toHaveBeenCalled();
      expect(prisma.invoiceService.create).not.toHaveBeenCalled();
    });

    it('adds only the missing services to an existing template that has none, and creates a missing template', async () => {
      const existing = Object.fromEntries(SEEDED.map(([name], i) => [name, { id: i + 1, services: 2 }]));
      existing['Meta Ads'].services = 0; // exists, no services
      delete existing['Website Hosting']; // missing
      const created = withExisting(existing);

      await service.seedInitialTemplates();

      expect(prisma.invoiceDescriptionTemplate.create).toHaveBeenCalledTimes(1);
      expect(prisma.invoiceDescriptionTemplate.create.mock.calls[0][0].data.name).toBe('Website Hosting');
      expect(servicesCreatedFor(existing['Meta Ads'].id).map(([args]: any) => args.data.name)).toEqual([
        'Meta Ads Campaign Creation',
        'Meta Ads Campaign Management',
        'Meta Ads Lead Generation',
        'Meta Ads Poster Design',
        'Social Media Marketing',
      ]);
      expect(servicesCreatedFor(created['Website Hosting'])).toHaveLength(6);
      expect(prisma.invoiceService.create).toHaveBeenCalledTimes(5 + 6);
    });
  });

  describe('findAll', () => {
    const withServices = { services: { orderBy: { id: 'asc' } } };

    it('returns active templates with their services (both ordered by id) by default', async () => {
      const templates = [{ id: 1, name: 'SEO Services', is_active: true, services: [{ id: 1 }] }];
      prisma.invoiceDescriptionTemplate.findMany.mockResolvedValue(templates);

      const result = await service.findAll({});

      expect(prisma.invoiceDescriptionTemplate.findMany).toHaveBeenCalledWith({
        where: { is_active: true },
        include: withServices,
        orderBy: { id: 'asc' },
      });
      expect(result).toEqual(templates);
    });

    it('returns all templates with their services if query.all === "true"', async () => {
      prisma.invoiceDescriptionTemplate.findMany.mockResolvedValue([]);

      await service.findAll({ all: 'true' });

      expect(prisma.invoiceDescriptionTemplate.findMany).toHaveBeenCalledWith({
        where: {},
        include: withServices,
        orderBy: { id: 'asc' },
      });
    });

    it('applies the search to name and description', async () => {
      prisma.invoiceDescriptionTemplate.findMany.mockResolvedValue([]);

      await service.findAll({ search: 'seo' });

      expect(prisma.invoiceDescriptionTemplate.findMany).toHaveBeenCalledWith({
        where: { is_active: true, OR: [{ name: { contains: 'seo' } }, { description: { contains: 'seo' } }] },
        include: withServices,
        orderBy: { id: 'asc' },
      });
    });
  });

  describe('create', () => {
    beforeEach(() => {
      prisma.invoiceDescriptionTemplate.create.mockImplementation(async ({ data }: any) => ({ id: 10, ...data, services: [] }));
    });
    const createdData = () => prisma.invoiceDescriptionTemplate.create.mock.calls[0][0].data;

    it('creates a template with the given rate', async () => {
      const result = await service.create({ name: ' Custom Service ', description: ' Custom Service Description ', rate: 5000 });

      expect(prisma.invoiceDescriptionTemplate.findFirst).toHaveBeenCalledWith({ where: { name: { equals: 'Custom Service' } } });
      expect(prisma.invoiceDescriptionTemplate.create).toHaveBeenCalledWith({
        data: { name: 'Custom Service', description: 'Custom Service Description', rate: 5000, is_active: true },
        include: { services: true },
      });
      expect(result).toMatchObject({ id: 10, name: 'Custom Service', rate: 5000 });
    });

    it.each([
      ['omitted', undefined],
      ['null', null],
      ['empty', ''],
    ])('defaults a %s rate to 0 (the template form sends no rate)', async (_label, rate) => {
      await service.create({ name: 'Test', description: 'Desc', rate } as any);
      expect(createdData().rate).toBe(0);
    });

    it('accepts 0 and numeric strings', async () => {
      await service.create({ name: 'A', description: 'Desc', rate: 0 });
      await service.create({ name: 'B', description: 'Desc', rate: '1500.50' as any });
      expect(prisma.invoiceDescriptionTemplate.create.mock.calls.map(([args]: any) => args.data.rate)).toEqual([0, 1500.5]);
    });

    it('rejects a missing name or description (400)', async () => {
      expect(await badRequest(service.create({ name: '', description: 'Desc', rate: 100 }))).toEqual({ error: 'Template name is required.' });
      expect(await badRequest(service.create({ name: 'Test', description: '  ', rate: 100 }))).toEqual({ error: 'Template description is required.' });
      expect(prisma.invoiceDescriptionTemplate.create).not.toHaveBeenCalled();
    });

    it.each([
      ['negative', -10],
      ['slightly negative', -0.01],
      ['negative string', '-5'],
      ['non-numeric string', 'abc'],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['boolean', true],
      ['object', {}],
      ['array', [5]],
      ['larger than DECIMAL(10,2)', 100000000],
    ])('rejects a %s rate (400) before any database call', async (_label, rate) => {
      expect(await badRequest(service.create({ name: 'Test', description: 'Desc', rate } as any))).toEqual({ error: INVALID_RATE });
      expect(prisma.invoiceDescriptionTemplate.findFirst).not.toHaveBeenCalled();
      expect(prisma.invoiceDescriptionTemplate.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate name (400) without saving', async () => {
      prisma.invoiceDescriptionTemplate.findFirst.mockResolvedValue({ id: 1, name: 'Test' });

      expect(await badRequest(service.create({ name: 'Test', description: 'Desc', rate: 100 }))).toEqual({ error: DUPLICATE_NAME });
      expect(prisma.invoiceDescriptionTemplate.create).not.toHaveBeenCalled();
    });

    it('turns a concurrent duplicate (Prisma P2002) into the same 400', async () => {
      prisma.invoiceDescriptionTemplate.create.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed on the constraint: `invoice_description_templates_name_key`'), { code: 'P2002' }),
      );

      expect(await badRequest(service.create({ name: 'Test', description: 'Desc' } as any))).toEqual({ error: DUPLICATE_NAME });
    });

    it('lets other database errors through unchanged', async () => {
      const failure = Object.assign(new Error('connection lost'), { code: 'P1001' });
      prisma.invoiceDescriptionTemplate.create.mockRejectedValue(failure);

      await expect(service.create({ name: 'Test', description: 'Desc' } as any)).rejects.toBe(failure);
    });
  });

  describe('update', () => {
    const stored = { id: 1, name: 'SEO Services', description: 'Old desc', rate: 1000, is_active: true };
    beforeEach(() => {
      prisma.invoiceDescriptionTemplate.findUnique.mockResolvedValue(stored);
      prisma.invoiceDescriptionTemplate.update.mockImplementation(async ({ data }: any) => ({ ...stored, ...data }));
    });
    const updatedData = () => prisma.invoiceDescriptionTemplate.update.mock.calls[0][0].data;

    it('updates the template', async () => {
      const result = await service.update(1, { name: 'SEO Services Updated', rate: 2000 });

      expect(prisma.invoiceDescriptionTemplate.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { name: 'SEO Services Updated', rate: 2000 },
        include: { services: true },
      });
      expect(result).toMatchObject({ name: 'SEO Services Updated', rate: 2000 });
    });

    it.each([
      ['omitted', undefined],
      ['null', null],
      ['empty', ''],
    ])('keeps the stored rate when the rate is %s', async (_label, rate) => {
      await service.update(1, { description: 'New desc', rate } as any);
      expect(updatedData()).toEqual({ description: 'New desc' });
    });

    it('accepts 0 and numeric strings', async () => {
      await service.update(1, { rate: 0 });
      await service.update(1, { rate: '250.75' as any });
      expect(prisma.invoiceDescriptionTemplate.update.mock.calls.map(([args]: any) => args.data.rate)).toEqual([0, 250.75]);
    });

    it.each([
      ['negative', -1],
      ['non-numeric string', 'abc'],
      ['NaN', NaN],
      ['boolean', false],
      ['larger than DECIMAL(10,2)', 1e9],
    ])('rejects a %s rate (400) without saving', async (_label, rate) => {
      expect(await badRequest(service.update(1, { rate } as any))).toEqual({ error: INVALID_RATE });
      expect(prisma.invoiceDescriptionTemplate.update).not.toHaveBeenCalled();
    });

    it('rejects a name used by another template (400), as before', async () => {
      prisma.invoiceDescriptionTemplate.findFirst.mockResolvedValue({ id: 2, name: 'Meta Ads' });

      expect(await badRequest(service.update(1, { name: 'Meta Ads' }))).toEqual({ error: DUPLICATE_NAME });
      expect(prisma.invoiceDescriptionTemplate.findFirst).toHaveBeenCalledWith({ where: { name: { equals: 'Meta Ads' }, id: { not: 1 } } });
      expect(prisma.invoiceDescriptionTemplate.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for an unknown template', async () => {
      prisma.invoiceDescriptionTemplate.findUnique.mockResolvedValue(null);
      await expect(service.update(99, { rate: 1 })).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('should soft deactivate template', async () => {
      prisma.invoiceDescriptionTemplate.findUnique.mockResolvedValue({ id: 1, name: 'SEO Services' });
      prisma.invoiceDescriptionTemplate.update.mockResolvedValue({ id: 1, is_active: false });

      const result = await service.remove(1);

      expect(prisma.invoiceDescriptionTemplate.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { is_active: false },
      });
      expect(result.is_active).toBe(false);
    });
  });
});
