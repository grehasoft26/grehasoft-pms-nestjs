import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import * as request from 'supertest';
import { Prisma } from '@prisma/client';
import { InvoicesService } from './invoices.service';
import { InvoicesController } from './invoices.controller';
import { InvoicePaymentsService } from './invoice-payments.service';
import { ReportsController } from '../reports/reports.controller';
import { ReportsService } from '../reports/reports.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { dateOnlyOrToday, parseInvoiceMonth } from './invoice-status';

/**
 * Invoice dashboard: month filter for the list and the summary cards, and Asia/Kolkata date defaults.
 * "Today" is 17 Nov 2026, 12:00 IST; the process time zone is UTC (production-like).
 */

type Row = Record<string, any>;
const D = (v: string | number) => new Prisma.Decimal(v);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const valueOf = (v: any) => (v instanceof Date ? v.getTime() : v);

const CLIENT_A = { id: 1, name: 'Acme', company_name: 'Acme Pvt Ltd', email: 'a@x', phone: '', address: '' };
const CLIENT_B = { id: 2, name: 'Birch', company_name: 'Birch LLP', email: 'b@x', phone: '', address: '' };

let paymentSeq = 500;
const pay = (invoiceId: number, amount: string, date: string) => ({
  id: ++paymentSeq, invoice_id: invoiceId, receipt_number: null, amount: D(amount), payment_date: day(date), payment_mode: 'cash', notes: '', created_at: day(date),
});
const invoice = (id: number, issue: string, total: string, o: { client?: Row; due?: string | null; payments?: Row[]; advance?: string; number?: string } = {}) => ({
  id,
  invoice_number: o.number ?? `GSI/${id}`,
  client_id: (o.client ?? CLIENT_A).id,
  client: o.client ?? CLIENT_A,
  client_address: '',
  issue_date: day(issue),
  due_date: o.due === undefined ? null : o.due ? day(o.due) : null,
  advance: D(o.advance ?? '0.00'),
  subtotal: D(total),
  tax: D('0.00'),
  total: D(total),
  notes: '',
  created_at: day(issue),
  items: [],
  payments: o.payments ?? [],
});

/**
 * November 2026 invoices cover: paid, partial, a payment received LATER (December), overdue, overpaid, a legacy advance
 * column, a zero total. Neighbouring months, year-end and leap-day invoices test the boundaries.
 */
const ALL: Row[] = [
  invoice(1, '2026-10-31', '1000.00', { payments: [pay(1, '1000.00', '2026-10-31')] }), // last day of October
  invoice(2, '2026-11-01', '1000.00', { payments: [pay(2, '1000.00', '2026-11-02')], due: '2026-11-15', number: 'NOV-PAID' }), // first day of November
  invoice(3, '2026-11-10', '2000.00', { payments: [pay(3, '500.00', '2026-11-12'), pay(3, '500.00', '2026-12-05')], due: '2026-12-31', number: 'NOV-PARTIAL' }), // partial, one payment in December
  invoice(4, '2026-11-20', '1500.00', { due: '2026-11-16', number: 'NOV-OVERDUE' }), // unpaid, overdue (due before "today" 17 Nov)
  invoice(5, '2026-11-25', '800.00', { client: CLIENT_B, payments: [pay(5, '1000.00', '2026-11-26')], number: 'NOV-OVERPAID' }), // overpaid by 200
  invoice(6, '2026-11-30', '1200.00', { advance: '200.00', payments: [pay(6, '300.00', '2026-11-30')], due: '2027-01-15', number: 'NOV-ADVANCE' }), // last day of November, legacy advance
  invoice(7, '2026-11-15', '0.00', { client: CLIENT_B, number: 'NOV-ZERO' }), // zero total
  invoice(8, '2026-12-01', '5000.00', { payments: [pay(8, '5000.00', '2026-12-01')] }), // first day of December
  invoice(9, '2026-12-31', '700.00', { payments: [] }), // year-end
  invoice(10, '2027-01-01', '900.00', { payments: [] }), // new year
  invoice(11, '2028-02-29', '100.00'), // leap day
  invoice(12, '2028-03-01', '200.00'),
  invoice(13, '2027-02-28', '300.00'), // non-leap February
  invoice(14, '2027-03-01', '400.00'),
];
const NOV = [2, 3, 4, 5, 6, 7];

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    if (key === 'client') return matches(row.client ?? {}, cond);
    const value = valueOf(row[key]);
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('contains' in cond) return String(row[key] ?? '').includes(cond.contains);
      if ('in' in cond) return (cond.in as any[]).includes(row[key]);
      if ('gte' in cond && !(value >= valueOf(cond.gte))) return false;
      if ('lt' in cond && !(value < valueOf(cond.lt))) return false;
      return true;
    }
    return value === valueOf(cond);
  });

