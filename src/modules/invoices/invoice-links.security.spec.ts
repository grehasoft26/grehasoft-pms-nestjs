import { ForbiddenException } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { InvoicePaymentsService, ReceiptSigning } from './invoice-payments.service';

/**
 * Phase 2.2: secure links are only issued for invoices/payments the caller can read,
 * and receipt tokens are verified with a constant-time comparison.
 */
const buildPrisma = () => ({
  invoice: { findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, client_id: 2, items: [], payments: [], client: { id: 2 } })) },
  invoicePayment: { findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, invoice: { id: 4, client_id: 2 } })) },
  // The CLIENT user belongs to client 1
  client: { findFirst: jest.fn(async () => ({ id: 1 })) },
});

const config = { get: jest.fn(() => 'test-secret') };
const req = (user: any) => ({ user, protocol: 'http', get: () => 'localhost:3000', headers: {} });
const clientUser = { id: 50, client_id: 1, role: { name: 'CLIENT' } };
const admin = { id: 1, role: { name: 'ADMIN', permissions: ['MANAGE_INVOICES'] } };

describe('Invoice and receipt secure links (Phase 2.2)', () => {
  it('refuses an invoice link for another client invoice', async () => {
    const prisma = buildPrisma();
    const service = new InvoicesService(prisma as any, {} as any, {} as any, config as any);
    await expect(service.generateSecureLink(3, req(clientUser))).rejects.toThrow(ForbiddenException);
    jest.spyOn(service as any, 'formatInvoice').mockReturnValue({});
    await expect(service.generateSecureLink(3, req(admin))).resolves.toHaveProperty('secure_pdf_link');
  });

  it('refuses a receipt link for another client payment', async () => {
    const prisma = buildPrisma();
    const service = new InvoicePaymentsService(prisma as any, {} as any, {} as any, config as any);
    await expect(service.generateSecureLink(7, req(clientUser))).rejects.toThrow(ForbiddenException);
    jest.spyOn(service as any, 'formatPayment').mockReturnValue({});
    await expect(service.generateSecureLink(7, req(admin))).resolves.toHaveProperty('secure_pdf_link');
  });

  it('receipt tokens: valid tokens pass; tampered, truncated or wrong-secret tokens fail', () => {
    const token = ReceiptSigning.generateToken(7, 'secret', 60);
    expect(ReceiptSigning.verifyToken(token, 'secret')).toEqual({ valid: true, paymentId: 7 });

    const [id, exp, mac] = token.split('.');
    const flipped = mac.slice(0, -1) + (mac.endsWith('0') ? '1' : '0');
    expect(ReceiptSigning.verifyToken(`${id}.${exp}.${flipped}`, 'secret').valid).toBe(false);
    expect(ReceiptSigning.verifyToken(`${id}.${exp}.${mac.slice(0, 10)}`, 'secret').valid).toBe(false);
    expect(ReceiptSigning.verifyToken(`8.${exp}.${mac}`, 'secret').valid).toBe(false);
    expect(ReceiptSigning.verifyToken(token, 'other-secret').valid).toBe(false);
  });
});
