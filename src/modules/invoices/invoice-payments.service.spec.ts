import { Test, TestingModule } from '@nestjs/testing';
import { InvoicePaymentsService } from './invoice-payments.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { NotFoundException, ForbiddenException } from '@nestjs/common';

describe('InvoicePaymentsService', () => {
  let service: InvoicePaymentsService;
  let prisma: any;
  let pdfService: any;

  // In-memory db representation for stateful concurrency testing
  const mockPaymentsDb: Record<number, any> = {};

  const mockPrismaService = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ lock_result: 1 }]),
    invoicePayment: {
      findUnique: jest.fn().mockImplementation(async ({ where }) => {
        const p = mockPaymentsDb[where.id];
        if (!p) return null;
        return { ...p };
      }),
      findMany: jest.fn().mockImplementation(async ({ where }) => {
        const prefix = where?.receipt_number?.startsWith || '';
        return Object.values(mockPaymentsDb)
          .filter((p: any) => p.receipt_number && p.receipt_number.startsWith(prefix))
          .map((p: any) => ({ receipt_number: p.receipt_number }));
      }),
      update: jest.fn().mockImplementation(async ({ where, data }) => {
        if (!mockPaymentsDb[where.id]) throw new NotFoundException('Payment not found');
        mockPaymentsDb[where.id].receipt_number = data.receipt_number;
        return { ...mockPaymentsDb[where.id] };
      }),
    },
    client: {
      findFirst: jest.fn(),
    },
    invoice: {
      findUnique: jest.fn(),
    },
  };

  const mockPdfService = {
    generateReceiptPdf: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    Object.keys(mockPaymentsDb).forEach((k) => delete mockPaymentsDb[Number(k)]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicePaymentsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: PdfService, useValue: mockPdfService },
      ],
    }).compile();

    service = module.get<InvoicePaymentsService>(InvoicePaymentsService);
    prisma = module.get(PrismaService);
    pdfService = module.get(PdfService);
  });

  describe('getOrAssignReceiptNumber', () => {
    it('should return existing receipt_number if already present', async () => {
      mockPaymentsDb[10] = {
        id: 10,
        receipt_number: 'RCT/2026-27/005',
        payment_date: new Date('2026-09-05'),
      };

      const res = await service.getOrAssignReceiptNumber(10);
      expect(res).toBe('RCT/2026-27/005');
    });

    it('should generate a formatted receipt number when absent', async () => {
      mockPaymentsDb[1] = {
        id: 1,
        receipt_number: 'RCT/2026-27/001',
        payment_date: new Date('2026-09-05'),
      };
      mockPaymentsDb[2] = {
        id: 2,
        receipt_number: null,
        payment_date: new Date('2026-09-05'),
      };

      const res = await service.getOrAssignReceiptNumber(2);
      expect(res).toBe('RCT/2026-27/002');
    });

    it('CONCURRENCY TEST: should handle simultaneous requests without generating duplicate receipt numbers', async () => {
      // Seed 5 payments with null receipt numbers
      for (let i = 1; i <= 5; i++) {
        mockPaymentsDb[i] = {
          id: i,
          receipt_number: null,
          payment_date: new Date('2026-09-05'),
        };
      }

      // Execute 5 receipt generations simultaneously
      const results = await Promise.all([
        service.getOrAssignReceiptNumber(1),
        service.getOrAssignReceiptNumber(2),
        service.getOrAssignReceiptNumber(3),
        service.getOrAssignReceiptNumber(4),
        service.getOrAssignReceiptNumber(5),
      ]);

      // Every result must be unique
      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBe(5);

      // Verify receipt numbers are strictly RCT/2026-27/001 through RCT/2026-27/005
      const sortedResults = [...results].sort();
      expect(sortedResults).toEqual([
        'RCT/2026-27/001',
        'RCT/2026-27/002',
        'RCT/2026-27/003',
        'RCT/2026-27/004',
        'RCT/2026-27/005',
      ]);
    });
  });

  describe('generateReceiptPdfStream', () => {
    it('should throw ForbiddenException if CLIENT role tries to access another client payment', async () => {
      mockPaymentsDb[10] = {
        id: 10,
        amount: 5000,
        invoice: { client_id: 2 },
      };
      mockPrismaService.client.findFirst.mockResolvedValue({ id: 99 }); // different client ID

      const user = { id: 1, role: { name: 'CLIENT' } };

      await expect(service.generateReceiptPdfStream(10, user)).rejects.toThrow(ForbiddenException);
    });

    it('should generate receipt PDF buffer and filename for authorized user', async () => {
      const mockPayment = {
        id: 10,
        amount: 5000,
        payment_date: new Date('2026-09-05'),
        payment_mode: 'upi',
        notes: 'Advance payment',
        invoice: {
          invoice_number: 'INV-2026-001',
          issue_date: new Date('2026-09-01'),
          total: 10000,
          client_id: 5,
          client: {
            name: 'John Doe',
            company_name: 'Acme Corp',
            email: 'john@acme.com',
          },
          items: [{ description: 'Web Dev', quantity: 1, rate: 10000, amount: 10000 }],
        },
      };

      mockPaymentsDb[10] = mockPayment;
      mockPdfService.generateReceiptPdf.mockResolvedValue(Buffer.from('PDF_CONTENT'));

      const user = { id: 1, role: { name: 'ADMIN' } };
      const result = await service.generateReceiptPdfStream(10, user);

      expect(result.filename).toBe('receipt_RCT-2026-27-001.pdf');
      expect(result.buffer).toEqual(Buffer.from('PDF_CONTENT'));
      expect(mockPdfService.generateReceiptPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          receipt_number: 'RCT/2026-27/001',
          payment_amount: 5000,
          invoice_total: 10000,
        }),
      );
    });
  });
});
