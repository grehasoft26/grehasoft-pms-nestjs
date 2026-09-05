import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';

@Injectable()
export class InvoicePaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
  ) {}

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

  async getOrAssignReceiptNumber(paymentId: number): Promise<string> {
    return this.acquireLock(async () => {
      const existing = await this.prisma.invoicePayment.findUnique({
        where: { id: paymentId },
        select: { receipt_number: true, payment_date: true },
      });
      if (!existing) throw new NotFoundException('Invoice payment not found');
      if (existing.receipt_number) {
        return existing.receipt_number;
      }

      const payDate = existing.payment_date || new Date();
      const year = payDate.getFullYear();
      const month = payDate.getMonth() + 1;

      let fiscalYearStr = '';
      if (month >= 4) {
        const nextYr = (year + 1) % 100;
        fiscalYearStr = `${year}-${String(nextYr).padStart(2, '0')}`;
      } else {
        const prevYr = year - 1;
        const curYr = year % 100;
        fiscalYearStr = `${prevYr}-${String(curYr).padStart(2, '0')}`;
      }

      const prefix = `RCT/${fiscalYearStr}/`;
      const lockKey = `receipt_lock_${fiscalYearStr.replace('-', '_')}`;

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

        const recheck = await this.prisma.invoicePayment.findUnique({
          where: { id: paymentId },
          select: { receipt_number: true },
        });
        if (recheck?.receipt_number) {
          return recheck.receipt_number;
        }

        const existingPayments = await this.prisma.invoicePayment.findMany({
          where: {
            receipt_number: { startsWith: prefix },
          },
          select: { receipt_number: true },
        });

        let maxNum = 0;
        for (const ep of existingPayments) {
          if (ep.receipt_number) {
            const parts = ep.receipt_number.split('/');
            if (parts.length === 3) {
              const num = parseInt(parts[2], 10);
              if (!isNaN(num) && num > maxNum) {
                maxNum = num;
              }
            }
          }
        }

        const nextNum = maxNum + 1;
        const candidateReceiptNumber = `${prefix}${String(nextNum).padStart(3, '0')}`;

        const updated = await this.prisma.invoicePayment.update({
          where: { id: paymentId },
          data: { receipt_number: candidateReceiptNumber },
        });

        return updated.receipt_number;
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

    const receiptData = {
      receipt_number: receiptNumber,
      payment_date: payment.payment_date ? payment.payment_date.toISOString().split('T')[0] : '',
      payment_amount: payment.amount ? Number(payment.amount) : 0,
      payment_mode: payment.payment_mode || 'cash',
      notes: payment.notes || '',
      invoice_number: payment.invoice.invoice_number,
      invoice_date: payment.invoice.issue_date ? payment.invoice.issue_date.toISOString().split('T')[0] : '',
      invoice_total: payment.invoice.total ? Number(payment.invoice.total) : 0,
      service_description: `Payment for Invoice ${payment.invoice.invoice_number}`,
      client: {
        name: payment.invoice.client?.name || '',
        company_name: payment.invoice.client?.company_name || '',
        email: payment.invoice.client?.email || '',
        phone: payment.invoice.client?.phone || '',
        address: payment.invoice.client?.address || '',
        gst_no: payment.invoice.client?.gst_no || '',
      },
      items: (payment.invoice.items || []).map((item: any) => ({
        description: item.description,
        quantity: item.quantity,
        rate: Number(item.rate),
        amount: Number(item.amount),
      })),
    };

    const pdfBuffer = await this.pdfService.generateReceiptPdf(receiptData);
    const safeNumber = (receiptNumber || 'RCT-001').replace(/\//g, '-');
    const filename = `receipt_${safeNumber}.pdf`;

    return { buffer: pdfBuffer, filename };
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
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException('Invoice not found');

    const payment = await this.prisma.invoicePayment.create({
      data: {
        invoice_id: invoiceId,
        amount: Number(body.amount || 0),
        payment_date: new Date(body.payment_date || new Date()),
        payment_mode: body.payment_mode || 'cash',
        notes: body.notes || '',
      },
    });

    return this.formatPayment(payment);
  }

  async update(id: number, user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify invoice payments.');
    }

    const existing = await this.prisma.invoicePayment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Invoice payment not found');

    const data: any = {};
    if (body.amount !== undefined) data.amount = Number(body.amount);
    if (body.payment_date !== undefined) data.payment_date = new Date(body.payment_date);
    if (body.payment_mode !== undefined) data.payment_mode = body.payment_mode;
    if (body.notes !== undefined) data.notes = body.notes;

    const updated = await this.prisma.invoicePayment.update({
      where: { id },
      data,
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
}
