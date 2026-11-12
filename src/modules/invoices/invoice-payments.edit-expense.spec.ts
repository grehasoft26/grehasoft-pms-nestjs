import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { InvoicePaymentsService } from './invoice-payments.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';

/**
 * Invoice → Edit Payment → "Also record an expense": the payment update and the new expense are written in ONE
 * transaction, only with MANAGE_EXPENSES, linked to the payment (expenses.invoice_payment_id, unique) and to the invoice
 * and client from the server's records. A payment that already has an expense never gets a second one. A fully paid
 * invoice is allowed (no outstanding balance needed).
 *
 * The Prisma stand-in stages writes and applies them only when the transaction callback resolves (a throw = rollback),
 * and enforces the unique invoice_payment_id like the database (P2002).
 */
const D = (v: string | number) => new Prisma.Decimal(v);

const admin = { id: 1, is_superuser: true, role: { name: 'SUPER_ADMIN' } };
const accountant = { id: 2, role: { name: 'ACCOUNTANT', permissions: ['MANAGE_INVOICES', 'MANAGE_EXPENSES'] } };
const invoiceOnly = { id: 3, role: { name: 'SALES', permissions: ['MANAGE_INVOICES'] } };
const portalClient = { id: 4, role: { name: 'CLIENT', permissions: ['MANAGE_INVOICES', 'MANAGE_EXPENSES'] } };

type Staged = { payments: any[]; paymentUpdates: Map<number, any>; expenses: any[] };

const buildDb = (opts: { payments?: any[]; expenses?: any[]; failExpenseCreate?: boolean; raceDuplicate?: boolean } = {}) => {
  const committed = {
    // Invoice 1: total 1000, fully paid by payment 10 (600) + payment 11 (400)
    payments: (opts.payments ?? [
      { id: 10, invoice_id: 1, amount: D('600.00'), payment_date: new Date('2026-10-05'), payment_mode: 'bank', notes: 'First', receipt_number: null, created_at: new Date() },
      { id: 11, invoice_id: 1, amount: D('400.00'), payment_date: new Date('2026-11-02'), payment_mode: 'upi', notes: 'Second', receipt_number: null, created_at: new Date() },
    ]).map((p) => ({ ...p })),
    expenses: (opts.expenses ?? []).map((e) => ({ ...e })),
  };
  const categories = [{ id: 7, name: 'Bank Charges', deleted_at: null }];
  const invoiceBase = { id: 1, client_id: 1, total: D('1000.00'), advance: D('0.00') };
  let nextExpenseId = 500;

  const view = (staged: Staged) => {
    const paymentsNow = () => committed.payments.map((p) => ({ ...p, ...(staged.paymentUpdates.get(p.id) ?? {}) }));
    const expensesNow = () => [...committed.expenses, ...staged.expenses];
    return {
      $queryRaw: jest.fn().mockResolvedValue([]),
      invoice: {
        findUnique: jest.fn(async ({ where, include, select }: any) => {
          if (where.id !== 1) return null;
          if (select) return { client_id: 1, client: { deleted_at: null } };
          return { ...invoiceBase, ...(include?.payments ? { payments: paymentsNow() } : {}) };
        }),
      },
      client: { findUnique: jest.fn(async ({ where }: any) => (where.id === 1 ? { id: 1, deleted_at: null } : null)) },
      project: { findUnique: jest.fn(async () => null) },
      expenseCategory: { findUnique: jest.fn(async ({ where }: any) => categories.find((c) => c.id === where.id) ?? null) },
      invoicePayment: {
        findUnique: jest.fn(async ({ where }: any) => paymentsNow().find((p) => p.id === where.id) ?? null),
        update: jest.fn(async ({ where, data }: any) => {
          staged.paymentUpdates.set(where.id, { ...(staged.paymentUpdates.get(where.id) ?? {}), ...data });
          return paymentsNow().find((p) => p.id === where.id);
        }),
      },
      expense: {
        findUnique: jest.fn(async ({ where }: any) => {
          // raceDuplicate: another request links an expense after this check but before this insert
          if (opts.raceDuplicate) return null;
          return expensesNow().find((e) => e.invoice_payment_id === where.invoice_payment_id) ?? null;
        }),
        create: jest.fn(async ({ data }: any) => {
          if (opts.failExpenseCreate) throw new Error('expense insert failed');
          const clash = expensesNow().some((e) => data.invoice_payment_id != null && e.invoice_payment_id === data.invoice_payment_id)
            || (opts.raceDuplicate && data.invoice_payment_id != null);
          if (clash) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          const row = { id: nextExpenseId++, deleted_at: null, ...data };
          staged.expenses.push(row);
          return row;
        }),
      },
    };
  };

  const emptyStage = (): Staged => ({ payments: [], paymentUpdates: new Map(), expenses: [] });
  const prisma: any = view(emptyStage());
  prisma.$transaction = jest.fn(async (cb: any) => {
    const staged = emptyStage();
    const result = await cb(view(staged)); // a throw = nothing staged is applied
    for (const [id, data] of staged.paymentUpdates) Object.assign(committed.payments.find((p) => p.id === id), data);
    committed.payments.push(...staged.payments);
    committed.expenses.push(...staged.expenses);
    return result;
  });
  // Outside a transaction (plain update path) writes apply directly
  prisma.invoicePayment.update = jest.fn(async ({ where, data }: any) => {
    const row = committed.payments.find((p) => p.id === where.id);
    Object.assign(row, data);
    return row;
  });
  return { prisma, committed };
};

