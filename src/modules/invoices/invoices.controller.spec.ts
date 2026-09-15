import { Test, TestingModule } from '@nestjs/testing';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';

describe('InvoicesController', () => {
  let controller: InvoicesController;
  let invoicesService: any;

  const mockInvoicesService = {
    findAll: jest.fn(),
    getNextInvoiceNumber: jest.fn(),
    getAnalytics: jest.fn(),
    findOne: jest.fn().mockResolvedValue({ id: 17, invoice_number: 'GSI/2026-27/001' }),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    generatePdfStream: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 ... mock pdf content')),
    generateSecureLink: jest.fn().mockResolvedValue({ secure_pdf_link: 'http://localhost:3000/api/v1/invoices/public/17.12345.abc/download/' }),
    generatePdfStreamFromPublicToken: jest.fn().mockResolvedValue({
      pdfBuffer: Buffer.from('%PDF-1.4 ... mock pdf content'),
      filename: 'invoice_GSI_2026-27_001.pdf',
    }),
    getInvoicePdfFilename: jest.fn().mockImplementation((inv: any) => {
      const safeInvoiceNum = (inv?.invoice_number || 'INV').replace(/\//g, '_');
      const companyName = inv?.client_details?.company_name || inv?.client?.company_name || inv?.company_name || '';
      if (companyName) {
        const sanitized = String(companyName).trim().replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
        return `invoice_${sanitized}_${safeInvoiceNum}.pdf`;
      }
      return `invoice_${safeInvoiceNum}.pdf`;
    }),
    previewPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 ... mock pdf content')),
    sendEmail: jest.fn(),
  };

  const mockResponse = () => {
    const res: any = {};
    res.setHeader = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    return res;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InvoicesController],
      providers: [
        { provide: InvoicesService, useValue: mockInvoicesService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<InvoicesController>(InvoicesController);
    invoicesService = module.get(InvoicesService);
  });

  describe('downloadPdf', () => {
    it('should generate and stream PDF with correct headers for authorized user', async () => {
      const user = { id: 1, role: { name: 'SUPER_ADMIN' } };
      const res = mockResponse();

      await controller.downloadPdf(17, user, res);

      expect(invoicesService.findOne).toHaveBeenCalledWith(17, user);
      expect(invoicesService.generatePdfStream).toHaveBeenCalledWith(17, user);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="invoice_GSI_2026-27_001.pdf"',
      );
      expect(res.send).toHaveBeenCalledWith(expect.any(Buffer));
    });
  });

  describe('downloadPublicPdf', () => {
    it('should stream PDF without requiring authentication when given valid public token', async () => {
      const res = mockResponse();
      await controller.downloadPublicPdf('17.12345.abc', res);

      expect(invoicesService.generatePdfStreamFromPublicToken).toHaveBeenCalledWith('17.12345.abc');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="invoice_GSI_2026-27_001.pdf"');
      expect(res.send).toHaveBeenCalledWith(expect.any(Buffer));
    });
  });

  describe('previewPdf', () => {
    it('should generate and stream PDF for unsaved invoice form data', async () => {
      const res = mockResponse();
      const body = { invoice_number: 'GSI/2026-27/099', items: [{ description: 'Test', quantity: 1, rate: 100 }] };
      await controller.previewPdf(body, res);

      expect(invoicesService.previewPdf).toHaveBeenCalledWith(body);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'inline; filename="invoice_preview.pdf"');
      expect(res.send).toHaveBeenCalledWith(expect.any(Buffer));
    });
  });

  describe('getSecureLink', () => {
    it('should return absolute secure PDF download URL with signed token', async () => {
      const req = { get: () => 'localhost:3000', protocol: 'http' };
      const result = await controller.getSecureLink(17, req);
      expect(invoicesService.generateSecureLink).toHaveBeenCalledWith(17, req);
      expect(result).toEqual({ secure_pdf_link: 'http://localhost:3000/api/v1/invoices/public/17.12345.abc/download/' });
    });
  });

  describe('update', () => {
    it('should delegate to invoicesService.update when invoked via PUT or PATCH route handler', async () => {
      const user = { id: 1 };
      const body = { notes: 'Updated notes' };
      mockInvoicesService.update.mockResolvedValue({ id: 17, ...body });

      const result = await controller.update(17, user, body);

      expect(invoicesService.update).toHaveBeenCalledWith(17, user, body);
      expect(result).toEqual({ id: 17, notes: 'Updated notes' });
    });
  });
});

