import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';

/**
 * Invoice View "Expenses" (GET /invoices/:id, payment_expenses_total): Σ amount of the expenses recorded with this
 * invoice's payments (expenses.invoice_payment_id), excluding deleted, rejected and non-positive ones, summed in paise.
 * Staff only (client portal users never receive it). Total, Paid and Balance are unchanged.
 * The Prisma stand-in applies the same include/select the real query uses: staff get each payment's linked expense
 * (id, title, amount, approval_status, deleted_at); client portal users get plain payments.
 */
const D = (v: string | number) => new Prisma.Decimal(v);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

const staff = { id: 1, is_superuser: true, role: { name: 'SUPER_ADMIN' } };
const portalClient = { id: 9, role: { name: 'CLIENT' } };

type Expense = { id: number; invoice_payment_id: number | null; invoice_id: number | null; title: string; amount: any; approval_status: string; deleted_at: Date | null };

const setup = async (opts: { total?: string; advance?: string; payments: any[]; expenses: Expense[] }) => {
  const invoice = {
    id: 1, invoice_number: 'GSI/2026-27/001', client_id: 7, issue_date: day('2026-11-01'), due_date: null,
    subtotal: D(opts.total ?? '30000.00'), tax: D('0.00'), total: D(opts.total ?? '30000.00'), advance: D(opts.advance ?? '0.00'),
    notes: '', created_at: new Date('2026-11-01T05:00:00Z'), client: { id: 7, name: 'Acme', phone: '9876543210' }, items: [],
  };
  const prisma: any = {
    invoice: {
      findUnique: jest.fn(async ({ include }: any) => {
        const withExpense = include?.payments !== true && include?.payments?.include?.expense;
        const sel = withExpense ? include.payments.include.expense.select : null;
        const payments = opts.payments.map((p) => {
          if (!withExpense) return { ...p };
          const e = opts.expenses.find((x) => x.invoice_payment_id === p.id); // unique link: at most one per payment
          return { ...p, expense: e ? Object.fromEntries(Object.keys(sel).map((k) => [k, (e as any)[k]])) : null };
        });
        return { ...invoice, payments };
      }),
    },
    client: { findFirst: jest.fn(async () => ({ id: 7 })) },
  };
  const module = await Test.createTestingModule({
    providers: [
      InvoicesService,
      { provide: PrismaService, useValue: prisma },
      { provide: PdfService, useValue: {} },
      { provide: MailerService, useValue: {} },
      { provide: ConfigService, useValue: { get: jest.fn() } },
    ],
  }).compile();
  return { svc: module.get(InvoicesService), prisma };
};

let nextId = 100;
const payment = (amount: string | number, date = '2026-11-10') => ({
  id: nextId++, invoice_id: 1, receipt_number: null, amount: D(amount), payment_date: day(date), payment_mode: 'bank', notes: '', created_at: new Date(),
});
const linkedExpense = (paymentId: number, amount: string | number, extra: Partial<Expense> = {}): Expense => ({
  id: nextId++, invoice_payment_id: paymentId, invoice_id: 1, title: 'Gateway fee', amount: D(amount), approval_status: 'approved', deleted_at: null, ...extra,
});