const expense = (extra: any = {}) => ({ title: 'Courier', category_id: 7, amount: 120, payment_method: 'cash', vendor: 'BlueDart', ...extra });

describe('Edit Payment with optional expense', () => {
  let db: ReturnType<typeof buildDb>;
  let service: InvoicePaymentsService;

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
    service = module.get(InvoicePaymentsService);
  };
  const payment = (id: number) => db.committed.payments.find((p) => p.id === id);

  beforeEach(() => setup());

  it('fully paid invoice: editing a payment records an expense linked to that payment, invoice and client', async () => {
    const res: any = await service.update(11, accountant, { amount: 400, payment_mode: 'upi', payment_date: '2026-11-02', notes: 'Second (edited)', expense: expense() });
    expect(db.committed.expenses).toHaveLength(1);
    const [e] = db.committed.expenses;
    expect(e).toMatchObject({
      invoice_payment_id: 11, invoice_id: 1, client_id: 1, title: 'Courier', amount: 120, amount_paid: 120, payment_status: 'paid',
      payment_method: 'cash', vendor: 'BlueDart', approval_status: 'approved', created_by_id: 2,
    });
    // Expense date defaults to the payment date
    expect(e.expense_date.toISOString().slice(0, 10)).toBe('2026-11-02');
    // The payment edit was applied too, amount unchanged
    expect(payment(11)).toMatchObject({ notes: 'Second (edited)' });
    expect(Number(payment(11).amount)).toBe(400);
    expect(res).toMatchObject({ id: 11, amount: 400, expense: { id: e.id, title: 'Courier', amount: 120 } });
  });

  it('the expense amount is its own (never copied from the payment) and an explicit date is kept', async () => {
    await service.update(10, accountant, { amount: 600, expense: expense({ amount: 35.5, expense_date: '2026-10-07' }) });
    const [e] = db.committed.expenses;
    expect(e.amount).toBe(35.5);
    expect(e.expense_date.toISOString().slice(0, 10)).toBe('2026-10-07');
    // Default expense date follows the payment date being saved
    await setup();
    await service.update(10, accountant, { payment_date: '2026-10-20', expense: expense() });
    expect(db.committed.expenses[0].expense_date.toISOString().slice(0, 10)).toBe('2026-10-20');
  });

  it('editing without an expense is unchanged: no transaction, no expense, no expense in the response', async () => {
    for (const exp of [undefined, null, false]) {
      await setup();
      const res: any = await service.update(11, invoiceOnly, { amount: 400, notes: 'Edited', expense: exp });
      expect(res.expense).toBeUndefined();
      expect(payment(11).notes).toBe('Edited');
      expect(db.committed.expenses).toHaveLength(0);
      expect(db.prisma.$transaction).not.toHaveBeenCalled();
    }
  });

  it('existing amount validation still applies: raising above the balance fails without an expense', async () => {
    await expect(service.update(11, accountant, { amount: 400.01 })).rejects.toThrow(BadRequestException);
    await expect(service.update(11, accountant, { amount: 400.01, expense: expense() })).rejects.toThrow(BadRequestException);
    expect(db.committed.expenses).toHaveLength(0);
    expect(Number(payment(11).amount)).toBe(400);
    // Lowering the amount with an expense is allowed and applied together
    await service.update(11, accountant, { amount: 300, expense: expense() });
    expect(Number(payment(11).amount)).toBe(300);
    expect(db.committed.expenses).toHaveLength(1);
  });

  it('without MANAGE_EXPENSES: 403, and the payment edit is not applied either', async () => {
    await expect(service.update(11, invoiceOnly, { notes: 'Changed', expense: expense() })).rejects.toThrow(ForbiddenException);
    expect(payment(11).notes).toBe('Second');
    expect(db.committed.expenses).toHaveLength(0);
  });

  it('super admins may record the expense; client portal users stay blocked', async () => {
    await expect(service.update(11, portalClient, { expense: expense() })).rejects.toThrow(ForbiddenException);
    await service.update(11, admin, { expense: expense() });
    expect(db.committed.expenses).toHaveLength(1);
  });

  it('duplicate prevention: a payment that already has an expense gets no second one (409), payment edit not applied', async () => {
    await service.update(11, accountant, { expense: expense() });
    await expect(service.update(11, accountant, { notes: 'Again', expense: expense({ title: 'Courier 2' }) })).rejects.toThrow(ConflictException);
    await expect(service.update(11, accountant, { expense: expense() })).rejects.toThrow(InvoicePaymentsService.EXPENSE_ALREADY_RECORDED);
    expect(db.committed.expenses).toHaveLength(1);
    expect(payment(11).notes).toBe('Second');
    // Another payment of the same invoice is independent
    await service.update(10, accountant, { expense: expense() });
    expect(db.committed.expenses.map((e) => e.invoice_payment_id)).toEqual([11, 10]);
  });

  it('a link to a deleted expense still counts: no replacement is created', async () => {
    await setup({ expenses: [{ id: 77, invoice_payment_id: 11, invoice_id: 1, deleted_at: new Date('2026-11-05') }] });
    await expect(service.update(11, accountant, { expense: expense() })).rejects.toThrow(ConflictException);
    expect(db.committed.expenses).toHaveLength(1);
  });

  it('concurrent duplicate (unique key violation at insert) is a conflict and rolls back the payment edit', async () => {
    await setup({ raceDuplicate: true });
    await expect(service.update(11, accountant, { notes: 'Race', expense: expense() })).rejects.toThrow(ConflictException);
    expect(payment(11).notes).toBe('Second');
    expect(db.committed.expenses).toHaveLength(0);
  });

  it('expense creation failure: rejected (no success response) and the payment edit is rolled back', async () => {
    await setup({ failExpenseCreate: true });
    await expect(service.update(11, accountant, { amount: 300, notes: 'X', expense: expense() })).rejects.toThrow('expense insert failed');
    expect(Number(payment(11).amount)).toBe(400);
    expect(payment(11).notes).toBe('Second');
  });

  it('invalid expense input: rejected before writing anything', async () => {
    for (const extra of [{ category_id: 999 }, { amount: 0 }, { title: ' ' }, { payment_method: 'bank' }]) {
      await expect(service.update(11, accountant, { notes: 'X', expense: expense(extra) })).rejects.toThrow(BadRequestException);
    }
    expect(payment(11).notes).toBe('Second');
    expect(db.committed.expenses).toHaveLength(0);
  });

  it('never trusts client-supplied links, payment link, amount paid or approval', async () => {
    await service.update(11, accountant, {
      expense: expense({ invoice_id: 99, client_id: 42, invoice_payment_id: 10, amount_paid: 0, approval_status: 'pending', created_by_id: 77 }),
    });
    expect(db.committed.expenses[0]).toMatchObject({
      invoice_payment_id: 11, invoice_id: 1, client_id: 1, amount_paid: 120, approval_status: 'approved', created_by_id: 2,
    });
  });
});

