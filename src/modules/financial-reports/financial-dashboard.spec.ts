import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { FinancialReportsService } from './financial-reports.service';
import { InvoicesService } from '../invoices/invoices.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';
import { INITIAL_PAYMENT_NOTE } from '../invoices/invoice-status';

/**
 * Financial Dashboard (GET /financial/dashboard) on the shared financial rules (Phase 2C):
 * Asia/Kolkata months; revenue by issue date; collections by payment date plus counted legacy advances on the issue
 * date; eligible expenses (not deleted, not rejected) for paid, trend and categories; all-time computed pending;
 * outstanding collections unchanged (same as the Invoices page); six parallel queries; exact paise.
 * The Prisma stand-in applies the same where/select the real queries use.
 */
const D = (v: string | number) => new Prisma.Decimal(v);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
type Data = { invoices: any[]; payments: any[]; expenses: any[] };

const inRange = (v: Date, r: any) => !r || ((!r.gte || v >= r.gte) && (!r.lt || v < r.lt) && (!r.lte || v <= r.lte));
const sumDec = (rows: any[], key: string) => rows.reduce((s, r) => s.plus(r[key]), D(0));

const buildPrisma = (data: Data) => {
  const paymentsOf = (id: number) => data.payments.filter((p) => p.invoice_id === id);
  const invoiceRow = (i: any, select?: any) => {
    if (!select) return { ...i, payments: paymentsOf(i.id) };
    const out: any = {};
    for (const k of Object.keys(select)) {
      if (k === 'payments') {
        const nested = select.payments === true ? null : select.payments;
        out.payments = paymentsOf(i.id)
          .filter((p) => !nested?.where?.notes || p.notes === nested.where.notes)
          .map((p) => (nested?.select ? Object.fromEntries(Object.keys(nested.select).map((pk) => [pk, p[pk]])) : p));
      } else if (k === 'client') out.client = { name: 'Acme' };
      else out[k] = i[k];
    }
    return out;
  };
  const eligible = (e: any, where: any) =>
    (!('deleted_at' in where) || e.deleted_at === null) && (!where.approval_status?.not || e.approval_status !== where.approval_status.not);
  return {
    invoice: {
      findMany: jest.fn(async ({ where = {}, select }: any = {}) =>
        data.invoices
          .filter((i) => inRange(i.issue_date, where.issue_date))
          .filter((i) => !where.advance || Number(i.advance) > 0)
          .map((i) => invoiceRow(i, select)),
      ),
      count: jest.fn(async () => data.invoices.length),
    },
    invoicePayment: {
      findMany: jest.fn(async ({ where = {}, include }: any = {}) =>
        data.payments
          .filter((p) => inRange(p.payment_date, where.payment_date))
          .map((p) => (include?.invoice ? { ...p, invoice: { ...data.invoices.find((i) => i.id === p.invoice_id), client: { name: 'Acme' } } } : p)),
      ),
      aggregate: jest.fn(async ({ where = {} }: any = {}) => ({ _sum: { amount: sumDec(data.payments.filter((p) => inRange(p.payment_date, where.payment_date)), 'amount') } })),
    },
    expense: {
      findMany: jest.fn(async ({ where = {}, select, include }: any = {}) =>
        data.expenses
          .filter((e) => inRange(e.expense_date, where.expense_date) && eligible(e, where))
          .map((e) => {
            const row = { ...e, category: { name: e.category_name } };
            if (include?.category) return row;
            return select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k as keyof typeof row]])) : row;
          }),
      ),
      aggregate: jest.fn(async ({ where = {} }: any = {}) => ({
        _sum: { amount_paid: sumDec(data.expenses.filter((e) => inRange(e.expense_date, where.expense_date) && eligible(e, where)), 'amount_paid') },
      })),
    },
    project: { findMany: jest.fn(async () => []) },
  };
};

