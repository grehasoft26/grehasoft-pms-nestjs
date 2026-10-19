import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { InvoicesService } from './invoices.service';
import { InvoicePaymentsService } from './invoice-payments.service';
import { ClientPortalService } from '../client-portal/client-portal.service';
import { ReportsService } from '../reports/reports.service';
import { FinancialReportsService } from '../financial-reports/financial-reports.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';
import { toPaise, fromPaise } from './invoice-status';

/**
 * 18 / 19. The same invoices must produce the same figures in the invoices API,
 * client portal, invoice analytics, reports, financial reports and receipts.
 * "Today" is fixed at 17 Oct 2026, 12:00 IST.
 */
const D = (v: string | number) => new Prisma.Decimal(v);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const PAST = '2026-10-10';
const FUTURE = '2026-10-30';

let paymentId = 100;
const inv = (id: number, total: string, payments: string[], due: string | null, advance = '0.00') => ({
  id,
  invoice_number: `GSI/2026-27/0${id}`,
  client_id: 1,
  client_address: '',
  issue_date: day('2026-09-01'),
  due_date: due ? day(due) : null,
  advance: D(advance),
  subtotal: D(total),
  tax: D('0.00'),
  total: D(total),
  notes: '',
  created_at: new Date('2026-09-01T10:00:00.000Z'),
  items: [],
  payments: payments.map((amount, i) => ({
    id: ++paymentId,
    invoice_id: id,
    receipt_number: `RCT-${id}-${i}`,
    amount: D(amount),
    payment_date: day(`2026-09-${String(10 + i).padStart(2, '0')}`),
    payment_mode: 'cash',
    notes: '',
    created_at: new Date('2026-09-20T10:00:00.000Z'),
  })),
});

const INVOICES = [
  inv(1, '2300.00', ['1512.01', '586.31', '201.68'], PAST), // paid in decimal instalments, after due date
  inv(2, '2300.00', ['1000.00'], FUTURE), // partial
  inv(3, '2300.00', [], FUTURE), // unpaid
  inv(4, '2300.00', [], PAST), // overdue
  inv(5, '2300.00', ['1000.00'], PAST), // partial + overdue
  inv(6, '2300.00', ['2300.00'], PAST), // paid after due date
  inv(7, '2300.00', [], null), // no due date
  inv(8, '1800.00', ['1000.00', '1000.00'], PAST), // total reduced below paid -> overpaid 200
  inv(9, '2300.00', ['1300.00'], FUTURE, '1000.00'), // legacy advance column + payment
  inv(10, '0.00', [], PAST), // zero total
];

const EXPECTED: Record<number, { status: string; payment_status: string; is_overdue: boolean; balance: number }> = {
  1: { status: 'paid', payment_status: 'paid', is_overdue: false, balance: 0 },
  2: { status: 'partial', payment_status: 'partial', is_overdue: false, balance: 1300 },
  3: { status: 'unpaid', payment_status: 'unpaid', is_overdue: false, balance: 2300 },
  4: { status: 'overdue', payment_status: 'unpaid', is_overdue: true, balance: 2300 },
  5: { status: 'overdue', payment_status: 'partial', is_overdue: true, balance: 1300 },
  6: { status: 'paid', payment_status: 'paid', is_overdue: false, balance: 0 },
  7: { status: 'unpaid', payment_status: 'unpaid', is_overdue: false, balance: 2300 },
  8: { status: 'paid', payment_status: 'paid', is_overdue: false, balance: 0 },
  9: { status: 'paid', payment_status: 'paid', is_overdue: false, balance: 0 },
  10: { status: 'unpaid', payment_status: 'unpaid', is_overdue: false, balance: 0 },
};

const CLIENT = { id: 1, name: 'Acme', company_name: 'Acme Pvt Ltd', email: 'client@acme.test', phone: '', address: '' };

const buildPrisma = () => {
  const withClient = (i: any) => ({ ...i, client: CLIENT });
  const empty = { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) };
  const allPayments = () => INVOICES.flatMap((i) => i.payments.map((p) => ({ ...p, invoice: withClient(i) })));
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ lock_result: 1 }]),
    invoice: {
      findMany: jest.fn(async ({ where }: any = {}) =>
        INVOICES.filter((i) => where?.client_id === undefined || i.client_id === where.client_id).map(withClient),
      ),
      findUnique: jest.fn(async ({ where }: any) => {
        const found = INVOICES.find((i) => i.id === where.id);
        return found ? withClient(found) : null;
      }),
    },
    invoicePayment: {
      // Financial dashboard queries payments by date range; none fall in its months here
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(async ({ where }: any) => allPayments().find((p) => p.id === where.id) ?? null),
    },
    client: { findFirst: jest.fn().mockResolvedValue(CLIENT) },
    project: empty,
    sEOWebsite: empty,
    task: empty,
    sEOTask: empty,
    taskFile: empty,
    clientNotification: empty,
    expense: empty,
    expenseCategory: empty,
  };
};

const findKey = (obj: any, key: string): any => {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
};