describe('Add Payment expense is linked to its new payment', () => {
  it('sets invoice_payment_id to the created payment, so Edit Payment cannot add a second one', async () => {
    const db = buildDb({ payments: [] });
    // Add-flow writes payments through the transaction's invoicePayment.create
    let nextId = 900;
    const origTx = db.prisma.$transaction;
    db.prisma.$transaction = jest.fn(async (cb: any) =>
      origTx(async (tx: any) => {
        tx.invoicePayment.create = jest.fn(async ({ data }: any) => {
          const row = { id: nextId++, receipt_number: null, created_at: new Date(), ...data };
          db.committed.payments.push(row); // visible for the later edit
          return row;
        });
        return cb(tx);
      }),
    );
    const module = await Test.createTestingModule({
      providers: [
        InvoicePaymentsService,
        { provide: PrismaService, useValue: db.prisma },
        { provide: PdfService, useValue: {} },
        { provide: MailerService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();
    const service = module.get(InvoicePaymentsService);

    const res: any = await service.create(accountant, { invoice: 1, amount: 500, payment_date: '2026-11-12', expense: expense() });
    expect(res.id).toBe(900);
    expect(db.committed.expenses).toHaveLength(1);
    expect(db.committed.expenses[0]).toMatchObject({ invoice_payment_id: 900, invoice_id: 1 });

    await expect(service.update(900, accountant, { expense: expense() })).rejects.toThrow(ConflictException);
    expect(db.committed.expenses).toHaveLength(1);
  });
});