let nextId = 900;
const invoice = (issue: string, total: string | number, extra: any = {}) => ({
  id: nextId++, invoice_number: `GSI/2026-27/${nextId}`, client_id: 1, issue_date: day(issue), due_date: null, total: D(total), advance: D(0), ...extra,
});
const payment = (inv: any, date: string, amount: string | number, notes = '') => ({
  id: nextId++, invoice_id: inv.id, receipt_number: `RCT-${nextId}`, payment_date: day(date), payment_mode: 'bank', amount: D(amount), notes,
});
const expense = (date: string, amount: string | number, paid: string | number, extra: any = {}) => ({
  id: nextId++, title: 'Hosting', expense_date: day(date), vendor: 'AWS', payment_method: 'upi', amount: D(amount), amount_paid: D(paid),
  outstanding_amount: D(0), payment_status: 'paid', deleted_at: null, approval_status: 'approved', category_id: 1, category_name: 'Hosting', ...extra,
});

const setup = async (data: Data) => {
  const prisma = buildPrisma(data);
  const module = await Test.createTestingModule({
    providers: [
      FinancialReportsService,
      InvoicesService,
      { provide: PrismaService, useValue: prisma },
      { provide: PdfService, useValue: {} },
      { provide: MailerService, useValue: {} },
      { provide: ConfigService, useValue: { get: jest.fn() } },
    ],
  }).compile();
  return { svc: module.get(FinancialReportsService), invoices: module.get(InvoicesService), prisma };
};
const dashboard = async (data: Data) => (await (await setup(data)).svc.getDashboardData({ id: 1 })) as any;
const at = (iso: string) => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.setSystemTime(new Date(iso));
};
const empty: Data = { invoices: [], payments: [], expenses: [] };

