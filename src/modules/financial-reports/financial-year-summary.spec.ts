import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { FinancialReportsService } from './financial-reports.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { INITIAL_PAYMENT_NOTE } from '../invoices/invoice-status';
import { countedLegacyAdvancePaise } from '../invoices/legacy-advance';

/**
 * Financial Year Summary (GET /financial/reports/financial-year-summary):
 * - Invoice Revenue = Σ invoices.total (GST included, after discount) by issue date, whatever the payment state;
 * - Collections = Σ payments by payment date + legacy advances on the issue date (not when an initial-payment row exists);
 * - Expenses Paid = Σ amount_paid by expense date, excluding deleted and rejected expenses;
 * - Net Cash Flow = Collections − Expenses Paid; annual totals = sums of the quarterly paise.
 * The Prisma stand-in applies the same where/select the real queries use (date ranges, deleted, rejected, advance > 0,
 * initial-payment rows), so the filters are tested, not assumed.
 */
const D = (v: string | number) => new Prisma.Decimal(v);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

type Data = { invoices: any[]; payments: any[]; expenses: any[] };

const inRange = (value: Date, range: any) =>
  !range || ((!range.gte || value >= range.gte) && (!range.lt || value < range.lt) && (!range.lte || value <= range.lte));

const pick = (row: any, select: any, data: Data) => {
  if (!select) return row;
  const out: any = {};
  for (const key of Object.keys(select)) {
    if (key === 'payments') {
      const nested = select.payments;
      out.payments = data.payments
        .filter((p) => p.invoice_id === row.id && (!nested.where?.notes || p.notes === nested.where.notes))
        .map((p) => Object.fromEntries(Object.keys(nested.select).map((k) => [k, p[k]])));
    } else out[key] = row[key];
  }
  return out;
};

const buildPrisma = (data: Data) => ({
  invoice: {
    findMany: jest.fn(async ({ where = {}, select }: any) =>
      data.invoices
        .filter((i) => inRange(i.issue_date, where.issue_date))
        .filter((i) => !where.advance || Number(i.advance) > 0)
        .map((i) => pick(i, select, data)),
    ),
  },
  invoicePayment: {
    findMany: jest.fn(async ({ where = {}, select }: any) =>
      data.payments.filter((p) => inRange(p.payment_date, where.payment_date)).map((p) => pick(p, select, data)),
    ),
  },
  expense: {
    findMany: jest.fn(async ({ where = {}, select }: any) =>
      data.expenses
        .filter((e) => inRange(e.expense_date, where.expense_date))
        .filter((e) => !('deleted_at' in where) || e.deleted_at === null)
        .filter((e) => !where.approval_status?.not || e.approval_status !== where.approval_status.not)
        .map((e) => pick(e, select, data)),
    ),
  },
  project: { findMany: jest.fn(async () => []) },
});

let nextId = 1;
const invoice = (issue: string, total: string | number, extra: any = {}) => ({
  id: nextId++, issue_date: day(issue), total: D(total), subtotal: D(0), tax: D(0), advance: D(0), ...extra,
});
const payment = (invoiceId: number, date: string, amount: string | number, notes = '') => ({
  id: nextId++, invoice_id: invoiceId, payment_date: day(date), amount: D(amount), notes,
});
const expense = (date: string, amount: string | number, paid: string | number, extra: any = {}) => ({
  id: nextId++, expense_date: day(date), amount: D(amount), amount_paid: D(paid), deleted_at: null, approval_status: 'approved', ...extra,
});

const run = async (data: Data, fy?: string) => {
  const module = await Test.createTestingModule({
    providers: [
      FinancialReportsService,
      { provide: PrismaService, useValue: buildPrisma(data) },
      { provide: PdfService, useValue: {} },
    ],
  }).compile();
  return module.get(FinancialReportsService).getFinancialYearSummary(fy === undefined ? {} : { fy });
};

const quarter = (res: any, i: number) => res.quarterly_breakdown[i];

