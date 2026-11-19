/**
 * Shared financial calculation rules for the Financial Reports (Phase 2A: Financial Year Summary, Income & Expense).
 * One definition per metric, exact paise arithmetic, date-only ranges (start included, end excluded):
 *
 * - Invoice Revenue  = Σ invoices.total (GST included, after discount) by issue_date, whatever the payment state.
 * - Collections      = Σ invoice_payments.amount by payment_date + legacy advances by invoice issue_date
 *                      (legacy-advance.ts: not counted again when an initial-payment row exists).
 * - Expenses Paid    = Σ amount_paid; Billed = Σ amount; Pending = Σ max(amount − amount_paid, 0); all by expense_date
 *                      over ELIGIBLE expenses (not deleted, not rejected; pending approval included). The schema has no
 *                      expense payment dates, so a later part-payment still counts on the expense date.
 * - Net Cash Flow    = Collections − Expenses Paid.
 *
 * Totals are kept in paise and converted to rupees (toRupees) only at the API boundary.
 */
import { businessDateKey, dateOnlyKey, fromPaise, parseInvoiceMonth, toPaise } from '../invoices/invoice-status';
import { LEGACY_ADVANCE_SELECT, countedLegacyAdvancePaise, legacyAdvanceWhere } from '../invoices/legacy-advance';

/** Date-only range for @db.Date columns: `gte` included, `lt` excluded (UTC midnight values). */
export interface DateRange {
  gte: Date;
  lt: Date;
}

const DAY_MS = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A strict "YYYY-MM-DD" calendar date as stored in a date column (UTC midnight), or null. */
export const parseDay = (value: unknown): Date | null => {
  const match = typeof value === 'string' ? value.match(ISO_DAY) : null;
  if (!match) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
};

/** Inclusive "YYYY-MM-DD" start and end (as an API consumer sends them) → [start, end + 1 day). Null if invalid. */
export const dateRange = (start: unknown, end: unknown): DateRange | null => {
  const from = parseDay(start);
  const to = parseDay(end);
  if (!from || !to) return null;
  return { gte: from, lt: new Date(to.getTime() + DAY_MS) };
};

/** Indian financial year starting 1 April `startYear`: [1 Apr startYear, 1 Apr startYear + 1). */
export const fyRange = (startYear: number): DateRange => ({
  gte: new Date(Date.UTC(startYear, 3, 1)),
  lt: new Date(Date.UTC(startYear + 1, 3, 1)),
});

/** Strict "YYYY-MM" (same validation as the invoice month filter) → [1st, 1st of next month). Null if invalid. */
export const monthRange = (month: unknown): DateRange | null => {
  const parsed = parseInvoiceMonth(month);
  return parsed ? { gte: parsed.from, lt: parsed.to } : null;
};

/** Current month "YYYY-MM" in Asia/Kolkata (not the server clock). */
export const currentMonthKey = (now: Date = new Date()): string => businessDateKey(now).slice(0, 7);

