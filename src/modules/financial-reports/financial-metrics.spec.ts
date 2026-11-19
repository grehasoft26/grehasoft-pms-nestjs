import { Prisma } from '@prisma/client';
import { INITIAL_PAYMENT_NOTE } from '../invoices/invoice-status';
import {
  ELIGIBLE_EXPENSE_WHERE,
  bucketKey,
  currentMonthKey,
  dateRange,
  eligibleExpenseWhere,
  expensePaise,
  fyQuarterIndex,
  fyRange,
  groupPaise,
  legacyAdvanceEntries,
  monthRange,
  paymentEntries,
  parseDay,
  percentChange,
  previousMonthKey,
  rangeBounds,
  revenueEntries,
  sumExpenses,
  sumPaise,
  toRupees,
} from './financial-metrics';

/** Shared financial calculation rules (Phase 2A): ranges, grouping, eligibility, legacy advances, exact paise. */
const D = (v: string | number) => new Prisma.Decimal(v);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('financial-metrics: date ranges', () => {
  it('dateRange: inclusive API dates → [start, end + 1 day)', () => {
    expect(dateRange('2026-04-01', '2026-04-30')).toEqual({ gte: day('2026-04-01'), lt: day('2026-05-01') });
    expect(dateRange('2027-02-01', '2027-02-28')).toEqual({ gte: day('2027-02-01'), lt: day('2027-03-01') });
    expect(rangeBounds(dateRange('2026-04-01', '2026-04-30')!)).toEqual({ start_date: '2026-04-01', end_date: '2026-04-30' });
  });

  it('dateRange / parseDay reject anything but a real YYYY-MM-DD', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-4-1', '01-04-2026', '', null, undefined, 20260401, '2026-04-01T00:00:00Z']) {
      expect(parseDay(bad as any)).toBeNull();
      expect(dateRange(bad as any, '2026-04-30')).toBeNull();
    }
  });

  it('fyRange: [1 April, next 1 April)', () => {
    expect(fyRange(2026)).toEqual({ gte: day('2026-04-01'), lt: day('2027-04-01') });
  });

  it('monthRange: strict YYYY-MM (same validation as the invoice month filter)', () => {
    expect(monthRange('2026-11')).toEqual({ gte: day('2026-11-01'), lt: day('2026-12-01') });
    expect(monthRange('2026-12')).toEqual({ gte: day('2026-12-01'), lt: day('2027-01-01') });
    for (const bad of ['2026-13', '2026-1', '2026-11-01', ' 2026-11', 'abc', null]) expect(monthRange(bad)).toBeNull();
  });

  it('currentMonthKey follows Asia/Kolkata, not UTC', () => {
    expect(currentMonthKey(new Date('2026-11-30T18:30:00Z'))).toBe('2026-12'); // 1 Dec 00:00 IST
    expect(currentMonthKey(new Date('2026-11-30T18:29:00Z'))).toBe('2026-11'); // 30 Nov 23:59 IST
    expect(currentMonthKey(new Date('2027-03-31T19:00:00Z'))).toBe('2027-04'); // 1 Apr 00:30 IST: new FY
  });

  it('bucketKey: months and financial-year quarters (31 Mar / 1 Apr, 30 Jun / 1 Jul)', () => {
    expect(bucketKey(day('2026-11-30'), 'month')).toBe('2026-11');
    expect(['2026-04-01', '2026-06-30', '2026-07-01', '2026-12-31', '2027-01-01', '2027-03-31'].map((d) => bucketKey(day(d), 'quarter')))
      .toEqual(['Q1', 'Q1', 'Q2', 'Q3', 'Q4', 'Q4']);
    expect(fyQuarterIndex('2026-09-30')).toBe(1);
  });

  it('groupPaise: fixed buckets in order; entries outside them are ignored', () => {
    const entries = [{ date: day('2026-04-05'), paise: 100 }, { date: day('2026-05-01'), paise: 50 }, { date: day('2026-07-01'), paise: 7 }];
    const g = groupPaise(entries, ['2026-04', '2026-05', '2026-06'], (d) => bucketKey(d, 'month'));
    expect([...g.entries()]).toEqual([['2026-04', 100], ['2026-05', 50], ['2026-06', 0]]);
  });
});

describe('financial-metrics: amounts', () => {
  it('eligible expenses: not deleted, not rejected (pending approval included)', () => {
    expect(ELIGIBLE_EXPENSE_WHERE).toEqual({ deleted_at: null, approval_status: { not: 'rejected' } });
    expect(eligibleExpenseWhere(fyRange(2026))).toEqual({
      deleted_at: null, approval_status: { not: 'rejected' }, expense_date: { gte: day('2026-04-01'), lt: day('2027-04-01') },
    });
  });

  it('expense figures: paid, billed and computed pending (never negative), for partly paid expenses', () => {
    expect(expensePaise({ amount: D('1000.00'), amount_paid: D('400.50') })).toEqual({ billed: 100000, paid: 40050, pending: 59950 });
    expect(expensePaise({ amount: D('100.00'), amount_paid: D('120.00') }).pending).toBe(0);
    expect(sumExpenses([{ amount: D('0.10'), amount_paid: D('0.10') }, { amount: D('0.20'), amount_paid: D('0.05') }]))
      .toEqual({ billed: 30, paid: 15, pending: 15 });
  });

  it('legacy advances: counted on the issue date, never when an initial-payment row exists; zero advances dropped', () => {
    const entries = legacyAdvanceEntries([
      { advance: D('400.00'), issue_date: day('2026-08-10'), payments: [] },
      { advance: D('300.00'), issue_date: day('2026-08-11'), payments: [{ notes: INITIAL_PAYMENT_NOTE }] },
      { advance: D('0.00'), issue_date: day('2026-08-12'), payments: [] },
    ]);
    expect(entries).toEqual([{ date: day('2026-08-10'), paise: 40000 }]);
  });

  it('exact paise sums and rupees only at the boundary; negative net allowed', () => {
    const collections = sumPaise(paymentEntries([{ amount: D('0.10'), payment_date: day('2026-04-01') }, { amount: D('0.20'), payment_date: day('2026-04-02') }]));
    expect(collections).toBe(30);
    expect(toRupees(collections)).toBe(0.3);
    expect(sumPaise(revenueEntries([{ total: D('1100.00'), issue_date: day('2026-04-01') }]))).toBe(110000);
    expect(toRupees(collections - 4000)).toBe(-39.7);
  });
});

describe('financial-metrics: month comparison helpers', () => {
  it('previousMonthKey: preceding calendar month; January → previous December; invalid → null', () => {
    expect(previousMonthKey('2026-11')).toBe('2026-10');
    expect(previousMonthKey('2027-01')).toBe('2026-12');
    expect(previousMonthKey('2026-04')).toBe('2026-03');
    for (const bad of ['2026-13', '2026-1', 'abc', '', null]) expect(previousMonthKey(bad)).toBeNull();
  });

  it('percentChange: exact paise, one decimal; null for a zero or negative base', () => {
    expect(percentChange(100000, 150000)).toBe(50);
    expect(percentChange(30000, 10000)).toBe(-66.7);
    expect(percentChange(3, 4)).toBe(33.3);
    expect(percentChange(100000, 100000)).toBe(0);
    expect(percentChange(0, 5000)).toBeNull();
    expect(percentChange(-5000, 5000)).toBeNull();
  });
});
