import { Test, TestingModule } from '@nestjs/testing';
import { FinancialReportsService } from './financial-reports.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';

describe('FinancialReportsService', () => {
  let service: FinancialReportsService;

  const mockPrismaService = {
    invoicePayment: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    invoice: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    expense: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    project: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  const mockPdfService = {
    generateInvoicePdf: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FinancialReportsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: PdfService, useValue: mockPdfService },
      ],
    }).compile();

    service = module.get<FinancialReportsService>(FinancialReportsService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should calculate dashboard data cleanly', async () => {
    mockPrismaService.invoicePayment.findMany.mockResolvedValue([
      { amount: 50000, payment_date: new Date() },
    ]);
    mockPrismaService.expense.findMany.mockResolvedValue([
      { amount: 20000, amount_paid: 20000, outstanding_amount: 0, expense_date: new Date() },
    ]);

    const result = await service.getDashboardData({ id: 1 });
    expect(result.summary.customer_collections_this_month).toBe(50000);
    expect(result.summary.expenses_paid_this_month).toBe(20000);
    expect(result.summary.net_cash_flow_this_month).toBe(30000);
  });

  it('7. should calculate project margin report for a single project client', async () => {
    mockPrismaService.project.findMany.mockImplementation(async (args) => {
      return [
        { id: 10, name: 'Project Alpha', client_id: 1, client: { id: 1, name: 'Client A' } },
      ];
    });

    mockPrismaService.invoice.findMany.mockResolvedValue([
      { id: 101, client_id: 1, total: 100000, payments: [{ amount: 60000 }, { amount: 20000 }] },
    ]);

    mockPrismaService.expense.findMany.mockResolvedValue([
      { id: 1, project_id: 10, amount: 30000, amount_paid: 30000, payment_status: 'paid' },
      { id: 2, project_id: 10, amount: 20000, amount_paid: 10000, payment_status: 'partially_paid' },
    ]);

    const result = await service.getProjectMarginReport({});
    expect(result.projects).toHaveLength(1);
    const proj = result.projects[0];
    expect(proj.total_invoiced_amount).toBe(100000);
    expect(proj.actual_collections).toBe(80000);
    expect(proj.linked_expenses_billed).toBe(50000);
    expect(proj.linked_expenses_paid).toBe(40000);
    // Preliminary Margin = Actual Collections (80000) - Paid Linked Expenses (40000) = 40000
    expect(proj.preliminary_margin).toBe(40000);
    expect(proj.margin_percentage).toBe(50);
  });

  it('7b. should isolate invoices per project for a client with multiple projects without duplicate counting', async () => {
    // Client 1 has 2 projects: Alpha (id: 10) and Beta (id: 11)
    mockPrismaService.project.findMany.mockImplementation(async (args) => {
      if (args?.select) {
        return [
          { id: 10, client_id: 1 },
          { id: 11, client_id: 1 },
        ];
      }
      return [
        { id: 10, name: 'Project Alpha', client_id: 1, client: { id: 1, name: 'Client Multi' } },
        { id: 11, name: 'Project Beta', client_id: 1, client: { id: 1, name: 'Client Multi' } },
      ];
    });

    mockPrismaService.invoice.findMany.mockImplementation(async (args) => {
      const projId = args?.where?.expenses?.some?.project_id;
      if (projId === 10) {
        return [{ id: 101, client_id: 1, total: 100000, payments: [{ amount: 80000 }] }];
      } else if (projId === 11) {
        return [{ id: 102, client_id: 1, total: 50000, payments: [{ amount: 50000 }] }];
      }
      return [];
    });

    mockPrismaService.expense.findMany.mockImplementation(async (args) => {
      const projId = args?.where?.project_id;
      if (projId === 10) {
        return [{ id: 1, project_id: 10, amount: 20000, amount_paid: 20000 }];
      } else if (projId === 11) {
        return [{ id: 2, project_id: 11, amount: 10000, amount_paid: 10000 }];
      }
      return [];
    });

    const result = await service.getProjectMarginReport({});
    expect(result.projects).toHaveLength(2);

    const projAlpha = result.projects.find((p) => p.project_id === 10);
    const projBeta = result.projects.find((p) => p.project_id === 11);

    expect(projAlpha?.total_invoiced_amount).toBe(100000);
    expect(projAlpha?.actual_collections).toBe(80000);

    expect(projBeta?.total_invoiced_amount).toBe(50000);
    expect(projBeta?.actual_collections).toBe(50000);

    // Verify Summary has exact totals with ZERO duplicate counting
    expect(result.summary.grand_total_invoiced).toBe(150000);
    expect(result.summary.grand_total_collections).toBe(130000);
    expect(result.summary.grand_total_expenses_paid).toBe(30000);
    expect(result.summary.grand_preliminary_margin).toBe(100000);
  });

  it('8 & 9. should handle paid, partially paid, and unpaid expenses without duplicate counting', async () => {
    mockPrismaService.expense.findMany.mockResolvedValue([
      { id: 1, title: 'Paid AWS', amount: 10000, amount_paid: 10000, payment_account_source: 'company_account', expense_date: new Date('2026-10-01'), category: { name: 'Hosting' } },
      { id: 2, title: 'Partial Rent', amount: 50000, amount_paid: 20000, payment_account_source: 'company_account', expense_date: new Date('2026-10-02'), category: { name: 'Rent' } },
      { id: 3, title: 'Unpaid Vendor', amount: 15000, amount_paid: 0, payment_account_source: 'owner_personal', expense_date: new Date('2026-10-03'), category: { name: 'Professional Fees' } },
    ]);

    const report = await service.getAccountCashFlowReport({ start_date: '2026-10-01', end_date: '2026-10-31' });

    // Paid cash outflow should only count actual paid amounts (10000 + 20000 = 30000)
    expect(report.summary.total_paid_cash_outflow).toBe(30000);
    expect(report.summary.total_billed_expenses).toBe(75000);
    expect(report.summary.total_unpaid_expenses).toBe(45000);
  });

  it('10. should group account-wise cash flow totals correctly', async () => {
    mockPrismaService.expense.findMany.mockResolvedValue([
      { id: 1, title: 'Office Supplies', amount: 2000, amount_paid: 2000, payment_account_source: 'cash_in_hand', expense_date: new Date('2026-10-01') },
      { id: 2, title: 'Software', amount: 8000, amount_paid: 8000, payment_account_source: 'company_account', expense_date: new Date('2026-10-02') },
    ]);

    const report = await service.getAccountCashFlowReport({});
    const cashAcc = report.accounts.find((a) => a.account_source === 'cash_in_hand');
    const compAcc = report.accounts.find((a) => a.account_source === 'company_account');

    expect(cashAcc?.total_paid).toBe(2000);
    expect(compAcc?.total_paid).toBe(8000);
    expect(report.summary.total_paid_cash_outflow).toBe(10000);
  });

  it('should calculate financial year summary for Indian FY (Apr-Mar)', async () => {
    const result = await service.getFinancialYearSummary({ fy: '2026-2027' });
    expect(result.financial_year).toContain('FY 2026-27');
    expect(result.quarterly_breakdown).toHaveLength(4);
  });
});
