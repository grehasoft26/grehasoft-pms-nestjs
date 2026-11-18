import { INITIAL_PAYMENT_NOTE, toPaise } from './invoice-status';

/**
 * Legacy invoice advances in "payments received" (one rule, shared by the Invoices summary and the Financial Year
 * Summary so both count collections the same way).
 *
 * `Invoice.advance` is an amount recorded on the invoice itself, with no date of its own: it counts as received on the
 * invoice's issue date. Newer invoices also store that first payment as an InvoicePayment row marked with
 * INITIAL_PAYMENT_NOTE; such a row is already counted by payment date, so the advance is then NOT counted again.
 * Amounts are never compared: only the marker decides.
 */

/** Date-only range (start included, end excluded), as stored in @db.Date columns. */
export interface DateOnlyRange {
  gte: Date;
  lt: Date;
}

/** `where` for invoices that may hold a legacy advance, optionally limited to an issue-date range and a client. */
export const legacyAdvanceWhere = (issueDate?: DateOnlyRange, clientId?: number | null) => {
  const where: any = { advance: { gt: 0 } };
  if (issueDate) where.issue_date = issueDate;
  if (clientId !== null && clientId !== undefined) where.client_id = clientId;
  return where;
};

/** Fields needed to decide whether an advance counts (and on which date). */
export const LEGACY_ADVANCE_SELECT = {
  advance: true,
  issue_date: true,
  payments: { where: { notes: INITIAL_PAYMENT_NOTE }, select: { id: true, notes: true } },
} as const;

/** The advance in paise when it counts as received, otherwise 0 (no advance, or an initial-payment row exists). */
export const countedLegacyAdvancePaise = (invoice: { advance: unknown; payments?: Array<{ notes?: string | null }> | null }): number => {
  const advance = toPaise(invoice.advance as any);
  if (advance <= 0) return 0;
  const representedByInitialPayment = (invoice.payments || []).some((p) => p.notes === INITIAL_PAYMENT_NOTE);
  return representedByInitialPayment ? 0 : advance;
};
