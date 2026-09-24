import { Injectable, NotFoundException, ForbiddenException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';

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
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + 1; // 1-12

    let startYear: number;
    let endYear: number;

    if (month >= 4) {
      startYear = year;
      endYear = year + 1;
    } else {
      startYear = year - 1;
      endYear = year;
    }

    const fiscalYear = `${startYear}-${String(endYear).slice(-2)}`;
    const prefix = `GSI/${fiscalYear}`;
    return `${prefix}/001`;
  }

  async getNextInvoiceNumber(): Promise<string> {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + 1;

    let startYear: number;
    let endYear: number;

    if (month >= 4) {
      startYear = year;
      endYear = year + 1;
    } else {
      startYear = year - 1;
      endYear = year;
    }

    const fiscalYear = `${startYear}-${String(endYear).slice(-2)}`;
    const prefix = `GSI/${fiscalYear}`;

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
    }));

    const paymentsSum = payments.reduce((sum: number, p: any) => sum + p.amount, 0);
    const total_paid = advance + paymentsSum;
    const balance = Math.max(0, total - total_paid);

    const todayStr = new Date().toISOString().split('T')[0];
    const dueDateStr = i.due_date ? i.due_date.toISOString().split('T')[0] : null;

    let status = 'unpaid';
    if (total_paid >= total && total > 0) {
      status = 'paid';
    } else if (dueDateStr && dueDateStr < todayStr && total_paid < total) {
      status = 'overdue';
    } else if (total_paid > 0 && total_paid < total) {
      status = 'partial';
    } else {
      status = 'unpaid';
    }

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
      total,
      total_paid,
      balance,
      status,
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

  async findAll(user: any, query: { search?: string; client?: string; status?: string; all?: string; page?: string; limit?: string }) {
    const roleName = user.role?.name;
    const where: any = {};

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
        formatted = formatted.filter((inv) => inv.status === query.status);
      }
      return formatted;
    }

    const page = Math.max(1, parseInt(query.page as string, 10) || 1);
    const limit = Math.max(1, parseInt(query.limit as string, 10) || 10);

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
      formatted = formatted.filter((inv) => inv.status === query.status);
    }

    const totalCount = formatted.length;
    const skip = (page - 1) * limit;
    const paginated = formatted.slice(skip, skip + limit);

    return {
      count: totalCount,
      next: page * limit < totalCount ? `/api/v1/invoices?page=${page + 1}` : null,
      previous: page > 1 ? `/api/v1/invoices?page=${page - 1}` : null,
      results: paginated,
    };
  }

  async findOne(id: number, user: any) {
    const roleName = user.role?.name;
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        client: true,
        items: true,
        payments: true,
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
      const qty = item.quantity || 1;
      const rate = Number(item.rate || 0);
      subtotal += qty * rate;
    }

    const tax = Number(body.tax || 0);
    const total = body.total !== undefined ? Number(body.total) : subtotal + tax;

    const initialPaymentAmount = Number(body.payment_amount ?? body.advance ?? 0);
    const issueDateObj = new Date(body.issue_date || new Date());
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
            notes: 'Initial payment received on invoice creation',
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
    const paymentMode = body.payment_mode || body.new_payment_mode || 'cash';
    const paymentDateStr = body.payment_date || body.new_payment_date;
    const paymentDateObj = paymentDateStr ? new Date(paymentDateStr) : (body.issue_date ? new Date(body.issue_date) : new Date());

    // Only update advance if explicitly provided and no new_payment_amount is being processed
    if (body.advance !== undefined && newPaymentAmount === 0 && body.new_payment_amount === undefined) {
      data.advance = Number(body.advance);
    }

    if (body.client_address !== undefined) data.client_address = body.client_address;
    if (body.notes !== undefined) data.notes = body.notes;

    if (body.items !== undefined && Array.isArray(body.items)) {
      let subtotal = 0;
      for (const item of body.items) {
        const qty = item.quantity || 1;
        const rate = Number(item.rate || 0);
        subtotal += qty * rate;
      }
      data.subtotal = subtotal;
      const tax = body.tax !== undefined ? Number(body.tax) : Number(existing.tax);
      data.tax = tax;
      data.total = body.total !== undefined ? Number(body.total) : subtotal + tax;

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
    } else if (body.tax !== undefined || body.total !== undefined) {
      if (body.tax !== undefined) data.tax = Number(body.tax);
      data.total = body.total !== undefined ? Number(body.total) : Number(existing.subtotal) + (data.tax ?? Number(existing.tax));
    }

    if (newPaymentAmount > 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.invoice.update({
          where: { id },
          data,
        });

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

  async getAnalytics(user: any) {
    const invoices = await this.findAll(user, { all: 'true' });
    const list = Array.isArray(invoices) ? invoices : invoices.results;

    let totalRevenue = 0;
    let totalPaid = 0;
    let totalBalance = 0;

    for (const inv of list) {
      totalRevenue += inv.total;
      totalPaid += inv.total_paid;
      totalBalance += inv.balance;
    }

    return {
      total_invoices: list.length,
      total_revenue: totalRevenue,
      total_paid: totalPaid,
      total_balance: totalBalance,
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

    const secret = this.getSigningSecret();
    const token = InvoiceSigning.generateToken(id, secret, 172800);
    const baseUrl = this.getBaseUrl(req);
    const securePdfLink = `${baseUrl}/api/v1/invoices/public/${encodeURIComponent(token)}/download/`;

    return { secure_pdf_link: securePdfLink };
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
      const qty = Number(item.quantity || 1);
      const rate = Number(item.rate || 0);
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
      issue_date: body.issue_date || body.issueDate || new Date().toISOString().split('T')[0],
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
        payment_date: body.issue_date || new Date().toISOString().split('T')[0],
        payment_mode: 'advance',
        notes: 'Amount Received',
      }] : [],
    };

    return this.pdfService.generateInvoicePdf(previewInvoiceData);
  }
}
