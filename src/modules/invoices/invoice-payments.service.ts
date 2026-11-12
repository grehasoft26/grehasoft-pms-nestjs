import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';
import { computeInvoiceFinancials, dateOnlyOrToday, roundMoney, toPaise, validatePaymentAmount } from './invoice-status';
import { EXPENSE_PAYMENT_METHODS, prepareExpenseData } from '../expenses/expense-record';
import { CreateExpenseDto } from '../expenses/dto/create-expense.dto';
import { getActiveRolePermissions, isSuperAdmin } from '../../core/utils/role-access.util';

export class ReceiptSigning {
  static generateToken(paymentId: number, secret: string, expiresInSeconds: number = 172800): string {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const payload = `receipt:${paymentId}:${expiresAt}`;
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `${paymentId}.${expiresAt}.${hmac}`;
  }

  static verifyToken(token: string, secret: string): { valid: boolean; paymentId?: number; error?: string } {
    if (!token) {
      return { valid: false, error: 'Token is required.' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid signature token.' };
    }

    const [idStr, expiresAtStr, hmacStr] = parts;
    const paymentId = parseInt(idStr, 10);
    const expiresAt = parseInt(expiresAtStr, 10);

    if (isNaN(paymentId) || isNaN(expiresAt)) {
      return { valid: false, error: 'Invalid signature token.' };
    }

    const currentTimestamp = Math.floor(Date.now() / 1000);
    if (currentTimestamp > expiresAt) {
      return { valid: false, error: 'This secure link has expired.' };
    }

    const payload = `receipt:${paymentId}:${expiresAt}`;
    const expectedHmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    // Constant-time comparison (as InvoiceSigning does)
    const given = Buffer.from(String(hmacStr), 'utf8');
    const expected = Buffer.from(expectedHmac, 'utf8');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return { valid: false, error: 'Invalid signature token.' };
    }

    return { valid: true, paymentId };
  }
}

