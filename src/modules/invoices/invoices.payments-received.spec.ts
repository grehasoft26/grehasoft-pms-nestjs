import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';
import { INITIAL_PAYMENT_NOTE, computeInvoiceFinancials } from './invoice-status';

/**
 * Invoice summary "Payments Received" (GET /invoices/analytics total_paid): money RECEIVED in the selected month, by
 * InvoicePayment.payment_date, whatever the invoice's issue date. A legacy Invoice.advance (no date) counts on its
 * invoice's issue date, unless the invoice also has the payment recorded at creation (INITIAL_PAYMENT_NOTE), which
 * already represents it. Revenue and Pending stay on the issue date; per-invoice financials are unchanged.
 *
 * The Prisma stand-in applies the same where-conditions Prisma would (dates, client, advance > 0, nested notes filter).
 */
const D = (v: string | number) => new Prisma.Decimal(v);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const t = (d: Date) => d.getTime();

let paymentSeq = 100;
const pay = (amount: string, date: string, notes = '') => ({ id: ++paymentSeq, amount: D(amount), payment_date: day(date), notes });
const invoice = (id: number, issue: string, total: string, payments: any[] = [], o: { advance?: string; client?: number; due?: string } = {}) => ({
  id, client_id: o.client ?? 1, issue_date: day(issue), due_date: o.due ? day(o.due) : null,
  total: D(total), advance: D(o.advance ?? '0.00'), payments: payments.map((p) => ({ ...p, invoice_id: id })),
});

const inRange = (value: Date, range: any) => !range || (t(value) >= t(range.gte) && t(value) < t(range.lt));

const buildPrisma = (rows: any[]) => ({
  client: { findFirst: jest.fn(async ({ where }: any) => (where.portal_users.some.id === 50 ? { id: 2 } : { id: 1 })) },
  invoice: {
    findMany: jest.fn(async ({ where = {}, select }: any = {}) => {
      const found = rows
        .filter((r) => inRange(r.issue_date, where.issue_date))
        .filter((r) => where.client_id === undefined || r.client_id === where.client_id)
        .filter((r) => !where.advance || Number(r.advance) > Number(where.advance.gt));
      return found.map((r) => Object.fromEntries(Object.keys(select).map((k) => {
        if (k !== 'payments') return [k, r[k]];
        const nestedWhere = select.payments.where;
        const ps = r.payments.filter((p: any) => !nestedWhere || p.notes === nestedWhere.notes);
        return [k, ps.map((p: any) => Object.fromEntries(Object.keys(select.payments.select).map((pk) => [pk, p[pk]])))];
      })));
    }),
  },
  invoicePayment: {
    aggregate: jest.fn(async ({ where = {} }: any) => {
      const found = rows
        .filter((r) => !where.invoice || r.client_id === where.invoice.client_id)
        .flatMap((r) => r.payments)
        .filter((p: any) => inRange(p.payment_date, where.payment_date));
      return { _sum: { amount: found.length ? found.reduce((a: any, p: any) => a.plus(p.amount), D(0)) : null } };
    }),
  },
  expense: { aggregate: jest.fn(async () => ({ _sum: { amount_paid: null } })) },
});

const admin = { id: 1, is_superuser: true, role: { name: 'SUPER_ADMIN' } };