/** The calendar month before a valid "YYYY-MM" (January → December of the previous year). Null if the key is invalid. */
export const previousMonthKey = (month: unknown): string | null => {
  const range = monthRange(month);
  if (!range) return null;
  const prev = new Date(Date.UTC(range.gte.getUTCFullYear(), range.gte.getUTCMonth() - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** The last `n` month keys ending with `currentKey` (included), oldest first; [] if the key is invalid. */
export const monthsBackKeys = (currentKey: string, n: number): string[] => {
  const keys: string[] = [];
  let key: string | null = monthRange(currentKey) ? currentKey : null;
  while (key && keys.length < n) {
    keys.unshift(key);
    key = previousMonthKey(key);
  }
  return keys;
};

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11" → "Nov 2026" (fixed English abbreviations; no time zone or locale involved). */
export const monthLabel = (key: string): string => {
  const [year, month] = key.split('-').map(Number);
  return `${MONTH_ABBR[month - 1]} ${year}`;
};

/**
 * Percentage change from `basePaise` to `newPaise`, rounded to one decimal, from exact integer paise:
 * round((new − base) × 1000 / base) / 10. Null when the base is zero or negative (no meaningful percentage).
 */
export const percentChange = (basePaise: number, newPaise: number): number | null => {
  if (basePaise <= 0) return null;
  return Math.round(((newPaise - basePaise) * 1000) / basePaise) / 10;
};

/** Inclusive "YYYY-MM-DD" bounds of a range, for API output. */
export const rangeBounds = (range: DateRange): { start_date: string; end_date: string } => ({
  start_date: range.gte.toISOString().slice(0, 10),
  end_date: new Date(range.lt.getTime() - DAY_MS).toISOString().slice(0, 10),
});

/** Financial-year quarter of a date-only value: 0 = Q1 (Apr-Jun) … 3 = Q4 (Jan-Mar). */
export const fyQuarterIndex = (date: Date | string): number => {
  const month = Number((dateOnlyKey(date) || '').slice(5, 7));
  return month >= 4 ? Math.floor((month - 4) / 3) : 3;
};

/** Grouping key of a date-only value: "YYYY-MM" for months; "Q1".."Q4" (financial-year quarters) for quarters. */
export const bucketKey = (date: Date | string, by: 'month' | 'quarter'): string =>
  by === 'month' ? (dateOnlyKey(date) || '').slice(0, 7) : `Q${fyQuarterIndex(date) + 1}`;

/** Eligible expenses: not deleted, not rejected (pending approval and approved count). */
export const ELIGIBLE_EXPENSE_WHERE = { deleted_at: null, approval_status: { not: 'rejected' } } as const;

/** Prisma `where` for eligible expenses dated in a range. */
export const eligibleExpenseWhere = (range: DateRange) => ({ ...ELIGIBLE_EXPENSE_WHERE, expense_date: { gte: range.gte, lt: range.lt } });

/** Prisma `where` for invoices issued in a range (revenue). */
export const revenueInvoiceWhere = (range: DateRange) => ({ issue_date: { gte: range.gte, lt: range.lt } });

/** Prisma `where` for payments received in a range (collections). */
export const paymentWhere = (range: DateRange) => ({ payment_date: { gte: range.gte, lt: range.lt } });

/** Prisma `where` / `select` for invoices whose legacy advance may count in a range (shared legacy-advance rule). */
export const legacyAdvanceInvoiceWhere = (range: DateRange) => legacyAdvanceWhere({ gte: range.gte, lt: range.lt });
export { LEGACY_ADVANCE_SELECT };

/** A dated amount in paise. */
export interface PaiseEntry {
  date: Date;
  paise: number;
}

export const revenueEntries = (invoices: Array<{ total: unknown; issue_date: Date }>): PaiseEntry[] =>
  invoices.map((i) => ({ date: i.issue_date, paise: toPaise(i.total as any) }));

export const paymentEntries = (payments: Array<{ amount: unknown; payment_date: Date }>): PaiseEntry[] =>
  payments.map((p) => ({ date: p.payment_date, paise: toPaise(p.amount as any) }));

/** Counted legacy advances only (zero-value advances dropped), dated on the invoice issue date. */
export const legacyAdvanceEntries = (
  invoices: Array<{ advance: unknown; issue_date: Date; payments?: Array<{ notes?: string | null }> | null }>,
): PaiseEntry[] =>
  invoices
    .map((i) => ({ date: i.issue_date, paise: countedLegacyAdvancePaise(i) }))
    .filter((e) => e.paise > 0);

/** Paid, billed and pending (never negative) of one eligible expense, in paise. */
export const expensePaise = (e: { amount: unknown; amount_paid: unknown }) => {
  const billed = toPaise(e.amount as any);
  const paid = toPaise(e.amount_paid as any);
  return { billed, paid, pending: Math.max(0, billed - paid) };
};

export interface ExpenseTotals {
  paid: number;
  billed: number;
  pending: number;
}

export const sumPaise = (entries: PaiseEntry[]): number => entries.reduce((acc, e) => acc + e.paise, 0);

export const sumExpenses = (expenses: Array<{ amount: unknown; amount_paid: unknown }>): ExpenseTotals =>
  expenses.reduce<ExpenseTotals>(
    (acc, e) => {
      const x = expensePaise(e);
      return { paid: acc.paid + x.paid, billed: acc.billed + x.billed, pending: acc.pending + x.pending };
    },
    { paid: 0, billed: 0, pending: 0 },
  );

/** Σ paise per bucket key; `keys` fixes the buckets (and their order), entries outside them are ignored. */
export const groupPaise = (entries: PaiseEntry[], keys: string[], keyOf: (date: Date) => string): Map<string, number> => {
  const out = new Map(keys.map((k) => [k, 0]));
  for (const e of entries) {
    const k = keyOf(e.date);
    if (out.has(k)) out.set(k, out.get(k)! + e.paise);
  }
  return out;
};

/** Paise → rupees, only at the API boundary. */
export const toRupees = (paise: number): number => fromPaise(paise);