@Injectable()
export class InvoicePaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
    private readonly mailerService: MailerService,
    private readonly configService: ConfigService,
  ) { }

  private formatPayment(p: any) {
    if (!p) return null;
    return {
      id: p.id,
      invoice: p.invoice_id,
      receipt_number: p.receipt_number || null,
      amount: p.amount ? Number(p.amount) : 0,
      payment_date: p.payment_date ? p.payment_date.toISOString().split('T')[0] : null,
      payment_mode: p.payment_mode || 'cash',
      notes: p.notes || '',
      created_at: p.created_at ? p.created_at.toISOString() : null,
    };
  }

  private receiptLockPromise: Promise<any> = Promise.resolve();

  private async acquireLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const currentLock = this.receiptLockPromise;
    this.receiptLockPromise = currentLock.then(() => nextLock, () => nextLock);
    await currentLock;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  private formatDateDDMMYYYY(dateVal: any): string {
    if (!dateVal) return '';
    if (dateVal instanceof Date) {
      const day = String(dateVal.getUTCDate()).padStart(2, '0');
      const month = String(dateVal.getUTCMonth() + 1).padStart(2, '0');
      const year = dateVal.getUTCFullYear();
      return `${day}-${month}-${year}`;
    }
    const s = String(dateVal).split('T')[0];
    const parts = s.split('-');
    if (parts.length === 3 && parts[0].length === 4) {
      return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return s;
  }

  /**
   * Receipt number shown inside the PDF only. Stored payment.receipt_number is unchanged.
   * Derived from the invoice number so every payment on the same invoice shows the same base
   * (e.g. RCT-2026-27-001-2 still displays RCT-2026-27-001). Invoice suffixes are not stripped.
   */
  getDisplayReceiptNumber(invoiceNumber?: string | null, storedReceiptNumber?: string | null): string {
    const invoice = (invoiceNumber || '').trim();
    if (invoice) {
      const sanitizedInvNum = invoice.replace(/^GSI[\/\-_]?/i, '').replace(/\//g, '-');
      return `RCT-${sanitizedInvNum}`;
    }
    return this.normalizeStoredReceiptNumberForDisplay(storedReceiptNumber || '');
  }

  private normalizeStoredReceiptNumberForDisplay(rctStr: string): string {
    if (!rctStr) return '';
    let s = String(rctStr).trim().replace(/\//g, '-');
    if (s.toUpperCase().startsWith('RCT-GSI-')) {
      s = 'RCT-' + s.slice(8);
    }
    // Strip a payment-sequence suffix only (e.g. -2, -3, -01), never the invoice sequence.
    const withPaymentSuffix = s.match(/^(RCT-\d{4}-\d{2}-[A-Za-z0-9]+)-\d+$/);
    if (withPaymentSuffix) {
      return withPaymentSuffix[1];
    }
    return s;
  }

  private nextUniqueStoredReceiptNumber(baseReceiptNumber: string, used: Set<string>): string {
    if (!used.has(baseReceiptNumber)) {
      return baseReceiptNumber;
    }
    for (let n = 2; n < 10000; n++) {
      const candidate = `${baseReceiptNumber}-${n}`;
      if (!used.has(candidate)) {
        return candidate;
      }
    }
    throw new InternalServerErrorException('Failed to allocate a unique receipt number');
  }

  async getOrAssignReceiptNumber(paymentId: number): Promise<string> {
    return this.acquireLock(async () => {
      const existing = await this.prisma.invoicePayment.findUnique({
        where: { id: paymentId },
        select: {
          receipt_number: true,
          payment_date: true,
          invoice_id: true,
          invoice: {
            select: { invoice_number: true },
          },
        },
      });
      if (!existing) throw new NotFoundException('Invoice payment not found');
      if (existing.receipt_number) {
        return existing.receipt_number;
      }

      const rawInvoiceNum = existing.invoice?.invoice_number || `INV-${existing.invoice_id}`;
      const sanitizedInvNum = rawInvoiceNum.replace(/^GSI[\/\-_]?/i, '').replace(/\//g, '-');
      const baseReceiptNumber = `RCT-${sanitizedInvNum}`;
      const lockKey = `receipt_lock_inv_${existing.invoice_id}`;

      let mysqlLockAcquired = false;
      try {
        try {
          const lockRes: any = await this.prisma.$queryRawUnsafe(
            `SELECT GET_LOCK('${lockKey}', 10) as lock_result`
          );
          if (lockRes && lockRes[0] && (lockRes[0].lock_result === 1 || lockRes[0].lock_result === '1')) {
            mysqlLockAcquired = true;
          }
        } catch (e) {
          // Ignore lock query errors in non-MySQL environments or mocks
        }

        // Re-check after acquiring lock (another concurrent call may have just assigned one).
        const recheck = await this.prisma.invoicePayment.findUnique({
          where: { id: paymentId },
          select: { receipt_number: true },
        });
        if (recheck?.receipt_number) {
          return recheck.receipt_number;
        }

        const maxAttempts = 25;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const usedReceipts = await this.prisma.invoicePayment.findMany({
            where: {
              receipt_number: { startsWith: baseReceiptNumber },
            },
            select: { receipt_number: true },
          });
          const used = new Set(
            usedReceipts.map((p) => p.receipt_number).filter((n): n is string => !!n),
          );
          const candidateReceiptNumber = this.nextUniqueStoredReceiptNumber(baseReceiptNumber, used);

          try {
            const updated = await this.prisma.invoicePayment.update({
              where: { id: paymentId },
              data: { receipt_number: candidateReceiptNumber },
            });
            return updated.receipt_number;
          } catch (error: any) {
            if (error?.code !== 'P2002') {
              throw error;
            }
            if (attempt === maxAttempts) {
              throw error;
            }
          }
        }

        throw new InternalServerErrorException('Failed to assign a unique receipt number');
      } finally {
        if (mysqlLockAcquired) {
          try {
            await this.prisma.$queryRawUnsafe(`SELECT RELEASE_LOCK('${lockKey}')`);
          } catch (e) {
            // Ignore release errors
          }
        }
      }
    });
  }

  async generateReceiptPdfStream(id: number, user: any): Promise<{ buffer: Buffer; filename: string }> {
    const roleName = user.role?.name;

    const payment = await this.prisma.invoicePayment.findUnique({
      where: { id },
      include: {
        invoice: {
          include: {
            client: true,
            items: true,
            payments: true,
          },
        },
      },
    });

    if (!payment) throw new NotFoundException('Invoice payment not found');

    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (!client || payment.invoice.client_id !== client.id) {
        throw new ForbiddenException('You do not have permission to access this payment receipt.');
      }
    }

    const receiptNumber = await this.getOrAssignReceiptNumber(id);

    // Point-in-time summary for THIS receipt, using the shared invoice calculation
    // (invoice-status.ts): "previously paid" = advance + payments recorded before this one
    // (ordered by payment_date, then id as a tie-breaker); all amounts in exact paise.
    const currentTime = payment.payment_date ? new Date(payment.payment_date).getTime() : 0;
    const earlierPayments = ((payment.invoice as any)?.payments || []).filter((p: any) => {
      if (p.id === payment.id) return false;
      const t = p.payment_date ? new Date(p.payment_date).getTime() : 0;
      return t < currentTime || (t === currentTime && p.id < payment.id);
    });
    const before = computeInvoiceFinancials({
      total: payment.invoice.total,
      advance: (payment.invoice as any)?.advance,
      payments: earlierPayments,
    });
    const after = computeInvoiceFinancials({
      total: payment.invoice.total,
      advance: (payment.invoice as any)?.advance,
      payments: [...earlierPayments, payment],
    });
    const invoiceTotal = after.total;
    const currentAmount = roundMoney(payment.amount);
    const previouslyPaid = before.total_paid;
    const balanceDue = after.balance;

    const receiptData = {
      receipt_number: this.getDisplayReceiptNumber(payment.invoice.invoice_number, receiptNumber),
      payment_date: this.formatDateDDMMYYYY(payment.payment_date),
      payment_amount: currentAmount,
      payment_mode: payment.payment_mode || 'cash',
      notes: payment.notes || '',
      invoice_number: payment.invoice.invoice_number,
      invoice_date: this.formatDateDDMMYYYY(payment.invoice?.issue_date),
      invoice_total: invoiceTotal,
      previously_paid: previouslyPaid,
      balance_due: balanceDue,
      service_description: `Payment for Invoice ${payment.invoice.invoice_number}`,
      client: {
        name: payment.invoice.client?.name || '',
        company_name: payment.invoice.client?.company_name || '',
        email: payment.invoice.client?.email || '',
        phone: payment.invoice.client?.phone || '',
        address: (payment.invoice as any)?.client_address?.trim?.() || payment.invoice.client?.address || '',
        gst_no: payment.invoice.client?.gst_no || '',
        country: (payment.invoice.client as any)?.country || '',
        contact_person: (payment.invoice.client as any)?.contact_person || '',
      },
    };

    const pdfBuffer = await this.pdfService.generateReceiptPdf(receiptData);
    const filename = this.getReceiptPdfFilename(receiptNumber, payment);

    return { buffer: pdfBuffer, filename };
  }

  getReceiptPdfFilename(receiptNumber: string, payment: any): string {
    const safeReceiptNum = (receiptNumber || 'RCT').replace(/\//g, '_');

    const rawCompanyName =
      payment?.invoice?.client?.company_name ||
      payment?.invoice?.client_details?.company_name ||
      payment?.client?.company_name ||
      payment?.client_details?.company_name ||
      '';

    const companyNameStr = String(rawCompanyName).trim();

    if (!companyNameStr) {
      return `receipt_${safeReceiptNum}.pdf`;
    }

    let sanitizedCompany = companyNameStr
      .replace(/[^a-zA-Z0-9_\-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');

    if (sanitizedCompany.length > 30) {
      sanitizedCompany = sanitizedCompany.substring(0, 30).replace(/_+$/g, '');
    }

    if (!sanitizedCompany) {
      return `receipt_${safeReceiptNum}.pdf`;
    }

    return `receipt_${safeReceiptNum}_${sanitizedCompany}.pdf`;
  }

  async findAll(user: any, query: { invoice?: string; invoice_id?: string }) {
    const roleName = user.role?.name;
    const where: any = {};

    const invoiceId = Number(query.invoice || query.invoice_id);
    if (invoiceId) {
      where.invoice_id = invoiceId;
    }

    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (client) {
        where.invoice = { client_id: client.id };
      } else {
        return [];
      }
    }

    const payments = await this.prisma.invoicePayment.findMany({
      where,
      orderBy: { payment_date: 'desc' },
    });

    return payments.map((p) => this.formatPayment(p));
  }

  async findOne(id: number, user: any) {
    const roleName = user.role?.name;
    const payment = await this.prisma.invoicePayment.findUnique({
      where: { id },
      include: { invoice: true },
    });

    if (!payment) throw new NotFoundException('Invoice payment not found');

    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (!client || payment.invoice.client_id !== client.id) {
        throw new ForbiddenException('You do not have permission to access this payment.');
      }
    }

    return this.formatPayment(payment);
  }

  async create(user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify invoice payments.');
    }

    const invoiceId = Number(body.invoice || body.invoice_id);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) throw new NotFoundException('Invoice not found');

    // Optional "Also record an expense": permission and shape checked before anything is written
    const expenseInput = this.paymentExpenseInput(user, body.expense);

    const { payment, expense } = await this.prisma.$transaction(async (tx) => {
      const financials = await this.lockInvoiceFinancials(tx, invoiceId);
      const paymentError = validatePaymentAmount(body.amount, financials.balance_paise);
      if (paymentError) throw new BadRequestException(paymentError);

      // No payment date: today in Asia/Kolkata (not the server's UTC date)
      const paymentDate = dateOnlyOrToday(body.payment_date);

      // The expense is validated by the Expenses module's own rules before either record is written
      const expenseData = expenseInput ? await this.paymentExpenseData(tx, user, expenseInput, invoiceId, paymentDate) : null;

      const createdPayment = await tx.invoicePayment.create({
        data: {
          invoice_id: invoiceId,
          amount: roundMoney(body.amount),
          payment_date: paymentDate,
          payment_mode: body.payment_mode || 'cash',
          notes: body.notes || '',
        },
      });

      // Same transaction: if this fails, the payment above is rolled back too
      const createdExpense = expenseData
        ? await this.createLinkedExpense(tx, expenseData, createdPayment.id)
        : null;
      return { payment: createdPayment, expense: createdExpense };
    });

    return this.withExpenseSummary(this.formatPayment(payment), expense);
  }

  /**
   * The expense's data, validated by the shared Expenses rules (prepareExpenseData). The invoice and client links come
   * from the invoice on the server, never from the request; the expense is recorded as already paid; the expense date
   * defaults to the payment date.
   */
  private async paymentExpenseData(tx: any, user: any, expenseInput: CreateExpenseDto, invoiceId: number, paymentDate: Date) {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: { client_id: true, client: { select: { deleted_at: true } } },
    });
    const clientId = invoice?.client_id && invoice.client && !invoice.client.deleted_at ? invoice.client_id : null;
    return prepareExpenseData(tx, user, {
      ...expenseInput,
      expense_date: expenseInput.expense_date || paymentDate.toISOString().slice(0, 10),
      invoice_id: invoiceId,
      client_id: clientId ?? undefined,
      amount_paid: expenseInput.amount,
    });
  }

  /**
   * Creates the expense linked to its payment (expenses.invoice_payment_id, unique). A concurrent request that already
   * linked an expense to the same payment fails on the unique key and is reported as a conflict, so the caller's
   * transaction rolls back and nothing is reported as recorded.
   */
  private async createLinkedExpense(tx: any, data: any, paymentId: number) {
    try {
      return await tx.expense.create({ data: { ...data, invoice_payment_id: paymentId } });
    } catch (err: any) {
      if (err?.code === 'P2002') throw new ConflictException(InvoicePaymentsService.EXPENSE_ALREADY_RECORDED);
      throw err;
    }
  }

  static readonly EXPENSE_ALREADY_RECORDED =
    'An expense has already been recorded for this payment. Open it in Expenses to change it.';

  private withExpenseSummary(result: any, expense: any) {
    if (expense) {
      result.expense = { id: expense.id, title: expense.title, amount: Number(expense.amount), expense_date: expense.expense_date };
    }
    return result;
  }

  /**
   * The optional `expense` of a new payment ("Also record an expense"), or null when none was requested. Requires
   * MANAGE_EXPENSES (the same permission as creating an expense directly), whatever invoice permission the caller has.
   * Only the expense's own fields are taken from the request; links, amount paid and approval are decided on the server.
   */
  private paymentExpenseInput(user: any, raw: any): CreateExpenseDto | null {
    if (raw === undefined || raw === null || raw === false) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('Invalid expense details.');
    }
    if (!isSuperAdmin(user) && !getActiveRolePermissions(user).includes('MANAGE_EXPENSES')) {
      throw new ForbiddenException('You do not have permission to record expenses.');
    }

    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) throw new BadRequestException('Expense title is required.');

    const paymentMethod = raw.payment_method;
    if (!(EXPENSE_PAYMENT_METHODS as readonly string[]).includes(paymentMethod)) {
      throw new BadRequestException(`Expense payment method must be one of: ${EXPENSE_PAYMENT_METHODS.join(', ')}.`);
    }

    const optionalText = (v: any) => (typeof v === 'string' ? v : undefined);
    return {
      title,
      category_id: raw.category_id,
      amount: raw.amount,
      expense_date: optionalText(raw.expense_date) as any,
      payment_method: paymentMethod,
      vendor: optionalText(raw.vendor),
      notes: optionalText(raw.notes),
    };
  }

  /**
   * Locks the invoice row (SELECT ... FOR UPDATE, released at commit) and returns its
   * financials, optionally excluding one payment (the payment being edited).
   */
  private async lockInvoiceFinancials(tx: any, invoiceId: number, excludePaymentId?: number) {
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;
    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { payments: true } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return computeInvoiceFinancials({
      total: invoice.total,
      advance: invoice.advance,
      payments: (invoice.payments || []).filter((p: any) => p.id !== excludePaymentId),
    });
  }

  async update(id: number, user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify invoice payments.');
    }

    // Optional "Also record an expense": permission and shape checked before anything is read or written
    const expenseInput = this.paymentExpenseInput(user, body.expense);

    const existing = await this.prisma.invoicePayment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Invoice payment not found');

    const data: any = {};
    if (body.payment_date !== undefined) data.payment_date = new Date(body.payment_date);
    if (body.payment_mode !== undefined) data.payment_mode = body.payment_mode;
    if (body.notes !== undefined) data.notes = body.notes;

    const amountChanged = body.amount !== undefined && toPaise(body.amount) !== toPaise(existing.amount);

    if (expenseInput) {
      // Payment update + expense in ONE transaction under the invoice row lock; any failure rolls back both.
      // No outstanding balance is required: a fully paid invoice's payment can still record an expense.
      const { payment, expense } = await this.prisma.$transaction(async (tx) => {
        const financials = await this.lockInvoiceFinancials(tx, existing.invoice_id, id);
        if (amountChanged) {
          const paymentError = validatePaymentAmount(body.amount, financials.balance_paise);
          if (paymentError) throw new BadRequestException(paymentError);
        } else if (body.amount !== undefined && toPaise(body.amount) <= 0) {
          throw new BadRequestException('Payment amount must be greater than zero.');
        }

        // One expense per payment: an existing link (even to a deleted expense) is never duplicated or replaced
        const linked = await tx.expense.findUnique({ where: { invoice_payment_id: id }, select: { id: true } });
        if (linked) throw new ConflictException(InvoicePaymentsService.EXPENSE_ALREADY_RECORDED);

        const paymentDate = data.payment_date ?? existing.payment_date;
        const expenseData = await this.paymentExpenseData(tx, user, expenseInput, existing.invoice_id, paymentDate);

        const updatedPayment = await tx.invoicePayment.update({
          where: { id },
          data: amountChanged ? { ...data, amount: roundMoney(body.amount) } : data,
        });
        const createdExpense = await this.createLinkedExpense(tx, expenseData, id);
        return { payment: updatedPayment, expense: createdExpense };
      });
      return this.withExpenseSummary(this.formatPayment(payment), expense);
    }

    if (!amountChanged) {
      if (body.amount !== undefined && toPaise(body.amount) <= 0) {
        throw new BadRequestException('Payment amount must be greater than zero.');
      }
      const updated = await this.prisma.invoicePayment.update({ where: { id }, data });
      return this.formatPayment(updated);
    }

    // Amount changed: revalidate against the balance excluding this payment's old amount
    const updated = await this.prisma.$transaction(async (tx) => {
      const financials = await this.lockInvoiceFinancials(tx, existing.invoice_id, id);
      const paymentError = validatePaymentAmount(body.amount, financials.balance_paise);
      if (paymentError) throw new BadRequestException(paymentError);

      return tx.invoicePayment.update({
        where: { id },
        data: { ...data, amount: roundMoney(body.amount) },
      });
    });

    return this.formatPayment(updated);
  }

  async remove(id: number, user: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify invoice payments.');
    }

    const existing = await this.prisma.invoicePayment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Invoice payment not found');

    await this.prisma.invoicePayment.delete({ where: { id } });
    return null;
  }

  async sendEmail(id: number, user: any) {
    const payment = await this.prisma.invoicePayment.findUnique({
      where: { id },
      include: {
        invoice: {
          include: {
            client: true,
          },
        },
      },
    });

    if (!payment) throw new NotFoundException('Invoice payment not found');

    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (!client || payment.invoice.client_id !== client.id) {
        throw new ForbiddenException('You do not have permission to access this payment receipt.');
      }
    }

    const clientEmail = payment.invoice?.client?.email;
    if (!clientEmail || !clientEmail.trim()) {
      throw new BadRequestException({ error: 'No email found for client' });
    }

    const { buffer: pdfBuffer, filename } = await this.generateReceiptPdfStream(id, user);
    const receiptNumber = await this.getOrAssignReceiptNumber(id);
    const paymentDateFormatted = this.formatDateDDMMYYYY(payment.payment_date);
    const amountStr = payment.amount ? Number(payment.amount).toLocaleString('en-IN') : '0';
    const clientName = payment.invoice?.client?.name || payment.invoice?.client?.company_name || 'Client';
    const invoiceNumber = payment.invoice?.invoice_number || 'N/A';
    const paymentModeStr = (payment.payment_mode || 'bank').toUpperCase();

    const text = `Dear ${clientName},\n\nThank you for your payment. Please find your payment receipt details below.\n\nReceipt No: ${receiptNumber}\nInvoice No: ${invoiceNumber}\nPayment Date: ${paymentDateFormatted}\nAmount Received: ₹${amountStr}\nPayment Mode: ${paymentModeStr}\n\nThank you for choosing GrehaSoft.\n\nRegards,\nGrehaSoft Smart IT Solutions`;

    const html = `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #333333;">
  <p style="margin: 0 0 12px 0;">Dear ${clientName},</p>
  <p style="margin: 0 0 12px 0;">Thank you for your payment. Please find your payment receipt details below.</p>
  <p style="margin: 0 0 12px 0; line-height: 1.6;">
    <strong>Receipt No:</strong> ${receiptNumber}<br />
    <strong>Invoice No:</strong> ${invoiceNumber}<br />
    <strong>Payment Date:</strong> ${paymentDateFormatted}<br />
    <strong>Amount Received:</strong> ₹${amountStr}<br />
    <strong>Payment Mode:</strong> ${paymentModeStr}
  </p>
  <p style="margin: 0 0 12px 0;">Thank you for choosing GrehaSoft.</p>
  <p style="margin: 0;">Regards,<br />GrehaSoft Accounts</p>
</div>`;

    const mailSent = await this.mailerService.sendMail({
      to: clientEmail,
      subject: `Payment Receipt - ${receiptNumber}`,
      text,
      html,
      attachments: [
        {
          filename,
          content: pdfBuffer,
        } as any,
      ],
    });

    if (!mailSent) {
      throw new InternalServerErrorException('Failed to send payment receipt email. Please check server email configuration.');
    }

    return { message: 'Email sent' };
  }

  private getSigningSecret(): string {
    return (
      this.configService?.get<string>('INVOICE_LINK_SECRET') ||
      this.configService?.get<string>('SECRET_KEY') ||
      this.configService?.get<string>('JWT_SECRET') ||
      'grehasoft-receipt-link-signing-secret-default'
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
    const payment = await this.prisma.invoicePayment.findUnique({ where: { id } });
    if (!payment) throw new NotFoundException('Invoice payment not found');
    // Caller must be able to read this payment (findOne applies CLIENT ownership scoping)
    if (req?.user) await this.findOne(id, req.user);

    const secret = this.getSigningSecret();
    const token = ReceiptSigning.generateToken(id, secret, 172800);
    const baseUrl = this.getBaseUrl(req);
    const securePdfLink = `${baseUrl}/api/v1/invoice-payments/public/${encodeURIComponent(token)}/download/`;

    return { secure_pdf_link: securePdfLink };
  }

  async generatePdfStreamFromPublicToken(token: string): Promise<{ buffer: Buffer; filename: string }> {
    const secret = this.getSigningSecret();
    const verification = ReceiptSigning.verifyToken(token, secret);

    if (!verification.valid || !verification.paymentId) {
      throw new ForbiddenException(verification.error || 'Invalid or expired signature token.');
    }

    return this.generateReceiptPdfStream(verification.paymentId, { role: { name: 'PUBLIC' } });
  }
}
