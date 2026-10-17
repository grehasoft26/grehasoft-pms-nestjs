/**
 * Single source of truth for invoice money and status.
 *
 * - Money is calculated in integer paise, so Decimal(10,2) values such as
 *   1512.01 + 586.31 + 201.68 add up to exactly 2300.00.
 * - Due dates are compared as calendar days in the business time zone
 *   (Asia/Kolkata). An invoice due today is not overdue; it becomes overdue
 *   from the next calendar day while a balance remains.
 * - Status is always derived from the stored invoice and payment records;
 *   nothing here is persisted.
 */

export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';

/** Note written on the payment created together with a new invoice (InvoicesService.create). */
export const INITIAL_PAYMENT_NOTE = 'Initial payment received on invoice creation';

export type InvoicePaymentStatus = 'paid' | 'partial' | 'unpaid';
/** API-compatible `status`: payment status, except unpaid/partial invoices past due are 'overdue'. */
export type InvoiceStatus = InvoicePaymentStatus | 'overdue';

/** Prisma Decimal, number or numeric string. */
export type MoneyValue = number | string | { toString(): string } | null | undefined;

export interface InvoiceFinancialsInput {
  total: MoneyValue;
  advance?: MoneyValue;
  payments?: Array<{ amount: MoneyValue }> | null;
  due_date?: Date | string | null;
}

export interface InvoiceFinancials {
  total: number;
  total_paid: number;
  balance: number;
  overpaid_amount: number;
  payment_status: InvoicePaymentStatus;
  is_overdue: boolean;
  status: InvoiceStatus;
  due_date: string | null;
  /** Integer paise, for exact aggregation. */
  total_paise: number;
  paid_paise: number;
  balance_paise: number;
  overpaid_paise: number;
}

/** Converts a money value to integer paise, rounding to the nearest paisa. */
export function toPaise(value: MoneyValue): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Converts integer paise back to rupees (always at most two decimals). */
export function fromPaise(paise: number): number {
  return Math.round(paise) / 100;
}

/** Rounds a money value to two decimals via paise. */
export function roundMoney(value: MoneyValue): number {
  return fromPaise(toPaise(value));
}