describe('Invoices: month filter, current-month summary, Asia/Kolkata date defaults', () => {
  let service: InvoicesService;
  let prisma: any;
  const admin = { id: 1, role: { name: 'SUPER_ADMIN' } };
  const originalTz = process.env.TZ;

  const makePrisma = (rows: Row[] = ALL) => ({
    client: { findUnique: jest.fn(async ({ where }: Row) => [CLIENT_A, CLIENT_B].find((c) => c.id === where.id) ?? null), findFirst: jest.fn(async () => CLIENT_A) },
    invoice: {
      findMany: jest.fn(async ({ where, select }: Row = {}) => {
        const found = rows.filter((r) => matches(r, where)).sort((a, b) => b.id - a.id);
        // `select` keeps only the requested columns, like Prisma
        return select ? found.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))) : found;
      }),
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async ({ where }: Row) => rows.find((r) => r.id === where.id) ?? null),
    },
  });

  const compile = async (extraProviders: any[] = []) => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: PdfService, useValue: { generateInvoicePdf: jest.fn() } },
        { provide: MailerService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        ...extraProviders,
      ],
    }).compile();
    service = module.get(InvoicesService);
  };

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    jest.setSystemTime(new Date('2026-11-17T06:30:00Z')); // 12:00 IST
    process.env.TZ = 'UTC';
    await compile();
  });

  afterEach(() => {
    process.env.TZ = originalTz;
    jest.useRealTimers();
  });

  const ids = (res: any) => (Array.isArray(res) ? res : res.results).map((i: any) => i.id).sort((a: number, b: number) => a - b);

  // ============================================================================================ parsing
  describe('month parsing', () => {
    it('accepts a real YYYY-MM month and gives the half-open date range', () => {
      expect(parseInvoiceMonth('2026-11')).toMatchObject({ month: '2026-11', from_date: '2026-11-01', to_date: '2026-11-30' });
      expect(parseInvoiceMonth('2026-11')!.from).toEqual(day('2026-11-01'));
      expect(parseInvoiceMonth('2026-11')!.to).toEqual(day('2026-12-01'));
    });

    it('year boundary: December ends on 31 Dec and the range stops at 1 Jan', () => {
      expect(parseInvoiceMonth('2026-12')).toMatchObject({ from_date: '2026-12-01', to_date: '2026-12-31' });
      expect(parseInvoiceMonth('2026-12')!.to).toEqual(day('2027-01-01'));
      expect(parseInvoiceMonth('2027-01')!.from).toEqual(day('2027-01-01'));
    });

    it('leap years: February has 29 days in 2028 and 28 days in 2027 and 2100', () => {
      expect(parseInvoiceMonth('2028-02')).toMatchObject({ to_date: '2028-02-29' });
      expect(parseInvoiceMonth('2028-02')!.to).toEqual(day('2028-03-01'));
      expect(parseInvoiceMonth('2027-02')).toMatchObject({ to_date: '2027-02-28' });
      expect(parseInvoiceMonth('2100-02')).toMatchObject({ to_date: '2100-02-28' });
    });

    it('rejects anything that is not exactly a real YYYY-MM month', () => {
      for (const bad of ['2026-13', '2026-00', '2026-1', '26-11', '2026-11-01', ' 2026-11', '2026-11 ', '11-2026', '2026/11', 'all', '2026-1a', '1999-12', '2101-01', 202611, null, undefined, {}]) {
        expect(parseInvoiceMonth(bad as any)).toBeNull();
      }
    });
  });

  // ============================================================================================ list
  describe('GET /invoices?month=', () => {
    it('lists only invoices issued in the month, including its first and last day (not the neighbours)', async () => {
      expect(ids(await service.findAll(admin, { month: '2026-11', limit: '100' }))).toEqual(NOV);
      expect(ids(await service.findAll(admin, { month: '2026-10', limit: '100' }))).toEqual([1]);
      expect(ids(await service.findAll(admin, { month: '2026-12', limit: '100' }))).toEqual([8, 9]);
      expect(ids(await service.findAll(admin, { month: '2027-01', limit: '100' }))).toEqual([10]);
    });

    it('leap day belongs to February 2028; 1 March to March', async () => {
      expect(ids(await service.findAll(admin, { month: '2028-02', limit: '100' }))).toEqual([11]);
      expect(ids(await service.findAll(admin, { month: '2028-03', limit: '100' }))).toEqual([12]);
      expect(ids(await service.findAll(admin, { month: '2027-02', limit: '100' }))).toEqual([13]);
    });

    it('filters the database by [first day, first day of next month) on the date column', async () => {
      await service.findAll(admin, { month: '2026-11' });
      const where = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(where.issue_date).toEqual({ gte: day('2026-11-01'), lt: day('2026-12-01') });
    });

    it('combines with search, client and status filters', async () => {
      expect(ids(await service.findAll(admin, { month: '2026-11', search: 'NOV-PAR', limit: '100' }))).toEqual([3]);
      expect(ids(await service.findAll(admin, { month: '2026-11', search: 'Birch', limit: '100' }))).toEqual([5, 7]);
      expect(ids(await service.findAll(admin, { month: '2026-11', client: '2', limit: '100' }))).toEqual([5, 7]);
      expect(ids(await service.findAll(admin, { month: '2026-11', status: 'partial', limit: '100' }))).toEqual([3, 6]);
      expect(ids(await service.findAll(admin, { month: '2026-11', status: 'overdue', limit: '100' }))).toEqual([4]);
      expect(ids(await service.findAll(admin, { month: '2026-11', status: 'paid', limit: '100' }))).toEqual([2, 5]); // 5 is overpaid
      // search that only matches another month's invoice finds nothing in this month
      expect(ids(await service.findAll(admin, { month: '2026-11', search: 'GSI/1', limit: '100' }))).toEqual([]);
    });

    it('pagination counts only the selected month and keeps the response shape', async () => {
      const page1: any = await service.findAll(admin, { month: '2026-11', page: '1', limit: '4' });
      const page2: any = await service.findAll(admin, { month: '2026-11', page: '2', limit: '4' });
      expect(page1.count).toBe(6);
      expect(page1.results.map((i: any) => i.id)).toEqual([7, 6, 5, 4]);
      expect(page2.results.map((i: any) => i.id)).toEqual([3, 2]);
      // The existing fields plus the period that was applied (only when a month is requested)
      expect(Object.keys(page1).sort()).toEqual(['count', 'next', 'period', 'previous', 'results']);
      expect(page1.period).toEqual({ type: 'month', month: '2026-11', from: '2026-11-01', to: '2026-11-30' });
      expect(page1.next).toBe('/api/v1/invoices?page=2');
      expect(page2.next).toBeNull();
      expect(page2.previous).toBe('/api/v1/invoices?page=1');
      expect(page1.results[0]).toMatchObject({ id: 7, issue_date: '2026-11-15', total: 0 });
    });

    it('an empty month returns count 0 and no rows', async () => {
      expect(await service.findAll(admin, { month: '2026-05', page: '1', limit: '10' })).toEqual({
        count: 0, next: null, previous: null, results: [],
        period: { type: 'month', month: '2026-05', from: '2026-05-01', to: '2026-05-31' },
      });
    });

    it('month omitted or empty: the complete list as before; all=true ignores the month (existing consumers unchanged)', async () => {
      expect(ids(await service.findAll(admin, { limit: '100' }))).toHaveLength(ALL.length);
      expect(ids(await service.findAll(admin, { month: '', limit: '100' }))).toHaveLength(ALL.length);
      // Without a month the paginated response keeps exactly its previous fields (no `period`)
      expect(Object.keys(await service.findAll(admin, { limit: '100' }) as any).sort()).toEqual(['count', 'next', 'previous', 'results']);
      expect(ids(await service.findAll(admin, { all: 'true' }))).toHaveLength(ALL.length);
      expect(ids(await service.findAll(admin, { all: 'true', month: '2026-11' }))).toHaveLength(ALL.length);
      const where = prisma.invoice.findMany.mock.calls.at(-1)![0].where;
      expect(where.issue_date).toBeUndefined();
    });

    it('an invalid month is rejected with 400 (also with all=true)', async () => {
      for (const month of ['2026-13', '2026-1', 'abc', '2026-11-01']) {
        await expect(service.findAll(admin, { month })).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.findAll(admin, { month, all: 'true' })).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    });
  });

  // ============================================================================================ analytics
  describe('GET /invoices/analytics?month=', () => {
    const sumRows = (rows: any[]) => ({
      invoices: rows.length,
      revenue: Math.round(rows.reduce((a, r) => a + r.total * 100, 0)) / 100,
      paid: Math.round(rows.reduce((a, r) => a + r.total_paid * 100, 0)) / 100,
      balance: Math.round(rows.reduce((a, r) => a + r.balance * 100, 0)) / 100,
      overpaid: Math.round(rows.reduce((a, r) => a + r.overpaid_amount * 100, 0)) / 100,
    });

    it('November: counts, revenue (GST included), paid to date (any payment date), pending, and the period', async () => {
      const a: any = await service.getAnalytics(admin, { month: '2026-11' });
      // revenue 1000 + 2000 + 1500 + 800 + 1200 + 0; paid 1000 + (500 + 500, the second received in December) + 0 + 1000 + (200 advance + 300) + 0
      expect(a).toMatchObject({
        total_invoices: 6,
        total_revenue: 6500,
        total_paid: 3500,
        total_balance: 3200, // 0 (paid) + 1000 (partial) + 1500 (unpaid) + 0 (overpaid) + 700 (advance + payment) + 0 (zero total)
        total_overpaid: 200,
        overdue_count: 1,
        overdue_balance: 1500,
        period: { type: 'month', month: '2026-11', from: '2026-11-01', to: '2026-11-30' },
      });
    });

    it('equals the sum of the invoice rows the list shows for the same month', async () => {
      for (const month of ['2026-10', '2026-11', '2026-12', '2027-01', '2028-02']) {
        const rows = (await service.findAll(admin, { month, limit: '100' }) as any).results;
        const sums = sumRows(rows);
        const a: any = await service.getAnalytics(admin, { month });
        expect([a.total_invoices, a.total_revenue, a.total_paid, a.total_balance, a.total_overpaid]).toEqual([sums.invoices, sums.revenue, sums.paid, sums.balance, sums.overpaid]);
      }
    });

    it('partial payment, a payment received in a later month, overpayment and a zero-total invoice, one by one', async () => {
      const only = async (invoiceNumber: string) => {
        prisma.invoice.findMany.mockImplementationOnce(async ({ select }: Row) =>
          ALL.filter((r) => r.invoice_number === invoiceNumber).map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))),
        );
        return service.getAnalytics(admin, { month: '2026-11' }) as any;
      };
      // Partial: 1000 of 2000 paid, of which 500 in December -> still counted as paid to date for November's invoice
      expect(await only('NOV-PARTIAL')).toMatchObject({ total_invoices: 1, total_revenue: 2000, total_paid: 1000, total_balance: 1000, overdue_count: 0 });
      // Overdue: unpaid and past due
      expect(await only('NOV-OVERDUE')).toMatchObject({ total_revenue: 1500, total_paid: 0, total_balance: 1500, overdue_count: 1, overdue_balance: 1500 });
      // Overpayment: paid counts the cash, pending is never negative
      expect(await only('NOV-OVERPAID')).toMatchObject({ total_revenue: 800, total_paid: 1000, total_balance: 0, total_overpaid: 200 });
      // Zero total: counted, no revenue, nothing pending
      expect(await only('NOV-ZERO')).toMatchObject({ total_invoices: 1, total_revenue: 0, total_paid: 0, total_balance: 0 });
      // Legacy advance column + a payment
      expect(await only('NOV-ADVANCE')).toMatchObject({ total_revenue: 1200, total_paid: 500, total_balance: 700 });
    });

    it('an empty month is all zeros with its period', async () => {
      expect(await service.getAnalytics(admin, { month: '2026-05' })).toEqual({
        total_invoices: 0, total_revenue: 0, total_paid: 0, total_balance: 0, total_overpaid: 0, overdue_count: 0, overdue_balance: 0,
        period: { type: 'month', month: '2026-05', from: '2026-05-01', to: '2026-05-31' },
      });
    });

    it('All Months (no month) keeps the all-time figures and field names; period says "all"', async () => {
      const a: any = await service.getAnalytics(admin, {});
      const rows = (await service.findAll(admin, { all: 'true' })) as any[];
      const sums = sumRows(rows);
      expect([a.total_invoices, a.total_revenue, a.total_paid, a.total_balance, a.total_overpaid]).toEqual([sums.invoices, sums.revenue, sums.paid, sums.balance, sums.overpaid]);
      expect(a.total_invoices).toBe(ALL.length);
      expect(Object.keys(a).sort()).toEqual(['overdue_balance', 'overdue_count', 'period', 'total_balance', 'total_invoices', 'total_overpaid', 'total_paid', 'total_revenue']);
      expect(a.period).toEqual({ type: 'all', month: null, from: null, to: null });
      expect((await service.getAnalytics(admin, undefined as any)).period.type).toBe('all');
    });

    it('is a lightweight query: amounts and payment amounts only, no client or items; and the month is applied in the database', async () => {
      await service.getAnalytics(admin, { month: '2026-11' });
      const args = prisma.invoice.findMany.mock.calls.at(-1)![0];
      expect(args.include).toBeUndefined();
      expect(args.select).toEqual({ id: true, total: true, advance: true, due_date: true, payments: { select: { amount: true } } });
      expect(args.where.issue_date).toEqual({ gte: day('2026-11-01'), lt: day('2026-12-01') });
    });

    it('an invalid month is a 400 and nothing is queried', async () => {
      await expect(service.getAnalytics(admin, { month: '2026-00' })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    });

    it('a client portal user only gets their own invoices in the summary', async () => {
      const a: any = await service.getAnalytics({ id: 9, role: { name: 'CLIENT' } }, { month: '2026-11' });
      expect(prisma.invoice.findMany.mock.calls.at(-1)![0].where.client_id).toBe(1);
      expect(a.total_invoices).toBe(4); // Acme's November invoices: 2, 3, 4, 6
    });
  });

  // ============================================================================================ HTTP
  describe('HTTP: the invoices route serves the summary (not shadowed by the reports module duplicate) and returns 400', () => {
    let app: any;
    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        // Same order as the application: InvoicesModule is registered before ReportsModule
        controllers: [InvoicesController, ReportsController],
        providers: [
          { provide: InvoicesService, useValue: service },
          { provide: ReportsService, useValue: { getInvoiceAnalytics: jest.fn(async () => ({ total_billed: -1, total_pending: -1, invoice_count: -1 })) } },
        ],
      })
        .overrideGuard(JwtAuthGuard).useValue({ canActivate: (c: any) => { c.switchToHttp().getRequest().user = admin; return true; } })
        .overrideGuard(PermissionsGuard).useValue({ canActivate: () => true })
        .compile();
      app = moduleRef.createNestApplication();
      await app.init();
    });
    afterEach(async () => app.close());

    it('GET /api/v1/invoices/analytics?month=2026-11 is answered by the invoices controller, with the period', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/invoices/analytics?month=2026-11');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total_invoices: 6, total_revenue: 6500, period: { month: '2026-11' } });
      expect(res.body.total_billed).toBeUndefined(); // the reports module's duplicate shape is NOT what is served
    });

    it('GET /api/v1/invoices/analytics without a month is the all-time summary', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/invoices/analytics');
      expect(res.status).toBe(200);
      expect(res.body.total_invoices).toBe(ALL.length);
      expect(res.body.period.type).toBe('all');
    });

    it('invalid month returns HTTP 400 for the list and the summary', async () => {
      for (const url of ['/api/v1/invoices?month=2026-13', '/api/v1/invoices/analytics?month=2026-13', '/api/v1/invoices?month=nov', '/api/v1/invoices?all=true&month=2026-1']) {
        const res = await request(app.getHttpServer()).get(url);
        expect(res.status).toBe(400);
      }
    });

    it('GET /api/v1/invoices?month=2026-11&page=1&limit=10 keeps the paginated shape', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/invoices?month=2026-11&page=1&limit=10');
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(6);
      expect(res.body.results).toHaveLength(6);
    });
  });

  // ============================================================================================ date defaults
  describe('date-only defaults use Asia/Kolkata, not the server\'s UTC date', () => {
    it('dateOnlyOrToday: 00:00-05:29 IST is already the new IST day (UTC process clock)', () => {
      expect(dateOnlyOrToday(undefined, new Date('2026-11-30T19:30:00Z'))).toEqual(day('2026-12-01')); // 01:00 IST on 1 Dec; UTC still says 30 Nov
      expect(dateOnlyOrToday('', new Date('2026-11-30T18:29:59Z'))).toEqual(day('2026-11-30')); // 23:59:59 IST
      expect(dateOnlyOrToday(null, new Date('2026-11-30T18:30:00Z'))).toEqual(day('2026-12-01')); // 00:00 IST
      expect(dateOnlyOrToday(undefined, new Date('2026-12-31T20:00:00Z'))).toEqual(day('2027-01-01')); // year end
      expect(dateOnlyOrToday('2026-03-05')).toEqual(day('2026-03-05')); // an explicit date is preserved
    });

    describe('create / update / preview', () => {
      const makeTx = () => {
        const captured: Row = { invoice: null, payment: null };
        const tx = {
          invoice: { create: jest.fn(async ({ data }: Row) => { captured.invoice = data; return { id: 99, ...data }; }) },
          invoiceItem: { create: jest.fn(async () => ({})) },
          invoicePayment: { create: jest.fn(async ({ data }: Row) => { captured.payment = data; return { id: 1, ...data }; }) },
        };
        prisma.$transaction = jest.fn(async (cb: any) => cb(tx));
        prisma.invoice.findUnique = jest.fn(async () => ({ ...invoice(99, '2026-12-01', '1000.00'), payments: [] }));
        return captured;
      };
      const body = (extra: Row = {}) => ({ client: 1, invoice_number: 'GSI/NEW/001', items: [{ description: 'Work', quantity: 1, rate: 1000 }], payment_amount: 100, ...extra });

      it('create without an issue date: issue and payment date are today in IST (1 Dec at 01:00 IST, UTC says 30 Nov)', async () => {
        jest.setSystemTime(new Date('2026-11-30T19:30:00Z'));
        const captured = makeTx();
        await service.create(admin, body());
        expect(captured.invoice.issue_date).toEqual(day('2026-12-01'));
        expect(captured.payment.payment_date).toEqual(day('2026-12-01'));
      });

      it('create keeps explicitly chosen issue and payment dates', async () => {
        jest.setSystemTime(new Date('2026-11-30T19:30:00Z'));
        const captured = makeTx();
        await service.create(admin, body({ issue_date: '2026-11-20', payment_date: '2026-11-25' }));
        expect(captured.invoice.issue_date).toEqual(day('2026-11-20'));
        expect(captured.payment.payment_date).toEqual(day('2026-11-25'));
        const again = makeTx();
        await service.create(admin, body({ issue_date: '2026-11-20' }));
        expect(again.payment.payment_date).toEqual(day('2026-11-20')); // payment defaults to the issue date, as before
      });

      it('payments service: a payment without a date is dated today in IST', async () => {
        jest.setSystemTime(new Date('2026-11-30T19:30:00Z'));
        const captured: Row = {};
        const tx: any = {
          $queryRaw: jest.fn(async () => []),
          invoice: { findUnique: jest.fn(async () => ({ ...invoice(7, '2026-11-01', '1000.00'), payments: [] })) },
          invoicePayment: { create: jest.fn(async ({ data }: Row) => { captured.data = data; return { id: 3, ...data, created_at: new Date() }; }) },
        };
        const paymentsService = new InvoicePaymentsService({ $transaction: async (cb: any) => cb(tx) } as any, {} as any, {} as any, {} as any);
        await paymentsService.create(admin, { invoice: 7, amount: 100 });
        expect(captured.data.payment_date).toEqual(day('2026-12-01'));
        await paymentsService.create(admin, { invoice: 7, amount: 100, payment_date: '2026-11-18' });
        expect(captured.data.payment_date).toEqual(day('2026-11-18'));
      });
    });
  });
});
