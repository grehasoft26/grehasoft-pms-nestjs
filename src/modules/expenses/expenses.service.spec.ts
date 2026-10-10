import { Test, TestingModule } from '@nestjs/testing';
import { ExpensesService } from './expenses.service';
import { PrismaService } from '../../core/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('ExpensesService', () => {
  let service: ExpensesService;
  let prisma: PrismaService;

  const mockPrismaService = {
    expenseCategory: {
      upsert: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    expense: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    client: {
      findUnique: jest.fn(),
    },
    project: {
      findUnique: jest.fn(),
    },
    invoice: {
      findUnique: jest.fn(),
    },
  };

  const mockUser = { id: 1, name: 'Admin User', role: { name: 'SUPER_ADMIN' } };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpensesService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<ExpensesService>(ExpensesService);
    prisma = module.get<PrismaService>(PrismaService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAllCategories', () => {
    it('should return list of categories', async () => {
      mockPrismaService.expenseCategory.findMany.mockResolvedValue([
        { id: 1, name: 'Office Rent' },
      ]);

      const result = await service.findAllCategories();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Office Rent');
    });
  });

  describe('createCategory', () => {
    it('should create new category', async () => {
      mockPrismaService.expenseCategory.findUnique.mockResolvedValue(null);
      mockPrismaService.expenseCategory.create.mockResolvedValue({
        id: 1,
        name: 'New Category',
      });

      const result = await service.createCategory({ name: 'New Category' });
      expect(result.name).toBe('New Category');
    });

    it('should throw BadRequestException if category name already exists', async () => {
      mockPrismaService.expenseCategory.findUnique.mockResolvedValue({
        id: 1,
        name: 'Existing',
        deleted_at: null,
      });

      await expect(service.createCategory({ name: 'Existing' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('create expense', () => {
    it('1. should create an expense with no client/project/invoice (company expense)', async () => {
      mockPrismaService.expenseCategory.findUnique.mockResolvedValue({ id: 1, name: 'Office Rent' });
      mockPrismaService.expense.create.mockResolvedValue({
        id: 10,
        title: 'Company Expense',
        category_id: 1,
        client_id: null,
        project_id: null,
        invoice_id: null,
        payment_account_source: 'company_account',
        amount: 25000,
        expense_date: new Date('2026-10-01'),
        amount_paid: 25000,
        outstanding_amount: 0,
        payment_status: 'paid',
        created_by_id: 1,
      });

      const result = await service.create(mockUser, {
        title: 'Company Expense',
        category_id: 1,
        amount: 25000,
        expense_date: '2026-10-01',
        amount_paid: 25000,
        payment_account_source: 'company_account',
      });

      expect(result.id).toBe(10);
      expect(result.client_id).toBeNull();
      expect(result.project_id).toBeNull();
      expect(result.payment_account_source).toBe('company_account');
    });

    it('2. should create a client-linked expense', async () => {
      mockPrismaService.expenseCategory.findUnique.mockResolvedValue({ id: 1, name: 'Client Meetings' });
      mockPrismaService.client.findUnique.mockResolvedValue({ id: 5, name: 'Acme Corp' });
      mockPrismaService.expense.create.mockResolvedValue({
        id: 11,
        title: 'Client Lunch',
        category_id: 1,
        client_id: 5,
        project_id: null,
        invoice_id: null,
        payment_account_source: 'owner_personal',
        amount: 3000,
        expense_date: new Date('2026-10-02'),
        amount_paid: 3000,
        outstanding_amount: 0,
        payment_status: 'paid',
        client: { id: 5, name: 'Acme Corp' },
        created_by_id: 1,
      });

      const result = await service.create(mockUser, {
        title: 'Client Lunch',
        category_id: 1,
        client_id: 5,
        amount: 3000,
        expense_date: '2026-10-02',
        amount_paid: 3000,
        payment_account_source: 'owner_personal',
      });

      expect(result.client_id).toBe(5);
      expect(result.client_name).toBe('Acme Corp');
      expect(result.payment_account_source).toBe('owner_personal');
    });

    it('3. should link an expense to a valid project and invoice', async () => {
      mockPrismaService.expenseCategory.findUnique.mockResolvedValue({ id: 1, name: 'Software License' });
      mockPrismaService.client.findUnique.mockResolvedValue({ id: 5, name: 'Acme Corp' });
      mockPrismaService.project.findUnique.mockResolvedValue({ id: 12, name: 'Web Redesign', client_id: 5 });
      mockPrismaService.invoice.findUnique.mockResolvedValue({ id: 100, invoice_number: 'INV-100', client_id: 5 });

      mockPrismaService.expense.create.mockResolvedValue({
        id: 15,
        title: 'Figma Subscription',
        category_id: 1,
        client_id: 5,
        project_id: 12,
        invoice_id: 100,
        payment_account_source: 'company_account',
        amount: 5000,
        expense_date: new Date('2026-10-03'),
        amount_paid: 5000,
        outstanding_amount: 0,
        payment_status: 'paid',
        client: { id: 5, name: 'Acme Corp' },
        project: { id: 12, name: 'Web Redesign', client_id: 5 },
        invoice: { id: 100, invoice_number: 'INV-100', client_id: 5 },
        created_by_id: 1,
      });

      const result = await service.create(mockUser, {
        title: 'Figma Subscription',
        category_id: 1,
        client_id: 5,
        project_id: 12,
        invoice_id: 100,
        amount: 5000,
        expense_date: '2026-10-03',
        amount_paid: 5000,
      });

      expect(result.project_id).toBe(12);
      expect(result.project_name).toBe('Web Redesign');
      expect(result.invoice_id).toBe(100);
      expect(result.invoice_number).toBe('INV-100');
    });

    it('4. should reject invalid or inconsistent relationship IDs', async () => {
      mockPrismaService.expenseCategory.findUnique.mockResolvedValue({ id: 1 });
      mockPrismaService.client.findUnique.mockResolvedValue({ id: 5, name: 'Acme Corp' });
      // Project belongs to client 99, not client 5
      mockPrismaService.project.findUnique.mockResolvedValue({ id: 12, name: 'Other Project', client_id: 99 });

      await expect(
        service.create(mockUser, {
          title: 'Mismatch Test',
          category_id: 1,
          client_id: 5,
          project_id: 12,
          amount: 1000,
          expense_date: '2026-10-03',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('5. should preserve existing expense formatting without new optional fields', async () => {
      mockPrismaService.expense.findUnique.mockResolvedValue({
        id: 1,
        title: 'Legacy Expense',
        category_id: 1,
        amount: 1000,
        expense_date: new Date('2025-01-01'),
        amount_paid: 1000,
        outstanding_amount: 0,
        payment_status: 'paid',
        payment_method: 'cash',
        created_by_id: 1,
      });

      const result = await service.findOne(1, mockUser);
      expect(result.id).toBe(1);
      expect(result.client_id).toBeNull();
      expect(result.project_id).toBeNull();
      expect(result.invoice_id).toBeNull();
      expect(result.payment_account_source).toBeNull();
    });

    it('6. should record owner personal account source correctly', async () => {
      mockPrismaService.expenseCategory.findUnique.mockResolvedValue({ id: 1 });
      mockPrismaService.expense.create.mockResolvedValue({
        id: 20,
        title: 'Out of Pocket Travel',
        category_id: 1,
        payment_account_source: 'owner_personal',
        amount: 1200,
        expense_date: new Date('2026-10-04'),
        amount_paid: 1200,
        outstanding_amount: 0,
        payment_status: 'paid',
        created_by_id: 1,
      });

      const result = await service.create(mockUser, {
        title: 'Out of Pocket Travel',
        category_id: 1,
        amount: 1200,
        expense_date: '2026-10-04',
        payment_account_source: 'owner_personal',
      });

      expect(result.payment_account_source).toBe('owner_personal');
    });

    it('should throw BadRequestException if amount is negative', async () => {
      mockPrismaService.expenseCategory.findUnique.mockResolvedValue({ id: 1 });

      await expect(
        service.create(mockUser, {
          title: 'Invalid',
          category_id: 1,
          amount: -500,
          expense_date: '2026-10-01',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if amount_paid > amount', async () => {
      mockPrismaService.expenseCategory.findUnique.mockResolvedValue({ id: 1 });

      await expect(
        service.create(mockUser, {
          title: 'Invalid',
          category_id: 1,
          amount: 1000,
          expense_date: '2026-10-01',
          amount_paid: 1500,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
