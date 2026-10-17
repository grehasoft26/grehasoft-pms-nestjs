import { Prisma } from '@prisma/client';
import {
  aggregateInvoiceFinancials,
  businessDateKey,
  computeInvoiceFinancials,
  dateOnlyKey,
  findInitialPaymentId,
  INITIAL_PAYMENT_NOTE,
  matchesInvoiceStatusFilter,
  toPaise,
  validatePaymentAmount,
} from './invoice-status';

const D = (v: string | number) => new Prisma.Decimal(v);
/** Prisma returns @db.Date columns as UTC midnight. */
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const TODAY = '2026-10-17';
const PAST = day('2026-10-10');
const FUTURE = day('2026-10-30');
const pay = (...amounts: Array<string | number>) => amounts.map((a) => ({ amount: D(a) }));

const calc = (input: Parameters<typeof computeInvoiceFinancials>[0], today: Date | string = TODAY) =>
  computeInvoiceFinancials(input, { today });

describe('invoice-status (single source of truth)', () => {
  describe('payment status and overdue flag', () => {
    it('1. fully paid invoice', () => {
      const f = calc({ total: D('2300.00'), payments: pay('2300.00'), due_date: FUTURE });
      expect(f).toMatchObject({ total_paid: 2300, balance: 0, overpaid_amount: 0, payment_status: 'paid', is_overdue: false, status: 'paid' });
    });

    it('2. partially paid invoice', () => {
      const f = calc({ total: D('2300.00'), payments: pay('1000.00'), due_date: FUTURE });
      expect(f).toMatchObject({ total_paid: 1000, balance: 1300, payment_status: 'partial', is_overdue: false, status: 'partial' });
    });

    it('3. unpaid invoice not yet due', () => {
      const f = calc({ total: D('2300.00'), due_date: FUTURE });
      expect(f).toMatchObject({ total_paid: 0, balance: 2300, payment_status: 'unpaid', is_overdue: false, status: 'unpaid' });
    });

    it('4. unpaid invoice past due', () => {
      const f = calc({ total: D('2300.00'), due_date: PAST });
      expect(f).toMatchObject({ balance: 2300, payment_status: 'unpaid', is_overdue: true, status: 'overdue' });
    });

    it('5. partially paid invoice past due keeps both facts', () => {
      const f = calc({ total: D('2300.00'), payments: pay('1000.00'), due_date: PAST });
      expect(f).toMatchObject({ balance: 1300, payment_status: 'partial', is_overdue: true, status: 'overdue' });
    });

    it('6. fully paid after the due date stays paid and is not overdue', () => {
      const f = calc({ total: D('2300.00'), payments: pay('2300.00'), due_date: PAST });
      expect(f).toMatchObject({ payment_status: 'paid', is_overdue: false, status: 'paid' });
    });

    it('7. due date equal to today is not overdue', () => {
      const f = calc({ total: D('2300.00'), due_date: day(TODAY) });
      expect(f).toMatchObject({ is_overdue: false, status: 'unpaid' });
    });

    it('8. missing due date is never overdue', () => {
      expect(calc({ total: D('2300.00'), due_date: null })).toMatchObject({ is_overdue: false, status: 'unpaid', due_date: null });
      expect(calc({ total: D('2300.00') })).toMatchObject({ is_overdue: false, due_date: null });
    });

    it('17. zero-total invoice is neither paid nor overdue', () => {
      const f = calc({ total: D('0.00'), due_date: PAST });
      expect(f).toMatchObject({ total: 0, total_paid: 0, balance: 0, payment_status: 'unpaid', is_overdue: false, status: 'unpaid' });
    });
  });

  describe('monetary precision', () => {
    it('9. decimal instalments that total the invoice amount are exactly paid', () => {
      // 1512.01 + 586.31 + 201.68 = 2299.9999999999995 with plain floating point
      expect(1512.01 + 586.31 + 201.68).not.toBe(2300);

      const f = calc({ total: D('2300.00'), payments: pay('1512.01', '586.31', '201.68'), due_date: PAST });
      expect(f).toMatchObject({ total_paid: 2300, balance: 0, payment_status: 'paid', is_overdue: false, status: 'paid' });
    });

    it('9b. never produces floating-point artifacts in balances', () => {
      const f = calc({ total: D('2300.00'), payments: pay('0.10', '0.20') });
      expect(f.total_paid).toBe(0.3);
      expect(f.balance).toBe(2299.7);
      expect(String(f.balance)).not.toContain('e-');
    });

    it('accepts Decimal, number and string inputs identically', () => {
      const a = calc({ total: D('100.10'), payments: [{ amount: D('33.37') }] });
      const b = calc({ total: 100.1, payments: [{ amount: 33.37 }] });
      const c = calc({ total: '100.10', payments: [{ amount: '33.37' }] });
      expect(a).toEqual(b);
      expect(b).toEqual(c);
      expect(a.balance).toBe(66.73);
    });

    it('toPaise rounds to the nearest paisa and handles empty values', () => {
      expect(toPaise(D('1512.01'))).toBe(151201);
      expect(toPaise(0.1 + 0.2)).toBe(30);
      expect(toPaise(null)).toBe(0);
      expect(toPaise('')).toBe(0);
      expect(toPaise('abc')).toBe(0);
    });
  });

  describe('advances and overpayments', () => {
    it('10. advance stored in the advance column counts as paid', () => {
      const f = calc({ total: D('2300.00'), advance: D('1000.00'), payments: [] });
      expect(f).toMatchObject({ total_paid: 1000, balance: 1300, payment_status: 'partial' });
    });

    it('11. advance represented by a payment record counts once', () => {
      const f = calc({ total: D('2300.00'), advance: D('0.00'), payments: pay('1000.00') });
      expect(f).toMatchObject({ total_paid: 1000, balance: 1300, payment_status: 'partial' });
    });

    it('12. advance column plus later payments is not double-counted', () => {
      const f = calc({ total: D('2300.00'), advance: D('1000.00'), payments: pay('1300.00') });
      expect(f).toMatchObject({ total_paid: 2300, balance: 0, overpaid_amount: 0, payment_status: 'paid' });
    });

    it('13. overpayment is exposed separately and the balance stays zero', () => {
      const f = calc({ total: D('2300.00'), payments: pay('2500.00') });
      expect(f).toMatchObject({ total_paid: 2500, balance: 0, overpaid_amount: 200, payment_status: 'paid', status: 'paid' });
    });

    it('16. invoice total reduced below the amount already paid', () => {
      const f = calc({ total: D('1800.00'), payments: pay('1000.00', '1000.00'), due_date: PAST });
      expect(f).toMatchObject({ total: 1800, total_paid: 2000, balance: 0, overpaid_amount: 200, payment_status: 'paid', is_overdue: false });
    });
  });

  describe('20. due-date comparisons around midnight in Asia/Kolkata', () => {
    const dueYesterday = { total: D('2300.00'), due_date: day('2026-10-16') };
    const at = (iso: string) => calc(dueYesterday, new Date(iso));

    it('16 Oct 23:59 IST: due today, not overdue', () => {
      expect(at('2026-10-16T18:29:00.000Z').is_overdue).toBe(false);
    });

    it('17 Oct 00:00 IST: overdue from the start of the next day', () => {
      expect(at('2026-10-16T18:30:00.000Z').is_overdue).toBe(true);
    });

    it('17 Oct 05:29 IST (still 16 Oct in UTC): already overdue', () => {
      expect(at('2026-10-16T23:59:00.000Z').status).toBe('overdue');
    });

    it('businessDateKey uses the business time zone, not UTC or the server zone', () => {
      expect(businessDateKey(new Date('2026-10-16T18:29:00.000Z'))).toBe('2026-10-16');
      expect(businessDateKey(new Date('2026-10-16T18:30:00.000Z'))).toBe('2026-10-17');
    });

    it('dateOnlyKey keeps the stored calendar date', () => {
      expect(dateOnlyKey(day('2026-10-16'))).toBe('2026-10-16');
      expect(dateOnlyKey('2026-10-16T00:00:00.000Z')).toBe('2026-10-16');
      expect(dateOnlyKey('2026-10-16')).toBe('2026-10-16');
      expect(dateOnlyKey(null)).toBeNull();
      expect(dateOnlyKey(new Date('invalid'))).toBeNull();
    });
  });

  describe('status filters', () => {
    const partialOverdue = calc({ total: D('2300.00'), payments: pay('1000.00'), due_date: PAST });
    const unpaidOverdue = calc({ total: D('2300.00'), due_date: PAST });
    const paidLate = calc({ total: D('2300.00'), payments: pay('2300.00'), due_date: PAST });

    it('a partially paid overdue invoice matches both Partial and Overdue', () => {
      expect(matchesInvoiceStatusFilter(partialOverdue, 'partial')).toBe(true);
      expect(matchesInvoiceStatusFilter(partialOverdue, 'overdue')).toBe(true);
      expect(matchesInvoiceStatusFilter(partialOverdue, 'unpaid')).toBe(false);
    });

    it('an unpaid overdue invoice matches Unpaid and Overdue', () => {
      expect(matchesInvoiceStatusFilter(unpaidOverdue, 'unpaid')).toBe(true);
      expect(matchesInvoiceStatusFilter(unpaidOverdue, 'overdue')).toBe(true);
    });

    it('a paid invoice never matches Overdue', () => {
      expect(matchesInvoiceStatusFilter(paidLate, 'paid')).toBe(true);
      expect(matchesInvoiceStatusFilter(paidLate, 'overdue')).toBe(false);
    });
  });

  describe('aggregateInvoiceFinancials', () => {
    it('sums exactly in paise and reports overpayments separately', () => {
      const totals = aggregateInvoiceFinancials([
        calc({ total: D('2300.00'), payments: pay('1512.01', '586.31', '201.68') }),
        calc({ total: D('2300.00'), payments: pay('2500.00') }),
        calc({ total: D('2300.00'), payments: pay('1000.00'), due_date: PAST }),
      ]);
      expect(totals).toEqual({
        invoice_count: 3,
        total_billed: 6900,
        total_paid: 5800,
        total_balance: 1300,
        total_overpaid: 200,
        overdue_count: 1,
        overdue_balance: 1300,
      });
      expect(totals.total_paid - totals.total_overpaid + totals.total_balance).toBe(totals.total_billed);
    });
  });

  describe('14. validatePaymentAmount', () => {
    it('rejects zero, negative, blank and non-numeric amounts', () => {
      for (const amount of [0, '0', -1, '-50', '', null, undefined, 'abc', '0.001']) {
        expect(validatePaymentAmount(amount as any, 230000)).toBeTruthy();
      }
    });

    it('rejects amounts above the outstanding balance', () => {
      expect(validatePaymentAmount(1300.01, 130000)).toBe('Payment amount cannot exceed the outstanding balance of ₹1300.00.');
    });

    it('accepts amounts up to the outstanding balance', () => {
      expect(validatePaymentAmount(1300, 130000)).toBeNull();
      expect(validatePaymentAmount('201.68', 20168)).toBeNull();
    });
  });

  describe('findInitialPaymentId', () => {
    const created = new Date('2026-10-01T10:00:00.000Z');
    const later = (ms: number) => new Date(created.getTime() + ms);

    it('finds the creation payment by its note', () => {
      expect(findInitialPaymentId({
        created_at: created,
        payments: [{ id: 9, notes: 'later', created_at: later(1000) }, { id: 7, notes: INITIAL_PAYMENT_NOTE, created_at: later(100000) }],
      })).toBe(7);
    });

    it('still finds it after the note was edited (created in the same transaction)', () => {
      expect(findInitialPaymentId({
        created_at: created,
        payments: [{ id: 5, notes: 'edited note', created_at: later(40) }, { id: 6, notes: '', created_at: later(86400000) }],
      })).toBe(5);
    });

    it('returns null for payments recorded later', () => {
      expect(findInitialPaymentId({ created_at: created, payments: [{ id: 5, notes: '', created_at: later(60000) }] })).toBeNull();
    });

    it('returns null for legacy invoices using the advance column', () => {
      expect(findInitialPaymentId({
        created_at: created,
        advance: D('1000.00'),
        payments: [{ id: 5, notes: INITIAL_PAYMENT_NOTE, created_at: later(10) }],
      })).toBeNull();
    });
  });
});
