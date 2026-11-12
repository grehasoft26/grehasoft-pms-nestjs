import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';

/**
 * Invoice summary cash flow (GET /invoices/analytics): period_collections (payments RECEIVED in the month, by
 * payment_date), period_expenses (Expense.amount_paid by expense_date, not deleted, not rejected) and period_profit.
 * Only for users who may see company expenses; never for client-portal users. The existing cards are unchanged.
 *
 * The aggregate stand-in applies the same where-conditions Prisma would (date range, deleted_at, approval_status).
 */
const D = (v: string | number) => new Prisma.Decimal(v);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

const INVOICES = [
  // October invoice paid partly in October and partly in November
  { id: 1, invoice_number: 'OCT', client_id: 1, issue_date: day('2026-10-20'), due_date: null, total: D('3000.00'), advance: D('0.00'),
    payments: [{ amount: D('1000.00') }, { amount: D('500.00') }] },
  { id: 2, invoice_number: 'NOV', client_id: 1, issue_date: day('2026-11-05'), due_date: null, total: D('2000.00'), advance: D('0.00'),
    payments: [{ amount: D('700.00') }, { amount: D('300.00') }] },
];

const PAYMENTS = [
  { invoice_id: 1, amount: D('1000.00'), payment_date: day('2026-10-25') },
  { invoice_id: 1, amount: D('500.00'), payment_date: day('2026-11-02') }, // October invoice, received in November
  { invoice_id: 2, amount: D('700.00'), payment_date: day('2026-11-30') }, // last day of November
  { invoice_id: 2, amount: D('300.00'), payment_date: day('2026-12-01') }, // first day of December
  { invoice_id: 9, amount: D('400.00'), payment_date: day('2026-12-31') }, // last day of the year
  { invoice_id: 9, amount: D('250.00'), payment_date: day('2027-01-01') }, // first day of the next year
];

const EXPENSES = [
  { id: 1, title: 'Manual', amount: D('800.00'), amount_paid: D('800.00'), expense_date: day('2026-11-01'), approval_status: 'approved', deleted_at: null, invoice_id: null },
  { id: 2, title: 'From payment', amount: D('600.00'), amount_paid: D('600.00'), expense_date: day('2026-11-15'), approval_status: 'approved', deleted_at: null, invoice_id: 2 },
  { id: 3, title: 'Deleted', amount: D('900.00'), amount_paid: D('900.00'), expense_date: day('2026-11-10'), approval_status: 'approved', deleted_at: day('2026-11-12'), invoice_id: null },
  { id: 4, title: 'Rejected', amount: D('1000.00'), amount_paid: D('1000.00'), expense_date: day('2026-11-11'), approval_status: 'rejected', deleted_at: null, invoice_id: null },
  { id: 5, title: 'Pending, part paid', amount: D('1000.00'), amount_paid: D('250.00'), expense_date: day('2026-11-20'), approval_status: 'pending', deleted_at: null, invoice_id: null },
  { id: 6, title: 'Unpaid', amount: D('400.00'), amount_paid: D('0.00'), expense_date: day('2026-11-21'), approval_status: 'approved', deleted_at: null, invoice_id: null },
  { id: 7, title: 'December', amount: D('100.00'), amount_paid: D('100.00'), expense_date: day('2026-12-31'), approval_status: 'approved', deleted_at: null, invoice_id: null },
  { id: 8, title: 'January', amount: D('50.00'), amount_paid: D('50.00'), expense_date: day('2027-01-01'), approval_status: 'approved', deleted_at: null, invoice_id: null },
];

const inRange = (value: Date, range: any) => !range || (value >= range.gte && value < range.lt);
const sum = (rows: any[], key: string) => (rows.length ? rows.reduce((a, r) => a.plus(r[key]), D(0)) : null);

const buildPrisma = (data = { payments: PAYMENTS, expenses: EXPENSES }) => ({
  client: { findFirst: jest.fn(async () => ({ id: 1 })) },
  invoice: {
    findMany: jest.fn(async ({ where = {}, select }: any = {}) => {
      const found = INVOICES.filter((i) => inRange(i.issue_date, where.issue_date)).filter((i) => where.client_id === undefined || i.client_id === where.client_id);
      return select ? found.map((r: any) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))) : found;
    }),
  },
  invoicePayment: {
    aggregate: jest.fn(async ({ where }: any) => ({ _sum: { amount: sum(data.payments.filter((p) => inRange(p.payment_date, where.payment_date)), 'amount') } })),
  },
  expense: {
    aggregate: jest.fn(async ({ where }: any) => {
      const rows = data.expenses
        .filter((e) => (where.deleted_at === null ? e.deleted_at === null : true))
        .filter((e) => (where.approval_status?.not ? e.approval_status !== where.approval_status.not : true))
        .filter((e) => inRange(e.expense_date, where.expense_date));
      return { _sum: { amount_paid: sum(rows, 'amount_paid') } };
    }),
  },
});

const superAdmin = { id: 1, is_superuser: true, role: { name: 'SUPER_ADMIN' } };
const withPerms = (name: string, permissions: string[]) => ({ id: 2, role: { name, permissions } });