/** Calendar date ("YYYY-MM-DD") of `reference` in the business time zone. */
export function businessDateKey(reference: Date = new Date(), timeZone: string = BUSINESS_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(reference);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Calendar date ("YYYY-MM-DD") of a date-only value.
 * Prisma returns @db.Date columns as UTC midnight, so the UTC date is the stored date.
 */
export function dateOnlyKey(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

const resolveToday = (today?: Date | string): string =>
  typeof today === 'string' ? (dateOnlyKey(today) ?? businessDateKey()) : businessDateKey(today ?? new Date());

/**
 * Financial summary and status for one invoice.
 *
 * Rules:
 * - total_paid = advance column + all payment records.
 * - balance = max(0, total - total_paid); overpaid_amount = max(0, total_paid - total).
 * - payment_status: 'paid' when total > 0 and total_paid >= total; 'partial' when
 *   0 < total_paid < total; otherwise 'unpaid' (including zero-total invoices).
 * - is_overdue: balance > 0 and due date < today (business time zone).
 * - status: 'paid' if paid, else 'overdue' if overdue, else payment_status.
 *
 * @param options.today reference date (Date or "YYYY-MM-DD"), defaults to now.
 */
export function computeInvoiceFinancials(
  input: InvoiceFinancialsInput,
  options: { today?: Date | string } = {},
): InvoiceFinancials {
  const totalPaise = toPaise(input.total);
  const paidPaise =
    toPaise(input.advance) + (input.payments || []).reduce((sum, p) => sum + toPaise(p?.amount), 0);
  const billablePaise = Math.max(0, totalPaise);
  const balancePaise = Math.max(0, billablePaise - paidPaise);
  const overpaidPaise = Math.max(0, paidPaise - billablePaise);

  let paymentStatus: InvoicePaymentStatus = 'unpaid';
  if (totalPaise > 0 && paidPaise >= totalPaise) paymentStatus = 'paid';
  else if (paidPaise > 0 && paidPaise < totalPaise) paymentStatus = 'partial';

  const dueDate = dateOnlyKey(input.due_date);
  const isOverdue = balancePaise > 0 && dueDate !== null && dueDate < resolveToday(options.today);

  return {
    total: fromPaise(totalPaise),
    total_paid: fromPaise(paidPaise),
    balance: fromPaise(balancePaise),
    overpaid_amount: fromPaise(overpaidPaise),
    payment_status: paymentStatus,
    is_overdue: isOverdue,
    status: paymentStatus === 'paid' ? 'paid' : isOverdue ? 'overdue' : paymentStatus,
    due_date: dueDate,
    total_paise: totalPaise,
    paid_paise: paidPaise,
    balance_paise: balancePaise,
    overpaid_paise: overpaidPaise,
  };
}

/**
 * Status filter used by the invoices list:
 * 'paid' | 'partial' | 'unpaid' match the payment status (overdue invoices included),
 * 'overdue' matches is_overdue (unpaid or partially paid, past due).
 */
export function matchesInvoiceStatusFilter(
  financials: Pick<InvoiceFinancials, 'payment_status' | 'is_overdue' | 'status'>,
  filter: string,
): boolean {
  if (filter === 'overdue') return financials.is_overdue;
  if (filter === 'paid' || filter === 'partial' || filter === 'unpaid') return financials.payment_status === filter;
  return financials.status === filter;
}

export interface InvoiceTotals {
  invoice_count: number;
  total_billed: number;
  total_paid: number;
  total_balance: number;
  total_overpaid: number;
  overdue_count: number;
  overdue_balance: number;
}

/**
 * Exact (paise-based) totals across invoices.
 * total_paid includes overpayments; total_paid - total_overpaid + total_balance = total_billed
 * (for invoices with a non-negative total).
 */
export function aggregateInvoiceFinancials(list: InvoiceFinancials[]): InvoiceTotals {
  let billed = 0;
  let paid = 0;
  let balance = 0;
  let overpaid = 0;
  let overdueCount = 0;
  let overdueBalance = 0;
  for (const f of list) {
    billed += f.total_paise;
    paid += f.paid_paise;
    balance += f.balance_paise;
    overpaid += f.overpaid_paise;
    if (f.is_overdue) {
      overdueCount += 1;
      overdueBalance += f.balance_paise;
    }
  }
  return {
    invoice_count: list.length,
    total_billed: fromPaise(billed),
    total_paid: fromPaise(paid),
    total_balance: fromPaise(balance),
    total_overpaid: fromPaise(overpaid),
    overdue_count: overdueCount,
    overdue_balance: fromPaise(overdueBalance),
  };
}

/** Throws-free validation of a payment amount. Returns an error message or null. */
export function validatePaymentAmount(
  amount: MoneyValue,
  outstandingPaise: number,
): string | null {
  const raw = typeof amount === 'number' ? amount : Number(String(amount ?? ''));
  if (amount === null || amount === undefined || amount === '' || !Number.isFinite(raw)) {
    return 'Payment amount must be a valid number.';
  }
  const paise = toPaise(raw);
  if (paise <= 0) return 'Payment amount must be greater than zero.';
  if (paise > Math.max(0, outstandingPaise)) {
    return `Payment amount cannot exceed the outstanding balance of ₹${fromPaise(Math.max(0, outstandingPaise)).toFixed(2)}.`;
  }
  return null;
}

/**
 * Id of the payment recorded together with the invoice at creation (the "advance" shown
 * on the edit form). Matches the creation note first; otherwise the earliest payment
 * created within a few seconds of the invoice (same database transaction), so editing the
 * note does not lose the link. Returns null for legacy invoices that use the advance column.
 */
export function findInitialPaymentId(invoice: {
  created_at?: Date | string | null;
  advance?: MoneyValue;
  payments?: Array<{ id: number; notes?: string | null; created_at?: Date | string | null }> | null;
}): number | null {
  if (toPaise(invoice.advance) > 0) return null;
  const payments = [...(invoice.payments || [])].sort((a, b) => a.id - b.id);
  const byNote = payments.find((p) => p.notes === INITIAL_PAYMENT_NOTE);
  if (byNote) return byNote.id;

  const invoiceCreated = invoice.created_at ? new Date(invoice.created_at).getTime() : NaN;
  if (Number.isNaN(invoiceCreated)) return null;
  const first = payments[0];
  if (!first?.created_at) return null;
  const diff = new Date(first.created_at).getTime() - invoiceCreated;
  return diff >= 0 && diff <= 5000 ? first.id : null;
}
