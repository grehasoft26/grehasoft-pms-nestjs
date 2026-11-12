import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';

/**
 * Regression: the summary cards (GET /invoices/analytics?month) and the invoice list (GET /invoices?month) must always
 * describe exactly the same issue-date period. Reported defect: September 2026 showed 1 invoice / ₹4,000 / ₹0 / ₹4,000
 * and listed the invoice dated 26 October 2026 (the API that served it ignored `month`, so both were all-time).
 *
 * For every month: same period object in both responses, count == total_invoices, the cards equal the sums of ALL list
 * rows (every page), every row's issue date lies inside the period, and an empty month is zero everywhere.
 */

const D = (v: string | number) => new Prisma.Decimal(v);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const CLIENT = { id: 1, name: 'ksfe', company_name: 'ksfe', email: 'k@x', phone: '', address: '' };
const invoice = (id: number, issue: string, total: string, payments: { amount: string; date: string }[] = [], due: string | null = null) => ({
  id, invoice_number: `GSI/2026-27/${String(id).padStart(3, '0')}`, client_id: 1, client: CLIENT, client_address: '',
  issue_date: day(issue), due_date: due ? day(due) : null, advance: D('0.00'), subtotal: D(total), tax: D('0.00'), total: D(total),
  notes: '', created_at: day(issue), items: [],
  payments: payments.map((p, i) => ({ id: id * 100 + i, invoice_id: id, receipt_number: null, amount: D(p.amount), payment_date: day(p.date), payment_mode: 'cash', notes: '', created_at: day(p.date) })),
});

/** The local database at the time of the report: one unpaid invoice of ₹4,000 issued 26 Oct 2026, due 28 Oct. */
const REPORTED = [invoice(1, '2026-10-26', '4000.00', [], '2026-10-28')];

/** A busier dataset: month edges, several pages, partial / later-month / over payments, and a zero total. */
const BUSY = [
  ...REPORTED,
  invoice(2, '2026-09-30', '1000.00', [{ amount: '1000.00', date: '2026-10-02' }]),
  invoice(3, '2026-10-01', '2500.50', [{ amount: '500.25', date: '2026-10-05' }, { amount: '1000.00', date: '2026-11-03' }], '2026-10-20'),
  invoice(4, '2026-10-31', '800.00', [{ amount: '900.00', date: '2026-10-31' }]),
  invoice(5, '2026-11-01', '0.00'),
  ...Array.from({ length: 23 }, (_, i) => invoice(10 + i, `2026-10-${String(2 + i).padStart(2, '0')}`, `${100 + i}.10`, i % 3 === 0 ? [{ amount: '50.05', date: '2026-12-01' }] : [], '2026-12-15')),
];

const MONTHS = ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12'];

const build = async (rows: any[]) => {
  const valueOf = (v: any) => (v instanceof Date ? v.getTime() : v);
  const prisma = {
    client: { findFirst: jest.fn(async () => CLIENT) },
    invoice: {
      findMany: jest.fn(async ({ where = {}, select }: any = {}) => {
        const found = rows
          .filter((r) => !where.issue_date || (valueOf(r.issue_date) >= valueOf(where.issue_date.gte) && valueOf(r.issue_date) < valueOf(where.issue_date.lt)))
          .filter((r) => where.client_id === undefined || r.client_id === where.client_id)
          .sort((a, b) => b.id - a.id);
        return select ? found.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))) : found;
      }),
    },
    // Payments Received: payments by payment_date, like Prisma's aggregate
    invoicePayment: {
      aggregate: jest.fn(async ({ where = {} }: any = {}) => {
        const found = rows.flatMap((r) => r.payments).filter((p: any) =>
          !where.payment_date || (valueOf(p.payment_date) >= valueOf(where.payment_date.gte) && valueOf(p.payment_date) < valueOf(where.payment_date.lt)));
        return { _sum: { amount: found.length ? found.reduce((a: any, p: any) => a.plus(p.amount), D(0)) : null } };
      }),
    },
    // Expenses: not part of these card-list agreement checks
    expense: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount_paid: null } }) },
  };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      InvoicesService,
      { provide: PrismaService, useValue: prisma },
      { provide: PdfService, useValue: {} },
      { provide: MailerService, useValue: {} },
      { provide: ConfigService, useValue: { get: jest.fn() } },
    ],
  }).compile();
  return module.get(InvoicesService);
};

const admin = { id: 1, role: { name: 'SUPER_ADMIN' } };
const paise = (n: number) => Math.round(n * 100);

/** Payments received in a "YYYY-MM" month (by payment date), from the test data; these datasets have no legacy advances. */
const receivedPaiseIn = (rows: any[], month: string) =>
  rows.flatMap((r) => r.payments).filter((p: any) => p.payment_date.toISOString().slice(0, 7) === month).reduce((a: number, p: any) => a + paise(Number(p.amount)), 0);

/** Every row of every page of the month (10 per page, as the dashboard requests). */
const allPages = async (service: InvoicesService, month: string) => {
  const rows: any[] = [];
  let first: any = null;
  for (let page = 1; ; page++) {
    const res: any = await service.findAll(admin, { month, page: String(page), limit: '10' });
    first ??= res;
    rows.push(...res.results);
    if (!res.next) break;
  }
  return { first, rows };
};