describe('Invoice details: payment_expenses_total', () => {
  it('one eligible linked expense; Total, Paid and Balance unchanged', async () => {
    const p = payment('30000.00');
    const { svc } = await setup({ payments: [p], expenses: [linkedExpense(p.id, '5000.00')] });
    const res: any = await svc.findOne(1, staff);
    expect(res.payment_expenses_total).toBe(5000);
    expect([res.total, res.total_paid, res.balance]).toEqual([30000, 30000, 0]);
    expect(res.payments[0].linked_expense).toEqual({ id: expect.any(Number), title: 'Gateway fee', deleted: false, amount: 5000, rejected: false });
  });

  it('multiple eligible linked expenses, summed exactly in paise', async () => {
    const a = payment('10000.00');
    const b = payment('5000.00');
    const c = payment('0.50');
    const { svc } = await setup({
      payments: [a, b, c],
      expenses: [linkedExpense(a.id, '0.10'), linkedExpense(b.id, '0.20'), linkedExpense(c.id, '1234.56')],
    });
    const res: any = await svc.findOne(1, staff);
    expect(res.payment_expenses_total).toBe(1234.86); // 0.10 + 0.20 + 1234.56, no floating-point drift
    expect([res.total_paid, res.balance]).toEqual([15000.5, 14999.5]);
  });

  it('deleted, rejected and non-positive linked expenses are excluded; pending approval counts', async () => {
    const [a, b, c, d, e] = [payment('100'), payment('100'), payment('100'), payment('100'), payment('100')];
    const { svc } = await setup({
      payments: [a, b, c, d, e],
      expenses: [
        linkedExpense(a.id, '700.00', { deleted_at: new Date('2026-11-12') }),
        linkedExpense(b.id, '800.00', { approval_status: 'rejected' }),
        linkedExpense(c.id, '0.00'),
        linkedExpense(d.id, '-50.00'),
        linkedExpense(e.id, '250.00', { approval_status: 'pending' }),
      ],
    });
    const res: any = await svc.findOne(1, staff);
    expect(res.payment_expenses_total).toBe(250);
    // The per-payment note still shows them, flagged
    const byPayment = Object.fromEntries(res.payments.map((p: any) => [p.id, p.linked_expense]));
    expect(byPayment[a.id]).toMatchObject({ deleted: true, amount: 700 });
    expect(byPayment[b.id]).toMatchObject({ rejected: true, amount: 800 });
  });

  it('an expense linked only through invoice_id (no payment link) is not counted', async () => {
    const p = payment('30000.00');
    const invoiceOnly: Expense = { id: 555, invoice_payment_id: null, invoice_id: 1, title: 'Courier', amount: D('900.00'), approval_status: 'approved', deleted_at: null };
    const { svc } = await setup({ payments: [p], expenses: [invoiceOnly] });
    const res: any = await svc.findOne(1, staff);
    expect(res.payment_expenses_total).toBe(0);
    expect(res.payments[0].linked_expense).toBeNull();
  });

  it('no eligible expenses returns 0, also for an invoice without payments', async () => {
    const { svc } = await setup({ payments: [], expenses: [] });
    const res: any = await svc.findOne(1, staff);
    expect(res.payment_expenses_total).toBe(0);
    expect([res.total, res.total_paid, res.balance]).toEqual([30000, 0, 30000]);
  });

  it('client portal users never receive the field (nor linked expenses)', async () => {
    const p = payment('30000.00');
    const { svc, prisma } = await setup({ payments: [p], expenses: [linkedExpense(p.id, '5000.00')] });
    const res: any = await svc.findOne(1, portalClient);
    expect(res).not.toHaveProperty('payment_expenses_total');
    expect(res.payments[0]).not.toHaveProperty('linked_expense');
    expect(prisma.invoice.findUnique.mock.calls[0][0].include.payments).toBe(true);
  });

  it('staff query loads exactly the linked expense fields needed', async () => {
    const { svc, prisma } = await setup({ payments: [], expenses: [] });
    await svc.findOne(1, staff);
    expect(prisma.invoice.findUnique.mock.calls[0][0].include.payments).toEqual({
      include: { expense: { select: { id: true, title: true, amount: true, approval_status: true, deleted_at: true } } },
    });
  });

  it('a legacy advance and expenses never change Paid or Balance (expenses are shown separately)', async () => {
    const p = payment('20000.00');
    const { svc } = await setup({ advance: '5000.00', payments: [p], expenses: [linkedExpense(p.id, '3000.00')] });
    const res: any = await svc.findOne(1, staff);
    expect([res.total, res.total_paid, res.balance, res.payment_expenses_total]).toEqual([30000, 25000, 5000, 3000]);
  });
});
