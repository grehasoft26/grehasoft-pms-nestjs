import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { InvoicePaymentsService } from './invoice-payments.service';
import { ExpensesService } from '../expenses/expenses.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';

/**
 * Invoice → Add Payment → "Also record an expense": the payment and the expense are created in ONE transaction by the
 * Expenses module's own rules, only with MANAGE_EXPENSES, linked to the invoice (and its client) on the server, with the
 * separately entered amount. Any failure leaves neither record.
 *
 * The Prisma stand-in really commits or discards each transaction (writes are staged and applied only when the callback
 * resolves), so rollback is tested, not assumed.
 */
const D = (v: string | number) => new Prisma.Decimal(v);

const admin = { id: 1, is_superuser: true, role: { name: 'SUPER_ADMIN' } };
const accountant = { id: 2, role: { name: 'ACCOUNTANT', permissions: ['MANAGE_INVOICES', 'MANAGE_EXPENSES'] } };
const invoiceOnly = { id: 3, role: { name: 'SALES', permissions: ['MANAGE_INVOICES', 'VIEW_LEADS'] } };
const portalClient = { id: 4, role: { name: 'CLIENT', permissions: ['MANAGE_INVOICES', 'MANAGE_EXPENSES'] } };

type Store = { payments: any[]; expenses: any[] };

const buildDb = (opts: { invoiceTotal?: string; clientDeleted?: boolean; failExpenseCreate?: boolean } = {}) => {
  const committed: Store = { payments: [], expenses: [] };
  const categories = [
    { id: 7, name: 'Bank Charges', deleted_at: null },
    { id: 8, name: 'Old category', deleted_at: new Date('2026-01-01') },
  ];
  const client = { id: 1, name: 'Client', deleted_at: opts.clientDeleted ? new Date('2026-01-01') : null };
  const invoiceBase = { id: 1, invoice_number: 'GSI/2026-27/001', client_id: 1, total: D(opts.invoiceTotal ?? '1000.00'), advance: D('0.00') };
  let nextPaymentId = 900;
  let nextExpenseId = 500;

  const view = (staged: Store) => ({
    $queryRaw: jest.fn().mockResolvedValue([]),
    invoice: {
      findUnique: jest.fn(async ({ where, include, select }: any) => {
        if (where.id !== 1) return null;
        const payments = [...committed.payments, ...staged.payments];
        if (select) return { client_id: invoiceBase.client_id, client: { deleted_at: client.deleted_at } };
        return { ...invoiceBase, ...(include?.payments ? { payments } : {}) };
      }),
    },
    client: { findUnique: jest.fn(async ({ where }: any) => (where.id === client.id ? client : null)) },
    project: { findUnique: jest.fn(async () => null) },
    expenseCategory: { findUnique: jest.fn(async ({ where }: any) => categories.find((c) => c.id === where.id) ?? null) },
    invoicePayment: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: nextPaymentId++, receipt_number: null, created_at: new Date(), ...data };
        staged.payments.push(row);
        return row;
      }),
    },
    expense: {
      create: jest.fn(async ({ data }: any) => {
        if (opts.failExpenseCreate) throw new Error('expense insert failed');
        const row = { id: nextExpenseId++, ...data };
        staged.expenses.push(row);
        return row;
      }),
    },
  });

  const prisma: any = view({ payments: [], expenses: [] });
  prisma.$transaction = jest.fn(async (cb: any) => {
    const staged: Store = { payments: [], expenses: [] };
    const result = await cb(view(staged)); // throws = nothing staged is applied (rollback)
    committed.payments.push(...staged.payments);
    committed.expenses.push(...staged.expenses);
    return result;
  });
  return { prisma, committed };
};

const expense = (extra: any = {}) => ({
  title: 'Gateway fee',
  category_id: 7,
  amount: 250,
  payment_method: 'upi',
  vendor: 'Razorpay',
  notes: 'Fee on this payment',
  ...extra,
});