describe('Financial Year Summary', () => {
  afterEach(() => jest.useRealTimers());

  it('invoice revenue is the final invoices.total (GST included, after discount), for paid, partial and unpaid invoices', async () => {
    // subtotal 1000 + GST 180 − discount 80 = total 1100 (as the invoice form stores it)
    const withGstAndDiscount = invoice('2026-05-10', '1100.00', { subtotal: D('1000.00'), tax: D('180.00') });
    const paid = invoice('2026-05-11', '500.00');
    const partial = invoice('2026-05-12', '300.00');
    const unpaid = invoice('2026-05-13', '200.00');
    const res: any = await run({
      invoices: [withGstAndDiscount, paid, partial, unpaid],
      payments: [payment(paid.id, '2026-05-20', '500.00'), payment(partial.id, '2026-05-20', '100.00')],
      expenses: [],
    }, '2026-2027');
    expect(res.summary.total_invoice_revenue).toBe(2100);
    expect(quarter(res, 0).invoice_revenue).toBe(2100);
    // Revenue is not collections
    expect(res.summary.total_collections).toBe(600);
  });

  it('FY and quarter boundaries: 31 Mar / 1 Apr and 30 Jun / 1 Jul', async () => {
    const res: any = await run({
      invoices: [
        invoice('2026-03-31', 1), // previous FY
        invoice('2026-04-01', 10), // Q1
        invoice('2026-06-30', 100), // Q1
        invoice('2026-07-01', 1000), // Q2
        invoice('2027-03-31', 10000), // Q4 (last day)
        invoice('2027-04-01', 100000), // next FY
      ],
      payments: [],
      expenses: [expense('2026-03-31', 5, 5), expense('2026-06-30', 7, 7), expense('2026-07-01', 9, 9), expense('2027-04-01', 3, 3)],
    }, '2026-2027');
    expect(res.quarterly_breakdown.map((x: any) => x.invoice_revenue)).toEqual([110, 1000, 0, 10000]);
    expect(res.summary.total_invoice_revenue).toBe(11110);
    expect(res.quarterly_breakdown.map((x: any) => x.expenses_paid)).toEqual([7, 9, 0, 0]);
    expect(res.quarterly_breakdown.map((x: any) => x.quarter)).toEqual(['Q1 (Apr-Jun)', 'Q2 (Jul-Sep)', 'Q3 (Oct-Dec)', 'Q4 (Jan-Mar)']);
  });

  it('invoice issued in FY1 and paid in FY2: revenue in FY1, collection in FY2', async () => {
    const inv = invoice('2027-03-15', '5000.00');
    const data = { invoices: [inv], payments: [payment(inv.id, '2027-04-05', '5000.00')], expenses: [] };
    const fy1: any = await run(data, '2026-2027');
    const fy2: any = await run(data, '2027-2028');
    expect([fy1.summary.total_invoice_revenue, fy1.summary.total_collections]).toEqual([5000, 0]);
    expect([fy2.summary.total_invoice_revenue, fy2.summary.total_collections]).toEqual([0, 5000]);
    expect(quarter(fy1, 3).invoice_revenue).toBe(5000);
    expect(quarter(fy2, 0).collections).toBe(5000);
  });

  it('legacy advance counts once, on the issue date; not again when an initial-payment row exists', async () => {
    const legacy = invoice('2026-08-10', '1000.00', { advance: D('400.00') }); // advance only on the invoice
    const marked = invoice('2026-08-11', '1000.00', { advance: D('300.00') }); // advance also stored as a payment row
    const res: any = await run({
      invoices: [legacy, marked],
      payments: [payment(marked.id, '2026-08-11', '300.00', INITIAL_PAYMENT_NOTE), payment(legacy.id, '2026-10-02', '600.00')],
      expenses: [],
    }, '2026-2027');
    // 400 (legacy, Q2 by issue date) + 300 (marked row, Q2) + 600 (Q3) — the marked advance is not added again
    expect(quarter(res, 1).collections).toBe(700);
    expect(quarter(res, 2).collections).toBe(600);
    expect(res.summary.total_collections).toBe(1300);
    // The same rule the Invoices summary uses
    expect(countedLegacyAdvancePaise({ advance: D('400.00'), payments: [] })).toBe(40000);
    expect(countedLegacyAdvancePaise({ advance: D('300.00'), payments: [{ notes: INITIAL_PAYMENT_NOTE }] })).toBe(0);
    expect(countedLegacyAdvancePaise({ advance: D('0.00'), payments: [] })).toBe(0);
  });

  it('rejected and soft-deleted expenses are excluded from paid, billed and pending', async () => {
    const res: any = await run({
      invoices: [],
      payments: [],
      expenses: [
        expense('2026-09-01', 1000, 600), // counted: paid 600, pending 400
        expense('2026-09-02', 500, 500, { approval_status: 'pending' }), // pending approval still counts
        expense('2026-09-03', 800, 800, { approval_status: 'rejected' }),
        expense('2026-09-04', 900, 900, { deleted_at: new Date('2026-09-05') }),
      ],
    }, '2026-2027');
    expect(res.summary.total_expenses_paid).toBe(1100);
    expect(res.summary.total_expenses_billed).toBe(1500);
    expect(res.summary.total_pending_expenses).toBe(400);
  });

  it('annual totals equal the quarterly sums; net cash flow = collections − expenses paid, also when negative', async () => {
    const a = invoice('2026-04-15', '1000.10');
    const b = invoice('2026-11-20', '2500.25');
    const res: any = await run({
      invoices: [a, b],
      payments: [payment(a.id, '2026-05-01', '1000.10'), payment(b.id, '2027-01-10', '1000.00')],
      expenses: [expense('2026-05-02', 300, 300), expense('2026-12-01', 4000, 3999.99), expense('2027-02-01', 50.5, 50.5)],
    }, '2026-2027');
    const sumOf = (key: string) => Math.round(res.quarterly_breakdown.reduce((s: number, x: any) => s + Math.round(x[key] * 100), 0)) / 100;
    expect(res.summary.total_invoice_revenue).toBe(sumOf('invoice_revenue'));
    expect(res.summary.total_collections).toBe(sumOf('collections'));
    expect(res.summary.total_expenses_paid).toBe(sumOf('expenses_paid'));
    expect(res.summary.net_cash_flow).toBe(sumOf('net_cash_flow'));
    for (const x of res.quarterly_breakdown) expect(x.net_cash_flow).toBe(Math.round((x.collections - x.expenses_paid) * 100) / 100);
    expect(quarter(res, 2).net_cash_flow).toBe(-3999.99); // Q3: no collections, 3999.99 paid
    expect(res.summary.net_cash_flow).toBe(-2350.39); // 2000.10 − 4350.49
  });

  it('paise arithmetic: 0.10 + 0.20 is exactly 0.30', async () => {
    const res: any = await run({
      invoices: [invoice('2026-04-10', '0.10'), invoice('2026-04-11', '0.20')],
      payments: [payment(999, '2026-04-12', '0.10'), payment(999, '2026-04-13', '0.20')],
      expenses: [expense('2026-04-14', '0.10', '0.10'), expense('2026-04-15', '0.20', '0.20')],
    }, '2026-2027');
    expect(res.summary.total_invoice_revenue).toBe(0.3);
    expect(res.summary.total_collections).toBe(0.3);
    expect(res.summary.total_expenses_paid).toBe(0.3);
    expect(res.summary.net_cash_flow).toBe(0);
  });

  it('default FY follows Asia/Kolkata: 00:30 IST on 1 April is already the new FY', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date('2027-03-31T19:00:00.000Z')); // 1 Apr 2027, 00:30 IST
    let res: any = await run({ invoices: [], payments: [], expenses: [] });
    expect(res.financial_year).toBe('FY 2027-28');
    expect(res.period).toEqual({ start_date: '2027-04-01', end_date: '2028-03-31' });
    jest.setSystemTime(new Date('2027-03-31T18:29:00.000Z')); // 31 Mar 2027, 23:59 IST
    res = await run({ invoices: [], payments: [], expenses: [] });
    expect(res.financial_year).toBe('FY 2026-27');
  });

  it('?fy= parsing and fallback are unchanged', async () => {
    expect(((await run({ invoices: [], payments: [], expenses: [] }, '2025-26')) as any).financial_year).toBe('FY 2025-26');
    expect(((await run({ invoices: [], payments: [], expenses: [] }, '2024-2025')) as any).financial_year).toBe('FY 2024-25');
  });

  it('keeps every existing response field and adds the new ones', async () => {
    const res: any = await run({ invoices: [], payments: [], expenses: [] }, '2026-2027');
    expect(Object.keys(res).sort()).toEqual(['disclaimer', 'financial_year', 'period', 'quarterly_breakdown', 'summary']);
    expect(Object.keys(res.summary).sort()).toEqual([
      'net_cash_flow', 'total_collections', 'total_expenses_billed', 'total_expenses_paid', 'total_invoice_revenue', 'total_pending_expenses',
    ]);
    expect(Object.keys(res.quarterly_breakdown[0]).sort()).toEqual(['collections', 'expenses_paid', 'invoice_revenue', 'net_cash_flow', 'quarter']);
  });
});
