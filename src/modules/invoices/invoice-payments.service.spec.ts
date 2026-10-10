import { Test, TestingModule } from '@nestjs/testing';
import { InvoicePaymentsService, ReceiptSigning } from './invoice-payments.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, ForbiddenException, BadRequestException, InternalServerErrorException } from '@nestjs/common';

describe('InvoicePaymentsService', () => {
  let service: InvoicePaymentsService;
  let prisma: any;
  let pdfService: any;
  let mailerService: any;

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

  const mockMailerService = {
    sendMail: jest.fn().mockResolvedValue(true),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'INVOICE_LINK_SECRET') return 'test-signing-secret';
      if (key === 'API_BASE_URL') return 'http://localhost:3000';
      return null;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    Object.keys(mockPaymentsDb).forEach((k) => delete mockPaymentsDb[Number(k)]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicePaymentsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: PdfService, useValue: mockPdfService },
        { provide: MailerService, useValue: mockMailerService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<InvoicePaymentsService>(InvoicePaymentsService);
    prisma = module.get(PrismaService);
    pdfService = module.get(PdfService);
    mailerService = module.get(MailerService);
  });

  describe('getOrAssignReceiptNumber', () => {
    it('A. New payment for invoice with no previous receipt -> RCT-2026-27-012', async () => {
      mockPaymentsDb[1] = {
        id: 1,
        invoice_id: 12,
        receipt_number: null,
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };

      const res = await service.getOrAssignReceiptNumber(1);
      expect(res).toBe('RCT-2026-27-012');
    });

    it('B. Second payment for same invoice -> RCT-2026-27-012-2', async () => {
      mockPaymentsDb[1] = {
        id: 1,
        invoice_id: 12,
        receipt_number: 'RCT-2026-27-012',
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };
      mockPaymentsDb[2] = {
        id: 2,
        invoice_id: 12,
        receipt_number: null,
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };

      const res = await service.getOrAssignReceiptNumber(2);
      expect(res).toBe('RCT-2026-27-012-2');
    });

    it('C. Third payment for same invoice -> RCT-2026-27-012-3', async () => {
      mockPaymentsDb[1] = {
        id: 1,
        invoice_id: 12,
        receipt_number: 'RCT-2026-27-012',
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };
      mockPaymentsDb[2] = {
        id: 2,
        invoice_id: 12,
        receipt_number: 'RCT-2026-27-012-2',
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };
      mockPaymentsDb[3] = {
        id: 3,
        invoice_id: 12,
        receipt_number: null,
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };

      const res = await service.getOrAssignReceiptNumber(3);
      expect(res).toBe('RCT-2026-27-012-3');
    });

    it('D. Existing legacy receipt remains RCT-2026-27-150 (never modified)', async () => {
      mockPaymentsDb[10] = {
        id: 10,
        invoice_id: 12,
        receipt_number: 'RCT-2026-27-150',
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };

      const res = await service.getOrAssignReceiptNumber(10);
      expect(res).toBe('RCT-2026-27-150');
    });

    it('E. Existing legacy receipt + new payment -> new payment gets RCT-2026-27-012-2', async () => {
      mockPaymentsDb[10] = {
        id: 10,
        invoice_id: 12,
        receipt_number: 'RCT-2026-27-012',
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };
      mockPaymentsDb[11] = {
        id: 11,
        invoice_id: 12,
        receipt_number: null,
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };

      const res10 = await service.getOrAssignReceiptNumber(10);
      expect(res10).toBe('RCT-2026-27-012');

      const res11 = await service.getOrAssignReceiptNumber(11);
      expect(res11).toBe('RCT-2026-27-012-2');
    });

    it('F. Edit payment date after receipt generation -> receipt number remains unchanged', async () => {
      mockPaymentsDb[1] = {
        id: 1,
        invoice_id: 12,
        receipt_number: null,
        payment_date: new Date('2026-09-01'),
        invoice: { invoice_number: 'GSI/2026-27/012' },
      };

      const originalReceipt = await service.getOrAssignReceiptNumber(1);
      expect(originalReceipt).toBe('RCT-2026-27-012');

      mockPaymentsDb[1].payment_date = new Date('2025-01-01');

      const afterEditReceipt = await service.getOrAssignReceiptNumber(1);
      expect(afterEditReceipt).toBe('RCT-2026-27-012');
    });

    it('G. CONCURRENCY TEST: simultaneous receipt generation for same invoice yields unique numbers', async () => {
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
    });
  });

  describe('generateReceiptPdfStream', () => {
    it('H. Receipt PDF displays new receipt number and formats dates in DD-MM-YYYY', async () => {
      const mockPayment = {
        id: 10,
        invoice_id: 12,
        amount: 5000,
        payment_date: new Date('2026-09-05T00:00:00.000Z'),
        payment_mode: 'upi',
        notes: 'Advance payment',
        invoice: {
          invoice_number: 'GSI/2026-27/012',
          issue_date: new Date('2026-09-01T00:00:00.000Z'),
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

      expect(result.filename).toBe('receipt_RCT-2026-27-012_Acme_Technologies_Pvt_Ltd.pdf');
      expect(result.buffer).toEqual(Buffer.from('PDF_CONTENT'));
      expect(mockPdfService.generateReceiptPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          receipt_number: 'RCT-2026-27-012',
          payment_date: '05-09-2026',
          invoice_date: '01-09-2026',
          payment_amount: 5000,
          invoice_total: 10000,
        }),
      );
    });

    it('getReceiptPdfFilename should generate correct filename formats with and without company_name', () => {
      const paymentWithCompany = {
        invoice: { client: { company_name: 'Acme Technologies Pvt Ltd' } },
      };
      expect(service.getReceiptPdfFilename('RCT-2026-27-150', paymentWithCompany)).toBe(
        'receipt_RCT-2026-27-150_Acme_Technologies_Pvt_Ltd.pdf',
      );

      const paymentNoCompany = {
        invoice: { client: { company_name: '' } },
      };
      expect(service.getReceiptPdfFilename('RCT-2026-27-150', paymentNoCompany)).toBe(
        'receipt_RCT-2026-27-150.pdf',
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

  describe('sendEmail', () => {
    it('should send payment receipt email with attachment when client email exists', async () => {
      mockPaymentsDb[10] = {
        id: 10,
        invoice_id: 12,
        amount: 5000,
        payment_date: new Date('2026-09-05T00:00:00.000Z'),
        payment_mode: 'bank',
        invoice: {
          invoice_number: 'GSI/2026-27/012',
          issue_date: new Date('2026-09-01T00:00:00.000Z'),
          total: 10000,
          client_id: 5,
          client: {
            name: 'Jane Client',
            company_name: 'TechCorp',
            email: 'jane@techcorp.com',
          },
          items: [],
        },
      };

      mockPdfService.generateReceiptPdf.mockResolvedValue(Buffer.from('PDF_RECEIPT_BYTES'));
      mockMailerService.sendMail.mockResolvedValue(true);

      const user = { id: 1, role: { name: 'ADMIN' } };
      const res = await service.sendEmail(10, user);

      expect(res).toEqual({ message: 'Email sent' });
      expect(mockMailerService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'jane@techcorp.com',
          subject: 'Payment Receipt - RCT-2026-27-012',
          attachments: [
            expect.objectContaining({
              filename: 'receipt_RCT-2026-27-012_TechCorp.pdf',
              content: Buffer.from('PDF_RECEIPT_BYTES'),
            }),
          ],
        }),
      );
    });

    it('should throw BadRequestException if client has no email', async () => {
      mockPaymentsDb[10] = {
        id: 10,
        invoice_id: 12,
        amount: 5000,
        invoice: {
          invoice_number: 'GSI/2026-27/012',
          client: { name: 'Jane Client', email: '' },
        },
      };

      const user = { id: 1, role: { name: 'ADMIN' } };
      await expect(service.sendEmail(10, user)).rejects.toThrow(BadRequestException);
    });

    it('should throw InternalServerErrorException if mailer service returns false', async () => {
      mockPaymentsDb[10] = {
        id: 10,
        invoice_id: 12,
        amount: 5000,
        payment_date: new Date('2026-09-05T00:00:00.000Z'),
        invoice: {
          invoice_number: 'GSI/2026-27/012',
          client: { email: 'jane@techcorp.com' },
          items: [],
        },
      };

      mockPdfService.generateReceiptPdf.mockResolvedValue(Buffer.from('PDF_RECEIPT_BYTES'));
      mockMailerService.sendMail.mockResolvedValue(false);

      const user = { id: 1, role: { name: 'ADMIN' } };
      await expect(service.sendEmail(10, user)).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('generateSecureLink & public tokens', () => {
    it('should generate a valid secure PDF link and verify public token stream generation', async () => {
      mockPaymentsDb[10] = {
        id: 10,
        invoice_id: 12,
        amount: 5000,
        payment_date: new Date('2026-09-05T00:00:00.000Z'),
        invoice: {
          invoice_number: 'GSI/2026-27/012',
          client: { company_name: 'TechCorp' },
          items: [],
        },
      };

      mockPdfService.generateReceiptPdf.mockResolvedValue(Buffer.from('PDF_PUBLIC_BYTES'));

      const secureLinkRes = await service.generateSecureLink(10);
      expect(secureLinkRes.secure_pdf_link).toContain('/api/v1/invoice-payments/public/');

      // Extract token from URL
      const parts = secureLinkRes.secure_pdf_link.split('/public/');
      const token = decodeURIComponent(parts[1].replace('/download/', ''));

      const publicStream = await service.generatePdfStreamFromPublicToken(token);
      expect(publicStream.filename).toBe('receipt_RCT-2026-27-012_TechCorp.pdf');
      expect(publicStream.buffer).toEqual(Buffer.from('PDF_PUBLIC_BYTES'));
    });

    it('should reject invalid or expired public tokens', async () => {
      await expect(service.generatePdfStreamFromPublicToken('invalid.token.str')).rejects.toThrow(ForbiddenException);
    });
  });
});
