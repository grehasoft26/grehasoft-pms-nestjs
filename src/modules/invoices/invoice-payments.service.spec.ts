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
        return {
          ...p,
          invoice: p.invoice || { invoice_number: p.invoice_number || 'GSI/2026-27/012' },
        };
      }),
      findMany: jest.fn().mockImplementation(async ({ where }) => {
        const prefix = where?.receipt_number?.startsWith || '';
        const invoiceId = where?.invoice_id;
        return Object.values(mockPaymentsDb)
          .filter((p: any) => {
            if (invoiceId !== undefined && p.invoice_id !== undefined && p.invoice_id !== invoiceId) {
              return false;
            }
            return p.receipt_number && p.receipt_number.startsWith(prefix);
          })
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
    it('A. New payment for invoice with no previous receipt -> RCT/GSI-2026-27-012/01', async () => {
      mockPaymentsDb[1] = {
        id: 1,
        invoice_id: 12,
        receipt_number: null,
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };

      const res = await service.getOrAssignReceiptNumber(1);
      expect(res).toBe('RCT/GSI-2026-27-012/01');
    });

    it('B. Second payment for same invoice -> RCT/GSI-2026-27-012/02', async () => {
      mockPaymentsDb[1] = {
        id: 1,
        invoice_id: 12,
        receipt_number: 'RCT/GSI-2026-27-012/01',
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };
      mockPaymentsDb[2] = {
        id: 2,
        invoice_id: 12,
        receipt_number: null,
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };

      const res = await service.getOrAssignReceiptNumber(2);
      expect(res).toBe('RCT/GSI-2026-27-012/02');
    });

    it('C. Third payment for same invoice -> RCT/GSI-2026-27-012/03', async () => {
      mockPaymentsDb[1] = {
        id: 1,
        invoice_id: 12,
        receipt_number: 'RCT/GSI-2026-27-012/01',
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };
      mockPaymentsDb[2] = {
        id: 2,
        invoice_id: 12,
        receipt_number: 'RCT/GSI-2026-27-012/02',
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };
      mockPaymentsDb[3] = {
        id: 3,
        invoice_id: 12,
        receipt_number: null,
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };

      const res = await service.getOrAssignReceiptNumber(3);
      expect(res).toBe('RCT/GSI-2026-27-012/03');
    });

    it('D. Delete payment 02, then create another payment -> 04, NOT 02 (never reuse)', async () => {
      mockPaymentsDb[1] = {
        id: 1,
        invoice_id: 12,
        receipt_number: 'RCT/GSI-2026-27-012/01',
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };
      // Payment 2 (RCT/GSI-2026-27-012/02) was deleted
      mockPaymentsDb[3] = {
        id: 3,
        invoice_id: 12,
        receipt_number: 'RCT/GSI-2026-27-012/03',
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };
      mockPaymentsDb[4] = {
        id: 4,
        invoice_id: 12,
        receipt_number: null,
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };

      const res = await service.getOrAssignReceiptNumber(4);
      expect(res).toBe('RCT/GSI-2026-27-012/04');
    });

    it('E. Existing legacy receipt remains RCT/2026-27/003 (never modified)', async () => {
      mockPaymentsDb[10] = {
        id: 10,
        invoice_id: 12,
        receipt_number: 'RCT/2026-27/003',
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };

      const res = await service.getOrAssignReceiptNumber(10);
      expect(res).toBe('RCT/2026-27/003');
    });

    it('F. Existing legacy receipt + new payment -> new payment gets new per-invoice format', async () => {
      mockPaymentsDb[10] = {
        id: 10,
        invoice_id: 12,
        receipt_number: 'RCT/2026-27/003', // Legacy receipt on same invoice
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };
      mockPaymentsDb[11] = {
        id: 11,
        invoice_id: 12,
        receipt_number: null,
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };

      const res10 = await service.getOrAssignReceiptNumber(10);
      expect(res10).toBe('RCT/2026-27/003');

      const res11 = await service.getOrAssignReceiptNumber(11);
      expect(res11).toBe('RCT/GSI-2026-27-012/01');
    });

    it('G. Edit payment date after receipt generation -> receipt number remains unchanged', async () => {
      mockPaymentsDb[1] = {
        id: 1,
        invoice_id: 12,
        receipt_number: null,
        payment_date: new Date('2026-09-01'),
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };

      const originalReceipt = await service.getOrAssignReceiptNumber(1);
      expect(originalReceipt).toBe('RCT/GSI-2026-27-012/01');

      // Edit payment_date to a different fiscal year date (e.g. 2025-01-01)
      mockPaymentsDb[1].payment_date = new Date('2025-01-01');

      const afterEditReceipt = await service.getOrAssignReceiptNumber(1);
      expect(afterEditReceipt).toBe('RCT/GSI-2026-27-012/01');
    });

    it('H. CONCURRENCY TEST: simultaneous receipt generation for same invoice yields unique numbers', async () => {
      for (let i = 1; i <= 5; i++) {
        mockPaymentsDb[i] = {
          id: i,
          invoice_id: 12,
          receipt_number: null,
          invoice: { invoice_number: 'GSI/2026-27/012' },
        };
      }

      const results = await Promise.all([
        service.getOrAssignReceiptNumber(1),
        service.getOrAssignReceiptNumber(2),
        service.getOrAssignReceiptNumber(3),
        service.getOrAssignReceiptNumber(4),
        service.getOrAssignReceiptNumber(5),
      ]);

      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBe(5);

      const sortedResults = [...results].sort();
      expect(sortedResults).toEqual([
        'RCT/GSI-2026-27-012/01',
        'RCT/GSI-2026-27-012/02',
        'RCT/GSI-2026-27-012/03',
        'RCT/GSI-2026-27-012/04',
        'RCT/GSI-2026-27-012/05',
      ]);
    });
  });

  describe('generateReceiptPdfStream', () => {
    it('I & J. Receipt PDF displays new receipt number and frontend filename uses sanitized format', async () => {
      const mockPayment = {
        id: 10,
        invoice_id: 12,
        amount: 5000,
        payment_date: new Date('2026-09-05'),
        payment_mode: 'upi',
        notes: 'Advance payment',
        invoice: {
          invoice_number: 'GSI/2026-27/012',
          issue_date: new Date('2026-09-01'),
          total: 10000,
          client_id: 5,
          client: {
            name: 'John Doe',
            company_name: 'Acme Technologies Pvt Ltd',
            email: 'john@acme.com',
          },
          items: [{ description: 'Web Dev', quantity: 1, rate: 10000, amount: 10000 }],
        },
      };

      mockPaymentsDb[10] = mockPayment;
      mockPdfService.generateReceiptPdf.mockResolvedValue(Buffer.from('PDF_CONTENT'));

      const user = { id: 1, role: { name: 'ADMIN' } };
      const result = await service.generateReceiptPdfStream(10, user);

      expect(result.filename).toBe('receipt_RCT_GSI-2026-27-012_01_Acme_Technologies_Pvt_Ltd.pdf');
      expect(result.buffer).toEqual(Buffer.from('PDF_CONTENT'));
      expect(mockPdfService.generateReceiptPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          receipt_number: 'RCT/GSI-2026-27-012/01',
          payment_amount: 5000,
          invoice_total: 10000,
        }),
      );
    });

    it('getReceiptPdfFilename should generate correct filename formats with and without company_name', () => {
      const paymentWithCompany = {
        invoice: { client: { company_name: 'Acme Technologies Pvt Ltd' } },
      };
      expect(service.getReceiptPdfFilename('RCT/GSI-2026-27-012/01', paymentWithCompany)).toBe(
        'receipt_RCT_GSI-2026-27-012_01_Acme_Technologies_Pvt_Ltd.pdf',
      );

      const legacyPaymentWithCompany = {
        invoice: { client: { company_name: 'Acme Technologies Pvt Ltd' } },
      };
      expect(service.getReceiptPdfFilename('RCT/2026-27/003', legacyPaymentWithCompany)).toBe(
        'receipt_RCT_2026-27_003_Acme_Technologies_Pvt_Ltd.pdf',
      );

      const paymentNoCompany = {
        invoice: { client: { company_name: '' } },
      };
      expect(service.getReceiptPdfFilename('RCT/GSI-2026-27-012/01', paymentNoCompany)).toBe(
        'receipt_RCT_GSI-2026-27-012_01.pdf',
      );
    });

    it('should throw ForbiddenException if CLIENT role tries to access another client payment', async () => {
      mockPaymentsDb[10] = {
        id: 10,
        invoice_id: 12,
        amount: 5000,
        invoice: { client_id: 2, invoice_number: 'GSI/2026-27/012' },
      };
      mockPrismaService.client.findFirst.mockResolvedValue({ id: 99 });

      const user = { id: 1, role: { name: 'CLIENT' } };

      await expect(service.generateReceiptPdfStream(10, user)).rejects.toThrow(ForbiddenException);
    });
  });
});