describe('Invoice dashboard: cards and list always describe the same month', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    jest.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  describe('the reported data (one ₹4,000 invoice issued 26 Oct 2026)', () => {
    it('September 2026: zero cards and an empty list (not the October invoice)', async () => {
      const service = await build(REPORTED);
      const list: any = await service.findAll(admin, { month: '2026-09', page: '1', limit: '10' });
      const cards: any = await service.getAnalytics(admin, { month: '2026-09' });
      expect(list).toMatchObject({ count: 0, results: [] });
      expect(cards).toMatchObject({ total_invoices: 0, total_revenue: 0, total_paid: 0, total_balance: 0 });
      expect(list.period).toEqual(cards.period);
      expect(cards.period).toEqual({ type: 'month', month: '2026-09', from: '2026-09-01', to: '2026-09-30' });
    });

    it('October 2026: the one invoice, ₹4,000 revenue, ₹0 paid, ₹4,000 pending, in both', async () => {
      const service = await build(REPORTED);
      const list: any = await service.findAll(admin, { month: '2026-10', page: '1', limit: '10' });
      const cards: any = await service.getAnalytics(admin, { month: '2026-10' });
      expect(list.count).toBe(1);
      expect(list.results.map((r: any) => [r.invoice_number, r.issue_date, r.total, r.total_paid, r.balance])).toEqual([['GSI/2026-27/001', '2026-10-26', 4000, 0, 4000]]);
      expect(cards).toMatchObject({ total_invoices: 1, total_revenue: 4000, total_paid: 0, total_balance: 4000 });
      expect(list.period).toEqual(cards.period);
    });

    it('November 2026: zero cards and an empty list', async () => {
      const service = await build(REPORTED);
      const list: any = await service.findAll(admin, { month: '2026-11', page: '1', limit: '10' });
      const cards: any = await service.getAnalytics(admin, { month: '2026-11' });
      expect(list).toMatchObject({ count: 0, results: [] });
      expect(cards).toMatchObject({ total_invoices: 0, total_revenue: 0, total_paid: 0, total_balance: 0 });
      expect(list.period).toEqual(cards.period);
    });
  });

  for (const [name, rows] of [['reported data', REPORTED], ['busy data (edges, pages, partial / later / over payments)', BUSY]] as const) {
    describe(name, () => {
      for (const month of MONTHS) {
        it(`${month}: same period, count = invoices, issue-date cards = sums of all list rows, payments received by date, rows inside the month`, async () => {
          const service = await build(rows as any[]);
          const { first, rows: listRows } = await allPages(service, month);
          const cards: any = await service.getAnalytics(admin, { month });

          expect(first.period).toEqual(cards.period);
          expect(first.period.month).toBe(month);
          expect(first.count).toBe(listRows.length);
          expect(cards.total_invoices).toBe(first.count);
          expect(paise(cards.total_revenue)).toBe(listRows.reduce((a, r) => a + paise(r.total), 0));
          // Payments Received: money received in the month (payment date), not the list rows' paid-to-date
          expect(paise(cards.total_paid)).toBe(receivedPaiseIn(rows as any[], month));
          expect(paise(cards.total_balance)).toBe(listRows.reduce((a, r) => a + paise(r.balance), 0));
          for (const r of listRows) {
            expect(r.issue_date >= first.period.from && r.issue_date <= first.period.to).toBe(true);
          }
          if (listRows.length === 0) {
            // No invoices issued: zero issue-date cards (payments may still have been received for older invoices)
            expect(cards).toMatchObject({ total_invoices: 0, total_revenue: 0, total_balance: 0 });
          }
        });
      }
    });
  }

  it('busy data, October: 26 invoices over 3 pages, and the cards equal all of them (not only page 1)', async () => {
    const service = await build(BUSY);
    const { first, rows } = await allPages(service, '2026-10');
    const cards: any = await service.getAnalytics(admin, { month: '2026-10' });
    expect(first.count).toBe(26);
    expect(rows).toHaveLength(26);
    expect(first.results).toHaveLength(10);
    expect(cards.total_invoices).toBe(26);
    // a later-month payment counts as paid to date for its October invoice; an overpayment never makes pending negative
    expect(rows.find((r: any) => r.id === 3)).toMatchObject({ total_paid: 1500.25, balance: 1000.25 });
    expect(rows.find((r: any) => r.id === 4)).toMatchObject({ total_paid: 900, balance: 0, overpaid_amount: 100 });
  });

  it('All Months: no period on the list, an "all" period on the cards, and both cover every invoice', async () => {
    const service = await build(BUSY);
    const list: any = await service.findAll(admin, { page: '1', limit: '100' });
    const cards: any = await service.getAnalytics(admin, {});
    expect(list.period).toBeUndefined();
    expect(cards.period).toEqual({ type: 'all', month: null, from: null, to: null });
    expect(cards.total_invoices).toBe(list.count);
    expect(list.count).toBe(BUSY.length);
    expect(paise(cards.total_revenue)).toBe(list.results.reduce((a: number, r: any) => a + paise(r.total), 0));
    // All time: every payment received equals the list's paid-to-date total (no legacy advances here)
    expect(paise(cards.total_paid)).toBe(list.results.reduce((a: number, r: any) => a + paise(r.total_paid), 0));
  });

  it('busy data: a later-month payment moves Payments Received to the month it was received', async () => {
    const service = await build(BUSY);
    // Invoice 3 (issued 1 Oct): 500.25 on 5 Oct and 1000.00 on 3 Nov; invoice 2 (issued 30 Sep) paid on 2 Oct
    const oct: any = await service.getAnalytics(admin, { month: '2026-10' });
    const nov: any = await service.getAnalytics(admin, { month: '2026-11' });
    const sep: any = await service.getAnalytics(admin, { month: '2026-09' });
    expect(paise(oct.total_paid)).toBe(paise(1000 + 500.25 + 900)); // 2 Oct, 5 Oct, 31 Oct
    expect(nov.total_paid).toBe(1000); // received 3 Nov for the October invoice
    expect(sep.total_paid).toBe(0); // the 30 Sep invoice was paid in October
    expect(sep.total_revenue).toBe(1000); // revenue stays on the issue date
  });
});