describe('Invoice financials consistency across modules', () => {
  let invoices: InvoicesService;
  let payments: InvoicePaymentsService;
  let portal: ClientPortalService;
  let reports: ReportsService;
  let financial: FinancialReportsService;
  let pdfService: { generateReceiptPdf: jest.Mock; generateInvoicePdf: jest.Mock };

  const admin = { id: 1, role: { name: 'SUPER_ADMIN' } };
  const clientUser = { id: 50, client_id: 1, email: CLIENT.email, role: { name: 'CLIENT' } };

  beforeAll(() => {
    jest.useFakeTimers({ now: new Date('2026-10-17T06:30:00.000Z'), advanceTimers: true });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(async () => {
    pdfService = { generateReceiptPdf: jest.fn().mockResolvedValue(Buffer.from('pdf')), generateInvoicePdf: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        InvoicePaymentsService,
        ClientPortalService,
        ReportsService,
        FinancialReportsService,
        { provide: PrismaService, useValue: buildPrisma() },
        { provide: PdfService, useValue: pdfService },
        { provide: MailerService, useValue: { sendMail: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    invoices = module.get(InvoicesService);
    payments = module.get(InvoicePaymentsService);
    portal = module.get(ClientPortalService);
    reports = module.get(ReportsService);
    financial = module.get(FinancialReportsService);
  });

  const mainApi = async () => (await invoices.findAll(admin, { all: 'true' })) as any[];

  it('main invoices API returns the expected status for every scenario', async () => {
    for (const row of await mainApi()) {
      expect({ id: row.id, ...EXPECTED[row.id] }).toEqual({
        id: row.id,
        status: row.status,
        payment_status: row.payment_status,
        is_overdue: row.is_overdue,
        balance: row.balance,
      });
    }
  });

  it('never returns floating-point artifacts', async () => {
    for (const row of await mainApi()) {
      for (const key of ['total', 'total_paid', 'balance', 'overpaid_amount']) {
        expect(fromPaise(toPaise(row[key]))).toBe(row[key]);
      }
    }
  });

  it('18. client portal agrees with the main API and does not crash without a due date', async () => {
    const main = new Map((await mainApi()).map((r) => [r.id, r]));
    const overview: any = await portal.getClientDashboardOverview(clientUser);

    expect(overview.invoices).toHaveLength(INVOICES.length);
    for (const p of overview.invoices) {
      const m = main.get(p.id);
      expect({ id: p.id, status: p.status, payment_status: p.payment_status, is_overdue: p.is_overdue, balance: p.balance, total_paid: p.total_paid, due_date: p.due_date }).toEqual({
        id: m.id,
        status: m.status,
        payment_status: m.payment_status,
        is_overdue: m.is_overdue,
        balance: m.balance,
        total_paid: m.total_paid,
        due_date: m.due_date,
      });
    }
    expect(overview.invoices.find((i: any) => i.id === 7).due_date).toBeNull();
    expect(overview.invoices.some((i: any) => i.status === 'partially_paid')).toBe(false);

    // paid: 1, 6, 8, 9; pending (balance > 0): 2, 3, 4, 5, 7; zero-total invoice 10 is neither
    expect(overview.metrics.paid_invoices).toBe(4);
    expect(overview.metrics.pending_invoices).toBe(5);
  });

  it('19. analytics, reports and financial reports agree on paid, balance and overpayment', async () => {
    const analytics: any = await invoices.getAnalytics(admin);
    const report: any = await reports.getInvoiceAnalytics();
    const dashboard: any = await financial.getDashboardData(admin);

    const rows = await mainApi();
    const sum = (key: string) => fromPaise(rows.reduce((s, r) => s + toPaise(r[key]), 0));

    expect(analytics).toMatchObject({
      total_invoices: 10,
      total_revenue: sum('total'),
      total_paid: sum('total_paid'),
      total_balance: sum('balance'),
      total_overpaid: 200,
      overdue_count: 2,
      overdue_balance: 3600,
    });
    expect(report).toEqual({
      total_billed: analytics.total_revenue,
      total_paid: analytics.total_paid,
      total_pending: analytics.total_balance,
      total_overpaid: analytics.total_overpaid,
      invoice_count: 10,
    });
    expect(findKey(dashboard, 'total_outstanding_collections')).toBe(analytics.total_balance);

    // Cards reconcile: cash received - excess + outstanding = billed
    expect(analytics.total_paid - analytics.total_overpaid + analytics.total_balance).toBeCloseTo(analytics.total_revenue, 2);
  });

  it('19b. each invoice\'s latest receipt shows the same balance as the invoice', async () => {
    const main = new Map((await mainApi()).map((r) => [r.id, r]));

    for (const invoice of INVOICES.filter((i) => i.payments.length > 0)) {
      const last = invoice.payments[invoice.payments.length - 1];
      pdfService.generateReceiptPdf.mockClear();
      await payments.generateReceiptPdfStream(last.id, admin);
      const receipt = pdfService.generateReceiptPdf.mock.calls[0][0];
      const m = main.get(invoice.id);

      expect({ invoice: invoice.id, balance_due: receipt.balance_due }).toEqual({ invoice: invoice.id, balance_due: m.balance });
      expect(fromPaise(toPaise(receipt.previously_paid) + toPaise(receipt.payment_amount))).toBe(m.total_paid);
      expect(receipt.invoice_total).toBe(m.total);
    }
  });

  it('19c. the decimal-instalment receipts show exact running balances', async () => {
    const [p1, p2, p3] = INVOICES[0].payments;
    const balances: number[] = [];
    for (const p of [p1, p2, p3]) {
      pdfService.generateReceiptPdf.mockClear();
      await payments.generateReceiptPdfStream(p.id, admin);
      balances.push(pdfService.generateReceiptPdf.mock.calls[0][0].balance_due);
    }
    expect(balances).toEqual([787.99, 201.68, 0]);
  });
});
