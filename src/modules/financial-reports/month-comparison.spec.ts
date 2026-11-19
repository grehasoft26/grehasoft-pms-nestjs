import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { FinancialReportsService } from './financial-reports.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { INITIAL_PAYMENT_NOTE } from '../invoices/invoice-status';

/**
 * Month Comparison (GET /financial/reports/comparison?month1&month2) on the shared financial rules (Phase 2B):
 * revenue by issue date; collections by payment date plus counted legacy advances on the issue date; eligible expenses
 * (not deleted, not rejected) by expense date; exact paise; strict YYYY-MM (400); Asia/Kolkata defaults; percentages
 * null when the month1 base is zero or negative. Reconciles with Income & Expense and the FY Summary.
 * The Prisma stand-in applies the same where/select/include the real queries use.
 */
const D = (v: string | number) => new Prisma.Decimal(v);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
type Data = { invoices: any[]; payments: any[]; expenses: any[] };

const inRange = (v: Date, r: any) => !r || ((!r.gte || v >= r.gte) && (!r.lt || v < r.lt) && (!r.lte || v <= r.lte));

const buildPrisma = (data: Data) => {
  const invoiceRow = (i: any, select?: any) => {
    if (!select) return i;
    const out: any = {};
    for (const k of Object.keys(select)) {
      if (k === 'payments') {
        out.payments = data.payments
          .filter((p) => p.invoice_id === i.id && (!select.payments.where?.notes || p.notes === select.payments.where.notes))
          .map((p) => ({ id: p.id, notes: p.notes }));
      } else if (k === 'client') out.client = { name: 'Acme' };
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
          .map((p) => (include?.invoice ? { ...p, invoice: { ...data.invoices.find((i) => i.id === p.invoice_id), client: { name: 'Acme' } } } : p)),
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

let nextId = 500;
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

const setup = async (data: Data) => {
  const prisma = buildPrisma(data);
  const module = await Test.createTestingModule({
    providers: [FinancialReportsService, { provide: PrismaService, useValue: prisma }, { provide: PdfService, useValue: {} }],
  }).compile();
  return { svc: module.get(FinancialReportsService), prisma };
};
const compare = async (data: Data, month1?: string, month2?: string) =>
  (await (await setup(data)).svc.getMonthComparisonReport({ month1, month2 })) as any;
const empty: Data = { invoices: [], payments: [], expenses: [] };

describe('Month Comparison', () => {
  afterEach(() => jest.useRealTimers());

  it('invoice revenue: final total (GST, after discount) of paid, partial and unpaid invoices, by issue month', async () => {
    const gst = invoice('2026-11-02', '1100.00'); // 1000 + 180 GST − 80 discount
    const paid = invoice('2026-11-10', '500.00');
    const partial = invoice('2026-11-11', '300.00');
    const unpaid = invoice('2026-11-12', '200.00');
    const oct = invoice('2026-10-15', '1000.00');
    const res = await compare(
      { invoices: [gst, paid, partial, unpaid, oct], payments: [payment(paid, '2026-11-20', '500.00'), payment(partial, '2026-11-21', '100.00')], expenses: [] },
      '2026-10', '2026-11',
    );
    expect(res.month1.invoice_revenue).toBe(1000);
    expect(res.month2.invoice_revenue).toBe(2100);
    expect(res.changes.revenue_diff).toBe(1100);
    expect(res.changes.revenue_percentage).toBe(110);
  });

  it('collections: payments by payment month, legacy advances by issue month, no duplicate with an initial-payment row', async () => {
    const legacy = invoice('2026-10-05', '1000.00', { advance: D('400.00') }); // advance only on the invoice (October)
    const marked = invoice('2026-10-06', '1000.00', { advance: D('300.00') }); // advance also stored as a payment row
    const res = await compare(
      {
        invoices: [legacy, marked],
        payments: [
          payment(marked, '2026-10-06', '300.00', INITIAL_PAYMENT_NOTE),
          payment(legacy, '2026-11-02', '600.00'), // issued in October, paid in November
        ],
        expenses: [],
      },
      '2026-10', '2026-11',
    );
    expect(res.month1.collections).toBe(700); // 400 advance + 300 initial-payment row (advance not added again)
    expect(res.month2.collections).toBe(600);
    expect(res.changes.collections_diff).toBe(-100);
    expect(res.changes.collections_percentage).toBe(-14.3);
  });

  it('expenses: rejected and deleted excluded, pending approval included; paid, billed, computed pending, eligible count', async () => {
    const res = await compare(
      {
        invoices: [],
        payments: [],
        expenses: [
          expense('2026-11-05', 1000, 600, { outstanding_amount: D('999.00') }), // stale stored value ignored
          expense('2026-11-06', 500, 500, { approval_status: 'pending' }),
          expense('2026-11-07', 800, 800, { approval_status: 'rejected' }),
          expense('2026-11-08', 900, 900, { deleted_at: new Date('2026-11-09') }),
        ],
      },
      '2026-11', '2026-11',
    );
    expect(res.month2).toMatchObject({ expenses_paid: 1100, expenses_total: 1500, pending_expenses: 400, expense_count: 2, net_cash_flow: -1100 });
  });

  it('exact paise and month boundaries (31 Mar / 1 Apr, 30 Nov / 1 Dec), start included and end excluded', async () => {
    const a = invoice('2027-03-31', '0.10');
    const b = invoice('2027-04-01', '0.20');
    const c = invoice('2026-11-30', '0.10');
    const d = invoice('2026-12-01', '0.20');
    const data = {
      invoices: [a, b, c, d],
      payments: [payment(a, '2027-03-31', '0.10'), payment(b, '2027-04-01', '0.20'), payment(c, '2026-11-30', '0.10'), payment(c, '2026-11-30', '0.20')],
      expenses: [expense('2026-11-30', '0.10', '0.10'), expense('2026-11-30', '0.20', '0.20'), expense('2026-12-01', 5, 5)],
    };
    const fy = await compare(data, '2027-03', '2027-04');
    expect([fy.month1.invoice_revenue, fy.month2.invoice_revenue, fy.month1.collections, fy.month2.collections]).toEqual([0.1, 0.2, 0.1, 0.2]);
    const nov = await compare(data, '2026-11', '2026-12');
    expect([nov.month1.invoice_revenue, nov.month1.collections, nov.month1.expenses_paid, nov.month1.net_cash_flow]).toEqual([0.1, 0.3, 0.3, 0]);
    expect([nov.month2.invoice_revenue, nov.month2.expenses_paid]).toEqual([0.2, 5]);
  });

  it.each(['abc', '2026-13', '2026-1', '2026-00', '1999-12', '2026-11-01', ' 2026-11'])('invalid month %p returns 400 for either field', async (bad) => {
    const { svc } = await setup(empty);
    await expect(svc.getMonthComparisonReport({ month1: bad, month2: '2026-11' })).rejects.toThrow(BadRequestException);
    await expect(svc.getMonthComparisonReport({ month1: bad, month2: '2026-11' })).rejects.toThrow('month1 must be a valid month in YYYY-MM format.');
    await expect(svc.getMonthComparisonReport({ month1: '2026-11', month2: bad })).rejects.toThrow('month2 must be a valid month in YYYY-MM format.');
  });

  it('missing or empty months default to the previous and current month in Asia/Kolkata', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date('2026-11-30T19:00:00Z')); // 1 Dec 2026, 00:30 IST
    let res = await compare(empty);
    expect([res.month1.month, res.month2.month]).toEqual(['2026-11', '2026-12']);
    res = await compare(empty, '', '');
    expect([res.month1.month, res.month2.month]).toEqual(['2026-11', '2026-12']);
    jest.setSystemTime(new Date('2027-01-15T06:00:00Z')); // January → previous December
    res = await compare(empty);
    expect([res.month1.month, res.month2.month]).toEqual(['2026-12', '2027-01']);
    // Only one given: the other one defaults
    res = await compare(empty, '2026-06');
    expect([res.month1.month, res.month2.month]).toEqual(['2026-06', '2027-01']);
  });

  it('same month twice: loaded once (4 queries, not 8), zero differences; month1 later than month2 is allowed', async () => {
    const inv = invoice('2026-11-03', '1000.00');
    const data = { invoices: [inv], payments: [payment(inv, '2026-11-04', '1000.00')], expenses: [expense('2026-11-05', 200, 200)] };
    const { svc, prisma } = await setup(data);
    const res: any = await svc.getMonthComparisonReport({ month1: '2026-11', month2: '2026-11' });
    const calls = prisma.invoice.findMany.mock.calls.length + prisma.invoicePayment.findMany.mock.calls.length + prisma.expense.findMany.mock.calls.length;
    expect(calls).toBe(4);
    expect(res.changes).toEqual({
      revenue_diff: 0, revenue_percentage: 0, collections_diff: 0, collections_percentage: 0, expenses_diff: 0, expenses_percentage: 0, cash_flow_diff: 0,
    });
    const reversed: any = await svc.getMonthComparisonReport({ month1: '2026-12', month2: '2026-11' });
    expect(reversed.changes.revenue_diff).toBe(1000); // month2 − month1
    expect(reversed.changes.revenue_percentage).toBeNull(); // December base is 0
  });

  it('percentages: null for a zero or negative base; negative and negative-to-positive net cash flow kept exact', async () => {
    const nov = invoice('2026-11-03', '500.00');
    const res = await compare(
      {
        invoices: [nov],
        payments: [payment(nov, '2026-11-04', '500.00')],
        expenses: [expense('2026-10-10', 300, 300), expense('2026-11-10', 100, 100)],
      },
      '2026-10', '2026-11',
    );
    expect(res.month1.net_cash_flow).toBe(-300); // negative month kept
    expect(res.month2.net_cash_flow).toBe(400);
    expect(res.changes.cash_flow_diff).toBe(700); // −300 → +400
    expect(res.changes.collections_percentage).toBeNull(); // October collections = 0
    expect(res.changes.revenue_percentage).toBeNull(); // October revenue = 0
    expect(res.changes.expenses_percentage).toBe(-66.7); // 300 → 100
    expect(res.changes).not.toHaveProperty('cash_flow_percentage');
  });

  it('keeps every existing response field and adds the new ones (nullable percentages)', async () => {
    const res = await compare(empty, '2026-10', '2026-11');
    expect(Object.keys(res).sort()).toEqual(['changes', 'month1', 'month2']);
    expect(Object.keys(res.month1).sort()).toEqual([
      'collections', 'expense_count', 'expenses_paid', 'expenses_total', 'invoice_revenue', 'month', 'net_cash_flow', 'pending_expenses',
    ]);
    expect(Object.keys(res.changes).sort()).toEqual([
      'cash_flow_diff', 'collections_diff', 'collections_percentage', 'expenses_diff', 'expenses_percentage', 'revenue_diff', 'revenue_percentage',
    ]);
    expect([res.changes.collections_percentage, res.changes.expenses_percentage, res.changes.revenue_percentage]).toEqual([null, null, null]);
  });
});

describe('Month Comparison reconciles with Income & Expense and the FY Summary', () => {
  // One dataset across Q1 and November: an advance-only invoice (April), an advance with an initial-payment row (May),
  // a cross-month payment (issued June, paid November), rejected and deleted expenses, and a partly paid expense.
  const adv = invoice('2026-04-10', '1000.00', { advance: D('250.00') });
  const marked = invoice('2026-05-12', '800.00', { advance: D('200.00') });
  const june = invoice('2026-06-20', '1500.55');
  const novInv = invoice('2026-11-03', '999.99');
  const data: Data = {
    invoices: [adv, marked, june, novInv],
    payments: [
      payment(marked, '2026-05-12', '200.00', INITIAL_PAYMENT_NOTE),
      payment(adv, '2026-06-01', '750.00'),
      payment(june, '2026-11-15', '1500.55'),
      payment(novInv, '2026-11-20', '0.33'),
    ],
    expenses: [
      expense('2026-04-30', '120.10', '120.10'),
      expense('2026-06-30', '500.00', '200.00'),
      expense('2026-05-01', 999, 999, { approval_status: 'rejected' }),
      expense('2026-11-30', '75.25', '75.25'),
      expense('2026-11-01', 888, 888, { deleted_at: new Date('2026-11-02') }),
    ],
  };

  it('November: Month Comparison = Income & Expense for 1–30 November', async () => {
    const { svc } = await setup(data);
    const month: any = (await svc.getMonthComparisonReport({ month1: '2026-11', month2: '2026-11' })).month1;
    const ie: any = await svc.getIncomeExpenseStatement({ start_date: '2026-11-01', end_date: '2026-11-30' });
    expect(month.invoice_revenue).toBe(ie.summary.total_invoice_revenue);
    expect(month.collections).toBe(ie.summary.total_collections);
    expect(month.expenses_paid).toBe(ie.summary.total_expenses_paid);
    expect(month.expenses_total).toBe(ie.summary.total_expenses_billed);
    expect(month.pending_expenses).toBe(ie.summary.total_pending_expenses);
    expect(month.net_cash_flow).toBe(ie.summary.net_cash_flow);
    expect(month.expense_count).toBe(ie.expenses.length);
    expect([month.invoice_revenue, month.collections, month.expenses_paid]).toEqual([999.99, 1500.88, 75.25]);
  });

  it('April + May + June = FY Summary Q1 (each metric on its own date basis)', async () => {
    const { svc } = await setup(data);
    const months = await Promise.all(['2026-04', '2026-05', '2026-06'].map(async (m) => ((await svc.getMonthComparisonReport({ month1: m, month2: m })) as any).month1));
    const q1: any = ((await svc.getFinancialYearSummary({ fy: '2026-2027' })) as any).quarterly_breakdown[0];
    const sum = (k: string) => Math.round(months.reduce((s, m) => s + Math.round(m[k] * 100), 0)) / 100;
    expect(sum('invoice_revenue')).toBe(q1.invoice_revenue); // by issue date
    expect(sum('collections')).toBe(q1.collections); // payments by payment date + advances by issue date
    expect(sum('expenses_paid')).toBe(q1.expenses_paid); // by expense date, eligible only
    expect(sum('net_cash_flow')).toBe(q1.net_cash_flow);
    // 250 (April advance) + 200 (May initial-payment row) + 750 (June payment)
    expect(q1.collections).toBe(1200);
  });
});
