import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { InvoicePaymentsService } from './invoice-payments.service';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';

/**
 * Payment amount validation (create / update / invoice create / invoice update),
 * using the shared invoice-status calculation and a locked transaction.
 */
const D = (v: string | number) => new Prisma.Decimal(v);
const admin = { id: 1, role: { name: 'SUPER_ADMIN' } };

const buildPrisma = () => {
  const mock: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    invoice: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
    invoicePayment: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => ({ id: 900, ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, invoice_id: 1, ...data })),
    },
    client: { findUnique: jest.fn().mockResolvedValue({ id: 1, name: 'Client', address: '' }) },
    invoiceItem: { create: jest.fn(), deleteMany: jest.fn() },
  };
  mock.$transaction = jest.fn(async (cb: any) => cb(mock));
  return mock;
};

const providers = (prisma: any) => [
  { provide: PrismaService, useValue: prisma },
  { provide: PdfService, useValue: { generateReceiptPdf: jest.fn(), generateInvoicePdf: jest.fn() } },
  { provide: MailerService, useValue: { sendMail: jest.fn() } },
  { provide: ConfigService, useValue: { get: jest.fn() } },
];

describe('Invoice payment validation', () => {
  let prisma: any;
  let payments: InvoicePaymentsService;
  let invoices: InvoicesService;

  /** Invoice total 2300.00 with existing payments 1000.00 (#11) and 500.00 (#12). */
  const invoiceRow = (overrides: any = {}) => ({
    id: 1,
    invoice_number: 'GSI/2026-27/001',
    client_id: 1,
    subtotal: D('2300.00'),
    tax: D('0.00'),
    total: D('2300.00'),
    advance: D('0.00'),
    due_date: null,
    issue_date: new Date('2026-10-01T00:00:00.000Z'),
    created_at: new Date('2026-10-01T10:00:00.000Z'),
    items: [],
    client: { id: 1, name: 'Client' },
    payments: [
      { id: 11, invoice_id: 1, amount: D('1000.00'), payment_date: new Date('2026-10-02T00:00:00.000Z') },
      { id: 12, invoice_id: 1, amount: D('500.00'), payment_date: new Date('2026-10-03T00:00:00.000Z') },
    ],
    ...overrides,
  });

  beforeEach(async () => {
    prisma = buildPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [InvoicePaymentsService, InvoicesService, ...providers(prisma)],
    }).compile();
    payments = module.get(InvoicePaymentsService);
    invoices = module.get(InvoicesService);
    prisma.invoice.findUnique.mockResolvedValue(invoiceRow());
  });

  describe('create payment', () => {
    it.each([0, -1, '-100', '', 'abc', null])('14. rejects invalid amount %p', async (amount) => {
      await expect(payments.create(admin, { invoice: 1, amount })).rejects.toThrow(BadRequestException);
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it('rejects an amount above the outstanding balance (800.00)', async () => {
      await expect(payments.create(admin, { invoice: 1, amount: 800.01 })).rejects.toThrow(
        'Payment amount cannot exceed the outstanding balance of ₹800.00.',
      );
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it('accepts exactly the outstanding balance and stores a two-decimal amount', async () => {
      await payments.create(admin, { invoice: 1, amount: '800.00', payment_mode: 'upi' });

      expect(prisma.invoicePayment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ invoice_id: 1, amount: 800, payment_mode: 'upi' }),
      });
    });

    it('rejects any payment on a fully paid invoice', async () => {
      prisma.invoice.findUnique.mockResolvedValue(invoiceRow({ payments: [{ id: 11, amount: D('2300.00') }] }));

      await expect(payments.create(admin, { invoice: 1, amount: 1 })).rejects.toThrow('outstanding balance of ₹0.00');
    });

    it('counts the advance column when computing the outstanding balance', async () => {
      prisma.invoice.findUnique.mockResolvedValue(invoiceRow({ advance: D('500.00') }));

      await expect(payments.create(admin, { invoice: 1, amount: 300.01 })).rejects.toThrow('₹300.00');
      await expect(payments.create(admin, { invoice: 1, amount: 300 })).resolves.toBeDefined();
    });

    it('validates inside a transaction after locking the invoice row', async () => {
      await payments.create(admin, { invoice: 1, amount: 100 });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const lockSql = prisma.$queryRaw.mock.calls[0][0].join('?');
      expect(lockSql).toContain('FOR UPDATE');
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.invoicePayment.create.mock.invocationCallOrder[0]);
    });

    it('returns 404 for a missing invoice', async () => {
      prisma.invoice.findUnique.mockResolvedValue(null);

      await expect(payments.create(admin, { invoice: 99, amount: 10 })).rejects.toThrow(NotFoundException);
    });
  });

  describe('update payment', () => {
    beforeEach(() => {
      prisma.invoicePayment.findUnique.mockResolvedValue({ id: 11, invoice_id: 1, amount: D('1000.00') });
    });

    it('15. excludes the old amount: payment #11 can grow to 1800.00 (2300 - 500)', async () => {
      await payments.update(11, admin, { amount: 1800 });

      expect(prisma.invoicePayment.update).toHaveBeenCalledWith({ where: { id: 11 }, data: { amount: 1800 } });
    });

    it('15b. rejects growing payment #11 beyond the balance excluding itself', async () => {
      await expect(payments.update(11, admin, { amount: 1800.01 })).rejects.toThrow('₹1800.00');
      expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
    });

    it.each([0, -5, 'abc'])('14b. rejects updating the amount to %p', async (amount) => {
      await expect(payments.update(11, admin, { amount })).rejects.toThrow(BadRequestException);
      expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
    });

    it('allows editing date/notes without revalidating, even on an overpaid invoice', async () => {
      prisma.invoice.findUnique.mockResolvedValue(invoiceRow({ total: D('900.00') }));

      await payments.update(11, admin, { amount: '1000.00', notes: 'corrected note' });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.invoicePayment.update).toHaveBeenCalledWith({ where: { id: 11 }, data: { notes: 'corrected note' } });
    });

    it('does not change or delete other payment records', async () => {
      await payments.update(11, admin, { amount: 1200 });

      expect(prisma.invoicePayment.update).toHaveBeenCalledTimes(1);
      expect(prisma.invoicePayment.update.mock.calls[0][0].where).toEqual({ id: 11 });
    });
  });

  describe('invoice create with initial payment', () => {
    beforeEach(() => {
      prisma.invoice.create.mockResolvedValue({ id: 1 });
    });

    const body = (payment_amount: any) => ({ client: 1, items: [{ description: 'Work', quantity: 1, rate: 2300 }], payment_amount });

    it('rejects a negative initial payment', async () => {
      await expect(invoices.create(admin, body(-100))).rejects.toThrow(BadRequestException);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it('rejects an initial payment above the invoice total', async () => {
      await expect(invoices.create(admin, body(2300.01))).rejects.toThrow('₹2300.00');
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it('still treats 0 / blank as "no initial payment"', async () => {
      await invoices.create(admin, body(0));
      await invoices.create(admin, body(''));

      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it('records a valid initial payment with the creation note', async () => {
      await invoices.create(admin, body(1000));

      expect(prisma.invoicePayment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: 1000, notes: 'Initial payment received on invoice creation' }),
      });
    });
  });

  describe('invoice update with new payment', () => {
    beforeEach(() => {
      prisma.invoice.update.mockResolvedValue(invoiceRow());
      prisma.invoicePayment.findMany.mockResolvedValue(invoiceRow().payments);
    });

    it('rejects a new payment above the outstanding balance and rolls back', async () => {
      await expect(invoices.update(1, admin, { new_payment_amount: 800.01 })).rejects.toThrow('₹800.00');
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it('rejects a negative new payment', async () => {
      await expect(invoices.update(1, admin, { new_payment_amount: -10 })).rejects.toThrow(BadRequestException);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it('accepts a new payment equal to the balance', async () => {
      await invoices.update(1, admin, { new_payment_amount: 800 });

      expect(prisma.invoicePayment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 800 }) });
    });

    it('validates against the new total when the edit changes the total', async () => {
      prisma.invoice.update.mockResolvedValue(invoiceRow({ total: D('2000.00') }));

      await expect(invoices.update(1, admin, { total: 2000, new_payment_amount: 600 })).rejects.toThrow('₹500.00');
    });
  });
});
