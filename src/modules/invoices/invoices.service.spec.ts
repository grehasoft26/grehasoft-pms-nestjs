import { Test, TestingModule } from '@nestjs/testing';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';

describe('InvoicesService', () => {
  let service: InvoicesService;

  const mockPrismaService = {
    invoice: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    client: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    invoiceItem: {
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  const mockPdfService = {
    generateInvoicePdf: jest.fn(),
  };

  const mockMailerService = {
    sendMail: jest.fn(),
  };

  const adminUser = { id: 1, role: { name: 'SUPER_ADMIN' } };
  const futureDueDate = new Date('2099-12-31');

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: PdfService, useValue: mockPdfService },
        { provide: MailerService, useValue: mockMailerService },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  describe('advance and balance calculations', () => {
    it('1. No advance + no payments: total_paid = 0, balance = total, status = unpaid', async () => {
      mockPrismaService.invoice.findUnique.mockResolvedValue({
        id: 1,
        invoice_number: 'GSI/2026-27/001',
        client_id: 1,
        subtotal: 2000,
        tax: 0,
        total: 2000,
        advance: 0,
        due_date: futureDueDate,
        payments: [],
        items: [],
      });

      const result = await service.findOne(1, adminUser);

      expect(result.total).toBe(2000);
      expect(result.advance).toBe(0);
      expect(result.total_paid).toBe(0);
      expect(result.balance).toBe(2000);
      expect(result.status).toBe('unpaid');
    });

    it('2. Advance only: total_paid = advance, balance = total - advance, status = partial', async () => {
      mockPrismaService.invoice.findUnique.mockResolvedValue({
        id: 2,
        invoice_number: 'GSI/2026-27/002',
        client_id: 1,
        subtotal: 2500,
        tax: 0,
        total: 2000,
        advance: 600,
        due_date: futureDueDate,
        payments: [],
        items: [],
      });

      const result = await service.findOne(2, adminUser);

      expect(result.total).toBe(2000);
      expect(result.advance).toBe(600);
      expect(result.total_paid).toBe(600);
      expect(result.balance).toBe(1400);
      expect(result.status).toBe('partial');
    });

    it('3. Advance + subsequent payment: total_paid = 1100, balance = 900 without double counting advance', async () => {
      mockPrismaService.invoice.findUnique.mockResolvedValue({
        id: 3,
        invoice_number: 'GSI/2026-27/003',
        client_id: 1,
        subtotal: 2500,
        tax: 0,
        total: 2000,
        advance: 600,
        due_date: futureDueDate,
        payments: [
          { id: 101, invoice_id: 3, amount: 500, payment_date: new Date() },
        ],
        items: [],
      });

      const result = await service.findOne(3, adminUser);

      expect(result.total).toBe(2000);
      expect(result.advance).toBe(600);
      expect(result.total_paid).toBe(1100); // 600 advance + 500 payment
      expect(result.balance).toBe(900); // 2000 - 1100
      expect(result.status).toBe('partial');
    });

    it('4. Advance equal to total: total_paid = total, balance = 0, status = paid', async () => {
      mockPrismaService.invoice.findUnique.mockResolvedValue({
        id: 4,
        invoice_number: 'GSI/2026-27/004',
        client_id: 1,
        subtotal: 2000,
        tax: 0,
        total: 2000,
        advance: 2000,
        due_date: futureDueDate,
        payments: [],
        items: [],
      });

      const result = await service.findOne(4, adminUser);

      expect(result.total).toBe(2000);
      expect(result.advance).toBe(2000);
      expect(result.total_paid).toBe(2000);
      expect(result.balance).toBe(0);
      expect(result.status).toBe('paid');
    });

    it('5. Advance greater than total: total_paid = 2500, balance = 0, status = paid', async () => {
      mockPrismaService.invoice.findUnique.mockResolvedValue({
        id: 5,
        invoice_number: 'GSI/2026-27/005',
        client_id: 1,
        subtotal: 2000,
        tax: 0,
        total: 2000,
        advance: 2500,
        due_date: futureDueDate,
        payments: [],
        items: [],
      });

      const result = await service.findOne(5, adminUser);

      expect(result.total).toBe(2000);
      expect(result.advance).toBe(2500);
      expect(result.total_paid).toBe(2500);
      expect(result.balance).toBe(0);
      expect(result.status).toBe('paid');
    });

    it('6. Status transitions: unpaid -> partial -> paid', async () => {
      // Step A: Unpaid (0 advance, 0 payments)
      mockPrismaService.invoice.findUnique.mockResolvedValueOnce({
        id: 6,
        total: 2000,
        advance: 0,
        due_date: futureDueDate,
        payments: [],
      });
      const stepA = await service.findOne(6, adminUser);
      expect(stepA.status).toBe('unpaid');

      // Step B: Partial (600 advance, 0 payments)
      mockPrismaService.invoice.findUnique.mockResolvedValueOnce({
        id: 6,
        total: 2000,
        advance: 600,
        due_date: futureDueDate,
        payments: [],
      });
      const stepB = await service.findOne(6, adminUser);
      expect(stepB.status).toBe('partial');

      // Step C: Partial (600 advance + 500 payment = 1100)
      mockPrismaService.invoice.findUnique.mockResolvedValueOnce({
        id: 6,
        total: 2000,
        advance: 600,
        due_date: futureDueDate,
        payments: [{ id: 1, amount: 500 }],
      });
      const stepC = await service.findOne(6, adminUser);
      expect(stepC.status).toBe('partial');

      // Step D: Paid (600 advance + 1400 payment = 2000)
      mockPrismaService.invoice.findUnique.mockResolvedValueOnce({
        id: 6,
        total: 2000,
        advance: 600,
        due_date: futureDueDate,
        payments: [{ id: 1, amount: 1400 }],
      });
      const stepD = await service.findOne(6, adminUser);
      expect(stepD.status).toBe('paid');
    });

    it('7. Balance never becomes negative even when total payments exceed total', async () => {
      mockPrismaService.invoice.findUnique.mockResolvedValue({
        id: 7,
        invoice_number: 'GSI/2026-27/007',
        client_id: 1,
        subtotal: 2000,
        tax: 0,
        total: 2000,
        advance: 600,
        due_date: futureDueDate,
        payments: [
          { id: 201, invoice_id: 7, amount: 1600, payment_date: new Date() }, // 600 + 1600 = 2200
        ],
        items: [],
      });

      const result = await service.findOne(7, adminUser);

      expect(result.total).toBe(2000);
      expect(result.total_paid).toBe(2200);
      expect(result.balance).toBe(0); // Math.max(0, 2000 - 2200) = 0
      expect(result.status).toBe('paid');
    });
  });

  describe('update client logic', () => {
    const existingInvoice = {
      id: 1,
      invoice_number: 'GSI/2026-27/001',
      client_id: 1,
      subtotal: 2000,
      tax: 0,
      total: 2000,
      advance: 500,
      due_date: futureDueDate,
      items: [],
      payments: [],
    };

    it('should update invoice client from Client A (id 1) to Client B (id 2) using body.client', async () => {
      mockPrismaService.invoice.findUnique
        .mockResolvedValueOnce(existingInvoice) // for update check
        .mockResolvedValueOnce({
          ...existingInvoice,
          client_id: 2,
          client: { id: 2, name: 'Client B' },
        }); // for findOne return

      mockPrismaService.client.findUnique.mockResolvedValue({ id: 2, name: 'Client B' });
      mockPrismaService.invoice.update.mockResolvedValue({ ...existingInvoice, client_id: 2 });

      const result = await service.update(1, adminUser, { client: 2 });

      expect(mockPrismaService.client.findUnique).toHaveBeenCalledWith({ where: { id: 2 } });
      expect(mockPrismaService.invoice.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({ client_id: 2 }),
      });
      expect(result.client).toBe(2);
      expect(result.client_name).toBe('Client B');
    });

    it('should update invoice client using body.client_id', async () => {
      mockPrismaService.invoice.findUnique
        .mockResolvedValueOnce(existingInvoice)
        .mockResolvedValueOnce({
          ...existingInvoice,
          client_id: 2,
          client: { id: 2, name: 'Client B' },
        });

      mockPrismaService.client.findUnique.mockResolvedValue({ id: 2, name: 'Client B' });
      mockPrismaService.invoice.update.mockResolvedValue({ ...existingInvoice, client_id: 2 });

      const result = await service.update(1, adminUser, { client_id: 2 });

      expect(mockPrismaService.invoice.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({ client_id: 2 }),
      });
      expect(result.client).toBe(2);
      expect(result.client_name).toBe('Client B');
    });

    it('should throw BadRequestException if invalid client ID is specified', async () => {
      mockPrismaService.invoice.findUnique.mockResolvedValueOnce(existingInvoice);
      mockPrismaService.client.findUnique.mockResolvedValue(null);

      await expect(service.update(1, adminUser, { client: 999 })).rejects.toThrow(
        expect.objectContaining({
          response: { client: ['Invalid client specified.'] },
        }),
      );
    });

    it('should update invoice without changing the client', async () => {
      mockPrismaService.invoice.findUnique
        .mockResolvedValueOnce(existingInvoice)
        .mockResolvedValueOnce({
          ...existingInvoice,
          notes: 'Updated notes',
          client: { id: 1, name: 'Client A' },
        });

      mockPrismaService.invoice.update.mockResolvedValue({ ...existingInvoice, notes: 'Updated notes' });

      const result = await service.update(1, adminUser, { notes: 'Updated notes' });

      expect(mockPrismaService.client.findUnique).not.toHaveBeenCalled();
      expect(mockPrismaService.invoice.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.not.objectContaining({ client_id: expect.anything() }),
      });
      expect(result.notes).toBe('Updated notes');
      expect(result.client).toBe(1);
    });

    it('should leave financial values unaffected when updating client', async () => {
      mockPrismaService.invoice.findUnique
        .mockResolvedValueOnce(existingInvoice)
        .mockResolvedValueOnce({
          ...existingInvoice,
          client_id: 2,
          client: { id: 2, name: 'Client B' },
        });

      mockPrismaService.client.findUnique.mockResolvedValue({ id: 2, name: 'Client B' });
      mockPrismaService.invoice.update.mockResolvedValue({ ...existingInvoice, client_id: 2 });

      const result = await service.update(1, adminUser, { client: 2 });

      expect(result.total).toBe(2000);
      expect(result.subtotal).toBe(2000);
      expect(result.advance).toBe(500);
      expect(result.total_paid).toBe(500);
      expect(result.balance).toBe(1500);
    });
  });
});