describe('Invoice summary: collections, expenses and profit of the selected month', () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof buildPrisma>;

  const compile = async (data?: Parameters<typeof buildPrisma>[0]) => {
    prisma = buildPrisma(data);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: PdfService, useValue: {} },
        { provide: MailerService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();
    service = module.get(InvoicesService);
  };
  const cash = async (month?: string, user: any = superAdmin) => {
    const a: any = await service.getAnalytics(user, month ? { month } : {});
    return { collections: a.period_collections, expenses: a.period_expenses, profit: a.period_profit, a };
  };

  beforeEach(() => compile());

  it('collections are payments received in the month (payment date), the same figure as the Payments Received card', async () => {
    const nov = await cash('2026-11');
    // 500 (October invoice, received 2 Nov) + 700 (received 30 Nov); not the 300 received 1 Dec
    expect(nov.collections).toBe(1200);
    expect(nov.a.total_paid).toBe(1200);
    const oct = await cash('2026-10');
    expect(oct.collections).toBe(1000);
    expect(oct.a.total_paid).toBe(1000); // the 500 received in November is November's, not the October invoice's month
  });

  it('expenses: amount_paid by expense date; deleted and rejected excluded; pending counts only what was paid; manual and payment-linked alike', async () => {
    // 800 (manual) + 600 (from a payment) + 250 (pending, part paid) + 0 (unpaid); not 900 (deleted) or 1000 (rejected)
    expect((await cash('2026-11')).expenses).toBe(1650);
  });

  it('profit = collections − expenses, and may be negative', async () => {
    const nov = await cash('2026-11');
    expect(nov.profit).toBe(1200 - 1650);
    expect(nov.profit).toBe(-450);
    expect((await cash('2026-10')).profit).toBe(1000);
  });

  it('month boundaries: first and last day, December to January', async () => {
    expect(await cash('2026-12')).toMatchObject({ collections: 300 + 400, expenses: 100, profit: 600 });
    expect(await cash('2027-01')).toMatchObject({ collections: 250, expenses: 50, profit: 200 });
    // The month filter is the date-only range [first day, first day of the next month)
    const call = prisma.invoicePayment.aggregate.mock.calls.at(-1)[0];
    expect(call.where.payment_date).toEqual({ gte: day('2027-01-01'), lt: day('2027-02-01') });
    expect(prisma.expense.aggregate.mock.calls.at(-1)[0].where).toEqual({
      deleted_at: null, approval_status: { not: 'rejected' }, expense_date: { gte: day('2027-01-01'), lt: day('2027-02-01') },
    });
  });

  it('All Months: everything, with the same exclusions', async () => {
    const all = await cash();
    expect(all).toMatchObject({ collections: 1000 + 500 + 700 + 300 + 400 + 250, expenses: 800 + 600 + 250 + 100 + 50 });
    expect(all.profit).toBe(3150 - 1800);
    expect(prisma.invoicePayment.aggregate.mock.calls.at(-1)[0].where).toEqual({});
  });

  it('an empty month is zero, not null; exact paise arithmetic', async () => {
    expect(await cash('2026-05')).toMatchObject({ collections: 0, expenses: 0, profit: 0 });
    await compile({
      payments: [{ invoice_id: 1, amount: D('0.10'), payment_date: day('2026-11-01') }, { invoice_id: 1, amount: D('0.20'), payment_date: day('2026-11-02') }],
      expenses: [{ ...EXPENSES[0], amount_paid: D('0.10') }],
    });
    expect(await cash('2026-11')).toMatchObject({ collections: 0.3, expenses: 0.1, profit: 0.2 });
  });

  it('payments received are computed once and shared with collections; one expense aggregate', async () => {
    await cash('2026-11');
    expect(prisma.invoicePayment.aggregate).toHaveBeenCalledTimes(1);
    expect(prisma.expense.aggregate).toHaveBeenCalledTimes(1);
    // The card query + the legacy-advance query
    expect(prisma.invoice.findMany).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['VIEW_EXPENSES', ['VIEW_INVOICES', 'VIEW_EXPENSES']],
    ['MANAGE_EXPENSES', ['MANAGE_INVOICES', 'MANAGE_EXPENSES']],
    ['VIEW_FINANCIAL_REPORTS', ['VIEW_INVOICES', 'VIEW_FINANCIAL_REPORTS']],
  ])('visible with %s', async (_p, permissions) => {
    expect((await cash('2026-11', withPerms('ACCOUNTANT', permissions))).profit).toBe(-450);
  });

  it('null for users without those permissions; the existing cards are identical for them', async () => {
    const forAdmin = await cash('2026-11');
    const forSales = await cash('2026-11', withPerms('SALES', ['MANAGE_INVOICES', 'VIEW_LEADS']));
    expect(forSales).toMatchObject({ collections: null, expenses: null, profit: null });
    const existing = (a: any) => [a.total_invoices, a.total_revenue, a.total_paid, a.total_balance, a.total_overpaid, a.overdue_count, a.overdue_balance, a.period];
    expect(existing(forSales.a)).toEqual(existing(forAdmin.a));
    // Payments Received is for every invoice reader; expenses only for the admin
    expect(prisma.invoicePayment.aggregate).toHaveBeenCalledTimes(2);
    expect(prisma.expense.aggregate).toHaveBeenCalledTimes(1);
  });

  it('never for client-portal users, even with a matching permission in their role', async () => {
    const client = await cash('2026-11', withPerms('CLIENT', ['VIEW_INVOICES', 'VIEW_FINANCIAL_REPORTS', 'VIEW_EXPENSES']));
    expect(client).toMatchObject({ collections: null, expenses: null, profit: null });
    // Their own Payments Received only (client-scoped); company expenses are never queried
    expect(prisma.invoicePayment.aggregate).toHaveBeenCalledTimes(1);
    expect(prisma.invoicePayment.aggregate.mock.calls[0][0].where.invoice).toEqual({ client_id: 1 });
    expect(prisma.expense.aggregate).not.toHaveBeenCalled();
  });

  it('a deleted role grants nothing', async () => {
    const user = { id: 3, role: { name: 'ACCOUNTANT', permissions: ['VIEW_EXPENSES'], deleted_at: new Date() } };
    expect(await cash('2026-11', user)).toMatchObject({ collections: null, expenses: null, profit: null });
  });
});
