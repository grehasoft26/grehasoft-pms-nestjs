import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { FinancialReportsService } from './financial-reports.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { INITIAL_PAYMENT_NOTE } from '../invoices/invoice-status';

/**
 * Income & Expense statement (GET /financial/reports/income-expense, and CSV type=income-expense) on the shared
 * financial rules: revenue by issue date, collections by payment date plus legacy advances (itemised as their own
 * rows), eligible expenses only (not deleted, not rejected), computed pending, exact paise, inclusive API end date.
 * The Prisma stand-in applies the same where/select/include the real queries use.
 */
const D = (v: string | number) => new Prisma.Decimal(v);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
type Data = { invoices: any[]; payments: any[]; expenses: any[] };

const inRange = (v: Date, r: any) => !r || ((!r.gte || v >= r.gte) && (!r.lt || v < r.lt) && (!r.lte || v <= r.lte));
const client = { id: 1, name: 'Acme' };

const buildPrisma = (data: Data) => {
  const invoiceRow = (i: any, select?: any) => {
    if (!select) return i;
    const out: any = {};
    for (const k of Object.keys(select)) {
      if (k === 'payments') {
        out.payments = data.payments
          .filter((p) => p.invoice_id === i.id && (!select.payments.where?.notes || p.notes === select.payments.where.notes))
          .map((p) => ({ id: p.id, notes: p.notes }));
      } else if (k === 'client') out.client = { name: client.name };
      else out[k] = i[k];
    }
    return out;
  };
  return {
    invoice: {
      findMany: jest.fn(async ({ where = {}, select }: any) =>
        data.invoices
          .filter((i) => inRange(i.issue_date, where.issue_date))
          .filter((i) => !where.advance || Number(i.advance) > 0)
          .map((i) => invoiceRow(i, select)),
      ),
    },
    invoicePayment: {
      findMany: jest.fn(async ({ where = {}, include }: any) =>
        data.payments
          .filter((p) => inRange(p.payment_date, where.payment_date))
          .map((p) => (include?.invoice ? { ...p, invoice: { ...data.invoices.find((i) => i.id === p.invoice_id), client } } : p)),
      ),
    },
    expense: {
      findMany: jest.fn(async ({ where = {}, include }: any) =>
        data.expenses
          .filter((e) => inRange(e.expense_date, where.expense_date))
          .filter((e) => !('deleted_at' in where) || e.deleted_at === null)
          .filter((e) => !where.approval_status?.not || e.approval_status !== where.approval_status.not)
          .map((e) => (include?.category ? { ...e, category: { name: 'Bank Charges' } } : e)),
      ),
    },
    project: { findMany: jest.fn(async () => []) },
  };
};

let nextId = 100;
const invoice = (issue: string, total: string | number, extra: any = {}) => ({
  id: nextId++, invoice_number: `GSI/2026-27/${nextId}`, client_id: 1, issue_date: day(issue), total: D(total), advance: D(0), ...extra,
});
const payment = (inv: any, date: string, amount: string | number, notes = '') => ({
  id: nextId++, invoice_id: inv.id, receipt_number: `RCT-${nextId}`, payment_date: day(date), payment_mode: 'bank', amount: D(amount), notes,
});
const expense = (date: string, amount: string | number, paid: string | number, extra: any = {}) => ({
  id: nextId++, title: 'Hosting', expense_date: day(date), vendor: 'AWS', payment_method: 'upi', amount: D(amount), amount_paid: D(paid),
  outstanding_amount: D(0), deleted_at: null, approval_status: 'approved', ...extra,
});

const service = async (data: Data) => {
  const module = await Test.createTestingModule({
    providers: [FinancialReportsService, { provide: PrismaService, useValue: buildPrisma(data) }, { provide: PdfService, useValue: {} }],
  }).compile();
  return module.get(FinancialReportsService);
};
const run = async (data: Data, start = '2026-11-01', end = '2026-11-30') =>
  (await service(data)).getIncomeExpenseStatement({ start_date: start, end_date: end }) as any;

