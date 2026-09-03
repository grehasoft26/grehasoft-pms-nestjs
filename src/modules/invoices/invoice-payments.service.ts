import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';

@Injectable()
export class InvoicePaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  private formatPayment(p: any) {
    if (!p) return null;
    return {
      id: p.id,
      invoice: p.invoice_id,
      amount: p.amount ? Number(p.amount) : 0,
      payment_date: p.payment_date ? p.payment_date.toISOString().split('T')[0] : null,
      payment_mode: p.payment_mode || 'cash',
      notes: p.notes || '',
      created_at: p.created_at ? p.created_at.toISOString() : null,
    };
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