describe('Invoice summary: Payments Received by payment date', () => {
  let service: InvoicesService;

  const compile = async (rows: any[]) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: buildPrisma(rows) },
        { provide: PdfService, useValue: {} },
        { provide: MailerService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();
    service = module.get(InvoicesService);
  };
  const cards = async (month?: string, user: any = admin): Promise<any> => service.getAnalytics(user, month ? { month } : {});

  it('the reported example: an October invoice paid in November counts in November, not October', async () => {
    await compile([invoice(1, '2026-10-12', '25000.00', [pay('10000.00', '2026-11-12')])]);
    const oct = await cards('2026-10');
    const nov = await cards('2026-11');
    expect(oct).toMatchObject({ total_paid: 0, total_revenue: 25000, total_balance: 15000, total_invoices: 1 });
    expect(nov).toMatchObject({ total_paid: 10000, total_revenue: 0, total_balance: 0, total_invoices: 0 });
    // Profit uses the same figure
    expect(nov.period_collections).toBe(10000);
    expect(oct.period_collections).toBe(0);
  });

  it('multiple and partial payments across months each count in their own month; All Months is their total', async () => {
    await compile([
      invoice(1, '2026-09-20', '10000.00', [pay('2000.00', '2026-09-25'), pay('3000.00', '2026-10-05'), pay('1500.50', '2026-11-30')]),
      invoice(2, '2026-10-01', '4000.00', [pay('4000.00', '2026-10-01')]),
    ]);
    expect((await cards('2026-09')).total_paid).toBe(2000);
    expect((await cards('2026-10')).total_paid).toBe(7000);
    expect((await cards('2026-11')).total_paid).toBe(1500.5);
    expect((await cards()).total_paid).toBe(10500.5);
  });

  it('month boundaries: first and last day, and December to January', async () => {
    await compile([
      invoice(1, '2026-10-01', '9000.00', [
        pay('100.00', '2026-10-31'), pay('200.00', '2026-11-01'), pay('300.00', '2026-11-30'),
        pay('400.00', '2026-12-01'), pay('500.00', '2026-12-31'), pay('600.00', '2027-01-01'),
      ]),
    ]);
    expect((await cards('2026-10')).total_paid).toBe(100);
    expect((await cards('2026-11')).total_paid).toBe(500);
    expect((await cards('2026-12')).total_paid).toBe(900);
    expect((await cards('2027-01')).total_paid).toBe(600);
  });

  it('a legacy advance with no initial-payment record counts on its invoice issue date (Option B), once', async () => {
    await compile([invoice(1, '2026-10-12', '25000.00', [pay('5000.00', '2026-11-03')], { advance: '8000.00' })]);
    expect((await cards('2026-10')).total_paid).toBe(8000);
    expect((await cards('2026-11')).total_paid).toBe(5000);
    expect((await cards('2026-12')).total_paid).toBe(0);
    expect((await cards()).total_paid).toBe(13000);
  });

  it('a legacy advance already represented by the initial-payment record (INITIAL_PAYMENT_NOTE) is not counted twice', async () => {
    await compile([
      invoice(1, '2026-10-12', '25000.00', [pay('8000.00', '2026-10-15', INITIAL_PAYMENT_NOTE), pay('2000.00', '2026-11-03')], { advance: '8000.00' }),
    ]);
    // Only the dated initial payment (15 Oct) counts, not the advance again
    expect((await cards('2026-10')).total_paid).toBe(8000);
    expect((await cards('2026-11')).total_paid).toBe(2000);
    expect((await cards()).total_paid).toBe(10000);
  });

  it('matching amounts alone are not treated as duplicates (only the creation marker is)', async () => {
    await compile([invoice(1, '2026-10-12', '25000.00', [pay('8000.00', '2026-10-15', 'Bank transfer')], { advance: '8000.00' })]);
    expect((await cards('2026-10')).total_paid).toBe(16000);
  });

  it('client-portal users see only their own payments received', async () => {
    await compile([
      invoice(1, '2026-10-12', '1000.00', [pay('1000.00', '2026-11-02')], { client: 1 }),
      invoice(2, '2026-10-20', '700.00', [pay('700.00', '2026-11-04')], { client: 2, advance: '300.00' }),
    ]);
    const clientOne = { id: 49, role: { name: 'CLIENT' } };
    const clientTwo = { id: 50, role: { name: 'CLIENT' } };
    expect((await cards('2026-11', clientOne)).total_paid).toBe(1000);
    expect((await cards('2026-11', clientTwo)).total_paid).toBe(700);
    expect((await cards('2026-10', clientTwo)).total_paid).toBe(300); // their legacy advance, on the issue date
    expect((await cards('2026-11', admin)).total_paid).toBe(1700);
  });

  it('revenue and pending stay on the issue date; per-invoice financials and statuses are unchanged', async () => {
    const rows = [
      invoice(1, '2026-10-12', '25000.00', [pay('10000.00', '2026-11-12')], { due: '2026-10-20' }),
      invoice(2, '2026-10-25', '5000.00', [pay('8000.00', '2026-10-30', INITIAL_PAYMENT_NOTE)], { advance: '0.00' }),
      invoice(3, '2026-10-28', '3000.00', [], { advance: '1000.00' }),
    ];
    await compile(rows);
    const oct = await cards('2026-10');
    const perInvoice = rows.map((r) => computeInvoiceFinancials({ total: r.total, advance: r.advance, payments: r.payments, due_date: r.due_date }, { today: '2026-11-15' }));
    expect(oct.total_revenue).toBe(33000);
    expect(oct.total_balance).toBe(perInvoice.reduce((a, f) => a + f.balance, 0)); // 15000 + 0 + 2000
    expect(oct.total_balance).toBe(17000);
    expect(oct.total_overpaid).toBe(3000);
    // October receipts: 8000 (30 Oct) + 1000 legacy advance; the 10000 of 12 Nov is November's
    expect(oct.total_paid).toBe(9000);
    // The per-invoice rules are untouched: invoice 1 is partial (10000 paid to date), invoice 3 counts its advance
    expect(perInvoice.map((f) => [f.total_paid, f.payment_status])).toEqual([[10000, 'partial'], [8000, 'paid'], [1000, 'partial']]);
  });

  it('an empty month and an invoice-free month with receipts', async () => {
    await compile([invoice(1, '2026-10-12', '1000.00', [pay('1000.00', '2026-12-05')])]);
    expect(await cards('2026-05')).toMatchObject({ total_paid: 0, total_invoices: 0 });
    expect(await cards('2026-12')).toMatchObject({ total_paid: 1000, total_invoices: 0, total_revenue: 0, total_balance: 0 });
  });
});
