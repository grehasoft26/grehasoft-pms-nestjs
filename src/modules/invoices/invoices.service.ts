import { Injectable, NotFoundException, ForbiddenException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';
import { getActiveRolePermissions, isSuperAdmin } from '../../core/utils/role-access.util';
import {
  INITIAL_PAYMENT_NOTE,
  InvoiceMonthRange,
  aggregateInvoiceFinancials,
  businessDateKey,
  computeInvoiceFinancials,
  dateOnlyOrToday,
  findInitialPaymentId,
  fromPaise,
  invoiceNumberPrefix,
  matchesInvoiceStatusFilter,
  parseInvoiceMonth,
  toPaise,
  validatePaymentAmount,
} from './invoice-status';

/**
 * Validity of the invoice secure links shared via WhatsApp (GET /invoices/:id/secure-link): exactly
 * 30 days. Receipt and offer-letter links keep their own 48-hour expiry. The expiry is signed into
 * each token, so links issued earlier keep the expiry they were issued with.
 */
export const INVOICE_SECURE_LINK_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The issue-date period of an invoice list page or summary: one calendar month, or all invoices. The list (with ?month)
 * and the analytics return the same object for the same request, so they can be checked against each other.
 */
export const invoicePeriod = (range: InvoiceMonthRange | null) =>
  range
    ? { type: 'month' as const, month: range.month, from: range.from_date, to: range.to_date }
    : { type: 'all' as const, month: null, from: null, to: null };

export class InvoiceSigning {
  static generateToken(invoiceId: number, secret: string, expiresInSeconds: number = 172800): string {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const payload = `${invoiceId}:${expiresAt}`;
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `${invoiceId}.${expiresAt}.${hmac}`;
  }

  static verifyToken(token: string, secret: string): { valid: boolean; invoiceId?: number; error?: string } {
    if (!token) {
      return { valid: false, error: 'Token is required.' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid signature token.' };
    }

    const [idStr, expiresAtStr, hmacStr] = parts;
    const invoiceId = parseInt(idStr, 10);
    const expiresAt = parseInt(expiresAtStr, 10);

    if (isNaN(invoiceId) || isNaN(expiresAt)) {
      return { valid: false, error: 'Invalid signature token.' };
    }

    const currentTimestamp = Math.floor(Date.now() / 1000);
    if (currentTimestamp > expiresAt) {
      return { valid: false, error: 'This secure link has expired.' };
    }

    const payload = `${invoiceId}:${expiresAt}`;
    const expectedHmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    try {
      const hmacBuffer = Buffer.from(hmacStr, 'hex');
      const expectedBuffer = Buffer.from(expectedHmac, 'hex');

      if (hmacBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(hmacBuffer, expectedBuffer)) {
        return { valid: false, error: 'Invalid signature token.' };
      }
    } catch {
      return { valid: false, error: 'Invalid signature token.' };
    }

    return { valid: true, invoiceId };
  }
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
    private readonly mailerService: MailerService,
    private readonly configService: ConfigService,
  ) {}

  generateNextInvoiceNumber(): string {
    // Financial year (April-March) of today in Asia/Kolkata, whatever the server's time zone
    return `${invoiceNumberPrefix()}/001`;
  }

  async getNextInvoiceNumber(): Promise<string> {
    const prefix = invoiceNumberPrefix();

    const lastInvoice = await this.prisma.invoice.findFirst({
      where: {
        invoice_number: { startsWith: prefix },
      },
      orderBy: { invoice_number: 'desc' },
    });

    if (lastInvoice && lastInvoice.invoice_number) {
      const parts = lastInvoice.invoice_number.split('/');
      const lastNum = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(lastNum)) {
        const newNum = lastNum + 1;
        return `${prefix}/${String(newNum).padStart(3, '0')}`;
      }
    }

    return `${prefix}/001`;
  }

  private formatInvoice(i: any) {
    if (!i) return null;

    const subtotal = i.subtotal ? Number(i.subtotal) : 0;
    const tax = i.tax ? Number(i.tax) : 0;
    const total = i.total ? Number(i.total) : subtotal + tax;
    const advance = i.advance ? Number(i.advance) : 0;

    const payments = (i.payments || []).map((p: any) => ({
      id: p.id,
      invoice: p.invoice_id,
      receipt_number: p.receipt_number || null,
      amount: p.amount ? Number(p.amount) : 0,
      payment_date: p.payment_date ? p.payment_date.toISOString().split('T')[0] : null,
      payment_mode: p.payment_mode || 'cash',
      notes: p.notes || '',
      created_at: p.created_at ? p.created_at.toISOString() : null,
      // Only when loaded (invoice details for staff): the expense recorded from this payment, if any
      ...(p.expense !== undefined
        ? { linked_expense: p.expense ? { id: p.expense.id, title: p.expense.title, deleted: !!p.expense.deleted_at } : null }
        : {}),
    }));

    // Shared paise-based calculation (see invoice-status.ts)
    const financials = computeInvoiceFinancials({
      total,
      advance,
      payments: i.payments || [],
      due_date: i.due_date,
    });
    const dueDateStr = financials.due_date;

    const tax_rate = subtotal > 0 ? Number(((tax / subtotal) * 100).toFixed(2)) : 0;

    return {
      id: i.id,
      invoice_number: i.invoice_number,
      client: i.client_id,
      client_name: i.client ? i.client.name : null,
      client_phone: i.client ? i.client.phone : null,
      client_address: (i.client_address !== null && i.client_address !== undefined && String(i.client_address).trim() !== '')
        ? String(i.client_address).trim()
        : (i.client && i.client.address && String(i.client.address).trim() !== '' ? String(i.client.address).trim() : null),
      client_details: i.client ? {
        id: i.client.id,
        name: i.client.name,
        company_name: i.client.company_name,
        address: i.client.address,
        email: i.client.email,
        phone: i.client.phone,
        gst_number: i.client.gst_no,
      } : null,
      project_name: null,
      issue_date: i.issue_date ? i.issue_date.toISOString().split('T')[0] : null,
      due_date: dueDateStr,
      advance: i.advance ? Number(i.advance) : 0,
      subtotal,
      tax,
      tax_rate,
      total: financials.total,
      total_paid: financials.total_paid,
      balance: financials.balance,
      status: financials.status,
      payment_status: financials.payment_status,
      is_overdue: financials.is_overdue,
      overpaid_amount: financials.overpaid_amount,
      initial_payment_id: findInitialPaymentId(i),
      notes: i.notes || '',
      created_at: i.created_at ? i.created_at.toISOString() : null,
      items: (i.items || []).map((item: any) => {
        const qty = item.quantity || 1;
        const rate = item.rate ? Number(item.rate) : 0;
        return {
          id: item.id,
          description: item.description || '',
          quantity: qty,
          rate,
          amount: Number(item.amount || qty * rate),
        };
      }),
      payments,
    };
  }

  /**
   * The optional `month=YYYY-MM` filter (issue date within that calendar month). Empty or missing = no month filter.
   * Anything else that is not exactly YYYY-MM with a real month is a 400.
   */
  private resolveMonthFilter(month: unknown): InvoiceMonthRange | null {
    if (month === undefined || month === null || month === '') return null;
    const range = parseInvoiceMonth(month);
    if (!range) {
      throw new BadRequestException({ month: ['Month must be a real calendar month in YYYY-MM format, for example 2026-11.'] });
    }
    return range;
  }

  async findAll(user: any, query: { search?: string; client?: string; status?: string; all?: string; page?: string; limit?: string; month?: string }) {
    const roleName = user.role?.name;
    const where: any = {};
    // Validated for every call; applied to the paginated list only. `all=true` callers (expense form picker, etc.) keep
    // receiving the complete list exactly as before.
    const monthRange = this.resolveMonthFilter(query.month);

    if (query.search) {
      const searchStr = query.search.trim();
      if (searchStr !== '') {
        where.OR = [
          { invoice_number: { contains: searchStr } },
          { client: { name: { contains: searchStr } } },
          { client: { company_name: { contains: searchStr } } },
        ];
      }
    }

    if (query.client) {
      where.client_id = Number(query.client);
    }

    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (client) {
        where.client_id = client.id;
      } else {
        return query.all === 'true' ? [] : { count: 0, next: null, previous: null, results: [] };
      }
    }

    if (query.all === 'true') {
      const invoices = await this.prisma.invoice.findMany({
        where,
        include: {
          client: true,
          items: true,
          payments: true,
        },
        orderBy: { id: 'desc' },
      });

      let formatted = invoices.map((i) => this.formatInvoice(i));
      if (query.status && query.status !== 'all') {
        formatted = formatted.filter((inv) => matchesInvoiceStatusFilter(inv, query.status));
      }
      return formatted;
    }

    const page = Math.max(1, parseInt(query.page as string, 10) || 1);
    const limit = Math.max(1, parseInt(query.limit as string, 10) || 10);

    // Issue date inside the month: [first day, first day of the next month), a date-only column (no time zone involved)
    if (monthRange) where.issue_date = { gte: monthRange.from, lt: monthRange.to };

    const invoices = await this.prisma.invoice.findMany({
      where,
      include: {
        client: true,
        items: true,
        payments: true,
      },
      orderBy: { id: 'desc' },
    });

    let formatted = invoices.map((i) => this.formatInvoice(i));
    if (query.status && query.status !== 'all') {
      formatted = formatted.filter((inv) => matchesInvoiceStatusFilter(inv, query.status));
    }

    const totalCount = formatted.length;
    const skip = (page - 1) * limit;
    const paginated = formatted.slice(skip, skip + limit);

    return {
      count: totalCount,
      next: page * limit < totalCount ? `/api/v1/invoices?page=${page + 1}` : null,
      previous: page > 1 ? `/api/v1/invoices?page=${page - 1}` : null,
      results: paginated,
      // Only with ?month: the period actually applied (same object as the analytics response), so a client can verify
      // that the rows belong to the month it asked for. Without ?month the response is exactly as before.
      ...(monthRange ? { period: invoicePeriod(monthRange) } : {}),
    };
  }

  async findOne(id: number, user: any) {
    const roleName = user.role?.name;
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        client: true,
        items: true,
        // Staff see which payments already have an expense (one per payment); client portal users never do
        payments:
          roleName === 'CLIENT'
            ? true
            : { include: { expense: { select: { id: true, title: true, deleted_at: true } } } },
      },
    });

    if (!invoice) throw new NotFoundException('Invoice not found');

    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (!client || invoice.client_id !== client.id) {
        throw new ForbiddenException('You do not have permission to access this invoice.');
      }
    }

    return this.formatInvoice(invoice);
  }

  async create(user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify invoices.');
    }

    const clientId = Number(body.client);
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw new BadRequestException({ client: ['Invalid client specified.'] });

    const invoiceNumber = body.invoice_number || (await this.getNextInvoiceNumber());

    const itemsData = body.items || [];
    let subtotal = 0;
    for (const item of itemsData) {
      if (item.quantity !== undefined && item.quantity !== null && item.quantity !== '' && Number(item.quantity) < 1) {
        throw new BadRequestException('Invoice item quantity must be at least 1.');
      }
      if (item.rate !== undefined && item.rate !== null && item.rate !== '' && Number(item.rate) < 0) {
        throw new BadRequestException('Invoice item rate cannot be negative.');
      }
      const qty = Number(item.quantity || 1);
      const rate = Number(item.rate ?? 0);
      subtotal += qty * rate;
    }

    const tax = Number(body.tax || 0);
    const total = body.total !== undefined ? Number(body.total) : subtotal + tax;

    const rawInitialPayment = body.payment_amount ?? body.advance ?? 0;
    const initialPaymentAmount = Number(rawInitialPayment);
    // An initial payment of 0/blank means "no payment"; anything else must be a positive
    // amount that does not exceed the invoice total.
    if (rawInitialPayment !== '' && rawInitialPayment !== null && initialPaymentAmount !== 0) {
      const paymentError = validatePaymentAmount(rawInitialPayment, toPaise(total));
      if (paymentError) throw new BadRequestException(paymentError);
    }
    // Missing issue date: today in Asia/Kolkata (not the server's UTC date)
    const issueDateObj = dateOnlyOrToday(body.issue_date);
    const paymentDateObj = body.payment_date ? new Date(body.payment_date) : issueDateObj;
    const paymentMode = body.payment_mode || 'cash';

    const createdId = await this.prisma.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: {
          invoice_number: invoiceNumber,
          client_id: clientId,
          client_address: body.client_address !== undefined ? body.client_address : (client.address || ''),
          issue_date: issueDateObj,
          due_date: body.due_date ? new Date(body.due_date) : null,
          advance: 0,
          subtotal,
          tax,
          total,
          notes: body.notes || '',
        },
      });

      for (const item of itemsData) {
        const qty = item.quantity || 1;
        const rate = Number(item.rate || 0);
        await tx.invoiceItem.create({
          data: {
            invoice_id: created.id,
            description: item.description || '',
            quantity: qty,
            rate,
            amount: qty * rate,
          },
        });
      }

      if (initialPaymentAmount > 0) {
        await tx.invoicePayment.create({
          data: {
            invoice_id: created.id,
            amount: initialPaymentAmount,
            payment_date: paymentDateObj,
            payment_mode: paymentMode,
            notes: INITIAL_PAYMENT_NOTE,
          },
        });
      }

      return created.id;
    });

    return this.findOne(createdId, user);
  }

  async update(id: number, user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify invoices.');
    }

    const existing = await this.prisma.invoice.findUnique({ where: { id }, include: { items: true } });
    if (!existing) throw new NotFoundException('Invoice not found');

    const data: any = {};
    if (body.client !== undefined || body.client_id !== undefined) {
      const clientId = Number(body.client ?? body.client_id);
      const client = await this.prisma.client.findUnique({ where: { id: clientId } });
      if (!client) {
        throw new BadRequestException({
          client: ['Invalid client specified.'],
        });
      }
      data.client_id = clientId;
    }
    if (body.invoice_number !== undefined) data.invoice_number = body.invoice_number;
    if (body.issue_date !== undefined) data.issue_date = new Date(body.issue_date);
    if (body.due_date !== undefined) data.due_date = body.due_date ? new Date(body.due_date) : null;

    const newPaymentAmount = Number(body.new_payment_amount || 0);
    // 0/blank means "no new payment"; negative or non-numeric amounts are rejected
    if (Number.isNaN(newPaymentAmount) || newPaymentAmount < 0) {
      throw new BadRequestException('Payment amount must be greater than zero.');
    }
    const paymentMode = body.payment_mode || body.new_payment_mode || 'cash';
    const paymentDateStr = body.payment_date || body.new_payment_date;
    // No payment date: the invoice's issue date when one is sent, otherwise today in Asia/Kolkata
    const paymentDateObj = paymentDateStr ? new Date(paymentDateStr) : dateOnlyOrToday(body.issue_date);

    // Only update advance if explicitly provided and no new_payment_amount is being processed
    if (body.advance !== undefined && newPaymentAmount === 0 && body.new_payment_amount === undefined) {
      data.advance = Number(body.advance);
    }

    if (body.client_address !== undefined) data.client_address = body.client_address;
    if (body.notes !== undefined) data.notes = body.notes;

    if (body.items !== undefined && Array.isArray(body.items)) {
      let subtotal = 0;
      for (const item of body.items) {
        if (item.quantity !== undefined && item.quantity !== null && item.quantity !== '' && Number(item.quantity) < 1) {
          throw new BadRequestException('Invoice item quantity must be at least 1.');
        }
        if (item.rate !== undefined && item.rate !== null && item.rate !== '' && Number(item.rate) < 0) {
          throw new BadRequestException('Invoice item rate cannot be negative.');
        }
        const qty = Number(item.quantity || 1);
        const rate = Number(item.rate ?? 0);
        subtotal += qty * rate;
      }
      data.subtotal = subtotal;
      const tax = body.tax !== undefined ? Number(body.tax) : Number(existing.tax);
      data.tax = tax;
      data.total = body.total !== undefined ? Number(body.total) : subtotal + tax;

      const normalize = (list: any[]) =>
        list.map((it: any) => [
          String(it.description || ''),
          Number(it.quantity || 1),
          Number(it.rate || 0),
        ].join('|'));
      const incoming = normalize(body.items);
      const stored = normalize(existing.items || []);
      const itemsUnchanged =
        incoming.length === stored.length && incoming.every((v, idx) => v === stored[idx]);

      if (!itemsUnchanged) {
        await this.prisma.invoiceItem.deleteMany({ where: { invoice_id: id } });
        for (const item of body.items) {
          const qty = item.quantity || 1;
          const rate = Number(item.rate || 0);
          await this.prisma.invoiceItem.create({
            data: {
              invoice_id: id,
              description: item.description || '',
              quantity: qty,
              rate,
              amount: qty * rate,
            },
          });
        }
      }

    } else if (body.tax !== undefined || body.total !== undefined) {
      if (body.tax !== undefined) data.tax = Number(body.tax);
      data.total = body.total !== undefined ? Number(body.total) : Number(existing.subtotal) + (data.tax ?? Number(existing.tax));
    }

    if (newPaymentAmount > 0) {
      await this.prisma.$transaction(async (tx) => {
        // Lock the invoice row so concurrent payments cannot both pass the balance check
        await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;

        const updatedInvoice = await tx.invoice.update({
          where: { id },
          data,
        });
        const existingPayments = await tx.invoicePayment.findMany({ where: { invoice_id: id } });

        const current = computeInvoiceFinancials({
          total: updatedInvoice.total,
          advance: updatedInvoice.advance,
          payments: existingPayments,
        });
        const paymentError = validatePaymentAmount(newPaymentAmount, current.balance_paise);
        if (paymentError) throw new BadRequestException(paymentError);

        await tx.invoicePayment.create({
          data: {
            invoice_id: id,
            amount: newPaymentAmount,
            payment_date: paymentDateObj,
            payment_mode: paymentMode,
            notes: 'Payment received during invoice update',
          },
        });
      });
    } else {
      await this.prisma.invoice.update({
        where: { id },
        data,
      });
    }

    return this.findOne(id, user);
  }

  async remove(id: number, user: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify invoices.');
    }

    const existing = await this.prisma.invoice.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Invoice not found');

    await this.prisma.invoice.delete({ where: { id } });
    return null;
  }

  /**
   * Invoice summary cards. `month=YYYY-MM` limits them to invoices ISSUED in that month; without it they cover all
   * invoices (as before).
   *
   * For a month:
   * - total_invoices: invoices issued in the month;
   * - total_revenue: sum of their totals (GST included);
   * - total_paid ("Payments Received"): money RECEIVED in the month, by payment date, whatever the invoice's issue date
   *   (see paymentsReceivedPaise; legacy advances count on their invoice's issue date);
   * - total_balance: outstanding balances of the invoices issued in the month (overdue and not yet due).
   * Invoices, revenue, balance, overpaid and overdue use the same per-invoice rules as the invoice list
   * (computeInvoiceFinancials). Because Payments Received is by payment date, revenue − received ≠ pending in general.
   */
  async getAnalytics(user: any, query: { month?: string } = {}) {
    const monthRange = this.resolveMonthFilter(query?.month);
    const period = invoicePeriod(monthRange);

    // Client-portal users only ever see their own invoices and payments
    let clientScope: number | null = null;
    if (user.role?.name === 'CLIENT') {
      const client = await this.prisma.client.findFirst({ where: { portal_users: { some: { id: user.id } } } });
      // A client account without a client record has no invoices (same as the list)
      clientScope = client ? client.id : -1;
    }

    const where: any = {};
    if (clientScope !== null) where.client_id = clientScope;
    if (monthRange) where.issue_date = { gte: monthRange.from, lt: monthRange.to };

    const invoices = await this.prisma.invoice.findMany({
      where,
      select: { id: true, total: true, advance: true, due_date: true, payments: { select: { amount: true } } },
    });

    // Exact paise-based totals from the same per-invoice figures shown in the table (issue-date basis)
    const totals = aggregateInvoiceFinancials(
      invoices.map((inv) =>
        computeInvoiceFinancials({ total: inv.total, advance: inv.advance, payments: inv.payments, due_date: inv.due_date }),
      ),
    );

    const receivedPaise = await this.paymentsReceivedPaise(monthRange, clientScope);

    return {
      total_invoices: totals.invoice_count,
      total_revenue: totals.total_billed,
      // Payments Received: by payment date (not the issue-date paid-to-date of the invoices above)
      total_paid: fromPaise(receivedPaise),
      total_balance: totals.total_balance,
      total_overpaid: totals.total_overpaid,
      overdue_count: totals.overdue_count,
      overdue_balance: totals.overdue_balance,
      // Company cash flow of the same month (or all time), by the date money moved. Null for users who may not see
      // company expenses (and always for client-portal users).
      ...(await this.periodCashFlow(user, monthRange, receivedPaise)),
      period,
    };
  }

  /**
   * Payments received in a month (or all time when `monthRange` is null), in paise, for one client or all clients:
   * - every InvoicePayment, on its own payment_date (partial and multiple payments each in their own month);
   * - a legacy Invoice.advance (stored without a date), on its invoice's issue_date (Option B) — except when that
   *   invoice also has the payment recorded at creation (marked INITIAL_PAYMENT_NOTE), which already represents the
   *   creation-time receipt; then only that dated payment counts, so nothing is counted twice. Amounts are never
   *   compared to decide this (current code never writes both; see findInitialPaymentId).
   * Same date-only month boundaries as the other cards; exact paise arithmetic.
   */
  private async paymentsReceivedPaise(monthRange: InvoiceMonthRange | null, clientScope: number | null): Promise<number> {
    const inMonth = monthRange ? { gte: monthRange.from, lt: monthRange.to } : undefined;
    const paymentWhere: any = {};
    if (inMonth) paymentWhere.payment_date = inMonth;
    if (clientScope !== null) paymentWhere.invoice = { client_id: clientScope };

    const advanceWhere: any = { advance: { gt: 0 } };
    if (inMonth) advanceWhere.issue_date = inMonth;
    if (clientScope !== null) advanceWhere.client_id = clientScope;

    const [payments, legacy] = await Promise.all([
      this.prisma.invoicePayment.aggregate({ where: paymentWhere, _sum: { amount: true } }),
      this.prisma.invoice.findMany({
        where: advanceWhere,
        select: {
          advance: true,
          payments: { where: { notes: INITIAL_PAYMENT_NOTE }, select: { id: true, notes: true } },
        },
      }),
    ]);

    let advancePaise = 0;
    for (const inv of legacy || []) {
      const advance = toPaise(inv.advance as any);
      if (advance <= 0) continue;
      const representedByInitialPayment = (inv.payments || []).some((p: any) => p.notes === INITIAL_PAYMENT_NOTE);
      if (!representedByInitialPayment) advancePaise += advance;
    }
    return toPaise(payments?._sum?.amount as any) + advancePaise;
  }

  /** Permissions that may see company expenses and profit on the invoice summary (same as viewing expenses / reports). */
  static readonly CASH_FLOW_PERMISSIONS = ['VIEW_EXPENSES', 'MANAGE_EXPENSES', 'VIEW_FINANCIAL_REPORTS'] as const;

  /**
   * Cash flow of a month (or all time when `monthRange` is null), using the same date-only month boundaries as the cards:
   * - period_collections: the company's Payments Received (the same figure as total_paid, see paymentsReceivedPaise);
   * - period_expenses: Expense.amount_paid by expense_date, excluding deleted and rejected expenses (a pending or partly
   *   paid expense counts only what was actually paid);
   * - period_profit = collections − expenses (may be negative).
   * One extra aggregate query; exact paise arithmetic.
   */
  private async periodCashFlow(
    user: any,
    monthRange: InvoiceMonthRange | null,
    receivedPaise: number,
  ): Promise<{ period_collections: number | null; period_expenses: number | null; period_profit: number | null }> {
    const allowed =
      user?.role?.name !== 'CLIENT' &&
      (isSuperAdmin(user) || getActiveRolePermissions(user).some((p) => (InvoicesService.CASH_FLOW_PERMISSIONS as readonly string[]).includes(p)));
    if (!allowed) return { period_collections: null, period_expenses: null, period_profit: null };

    const inMonth = monthRange ? { gte: monthRange.from, lt: monthRange.to } : undefined;
    const expenses = await this.prisma.expense.aggregate({
      where: {
        deleted_at: null,
        approval_status: { not: 'rejected' },
        ...(inMonth ? { expense_date: inMonth } : {}),
      },
      _sum: { amount_paid: true },
    });

    // Non-client users are never client-scoped, so this is the company's Payments Received
    const collectionsPaise = receivedPaise;
    const expensesPaise = toPaise(expenses?._sum?.amount_paid as any);
    return {
      period_collections: fromPaise(collectionsPaise),
      period_expenses: fromPaise(expensesPaise),
      period_profit: fromPaise(collectionsPaise - expensesPaise),
    };
  }

  async generatePdfStream(id: number, user: any): Promise<Buffer> {
    const invoice = await this.findOne(id, user);
    return this.pdfService.generateInvoicePdf(invoice);
  }

  async sendEmail(id: number, user: any) {
    const invoice = await this.findOne(id, user);
    const client = await this.prisma.client.findUnique({ where: { id: invoice.client } });
    if (!client || !client.email) {
      throw new BadRequestException({ error: 'No email found for client' });
    }

    const pdfBuffer = await this.pdfService.generateInvoicePdf(invoice);
    const mailSent = await this.mailerService.sendMail({
      to: client.email,
      subject: `Invoice ${invoice.invoice_number} from Grehasoft`,
      text: `Hello ${client.name || 'Client'},\n\nPlease find attached invoice ${invoice.invoice_number}.\n\nRegards,\nGrehasoft Smart IT Solutions`,
      attachments: [
        {
          filename: `invoice_${invoice.invoice_number.replace(/\//g, '_')}.pdf`,
          content: pdfBuffer,
        } as any,
      ],
    });

    if (!mailSent) {
      throw new InternalServerErrorException('Failed to send invoice email. Please check server email configuration.');
    }

    return { message: 'Email sent' };
  }

  private getSigningSecret(): string {
    return (
      this.configService?.get<string>('INVOICE_LINK_SECRET') ||
      this.configService?.get<string>('SECRET_KEY') ||
      this.configService?.get<string>('JWT_SECRET') ||
      'grehasoft-invoice-link-signing-secret-default'
    );
  }

  private getBaseUrl(req?: any): string {
    if (req) {
      const host = req.get ? req.get('host') : req.headers?.host;
      const protocol = req.protocol || (req.connection?.encrypted ? 'https' : 'http');
      if (host) {
        return `${protocol}://${host}`;
      }
    }
    const configuredUrl =
      this.configService?.get<string>('API_BASE_URL') ||
      this.configService?.get<string>('SITE_URL');
    if (configuredUrl) {
      return configuredUrl.replace(/\/$/, '');
    }
    return 'http://localhost:3000';
  }

  async generateSecureLink(id: number, req?: any) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    // Caller must be able to read this invoice (findOne applies CLIENT ownership scoping)
    if (req?.user) await this.findOne(id, req.user);

    const secret = this.getSigningSecret();
    const token = InvoiceSigning.generateToken(id, secret, INVOICE_SECURE_LINK_TTL_SECONDS);
    const baseUrl = this.getBaseUrl(req);
    const securePdfLink = `${baseUrl}/api/v1/invoices/public/${encodeURIComponent(token)}/download/`;
    // The expiry signed into the token ("<id>.<expiresAt>.<hmac>"), not a separately computed value
    const expiresAt = Number(token.split('.')[1]);

    return { secure_pdf_link: securePdfLink, expires_at: new Date(expiresAt * 1000).toISOString() };
  }

  getInvoicePdfFilename(invoice: any): string {
    const safeInvoiceNum = (invoice?.invoice_number || 'INV').replace(/\//g, '_');

    const rawCompanyName =
      invoice?.client_details?.company_name ||
      invoice?.client?.company_name ||
      (typeof invoice?.client === 'object' && invoice?.client?.company_name) ||
      invoice?.company_name ||
      '';

    const companyNameStr = String(rawCompanyName).trim();

    if (!companyNameStr) {
      return `invoice_${safeInvoiceNum}.pdf`;
    }

    let sanitizedCompany = companyNameStr
      .replace(/[^a-zA-Z0-9_\-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');

    if (sanitizedCompany.length > 30) {
      sanitizedCompany = sanitizedCompany.substring(0, 30).replace(/_+$/g, '');
    }

    if (!sanitizedCompany) {
      return `invoice_${safeInvoiceNum}.pdf`;
    }

    return `invoice_${safeInvoiceNum}_${sanitizedCompany}.pdf`;
  }

  async generatePdfStreamFromPublicToken(token: string): Promise<{ pdfBuffer: Buffer; filename: string }> {
    const secret = this.getSigningSecret();
    const verification = InvoiceSigning.verifyToken(token, secret);

    if (!verification.valid || !verification.invoiceId) {
      throw new ForbiddenException(verification.error || 'Invalid or expired signature token.');
    }

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: verification.invoiceId },
      include: {
        client: true,
        items: true,
        payments: true,
      },
    });

    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }

    const formattedInvoice = this.formatInvoice(invoice);
    const pdfBuffer = await this.pdfService.generateInvoicePdf(formattedInvoice);
    const filename = this.getInvoicePdfFilename(formattedInvoice);

    return { pdfBuffer, filename };
  }

  async previewPdf(body: any): Promise<Buffer> {
    let clientObj: any = null;
    if (body.client) {
      const clientId = Number(body.client);
      if (!isNaN(clientId) && clientId > 0) {
        clientObj = await this.prisma.client.findUnique({ where: { id: clientId } });
      }
    }

    const itemsData = body.items || [];
    let subtotal = 0;
    const formattedItems = [];

    for (const item of itemsData) {
      if (item.quantity !== undefined && item.quantity !== null && item.quantity !== '' && Number(item.quantity) < 1) {
        throw new BadRequestException('Invoice item quantity must be at least 1.');
      }
      if (item.rate !== undefined && item.rate !== null && item.rate !== '' && Number(item.rate) < 0) {
        throw new BadRequestException('Invoice item rate cannot be negative.');
      }
      const qty = Number(item.quantity || 1);
      const rate = Number(item.rate ?? 0);
      const amount = qty * rate;
      subtotal += amount;
      formattedItems.push({
        description: item.description || '',
        quantity: qty,
        rate,
        amount,
      });
    }

    const tax = Number(body.tax || 0);
    const discount = Number(body.discount || 0);
    const total = Math.max(subtotal + tax - discount, 0);
    const advance = Number(body.advance || 0);
    const balance = Math.max(total - advance, 0);

    const rawDueDate = body.due_date !== undefined ? body.due_date : body.dueDate;
    const dueDateStr = rawDueDate && String(rawDueDate).trim() !== '' && String(rawDueDate).trim().toLowerCase() !== 'null'
      ? String(rawDueDate).trim()
      : null;

    const previewInvoiceData = {
      invoice_number: body.invoice_number || body.invoiceNumber || 'PREVIEW',
      issue_date: body.issue_date || body.issueDate || businessDateKey(),
      due_date: dueDateStr,
      status: advance >= total && total > 0 ? 'paid' : advance > 0 ? 'partial' : 'unpaid',
      subtotal,
      tax,
      total,
      advance,
      total_paid: advance,
      balance,
      notes: body.notes || '',
      client: {
        name: clientObj?.name || (typeof body.client === 'string' ? body.client : ''),
        company_name: clientObj?.company_name || '',
        email: clientObj?.email || '',
        phone: clientObj?.phone || '',
        address: (body.client_address !== undefined && body.client_address !== null && String(body.client_address).trim() !== '')
          ? String(body.client_address).trim()
          : (clientObj?.address || ''),
        gst_no: clientObj?.gst_no || '',
      },
      items: formattedItems,
      payments: advance > 0 ? [{
        amount: advance,
        payment_date: body.issue_date || businessDateKey(),
        payment_mode: 'advance',
        notes: 'Amount Received',
      }] : [],
    };

    return this.pdfService.generateInvoicePdf(previewInvoiceData);
  }
}
