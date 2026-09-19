import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
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

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'INVOICE_LINK_SECRET') return 'test-secret-key';
      if (key === 'API_BASE_URL') return 'http://localhost:3000';
      return null;
    }),
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
        { provide: ConfigService, useValue: mockConfigService },
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

    it('3b. Should include receipt_number in payments mapped by findOne', async () => {
      mockPrismaService.invoice.findUnique.mockResolvedValue({
        id: 33,
        invoice_number: 'GSI/2026-27/033',
        client_id: 1,
        subtotal: 2000,
        tax: 0,
        total: 2000,
        advance: 0,
        due_date: futureDueDate,
        payments: [
          { id: 101, invoice_id: 33, receipt_number: 'RCT/2026-27/001', amount: 500, payment_date: new Date() },
          { id: 102, invoice_id: 33, receipt_number: null, amount: 500, payment_date: new Date() },
        ],
        items: [],
      });

      const result = await service.findOne(33, adminUser);

      expect(result.payments).toHaveLength(2);
      expect(result.payments[0].receipt_number).toBe('RCT/2026-27/001');
      expect(result.payments[1].receipt_number).toBeNull();
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

    it('should create invoice with custom client_address and persist it', async () => {
      const customAddress = '456 Custom Suite, Infopark, Kochi';
      mockPrismaService.client.findUnique.mockResolvedValue({ id: 1, name: 'Client A', address: 'Master Address' });
      mockPrismaService.invoice.create.mockResolvedValue({
        id: 10,
        invoice_number: 'GSI/2026-27/010',
        client_id: 1,
        client_address: customAddress,
        subtotal: 1000,
        tax: 0,
        total: 1000,
        advance: 0,
        due_date: futureDueDate,
      });
      mockPrismaService.invoice.findUnique.mockResolvedValue({
        id: 10,
        invoice_number: 'GSI/2026-27/010',
        client_id: 1,
        client_address: customAddress,
        subtotal: 1000,
        tax: 0,
        total: 1000,
        advance: 0,
        due_date: futureDueDate,
        client: { id: 1, name: 'Client A', address: 'Master Address' },
        items: [],
        payments: [],
      });

      const result = await service.create(adminUser, {
        client: 1,
        client_address: customAddress,
        items: [{ description: 'Dev', quantity: 1, rate: 1000 }],
      });

      expect(mockPrismaService.invoice.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ client_address: customAddress }),
      });
      expect(result.client_address).toBe(customAddress);
    });

    it('should update invoice client_address and return updated address', async () => {
      const updatedAddress = '789 New Billing Address, Bangalore';
      mockPrismaService.invoice.findUnique
        .mockResolvedValueOnce(existingInvoice)
        .mockResolvedValueOnce({
          ...existingInvoice,
          client_address: updatedAddress,
          client: { id: 1, name: 'Client A', address: 'Master Address' },
        });

      mockPrismaService.invoice.update.mockResolvedValue({
        ...existingInvoice,
        client_address: updatedAddress,
      });

      const result = await service.update(1, adminUser, { client_address: updatedAddress });

      expect(mockPrismaService.invoice.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({ client_address: updatedAddress }),
      });
      expect(result.client_address).toBe(updatedAddress);
    });

    it('should fallback to Client.address when invoice.client_address is null or empty', async () => {
      mockPrismaService.invoice.findUnique.mockResolvedValue({
        id: 12,
        invoice_number: 'GSI/2026-27/012',
        client_id: 1,
        client_address: '', // empty invoice-specific address
        client: { id: 1, name: 'Client A', address: 'Master Client Address' },
        subtotal: 1000,
        tax: 0,
        total: 1000,
        payments: [],
        items: [],
      });

      const result = await service.findOne(12, adminUser);

      expect(result.client_address).toBe('Master Client Address');
    });

    it('should create invoice with blank due_date (null) without auto-generating a default date', async () => {
      mockPrismaService.client.findUnique.mockResolvedValue({ id: 1, name: 'Client A' });
      mockPrismaService.invoice.create.mockResolvedValue({
        id: 11,
        invoice_number: 'GSI/2026-27/011',
        client_id: 1,
        issue_date: new Date(),
        due_date: null,
        subtotal: 1000,
        tax: 0,
        total: 1000,
      });
      mockPrismaService.invoice.findUnique.mockResolvedValue({
        id: 11,
        invoice_number: 'GSI/2026-27/011',
        client_id: 1,
        issue_date: new Date(),
        due_date: null,
        subtotal: 1000,
        tax: 0,
        total: 1000,
        client: { id: 1, name: 'Client A' },
        items: [],
        payments: [],
      });

      const result = await service.create(adminUser, {
        client: 1,
        due_date: '',
        items: [{ description: 'Dev', quantity: 1, rate: 1000 }],
      });

      expect(mockPrismaService.invoice.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ due_date: null }),
      });
      expect(result.due_date).toBeNull();
    });

    it('should update invoice to clear due_date to null when passed empty string', async () => {
      mockPrismaService.invoice.findUnique
        .mockResolvedValueOnce(existingInvoice)
        .mockResolvedValueOnce({
          ...existingInvoice,
          due_date: null,
          client: { id: 1, name: 'Client A' },
        });

      mockPrismaService.invoice.update.mockResolvedValue({
        ...existingInvoice,
        due_date: null,
      });

      const result = await service.update(1, adminUser, { due_date: '' });

      expect(mockPrismaService.invoice.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({ due_date: null }),
      });
      expect(result.due_date).toBeNull();
    });
  });

  describe('findAll search logic', () => {
    const mockInvoicesDb = [
      {
        id: 101,
        invoice_number: 'GSI/2026-27/101',
        client_id: 10,
        subtotal: 5000,
        tax: 0,
        total: 5000,
        advance: 5000,
        due_date: futureDueDate,
        payments: [],
        items: [],
        client: { id: 10, name: 'Rahul Sharma', company_name: 'Acme Technologies Pvt Ltd', address: 'Bangalore' },
      },
      {
        id: 102,
        invoice_number: 'GSI/2026-27/102',
        client_id: 20,
        subtotal: 3000,
        tax: 0,
        total: 3000,
        advance: 0,
        due_date: futureDueDate,
        payments: [],
        items: [],
        client: { id: 20, name: 'Priya Patel', company_name: 'Grehasoft Global Solutions', address: 'Kochi' },
      },
      {
        id: 103,
        invoice_number: 'GSI/2026-27/103',
        client_id: 30,
        subtotal: 4000,
        tax: 0,
        total: 4000,
        advance: 1000,
        due_date: futureDueDate,
        payments: [],
        items: [],
        client: { id: 30, name: 'Amit Kumar', company_name: 'Zenith Logistics Services', address: 'Mumbai' },
      },
    ];

    beforeEach(() => {
      mockPrismaService.invoice.findMany.mockImplementation(async ({ where }) => {
        if (!where || !where.OR) return mockInvoicesDb;
        const searchTerms = where.OR.map((cond: any) => {
          if (cond.invoice_number?.contains) return cond.invoice_number.contains.toLowerCase();
          if (cond.client?.name?.contains) return cond.client.name.contains.toLowerCase();
          if (cond.client?.company_name?.contains) return cond.client.company_name.contains.toLowerCase();
          return '';
        }).filter(Boolean);

        const searchStr = searchTerms[0] || '';
        return mockInvoicesDb.filter((inv) => {
          const invNum = inv.invoice_number.toLowerCase();
          const contactName = inv.client.name.toLowerCase();
          const compName = inv.client.company_name.toLowerCase();
          return invNum.includes(searchStr) || contactName.includes(searchStr) || compName.includes(searchStr);
        });
      });
    });

    it('should search invoices by full Company Name', async () => {
      const res: any = await service.findAll(adminUser, { search: 'Acme Technologies Pvt Ltd' });
      expect(res.results).toHaveLength(1);
      expect(res.results[0].invoice_number).toBe('GSI/2026-27/101');
    });

    it('should search invoices by partial Company Name', async () => {
      const res: any = await service.findAll(adminUser, { search: 'Grehasoft' });
      expect(res.results).toHaveLength(1);
      expect(res.results[0].invoice_number).toBe('GSI/2026-27/102');
    });

    it('should search invoices by full Contact Person Name', async () => {
      const res: any = await service.findAll(adminUser, { search: 'Rahul Sharma' });
      expect(res.results).toHaveLength(1);
      expect(res.results[0].invoice_number).toBe('GSI/2026-27/101');
    });

    it('should search invoices by partial Contact Person Name', async () => {
      const res: any = await service.findAll(adminUser, { search: 'Priya' });
      expect(res.results).toHaveLength(1);
      expect(res.results[0].invoice_number).toBe('GSI/2026-27/102');
    });

    it('should support case-insensitive search matching', async () => {
      const res: any = await service.findAll(adminUser, { search: 'zEnItH' });
      expect(res.results).toHaveLength(1);
      expect(res.results[0].invoice_number).toBe('GSI/2026-27/103');
    });

    it('should search invoices by Invoice Number', async () => {
      const res: any = await service.findAll(adminUser, { search: 'GSI/2026-27/102' });
      expect(res.results).toHaveLength(1);
      expect(res.results[0].invoice_number).toBe('GSI/2026-27/102');
    });

    it('should combine search with status filter (e.g. search="Sharma" + status="paid")', async () => {
      const res: any = await service.findAll(adminUser, { search: 'Sharma', status: 'paid' });
      expect(res.results).toHaveLength(1);
      expect(res.results[0].status).toBe('paid');
    });

    it('should support pagination on search results', async () => {
      const res: any = await service.findAll(adminUser, { search: '2026-27', page: '1', limit: '2' });
      expect(res.count).toBe(3);
      expect(res.results).toHaveLength(2);
      expect(res.next).toContain('page=2');
    });
  });

  describe('sendEmail flow', () => {
    const mockInvoice = {
      id: 50,
      invoice_number: 'GSI/2026-27/050',
      client_id: 10,
      client: { id: 10, name: 'Test Client', email: 'test@example.com' },
      items: [],
      payments: [],
    };

    it('should send email successfully when MailerService returns true', async () => {
      mockPrismaService.invoice.findUnique.mockResolvedValue(mockInvoice);
      mockPrismaService.client.findUnique.mockResolvedValue({ id: 10, name: 'Test Client', email: 'test@example.com' });
      mockPdfService.generateInvoicePdf.mockResolvedValue(Buffer.from('PDF Content'));
      mockMailerService.sendMail.mockResolvedValue(true);

      const result = await service.sendEmail(50, adminUser);

      expect(mockMailerService.sendMail).toHaveBeenCalledWith({
        to: 'test@example.com',
        subject: 'Invoice GSI/2026-27/050 from Grehasoft',
        text: expect.stringContaining('Hello Test Client'),
        attachments: expect.any(Array),
      });
      expect(result).toEqual({ message: 'Email sent' });
    });

    it('should throw InternalServerErrorException when MailerService returns false', async () => {
      mockPrismaService.invoice.findUnique.mockResolvedValue(mockInvoice);
      mockPrismaService.client.findUnique.mockResolvedValue({ id: 10, name: 'Test Client', email: 'test@example.com' });
      mockPdfService.generateInvoicePdf.mockResolvedValue(Buffer.from('PDF Content'));
      mockMailerService.sendMail.mockResolvedValue(false);

      await expect(service.sendEmail(50, adminUser)).rejects.toThrow(
        'Failed to send invoice email. Please check server email configuration.',
      );
    });

    it('should throw BadRequestException when client has no email address', async () => {
      mockPrismaService.invoice.findUnique.mockResolvedValue(mockInvoice);
      mockPrismaService.client.findUnique.mockResolvedValue({ id: 10, name: 'No Email Client', email: '' });

      await expect(service.sendEmail(50, adminUser)).rejects.toThrow(
        expect.objectContaining({ response: { error: 'No email found for client' } }),
      );
    });
  });

  describe('InvoiceSigning & Public Secure Links', () => {
    const mockInvoice = {
      id: 77,
      invoice_number: 'GSI/2026-27/077',
      client_id: 1,
      client: { id: 1, name: 'Client A' },
      items: [],
      payments: [],
    };

    it('A. Secure link generation returns an absolute URL with a signed token', async () => {
      mockPrismaService.invoice.findUnique.mockResolvedValue(mockInvoice);
      const req = { get: () => 'pms-api.grehasoft.com', protocol: 'https' };

      const res = await service.generateSecureLink(77, req);

      expect(res.secure_pdf_link).toContain('https://pms-api.grehasoft.com/api/v1/invoices/public/');
      expect(res.secure_pdf_link).toContain('/download/');
      expect(res.secure_pdf_link).toContain('77.');
    });

    it('B. Valid public token generates PDF stream successfully', async () => {
      mockPrismaService.invoice.findUnique.mockResolvedValue(mockInvoice);
      mockPdfService.generateInvoicePdf.mockResolvedValue(Buffer.from('PDF Content'));

      const secureLinkRes = await service.generateSecureLink(77);
      const match = secureLinkRes.secure_pdf_link.match(/public\/(.*?)\/download/);
      const token = decodeURIComponent(match[1]);

      const res = await service.generatePdfStreamFromPublicToken(token);

      expect(res.filename).toBe('invoice_GSI_2026-27_077.pdf');
      expect(res.pdfBuffer).toBeInstanceOf(Buffer);
    });

    it('C. Tampered token is rejected with ForbiddenException', async () => {
      const secureLinkRes = await service.generateSecureLink(77);
      const match = secureLinkRes.secure_pdf_link.match(/public\/(.*?)\/download/);
      let token = decodeURIComponent(match[1]);
      token = token.substring(0, token.length - 4) + 'ffff'; // tamper signature

      await expect(service.generatePdfStreamFromPublicToken(token)).rejects.toThrow(
        'Invalid signature token.',
      );
    });

    it('D. Expired token is rejected with ForbiddenException', async () => {
      const secret = (service as any).getSigningSecret();
      // Generate expired token (-100 seconds)
      const expiredToken = require('./invoices.service').InvoiceSigning.generateToken(77, secret, -100);

      await expect(service.generatePdfStreamFromPublicToken(expiredToken)).rejects.toThrow(
        'This secure link has expired.',
      );
    });

    it('E. Wrong invoice ID in signature is rejected', async () => {
      const secret = (service as any).getSigningSecret();
      const validToken = require('./invoices.service').InvoiceSigning.generateToken(77, secret, 172800);
      const parts = validToken.split('.');
      const tamperedIdToken = `999.${parts[1]}.${parts[2]}`; // Changed ID from 77 to 999 without changing signature

      await expect(service.generatePdfStreamFromPublicToken(tamperedIdToken)).rejects.toThrow(
        'Invalid signature token.',
      );
    });
  });

  describe('getInvoicePdfFilename', () => {
    it('should format filename with sanitized company_name when company_name is present', () => {
      const inv = {
        invoice_number: 'GSI/2026-27/008',
        client_details: { company_name: 'Qwerty' },
      };
      expect(service.getInvoicePdfFilename(inv)).toBe('invoice_Qwerty_GSI_2026-27_008.pdf');
    });

    it('should convert spaces and special characters in company_name to underscores', () => {
      const inv = {
        invoice_number: 'GSI/2026-27/112',
        client_details: { company_name: 'ABC Company' },
      };
      expect(service.getInvoicePdfFilename(inv)).toBe('invoice_ABC_Company_GSI_2026-27_112.pdf');
    });

    it('should truncate company_name to 30 characters maximum', () => {
      const inv = {
        invoice_number: 'GSI/2026-27/115',
        client_details: { company_name: 'Forum Business Center LLC & International Traders' },
      };
      const res = service.getInvoicePdfFilename(inv);
      expect(res).toBe('invoice_Forum_Business_Center_LLC_Inte_GSI_2026-27_115.pdf');
    });

    it('should fall back to invoice_{invoice_number}.pdf if company_name is missing', () => {
      const inv = {
        invoice_number: 'GSI/2026-27/001',
        client_details: { company_name: '' },
      };
      expect(service.getInvoicePdfFilename(inv)).toBe('invoice_GSI_2026-27_001.pdf');
    });
  });

  describe('previewPdf for unsaved invoices', () => {
    it('1. should generate PDF buffer for single item invoice without database persistence', async () => {
      mockPrismaService.client.findUnique.mockResolvedValue({ id: 1, name: 'Client Preview', address: 'Master Addr' });
      mockPdfService.generateInvoicePdf.mockResolvedValue(Buffer.from('%PDF-1.4 Mock Preview'));

      const body = {
        invoice_number: 'GSI/2026-27/PREVIEW-1',
        client: 1,
        issue_date: '2026-09-14',
        due_date: '2026-09-28',
        items: [{ description: 'Web Design', quantity: 1, rate: 5000 }],
        tax: 900,
        advance: 1000,
      };

      const pdfBuffer = await service.previewPdf(body);

      expect(mockPdfService.generateInvoicePdf).toHaveBeenCalledWith(
        expect.objectContaining({
          invoice_number: 'GSI/2026-27/PREVIEW-1',
          subtotal: 5000,
          tax: 900,
          total: 5900,
          advance: 1000,
          balance: 4900,
          client: expect.objectContaining({ name: 'Client Preview' }),
          items: [expect.objectContaining({ description: 'Web Design', quantity: 1, rate: 5000, amount: 5000 })],
        }),
      );
      expect(pdfBuffer).toBeInstanceOf(Buffer);
      expect(mockPrismaService.invoice.create).not.toHaveBeenCalled();
    });

    it('2. should handle multiple items, discount, advance, and blank due_date without persisting', async () => {
      mockPrismaService.client.findUnique.mockResolvedValue({ id: 2, name: 'Client Multi' });
      mockPdfService.generateInvoicePdf.mockResolvedValue(Buffer.from('%PDF-1.4 Mock Multi Preview'));

      const body = {
        invoice_number: 'GSI/2026-27/PREVIEW-2',
        client: 2,
        client_address: 'Custom Invoice Address',
        issue_date: '2026-09-14',
        due_date: '',
        items: [
          { description: 'Item 1', quantity: 2, rate: 1000 },
          { description: 'Item 2', quantity: 1, rate: 3000 },
        ],
        tax: 900,
        discount: 500,
        advance: 2000,
        notes: 'Preview notes',
      };

      const pdfBuffer = await service.previewPdf(body);

      expect(mockPdfService.generateInvoicePdf).toHaveBeenCalledWith(
        expect.objectContaining({
          invoice_number: 'GSI/2026-27/PREVIEW-2',
          due_date: null,
          subtotal: 5000,
          tax: 900,
          total: 5400, // 5000 + 900 - 500
          advance: 2000,
          balance: 3400,
          notes: 'Preview notes',
          client: expect.objectContaining({ address: 'Custom Invoice Address' }),
          items: expect.arrayContaining([
            expect.objectContaining({ description: 'Item 1', amount: 2000 }),
            expect.objectContaining({ description: 'Item 2', amount: 3000 }),
          ]),
        }),
      );
      expect(pdfBuffer).toBeInstanceOf(Buffer);
      expect(mockPrismaService.invoice.create).not.toHaveBeenCalled();
    });
  });

  describe('remove invoice logic', () => {
    it('1. should delete an UNPAID invoice successfully for authorized admin', async () => {
      const unpaidInvoice = { id: 201, invoice_number: 'GSI/2026-27/201', client_id: 1, status: 'unpaid' };
      mockPrismaService.invoice.findUnique.mockResolvedValue(unpaidInvoice);
      mockPrismaService.invoice.delete.mockResolvedValue(unpaidInvoice);

      const result = await service.remove(201, adminUser);

      expect(mockPrismaService.invoice.findUnique).toHaveBeenCalledWith({ where: { id: 201 } });
      expect(mockPrismaService.invoice.delete).toHaveBeenCalledWith({ where: { id: 201 } });
      expect(result).toBeNull();
    });

    it('2. should delete a PARTIAL invoice with payments for authorized admin', async () => {
      const partialInvoice = { id: 202, invoice_number: 'GSI/2026-27/202', client_id: 1, status: 'partial' };
      mockPrismaService.invoice.findUnique.mockResolvedValue(partialInvoice);
      mockPrismaService.invoice.delete.mockResolvedValue(partialInvoice);

      const result = await service.remove(202, adminUser);

      expect(mockPrismaService.invoice.delete).toHaveBeenCalledWith({ where: { id: 202 } });
      expect(result).toBeNull();
    });

    it('3. should delete a PAID invoice with payment records for authorized admin', async () => {
      const paidInvoice = { id: 203, invoice_number: 'GSI/2026-27/203', client_id: 1, status: 'paid' };
      mockPrismaService.invoice.findUnique.mockResolvedValue(paidInvoice);
      mockPrismaService.invoice.delete.mockResolvedValue(paidInvoice);

      const result = await service.remove(203, adminUser);

      expect(mockPrismaService.invoice.delete).toHaveBeenCalledWith({ where: { id: 203 } });
      expect(result).toBeNull();
    });

    it('4. should throw ForbiddenException if CLIENT role attempts to delete an invoice', async () => {
      const clientUser = { id: 99, role: { name: 'CLIENT' } };

      await expect(service.remove(201, clientUser)).rejects.toThrow(
        'Clients do not have permission to modify invoices.',
      );
      expect(mockPrismaService.invoice.delete).not.toHaveBeenCalled();
    });

    it('5. should throw NotFoundException if invoice to delete does not exist', async () => {
      mockPrismaService.invoice.findUnique.mockResolvedValue(null);

      await expect(service.remove(999, adminUser)).rejects.toThrow('Invoice not found');
      expect(mockPrismaService.invoice.delete).not.toHaveBeenCalled();
    });
  });
});