describe('Income & Expense statement', () => {
  afterEach(() => jest.useRealTimers());

  it('collections: payment rows plus legacy advances as their own rows; advances with an initial-payment row not repeated', async () => {
    const legacy = invoice('2026-11-03', '1000.00', { advance: D('400.00') });
    const marked = invoice('2026-11-04', '1000.00', { advance: D('300.00') });
    const plain = invoice('2026-10-20', '500.00');
    const res = await run({
      invoices: [legacy, marked, plain],
      payments: [payment(marked, '2026-11-04', '300.00', INITIAL_PAYMENT_NOTE), payment(plain, '2026-11-10', '250.00')],
      expenses: [],
    });
    expect(res.summary.total_collections).toBe(950); // 400 advance + 300 initial-payment row + 250
    const rows = res.collections.map((c: any) => [c.entry_type, c.date, c.amount]);
    expect(rows).toEqual([
      ['payment', '2026-11-10', 250],
      ['payment', '2026-11-04', 300],
      ['legacy_advance', '2026-11-03', 400],
    ]);
    const advance = res.collections.find((c: any) => c.entry_type === 'legacy_advance');
    expect(advance).toMatchObject({ receipt_number: `Advance on ${legacy.invoice_number}`, invoice_number: legacy.invoice_number, client_name: 'Acme', payment_mode: 'advance' });
    // Existing payment row fields are kept
    expect(res.collections[0]).toMatchObject({ receipt_number: expect.any(String), client_name: 'Acme', invoice_number: plain.invoice_number, payment_mode: 'bank' });
    // The list reconciles exactly with the total
    expect(Math.round(res.collections.reduce((s: number, c: any) => s + c.amount * 100, 0))).toBe(95000);
  });

  it('expenses: rejected and deleted excluded, pending approval included; paid = amount_paid; pending computed', async () => {
    const res = await run({
      invoices: [],
      payments: [],
      expenses: [
        expense('2026-11-05', 1000, 600, { outstanding_amount: D('999.00') }), // stale stored value ignored
        expense('2026-11-06', 500, 500, { approval_status: 'pending' }),
        expense('2026-11-07', 800, 800, { approval_status: 'rejected' }),
        expense('2026-11-08', 900, 900, { deleted_at: new Date('2026-11-09') }),
      ],
    });
    expect(res.expenses).toHaveLength(2);
    expect(res.summary.total_expenses_paid).toBe(1100);
    expect(res.summary.total_expenses_billed).toBe(1500);
    expect(res.summary.total_pending_expenses).toBe(400);
    expect(res.expenses.find((e: any) => e.amount === 1000).outstanding_amount).toBe(400);
    expect(res.summary.net_cash_flow).toBe(-1100);
  });

  it('invoice revenue: final total (GST, after discount) of paid, partial and unpaid invoices, by issue date only', async () => {
    const gst = invoice('2026-11-02', '1100.00'); // 1000 + 180 GST − 80 discount
    const paid = invoice('2026-11-12', '500.00');
    const partial = invoice('2026-11-13', '300.00');
    const unpaid = invoice('2026-11-30', '200.00'); // last day, included
    const outside = invoice('2026-12-01', '9999.00');
    const earlier = invoice('2026-10-31', '7777.00');
    const res = await run({
      invoices: [gst, paid, partial, unpaid, outside, earlier],
      payments: [payment(paid, '2026-11-15', '500.00'), payment(partial, '2026-12-02', '100.00'), payment(earlier, '2026-11-01', '7777.00')],
      expenses: [],
    });
    expect(res.summary.total_invoice_revenue).toBe(2100);
    // Cross-month: the October invoice's November payment is a November collection, not November revenue
    expect(res.summary.total_collections).toBe(8277);
  });

  it('inclusive API end date: 2026-11-30 includes the 30th and excludes 1 December', async () => {
    const inv = invoice('2026-11-30', '10.00');
    const next = invoice('2026-12-01', '20.00');
    const res = await run({
      invoices: [inv, next],
      payments: [payment(inv, '2026-11-30', '10.00'), payment(next, '2026-12-01', '20.00')],
      expenses: [expense('2026-11-30', 5, 5), expense('2026-12-01', 7, 7)],
    });
    expect([res.summary.total_invoice_revenue, res.summary.total_collections, res.summary.total_expenses_paid]).toEqual([10, 10, 5]);
    expect(res.period).toEqual({ start_date: '2026-11-01', end_date: '2026-11-30' });
  });

  it('exact paise arithmetic', async () => {
    const a = invoice('2026-11-01', '0.10');
    const b = invoice('2026-11-02', '0.20');
    const res = await run({
      invoices: [a, b],
      payments: [payment(a, '2026-11-03', '0.10'), payment(b, '2026-11-04', '0.20')],
      expenses: [expense('2026-11-05', '0.10', '0.10'), expense('2026-11-06', '0.20', '0.20')],
    });
    expect([res.summary.total_invoice_revenue, res.summary.total_collections, res.summary.total_expenses_paid, res.summary.net_cash_flow])
      .toEqual([0.3, 0.3, 0.3, 0]);
  });

  it('missing or invalid dates fall back to the current month in Asia/Kolkata', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date('2026-11-30T18:30:00Z')); // 1 Dec 2026, 00:00 IST
    const svc = await service({ invoices: [], payments: [], expenses: [] });
    expect(((await svc.getIncomeExpenseStatement({})) as any).period).toEqual({ start_date: '2026-12-01', end_date: '2026-12-31' });
    expect(((await svc.getIncomeExpenseStatement({ start_date: '2026-02-30', end_date: '2026-03-31' })) as any).period)
      .toEqual({ start_date: '2026-12-01', end_date: '2026-12-31' });
  });

  it('keeps every existing response field and adds the new ones', async () => {
    const inv = invoice('2026-11-02', '100.00');
    const res = await run({ invoices: [inv], payments: [payment(inv, '2026-11-03', '100.00')], expenses: [expense('2026-11-04', 10, 5)] });
    expect(Object.keys(res).sort()).toEqual(['collections', 'disclaimer', 'expenses', 'period', 'summary']);
    expect(Object.keys(res.summary).sort()).toEqual([
      'net_cash_flow', 'total_collections', 'total_expenses_billed', 'total_expenses_paid', 'total_invoice_revenue', 'total_pending_expenses',
    ]);
    expect(Object.keys(res.collections[0]).sort()).toEqual(['amount', 'client_name', 'date', 'entry_type', 'id', 'invoice_number', 'payment_mode', 'receipt_number']);
    expect(Object.keys(res.expenses[0]).sort()).toEqual(['amount', 'amount_paid', 'category_name', 'date', 'id', 'outstanding_amount', 'payment_method', 'title', 'vendor']);
  });

  it('CSV income-expense export still works and includes the advance rows and totals', async () => {
    const legacy = invoice('2026-11-03', '1000.00', { advance: D('400.00') });
    const svc = await service({ invoices: [legacy], payments: [payment(legacy, '2026-11-10', '600.00')], expenses: [expense('2026-11-05', 100, 100)] });
    const csv = await svc.generateCsvExport('income-expense', { start_date: '2026-11-01', end_date: '2026-11-30' });
    expect(csv).toContain('INCOME & EXPENSE STATEMENT (2026-11-01 to 2026-11-30)');
    expect(csv).toContain(`2026-11-03,"Advance on ${legacy.invoice_number}","Acme","${legacy.invoice_number}",advance,400`);
    expect(csv).toContain('Total Collections,,,,,1000');
    expect(csv).toContain('Total Expenses Paid,,,,,100');
    expect(csv).toContain('Net Cash Flow,,,,,900');
  });
});