describe('Financial Dashboard', () => {
  beforeEach(() => at('2026-11-19T06:00:00Z')); // 19 Nov 2026, IST
  afterEach(() => jest.useRealTimers());

  it('months follow Asia/Kolkata: 00:30 IST on 1 December is December (last month November)', async () => {
    at('2026-11-30T19:00:00Z');
    const inv = invoice('2026-12-01', '100.00');
    const res = await dashboard({ invoices: [inv, invoice('2026-11-30', '40.00')], payments: [], expenses: [] });
    expect(res.summary.invoice_revenue_this_month).toBe(100);
    expect(res.summary.invoice_revenue_last_month).toBe(40);
    expect(res.visualizations.monthly_trends.map((t: any) => t.month_key)).toEqual(['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']);
  });

  it('00:30 IST on 1 January: January this month, December last month; the trend crosses the year', async () => {
    at('2026-12-31T19:00:00Z');
    const res = await dashboard({ invoices: [invoice('2026-12-15', '70.00'), invoice('2027-01-01', '30.00')], payments: [], expenses: [] });
    expect([res.summary.invoice_revenue_this_month, res.summary.invoice_revenue_last_month]).toEqual([30, 70]);
    expect(res.visualizations.monthly_trends.map((t: any) => [t.month_key, t.month])).toEqual([
      ['2026-08', 'Aug 2026'], ['2026-09', 'Sep 2026'], ['2026-10', 'Oct 2026'], ['2026-11', 'Nov 2026'], ['2026-12', 'Dec 2026'], ['2027-01', 'Jan 2027'],
    ]);
  });

  it('collections: payments by payment month, legacy advances by issue month, no duplicate with an initial-payment row', async () => {
    const legacy = invoice('2026-10-05', '1000.00', { advance: D('400.00') });
    const marked = invoice('2026-10-06', '1000.00', { advance: D('300.00') });
    const res = await dashboard({
      invoices: [legacy, marked],
      payments: [payment(marked, '2026-10-06', '300.00', INITIAL_PAYMENT_NOTE), payment(legacy, '2026-11-02', '600.00')],
      expenses: [],
    });
    expect(res.summary.customer_collections_last_month).toBe(700); // 400 advance + 300 initial-payment row
    expect(res.summary.customer_collections_this_month).toBe(600); // issued in October, paid in November
  });

  it('revenue: final totals (GST, after discount) of paid, partial and unpaid invoices by issue date; change and percentage', async () => {
    const gst = invoice('2026-11-02', '1100.00'); // 1000 + 180 GST − 80 discount
    const paid = invoice('2026-11-10', '500.00');
    const partial = invoice('2026-11-11', '300.00');
    const unpaid = invoice('2026-11-12', '100.00');
    const oct = invoice('2026-10-20', '1000.00');
    const res = await dashboard({
      invoices: [gst, paid, partial, unpaid, oct],
      payments: [payment(paid, '2026-11-15', '500.00'), payment(partial, '2026-12-01', '100.00'), payment(oct, '2026-11-01', '1000.00')],
      expenses: [],
    });
    expect(res.summary).toMatchObject({
      invoice_revenue_this_month: 2000, invoice_revenue_last_month: 1000, revenue_change: 1000, revenue_change_percentage: 100,
      customer_collections_this_month: 1500, // payment date, not issue date
    });
    // Negative change; zero base gives null (never 0)
    const down = await dashboard({ invoices: [invoice('2026-10-01', '300.00'), invoice('2026-11-01', '100.00')], payments: [], expenses: [] });
    expect([down.summary.revenue_change, down.summary.revenue_change_percentage]).toEqual([-200, -66.7]);
    const fromZero = await dashboard({ invoices: [invoice('2026-11-01', '100.00')], payments: [], expenses: [] });
    expect(fromZero.summary.revenue_change_percentage).toBeNull();
  });

  it('expenses: rejected and deleted excluded from paid, trend and categories; pending approval included', async () => {
    const res = await dashboard({
      invoices: [],
      payments: [],
      expenses: [
        expense('2026-11-05', 1000, 600, { category_name: 'Hosting' }),
        expense('2026-11-06', 500, 500, { approval_status: 'pending', category_name: 'Travel' }),
        expense('2026-11-07', 800, 800, { approval_status: 'rejected', category_name: 'Travel' }),
        expense('2026-11-08', 900, 900, { deleted_at: new Date('2026-11-09'), category_name: 'Hosting' }),
      ],
    });
    expect(res.summary.expenses_paid_this_month).toBe(1100);
    expect(res.visualizations.monthly_trends.at(-1).expenses).toBe(1100);
    expect(res.visualizations.category_breakdown).toEqual([
      { category_name: 'Hosting', amount: 600 },
      { category_name: 'Travel', amount: 500 },
    ]);
  });

  it('pending expenses: all-time, eligible only, computed (stale outstanding_amount and payment_status ignored)', async () => {
    const res = await dashboard({
      invoices: [],
      payments: [],
      expenses: [
        expense('2026-11-05', 1000, 600, { outstanding_amount: D('999.00'), payment_status: 'partially_paid' }), // owes 400
        expense('2026-11-06', 300, 100, { payment_status: 'paid' }), // stored as paid but still owes 200
        expense('2025-01-10', 250, 0, { payment_status: 'pending' }), // older month, still owed now: 250
        expense('2026-11-07', 800, 0, { approval_status: 'rejected', payment_status: 'pending' }),
        expense('2026-11-08', 900, 0, { deleted_at: new Date('2026-11-09'), payment_status: 'pending' }),
      ],
    });
    expect(res.summary.total_pending_expenses).toBe(850);
  });

  it('exact paise, empty months as zero, negative net cash flow kept', async () => {
    const a = invoice('2026-11-01', '0.10');
    const b = invoice('2026-11-02', '0.20');
    const res = await dashboard({
      invoices: [a, b],
      payments: [payment(a, '2026-11-03', '0.10'), payment(b, '2026-11-04', '0.20')],
      expenses: [expense('2026-11-05', '0.10', '0.10'), expense('2026-11-06', '0.20', '0.20'), expense('2026-10-01', 50, 50)],
    });
    expect([res.summary.invoice_revenue_this_month, res.summary.customer_collections_this_month, res.summary.expenses_paid_this_month, res.summary.net_cash_flow_this_month])
      .toEqual([0.3, 0.3, 0.3, 0]);
    expect(res.summary.net_cash_flow_last_month).toBe(-50);
    const trends = res.visualizations.monthly_trends;
    expect(trends).toHaveLength(6);
    expect(trends.slice(0, 4).every((t: any) => t.invoice_revenue === 0 && t.collections === 0 && t.expenses === 0 && t.net_cash_flow === 0)).toBe(true);
    const none = await dashboard(empty);
    expect(none.summary).toMatchObject({ invoice_revenue_this_month: 0, customer_collections_this_month: 0, total_outstanding_collections: 0, total_pending_expenses: 0 });
    expect(none.visualizations.category_breakdown).toEqual([]);
  });

  it('outstanding collections: unchanged calculation, equal to the Invoices page all-months total_balance', async () => {
    const legacy = invoice('2025-06-01', '1000.00', { advance: D('250.00') });
    const partial = invoice('2026-11-05', '799.99');
    const over = invoice('2026-09-01', '100.00');
    const data = {
      invoices: [legacy, partial, over],
      payments: [payment(legacy, '2025-07-01', '500.00'), payment(partial, '2026-11-06', '0.33'), payment(over, '2026-09-02', '150.00')],
      expenses: [],
    };
    const { svc, invoices } = await setup(data);
    const res: any = await svc.getDashboardData({ id: 1 });
    const analytics: any = await invoices.getAnalytics({ id: 1, is_superuser: true, role: { name: 'SUPER_ADMIN' } }, {});
    expect(res.summary.total_outstanding_collections).toBe(analytics.total_balance);
    expect(res.summary.total_outstanding_collections).toBe(1049.66); // 250 + 799.66 (overpaid invoice contributes 0)
  });

  it('pending collections this month: balances of invoices issued in the current Asia/Kolkata month only', async () => {
    at('2026-11-30T19:00:00Z'); // 1 Dec 2026, 00:30 IST: the current month is December
    const unpaid = invoice('2026-12-01', '1000.00'); // owes 1000
    const partial = invoice('2026-12-01', '799.99'); // 0.33 paid → owes 799.66
    const paid = invoice('2026-12-01', '500.00'); // fully paid → 0
    const over = invoice('2026-12-01', '100.00'); // overpaid → 0 (does not offset the others)
    const advance = invoice('2026-12-01', '400.00', { advance: D('150.00') }); // legacy advance → owes 250
    const lateNov = invoice('2026-11-30', '300.00'); // issued last month (IST), unpaid → excluded
    const oldUnpaid = invoice('2026-06-15', '2000.00'); // older unpaid → excluded from this month
    const data = {
      invoices: [unpaid, partial, paid, over, advance, lateNov, oldUnpaid],
      payments: [
        payment(partial, '2026-12-01', '0.33'),
        payment(paid, '2026-12-01', '500.00'),
        payment(over, '2026-12-01', '150.00'),
      ],
      expenses: [],
    };
    const { svc, invoices, prisma } = await setup(data);
    const res: any = await svc.getDashboardData({ id: 1 });
    // No extra query: still six (counted before the comparison calls below)
    const calls = prisma.invoice.findMany.mock.calls.length + prisma.invoicePayment.findMany.mock.calls.length + prisma.expense.findMany.mock.calls.length;
    expect(calls).toBe(6);
    expect(res.summary.outstanding_collections_this_month).toBe(2049.66); // 1000 + 799.66 + 0 + 0 + 250
    // Unchanged all-time figure: also includes last month's and older unpaid invoices
    expect(res.summary.total_outstanding_collections).toBe(4349.66); // 2049.66 + 300 + 2000
    // Same as the Invoices page Pending Amount for the current month and for All Months
    const admin = { id: 1, is_superuser: true, role: { name: 'SUPER_ADMIN' } };
    expect(res.summary.outstanding_collections_this_month).toBe(((await invoices.getAnalytics(admin, { month: '2026-12' })) as any).total_balance);
    expect(res.summary.total_outstanding_collections).toBe(((await invoices.getAnalytics(admin, {})) as any).total_balance);
  });

  it('pending collections this month: a payment made after the invoice month still reduces what is owed now', async () => {
    const nov = invoice('2026-11-05', '1000.00');
    const res = await dashboard({ invoices: [nov], payments: [payment(nov, '2026-12-10', '600.00')], expenses: [] });
    // Clock: 19 Nov 2026 (beforeEach); the December payment is already recorded, so November's invoice owes 400
    expect(res.summary.outstanding_collections_this_month).toBe(400);
    expect(res.summary.customer_collections_this_month).toBe(0); // collections still by payment date
  });

  it('keeps every old field, adds the new ones; cards equal the trend; categories sum to expenses paid; six queries', async () => {
    const inv = invoice('2026-11-02', '500.00');
    const { svc, prisma } = await setup({
      invoices: [inv, invoice('2026-10-02', '200.00')],
      payments: [payment(inv, '2026-11-03', '300.00')],
      expenses: [expense('2026-11-04', 100, 60, { category_name: 'A' }), expense('2026-11-05', 40, 40, { category_name: 'B' }), expense('2026-10-04', 10, 10)],
    });
    const res: any = await svc.getDashboardData({ id: 1 });
    expect(Object.keys(res.summary).sort()).toEqual([
      'customer_collections_last_month', 'customer_collections_this_month', 'expenses_paid_last_month', 'expenses_paid_this_month',
      'invoice_revenue_last_month', 'invoice_revenue_this_month', 'net_cash_flow_last_month', 'net_cash_flow_this_month', 'outstanding_collections_this_month',
      'revenue_change', 'revenue_change_percentage', 'total_outstanding_collections', 'total_pending_expenses',
    ]);
    expect(Object.keys(res.visualizations.monthly_trends[0]).sort()).toEqual(['collections', 'expenses', 'invoice_revenue', 'month', 'month_key', 'net_cash_flow']);
    expect(Object.keys(res.visualizations.category_breakdown[0]).sort()).toEqual(['amount', 'category_name']);
    const [last, current] = res.visualizations.monthly_trends.slice(-2);
    expect([current.invoice_revenue, current.collections, current.expenses, current.net_cash_flow]).toEqual([
      res.summary.invoice_revenue_this_month, res.summary.customer_collections_this_month, res.summary.expenses_paid_this_month, res.summary.net_cash_flow_this_month,
    ]);
    expect([last.invoice_revenue, last.collections, last.expenses, last.net_cash_flow]).toEqual([
      res.summary.invoice_revenue_last_month, res.summary.customer_collections_last_month, res.summary.expenses_paid_last_month, res.summary.net_cash_flow_last_month,
    ]);
    expect(res.visualizations.category_breakdown.reduce((s: number, c: any) => s + c.amount, 0)).toBe(res.summary.expenses_paid_this_month);
    const calls = prisma.invoice.findMany.mock.calls.length + prisma.invoicePayment.findMany.mock.calls.length + prisma.expense.findMany.mock.calls.length;
    expect(calls).toBe(6);
    // Outstanding query fetches only the fields it needs
    const outstandingCall = prisma.invoice.findMany.mock.calls.find((c: any[]) => !c[0]?.where);
    expect(outstandingCall[0].select).toEqual({ total: true, advance: true, issue_date: true, payments: { select: { amount: true } } });
  });

  it('reconciles with Income & Expense and Month Comparison for the same month, and pending with Income & Expense', async () => {
    const adv = invoice('2026-11-04', '1000.00', { advance: D('250.00') });
    const oct = invoice('2026-10-15', '1500.55');
    const data = {
      invoices: [adv, oct, invoice('2026-11-20', '999.99')],
      payments: [payment(oct, '2026-11-15', '1500.55'), payment(adv, '2026-11-25', '0.33')],
      expenses: [
        expense('2026-11-30', '75.25', '75.25'),
        expense('2026-11-10', '500.00', '200.00'),
        expense('2026-11-11', 999, 999, { approval_status: 'rejected' }),
        expense('2025-03-01', '40.00', '10.00'),
      ],
    };
    const { svc } = await setup(data);
    const dash: any = await svc.getDashboardData({ id: 1 });
    const ie: any = await svc.getIncomeExpenseStatement({ start_date: '2026-11-01', end_date: '2026-11-30' });
    const mc: any = (await svc.getMonthComparisonReport({ month1: '2026-11', month2: '2026-11' })).month1;
    const d = dash.summary;
    expect([d.invoice_revenue_this_month, d.customer_collections_this_month, d.expenses_paid_this_month, d.net_cash_flow_this_month]).toEqual([
      ie.summary.total_invoice_revenue, ie.summary.total_collections, ie.summary.total_expenses_paid, ie.summary.net_cash_flow,
    ]);
    expect([d.invoice_revenue_this_month, d.customer_collections_this_month, d.expenses_paid_this_month, d.net_cash_flow_this_month]).toEqual([
      mc.invoice_revenue, mc.collections, mc.expenses_paid, mc.net_cash_flow,
    ]);
    // All-time pending = Income & Expense pending over a range covering every expense
    const all: any = await svc.getIncomeExpenseStatement({ start_date: '2000-01-01', end_date: '2100-12-31' });
    expect(d.total_pending_expenses).toBe(all.summary.total_pending_expenses);
    expect(d.total_pending_expenses).toBe(330); // 300 + 30 (rejected excluded)
  });
});