describe('Invoice payment with optional expense', () => {
  let db: ReturnType<typeof buildDb>;
  let payments: InvoicePaymentsService;

  const setup = async (opts?: Parameters<typeof buildDb>[0]) => {
    db = buildDb(opts);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicePaymentsService,
        { provide: PrismaService, useValue: db.prisma },
        { provide: PdfService, useValue: {} },
        { provide: MailerService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();
    payments = module.get(InvoicePaymentsService);
  };

  beforeEach(() => setup());

  it('payment without expense: existing behaviour, no expense, no expense in the response', async () => {
    for (const exp of [undefined, null, false]) {
      await setup();
      const res: any = await payments.create(accountant, { invoice: 1, amount: 400, payment_mode: 'bank', payment_date: '2026-11-10', expense: exp });
      expect(db.committed.payments).toHaveLength(1);
      expect(db.committed.expenses).toHaveLength(0);
      expect(res.expense).toBeUndefined();
      expect(res).toMatchObject({ amount: 400, payment_mode: 'bank' });
    }
    // A user without MANAGE_EXPENSES can still add a plain payment
    await setup();
    await payments.create(invoiceOnly, { invoice: 1, amount: 100 });
    expect(db.committed.payments).toHaveLength(1);
  });

  it('payment with expense: both created; separate amount; linked to the invoice and its client on the server', async () => {
    const res: any = await payments.create(accountant, {
      invoice: 1, amount: 400, payment_mode: 'bank', payment_date: '2026-11-10', notes: 'Part payment',
      expense: expense(),
    });
    expect(db.committed.payments).toHaveLength(1);
    expect(db.committed.expenses).toHaveLength(1);
    const [p] = db.committed.payments;
    const [e] = db.committed.expenses;
    // The payment is exactly as without an expense
    expect(Number(p.amount)).toBe(400);
    expect(p).toMatchObject({ invoice_id: 1, payment_mode: 'bank', notes: 'Part payment' });
    // The expense: its own amount (never the payment amount), already paid, existing approval default
    expect(e).toMatchObject({
      title: 'Gateway fee', category_id: 7, amount: 250, amount_paid: 250, outstanding_amount: 0, payment_status: 'paid',
      payment_method: 'upi', vendor: 'Razorpay', notes: 'Fee on this payment', invoice_id: 1, client_id: 1,
      approval_status: 'approved', created_by_id: 2,
    });
    // Expense date defaults to the payment date
    expect(e.expense_date.toISOString().slice(0, 10)).toBe('2026-11-10');
    expect(res.expense).toMatchObject({ id: e.id, title: 'Gateway fee', amount: 250 });
  });

  it('uses an explicit expense date when given', async () => {
    await payments.create(accountant, { invoice: 1, amount: 100, payment_date: '2026-11-10', expense: expense({ expense_date: '2026-11-08' }) });
    expect(db.committed.expenses[0].expense_date.toISOString().slice(0, 10)).toBe('2026-11-08');
  });

  it('never trusts client-supplied links, amount paid or approval', async () => {
    await payments.create(accountant, {
      invoice: 1, amount: 100,
      expense: expense({ invoice_id: 99, client_id: 42, project_id: 5, amount_paid: 0, payment_status: 'pending', approval_status: 'pending', created_by_id: 77 }),
    });
    expect(db.committed.expenses[0]).toMatchObject({
      invoice_id: 1, client_id: 1, project_id: null, amount_paid: 250, payment_status: 'paid', approval_status: 'approved', created_by_id: 2,
    });
  });

  it.each([
    ['missing category', { category_id: undefined }],
    ['unknown category', { category_id: 999 }],
    ['deleted category', { category_id: 8 }],
  ])('invalid expense category (%s): neither record is created', async (_n, extra) => {
    await expect(payments.create(accountant, { invoice: 1, amount: 100, expense: expense(extra) })).rejects.toThrow(BadRequestException);
    expect(db.committed.payments).toHaveLength(0);
    expect(db.committed.expenses).toHaveLength(0);
  });

  it.each([0, -5, 'abc', '', null])('invalid expense amount %p: neither record is created', async (amount) => {
    await expect(payments.create(accountant, { invoice: 1, amount: 100, expense: expense({ amount }) })).rejects.toThrow(BadRequestException);
    expect(db.committed.payments).toHaveLength(0);
    expect(db.committed.expenses).toHaveLength(0);
  });

  it.each([
    ['missing title', { title: '  ' }],
    ['missing payment method', { payment_method: undefined }],
    ['invoice payment mode instead of expense method', { payment_method: 'bank' }],
    ['invalid date', { expense_date: 'not-a-date' }],
  ])('invalid expense (%s): neither record is created', async (_n, extra) => {
    await expect(payments.create(accountant, { invoice: 1, amount: 100, expense: expense(extra) })).rejects.toThrow(BadRequestException);
    expect(db.committed.payments).toHaveLength(0);
    expect(db.committed.expenses).toHaveLength(0);
  });

  it('rejects a malformed expense value', async () => {
    for (const bad of ['yes', 1, true, []]) {
      await expect(payments.create(accountant, { invoice: 1, amount: 100, expense: bad })).rejects.toThrow(BadRequestException);
    }
    expect(db.committed.payments).toHaveLength(0);
  });

  it('without MANAGE_EXPENSES the expense is refused (403) and the payment is not created either', async () => {
    await expect(payments.create(invoiceOnly, { invoice: 1, amount: 100, expense: expense() })).rejects.toThrow(ForbiddenException);
    expect(db.committed.payments).toHaveLength(0);
    expect(db.committed.expenses).toHaveLength(0);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('super admins pass the expense permission check', async () => {
    await payments.create(admin, { invoice: 1, amount: 100, expense: expense() });
    expect(db.committed.expenses).toHaveLength(1);
  });

  it('client portal users remain blocked, with or without an expense', async () => {
    await expect(payments.create(portalClient, { invoice: 1, amount: 100, expense: expense() })).rejects.toThrow(ForbiddenException);
    await expect(payments.create(portalClient, { invoice: 1, amount: 100 })).rejects.toThrow(ForbiddenException);
    expect(db.committed.payments).toHaveLength(0);
    expect(db.committed.expenses).toHaveLength(0);
  });

  it('invoice payment validation failure (over the balance): neither record is created', async () => {
    await expect(payments.create(accountant, { invoice: 1, amount: 1000.01, expense: expense() })).rejects.toThrow(BadRequestException);
    expect(db.committed.payments).toHaveLength(0);
    expect(db.committed.expenses).toHaveLength(0);
  });

  it('expense creation failure: the payment is rolled back', async () => {
    await setup({ failExpenseCreate: true });
    await expect(payments.create(accountant, { invoice: 1, amount: 100, expense: expense() })).rejects.toThrow('expense insert failed');
    expect(db.committed.payments).toHaveLength(0);
    expect(db.committed.expenses).toHaveLength(0);
  });

  it('partial and multiple payments: each expense is separate and never changes the invoice balance', async () => {
    await payments.create(accountant, { invoice: 1, amount: 300, expense: expense({ amount: 20 }) });
    await payments.create(accountant, { invoice: 1, amount: 300 });
    await payments.create(accountant, { invoice: 1, amount: 400, expense: expense({ amount: 35.5, title: 'Courier' }) });
    expect(db.committed.payments.map((p) => Number(p.amount))).toEqual([300, 300, 400]);
    expect(db.committed.expenses.map((e) => [e.title, e.amount])).toEqual([['Gateway fee', 20], ['Courier', 35.5]]);
    // Fully paid by payments alone (1000): expenses did not count towards it
    await expect(payments.create(accountant, { invoice: 1, amount: 0.01, expense: expense() })).rejects.toThrow(BadRequestException);
    expect(db.committed.payments).toHaveLength(3);
    expect(db.committed.expenses).toHaveLength(2);
  });

  it('repeated submission cannot overpay; a rejected repeat creates neither record', async () => {
    const body = { invoice: 1, amount: 1000, expense: expense() };
    await payments.create(accountant, body);
    await expect(payments.create(accountant, body)).rejects.toThrow(BadRequestException);
    expect(db.committed.payments).toHaveLength(1);
    expect(db.committed.expenses).toHaveLength(1);
  });

  it('an invoice whose client was deleted still records the expense, linked to the invoice only', async () => {
    await setup({ clientDeleted: true });
    await payments.create(accountant, { invoice: 1, amount: 100, expense: expense() });
    expect(db.committed.expenses[0]).toMatchObject({ invoice_id: 1, client_id: null });
  });
});

describe('Existing expense creation is unchanged (shared rules)', () => {
  const user = { id: 9 };
  const makeService = async (prisma: any) => {
    const module = await Test.createTestingModule({ providers: [ExpensesService, { provide: PrismaService, useValue: prisma }] }).compile();
    return module.get(ExpensesService);
  };
  const prismaFor = () => ({
    expenseCategory: { findUnique: jest.fn(async ({ where }: any) => (where.id === 7 ? { id: 7, deleted_at: null } : null)), upsert: jest.fn() },
    client: { findUnique: jest.fn() },
    project: { findUnique: jest.fn() },
    invoice: { findUnique: jest.fn() },
    expense: { create: jest.fn(async ({ data }: any) => ({ id: 1, ...data })) },
  });

  it('a pending expense with a partial amount paid gets the same derived values as before', async () => {
    const prisma = prismaFor();
    const service = await makeService(prisma);
    const res: any = await service.create(user, { title: ' Rent ', category_id: '7', amount: '1000', amount_paid: '400', expense_date: '2026-11-01' } as any);
    expect(prisma.expense.create.mock.calls[0][0].data).toMatchObject({
      title: 'Rent', category_id: 7, amount: 1000, amount_paid: 400, outstanding_amount: 600, payment_status: 'partially_paid',
      payment_method: 'cash', approval_status: 'approved', created_by_id: 9, invoice_id: null, client_id: null, receipt_file: null,
    });
    expect(res).toMatchObject({ amount: 1000, payment_status: 'partially_paid' });
  });

  it('defaults: paid in full when no amount paid is given; invalid input is still rejected with the same messages', async () => {
    const prisma = prismaFor();
    const service = await makeService(prisma);
    await service.create(user, { title: 'Fee', category_id: 7, amount: 50, expense_date: '2026-11-01' } as any);
    expect(prisma.expense.create.mock.calls[0][0].data).toMatchObject({ amount_paid: 50, payment_status: 'paid' });
    await expect(service.create(user, { title: 'x', category_id: 99, amount: 5 } as any)).rejects.toThrow('Invalid expense category specified.');
    await expect(service.create(user, { title: 'x', category_id: 7, amount: 0 } as any)).rejects.toThrow('Amount must be a positive number.');
    await expect(service.create(user, { title: 'x', category_id: 7, amount: 5, amount_paid: 6 } as any)).rejects.toThrow('Amount paid cannot exceed total expense amount.');
    expect(prisma.expense.create).toHaveBeenCalledTimes(1);
  });
});
