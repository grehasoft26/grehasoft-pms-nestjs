import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
    private readonly mailerService: MailerService,
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
      client_address: i.client_address !== null && i.client_address !== undefined ? i.client_address : (i.client ? i.client.address : null),
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

  async findAll(user: any, query: { search?: string; client?: string; all?: string; page?: string; limit?: string }) {
    const roleName = user.role?.name;
    const where: any = {};

    if (query.search) {
      where.OR = [
        { invoice_number: { contains: query.search } },
        { client: { name: { contains: query.search } } },
        { client: { company_name: { contains: query.search } } },
      ];
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

      return invoices.map((i) => this.formatInvoice(i));
    }

    const page = Math.max(1, parseInt(query.page as string, 10) || 1);
    const limit = Math.max(1, parseInt(query.limit as string, 10) || 5);
    const skip = (page - 1) * limit;

    const totalCount = await this.prisma.invoice.count({ where });

    const invoices = await this.prisma.invoice.findMany({
      where,
      include: {
        client: true,
        items: true,
        payments: true,
      },
      orderBy: { id: 'desc' },
      skip,
      take: limit,
    });

    const formatted = invoices.map((i) => this.formatInvoice(i));

    return {
      count: totalCount,
      next: null,
      previous: null,
      results: formatted,
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

    const created = await this.prisma.invoice.create({
      data: {
        invoice_number: invoiceNumber,
        client_id: clientId,
        client_address: body.client_address !== undefined ? body.client_address : (client.address || ''),
        issue_date: new Date(body.issue_date || new Date()),
        due_date: body.due_date ? new Date(body.due_date) : null,
        advance: Number(body.advance || 0),
        subtotal,
        tax,
        total,
        notes: body.notes || '',
      },
    });

    for (const item of itemsData) {
      const qty = item.quantity || 1;
      const rate = Number(item.rate || 0);
      await this.prisma.invoiceItem.create({
        data: {
          invoice_id: created.id,
          description: item.description || '',
          quantity: qty,
          rate,
          amount: qty * rate,
        },
      });
    }

    return this.findOne(created.id, user);
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
    if (body.advance !== undefined) data.advance = Number(body.advance);
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

    await this.prisma.invoice.update({
      where: { id },
      data,
    });

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
    await this.mailerService.sendMail({
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

    return { message: 'Email sent' };
  }
}
