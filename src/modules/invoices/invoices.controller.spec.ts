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

  describe('getSecureLink', () => {
    it('should return secure PDF download URL with trailing slash', async () => {
      const result = await controller.getSecureLink(17);
      expect(result).toEqual({ secure_pdf_link: '/api/v1/invoices/17/download/' });
    });
  });
});
