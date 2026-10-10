import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';

@Injectable()
export class FinancialReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
  ) {}

  // Helper to format date range for Indian FY (April 1 to March 31)
  private getFinancialYearDates(fyString?: string) {
    let startYear: number;

    if (fyString && /^\d{4}-\d{2,4}$/.test(fyString)) {
      startYear = parseInt(fyString.split('-')[0], 10);
    } else {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1; // 1-12
      startYear = month >= 4 ? year : year - 1;
    }

    const startDate = new Date(Date.UTC(startYear, 3, 1, 0, 0, 0, 0)); // April 1
    const endDate = new Date(Date.UTC(startYear + 1, 2, 31, 23, 59, 59, 999)); // March 31
    const label = `FY ${startYear}-${String(startYear + 1).slice(-2)}`;

    return { startDate, endDate, startYear, endYear: startYear + 1, label };
  }

  // -------------------------------------------------------------
  // 1. FINANCIAL DASHBOARD
  // -------------------------------------------------------------
  async getDashboardData(user: any) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-11

    const startOfCurrentMonth = new Date(Date.UTC(currentYear, currentMonth, 1, 0, 0, 0, 0));
    const endOfCurrentMonth = new Date(Date.UTC(currentYear, currentMonth + 1, 0, 23, 59, 59, 999));

    const startOfLastMonth = new Date(Date.UTC(currentYear, currentMonth - 1, 1, 0, 0, 0, 0));
    const endOfLastMonth = new Date(Date.UTC(currentYear, currentMonth, 0, 23, 59, 59, 999));

    // Revenue / Collections from InvoicePayment (source of truth)
    const currentMonthPayments = await this.prisma.invoicePayment.findMany({
      where: {
        payment_date: { gte: startOfCurrentMonth, lte: endOfCurrentMonth },
      },
    });
    const currentMonthCollections = currentMonthPayments.reduce(
      (sum, p) => sum + Number(p.amount || 0),
      0,
    );

    const lastMonthPayments = await this.prisma.invoicePayment.findMany({
      where: {
        payment_date: { gte: startOfLastMonth, lte: endOfLastMonth },
      },
    });
    const lastMonthCollections = lastMonthPayments.reduce(
      (sum, p) => sum + Number(p.amount || 0),
      0,
    );

    // Outstanding customer payments from Invoice table
    const allInvoices = await this.prisma.invoice.findMany({
      include: { payments: true },
    });

    let totalOutstandingRevenue = 0;
    for (const inv of allInvoices) {
      const total = Number(inv.total || 0);
      const advance = Number(inv.advance || 0);
      const paymentsSum = inv.payments.reduce((acc, p) => acc + Number(p.amount || 0), 0);
      const paid = advance + paymentsSum;
      const balance = Math.max(0, total - paid);
      totalOutstandingRevenue += balance;
    }

    // Expenses Paid & Pending
    const currentMonthExpenses = await this.prisma.expense.findMany({
      where: {
        deleted_at: null,
        expense_date: { gte: startOfCurrentMonth, lte: endOfCurrentMonth },
      },
    });
    const currentMonthExpensesPaid = currentMonthExpenses.reduce(
      (sum, e) => sum + Number(e.amount_paid || 0),
      0,
    );

    const lastMonthExpenses = await this.prisma.expense.findMany({
      where: {
        deleted_at: null,
        expense_date: { gte: startOfLastMonth, lte: endOfLastMonth },
      },
    });
    const lastMonthExpensesPaid = lastMonthExpenses.reduce(
      (sum, e) => sum + Number(e.amount_paid || 0),
      0,
    );

    // All active pending expenses
    const pendingExpensesList = await this.prisma.expense.findMany({
      where: {
        deleted_at: null,
        payment_status: { in: ['pending', 'partially_paid'] },
      },
    });
    const totalPendingExpenses = pendingExpensesList.reduce(
      (sum, e) => sum + Number(e.outstanding_amount || Math.max(0, Number(e.amount) - Number(e.amount_paid))),
      0,
    );

    // Net Cash Flow
    const currentMonthNetCashFlow = currentMonthCollections - currentMonthExpensesPaid;
    const lastMonthNetCashFlow = lastMonthCollections - lastMonthExpensesPaid;

    // Monthly trends (Last 6 Months)
    const monthlyTrends: any[] = [];
    for (let i = 5; i >= 0; i--) {
      const mDate = new Date(Date.UTC(currentYear, currentMonth - i, 1));
      const mYear = mDate.getUTCFullYear();
      const mMonth = mDate.getUTCMonth();
      const mStart = new Date(Date.UTC(mYear, mMonth, 1, 0, 0, 0, 0));
      const mEnd = new Date(Date.UTC(mYear, mMonth + 1, 0, 23, 59, 59, 999));
      const monthLabel = mDate.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

      const mPayments = await this.prisma.invoicePayment.findMany({
        where: { payment_date: { gte: mStart, lte: mEnd } },
      });
      const collections = mPayments.reduce((acc, p) => acc + Number(p.amount || 0), 0);

      const mExpenses = await this.prisma.expense.findMany({
        where: { deleted_at: null, expense_date: { gte: mStart, lte: mEnd } },
      });
      const expensesPaid = mExpenses.reduce((acc, e) => acc + Number(e.amount_paid || 0), 0);
      const cashFlow = collections - expensesPaid;

      monthlyTrends.push({
        month: monthLabel,
        collections: Math.round(collections * 100) / 100,
        expenses: Math.round(expensesPaid * 100) / 100,
        net_cash_flow: Math.round(cashFlow * 100) / 100,
      });
    }

    // Category distribution for current month
    const categoryExpensesMap = new Map<string, number>();
    const currentExpensesDetailed = await this.prisma.expense.findMany({
      where: { deleted_at: null, expense_date: { gte: startOfCurrentMonth, lte: endOfCurrentMonth } },
      include: { category: true },
    });
    for (const exp of currentExpensesDetailed) {
      const catName = exp.category?.name || 'Miscellaneous';
      const prev = categoryExpensesMap.get(catName) || 0;
      categoryExpensesMap.set(catName, prev + Number(exp.amount_paid || 0));
    }

    const categoryBreakdown = Array.from(categoryExpensesMap.entries()).map(([name, amount]) => ({
      category_name: name,
      amount: Math.round(amount * 100) / 100,
    })).sort((a, b) => b.amount - a.amount);

    return {
      summary: {
        customer_collections_this_month: Math.round(currentMonthCollections * 100) / 100,
        customer_collections_last_month: Math.round(lastMonthCollections * 100) / 100,
        total_outstanding_collections: Math.round(totalOutstandingRevenue * 100) / 100,
        expenses_paid_this_month: Math.round(currentMonthExpensesPaid * 100) / 100,
        expenses_paid_last_month: Math.round(lastMonthExpensesPaid * 100) / 100,
        total_pending_expenses: Math.round(totalPendingExpenses * 100) / 100,
        net_cash_flow_this_month: Math.round(currentMonthNetCashFlow * 100) / 100,
        net_cash_flow_last_month: Math.round(lastMonthNetCashFlow * 100) / 100,
      },
      visualizations: {
        monthly_trends: monthlyTrends,
        category_breakdown: categoryBreakdown,
      },
    };
  }

  // -------------------------------------------------------------
  // 2. MONTHLY INCOME & EXPENSE STATEMENT
  // -------------------------------------------------------------
  async getIncomeExpenseStatement(query: { start_date?: string; end_date?: string }) {
    const now = new Date();
    const startDate = query.start_date
      ? new Date(`${query.start_date}T00:00:00.000Z`)
      : new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0));
    const endDate = query.end_date
      ? new Date(`${query.end_date}T23:59:59.999Z`)
      : new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999));

    const payments = await this.prisma.invoicePayment.findMany({
      where: { payment_date: { gte: startDate, lte: endDate } },
      include: { invoice: { include: { client: true } } },
      orderBy: { payment_date: 'desc' },
    });

    const collections = payments.map((p) => ({
      id: p.id,
      receipt_number: p.receipt_number || `REC-${p.id}`,
      date: p.payment_date.toISOString().split('T')[0],
      client_name: p.invoice?.client?.name || 'Client',
      invoice_number: p.invoice?.invoice_number || 'INV',
      payment_mode: p.payment_mode,
      amount: Number(p.amount),
    }));

    const totalCollections = collections.reduce((acc, c) => acc + c.amount, 0);

    const expenses = await this.prisma.expense.findMany({
      where: { deleted_at: null, expense_date: { gte: startDate, lte: endDate } },
      include: { category: true },
      orderBy: { expense_date: 'desc' },
    });

    const formattedExpenses = expenses.map((e) => ({
      id: e.id,
      title: e.title,
      date: e.expense_date.toISOString().split('T')[0],
      category_name: e.category?.name || 'Uncategorized',
      vendor: e.vendor || '',
      payment_method: e.payment_method,
      amount: Number(e.amount),
      amount_paid: Number(e.amount_paid),
      outstanding_amount: Number(e.outstanding_amount),
    }));

    const totalExpensesPaid = formattedExpenses.reduce((acc, e) => acc + e.amount_paid, 0);
    const totalExpensesBilled = formattedExpenses.reduce((acc, e) => acc + e.amount, 0);
    const netCashFlow = totalCollections - totalExpensesPaid;

    return {
      period: {
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
      },
      collections,
      expenses: formattedExpenses,
      summary: {
        total_collections: Math.round(totalCollections * 100) / 100,
        total_expenses_billed: Math.round(totalExpensesBilled * 100) / 100,
        total_expenses_paid: Math.round(totalExpensesPaid * 100) / 100,
        net_cash_flow: Math.round(netCashFlow * 100) / 100,
      },
      disclaimer: 'This is a cash-flow collection & business expense statement. It is not an audited statutory Profit and Loss Statement.',
    };
  }

  // -------------------------------------------------------------
  // 3. MONTH-OVER-MONTH COMPARISON REPORT
  // -------------------------------------------------------------
  async getMonthComparisonReport(query: { month1?: string; month2?: string }) {
    const now = new Date();
    const currYear = now.getFullYear();
    const currMonthStr = `${currYear}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    let prevDate = new Date(Date.UTC(currYear, now.getMonth() - 1, 1));
    const prevMonthStr = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, '0')}`;

    const m1 = query.month1 || prevMonthStr;
    const m2 = query.month2 || currMonthStr;

    const getMonthData = async (mStr: string) => {
      const [year, month] = mStr.split('-').map(Number);
      const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
      const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

      const payments = await this.prisma.invoicePayment.findMany({
        where: { payment_date: { gte: start, lte: end } },
      });
      const collections = payments.reduce((acc, p) => acc + Number(p.amount || 0), 0);

      const expenses = await this.prisma.expense.findMany({
        where: { deleted_at: null, expense_date: { gte: start, lte: end } },
      });
      const expensesPaid = expenses.reduce((acc, e) => acc + Number(e.amount_paid || 0), 0);
      const expensesTotal = expenses.reduce((acc, e) => acc + Number(e.amount || 0), 0);
      const cashFlow = collections - expensesPaid;

      return {
        month: mStr,
        collections: Math.round(collections * 100) / 100,
        expenses_paid: Math.round(expensesPaid * 100) / 100,
        expenses_total: Math.round(expensesTotal * 100) / 100,
        net_cash_flow: Math.round(cashFlow * 100) / 100,
        expense_count: expenses.length,
      };
    };

    const data1 = await getMonthData(m1);
    const data2 = await getMonthData(m2);

    const collectionsDiff = data2.collections - data1.collections;
    const expensesDiff = data2.expenses_paid - data1.expenses_paid;
    const cashFlowDiff = data2.net_cash_flow - data1.net_cash_flow;

    return {
      month1: data1,
      month2: data2,
      changes: {
        collections_diff: Math.round(collectionsDiff * 100) / 100,
        collections_percentage: data1.collections > 0 ? Math.round((collectionsDiff / data1.collections) * 1000) / 10 : 0,
        expenses_diff: Math.round(expensesDiff * 100) / 100,
        expenses_percentage: data1.expenses_paid > 0 ? Math.round((expensesDiff / data1.expenses_paid) * 1000) / 10 : 0,
        cash_flow_diff: Math.round(cashFlowDiff * 100) / 100,
      },
    };
  }

  // -------------------------------------------------------------
  // 4. CATEGORY-WISE EXPENSE REPORT
  // -------------------------------------------------------------
  async getCategoryExpenseReport(query: { start_date?: string; end_date?: string }) {
    const now = new Date();
    const startDate = query.start_date
      ? new Date(`${query.start_date}T00:00:00.000Z`)
      : new Date(Date.UTC(now.getFullYear(), 0, 1, 0, 0, 0, 0));
    const endDate = query.end_date
      ? new Date(`${query.end_date}T23:59:59.999Z`)
      : new Date(Date.UTC(now.getFullYear(), 11, 31, 23, 59, 59, 999));

    const expenses = await this.prisma.expense.findMany({
      where: { deleted_at: null, expense_date: { gte: startDate, lte: endDate } },
      include: { category: true },
    });

    const categoryMap = new Map<number, { id: number; name: string; total_billed: number; total_paid: number; pending: number; count: number }>();

    let grandBilled = 0;
    let grandPaid = 0;

    for (const exp of expenses) {
      const catId = exp.category_id;
      const catName = exp.category?.name || 'Uncategorized';
      const billed = Number(exp.amount || 0);
      const paid = Number(exp.amount_paid || 0);
      const pending = Math.max(0, billed - paid);

      grandBilled += billed;
      grandPaid += paid;

      const existing = categoryMap.get(catId) || { id: catId, name: catName, total_billed: 0, total_paid: 0, pending: 0, count: 0 };
      existing.total_billed += billed;
      existing.total_paid += paid;
      existing.pending += pending;
      existing.count += 1;
      categoryMap.set(catId, existing);
    }

    const categories = Array.from(categoryMap.values()).map((c) => ({
      ...c,
      total_billed: Math.round(c.total_billed * 100) / 100,
      total_paid: Math.round(c.total_paid * 100) / 100,
      pending: Math.round(c.pending * 100) / 100,
      percentage_of_paid: grandPaid > 0 ? Math.round((c.total_paid / grandPaid) * 1000) / 10 : 0,
    })).sort((a, b) => b.total_paid - a.total_paid);

    return {
      period: {
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
      },
      categories,
      grand_totals: {
        total_billed: Math.round(grandBilled * 100) / 100,
        total_paid: Math.round(grandPaid * 100) / 100,
        total_pending: Math.round((grandBilled - grandPaid) * 100) / 100,
      },
    };
  }

  // -------------------------------------------------------------
  // 5. EXPENSE LEDGER WITH RECEIPTS
  // -------------------------------------------------------------
  async getExpenseLedger(query: { start_date?: string; end_date?: string; category?: string; payment_status?: string }) {
    const now = new Date();
    const startDate = query.start_date
      ? new Date(`${query.start_date}T00:00:00.000Z`)
      : new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0));
    const endDate = query.end_date
      ? new Date(`${query.end_date}T23:59:59.999Z`)
      : new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999));

    const where: any = {
      deleted_at: null,
      expense_date: { gte: startDate, lte: endDate },
    };

    if (query.category) where.category_id = Number(query.category);
    if (query.payment_status && query.payment_status !== 'all') where.payment_status = query.payment_status as any;

    const expenses = await this.prisma.expense.findMany({
      where,
      include: {
        category: true,
        created_by: true,
        employee: { include: { user: true } },
      },
      orderBy: { expense_date: 'asc' },
    });

    let runningPaidBalance = 0;
    let runningBilledBalance = 0;

    const ledgerEntries = expenses.map((e) => {
      const billed = Number(e.amount);
      const paid = Number(e.amount_paid);
      runningBilledBalance += billed;
      runningPaidBalance += paid;

      return {
        id: e.id,
        date: e.expense_date.toISOString().split('T')[0],
        title: e.title,
        category: e.category?.name || 'Uncategorized',
        vendor: e.vendor || '',
        reference_number: e.reference_number || '',
        payment_method: e.payment_method,
        payment_status: e.payment_status,
        billed_amount: billed,
        paid_amount: paid,
        outstanding_amount: Number(e.outstanding_amount),
        receipt_file: e.receipt_file || null,
        has_receipt: !!e.receipt_file,
        created_by: e.created_by?.name || 'System',
        running_paid_total: Math.round(runningPaidBalance * 100) / 100,
      };
    });

    return {
      period: {
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
      },
      entries: ledgerEntries,
      summary: {
        total_entries: ledgerEntries.length,
        total_billed: Math.round(runningBilledBalance * 100) / 100,
        total_paid: Math.round(runningPaidBalance * 100) / 100,
        total_outstanding: Math.round((runningBilledBalance - runningPaidBalance) * 100) / 100,
      },
    };
  }

  // -------------------------------------------------------------
  // 6. FINANCIAL YEAR SUMMARY (April 1 to March 31)
  // -------------------------------------------------------------
  async getFinancialYearSummary(query: { fy?: string }) {
    const fyInfo = this.getFinancialYearDates(query.fy);
    const { startDate, endDate, label, startYear, endYear } = fyInfo;

    const payments = await this.prisma.invoicePayment.findMany({
      where: { payment_date: { gte: startDate, lte: endDate } },
    });

    const expenses = await this.prisma.expense.findMany({
      where: { deleted_at: null, expense_date: { gte: startDate, lte: endDate } },
      include: { category: true },
    });

    // Quarterly breakdown for the FY
    const quarters = [
      { name: 'Q1 (Apr-Jun)', start: new Date(Date.UTC(startYear, 3, 1, 0, 0, 0, 0)), end: new Date(Date.UTC(startYear, 5, 30, 23, 59, 59, 999)) },
      { name: 'Q2 (Jul-Sep)', start: new Date(Date.UTC(startYear, 6, 1, 0, 0, 0, 0)), end: new Date(Date.UTC(startYear, 8, 30, 23, 59, 59, 999)) },
      { name: 'Q3 (Oct-Dec)', start: new Date(Date.UTC(startYear, 9, 1, 0, 0, 0, 0)), end: new Date(Date.UTC(startYear, 11, 31, 23, 59, 59, 999)) },
      { name: 'Q4 (Jan-Mar)', start: new Date(Date.UTC(endYear, 0, 1, 0, 0, 0, 0)), end: new Date(Date.UTC(endYear, 2, 31, 23, 59, 59, 999)) },
    ];

    const quarterlyData = [];
    for (const q of quarters) {
      const qPayments = payments.filter((p) => p.payment_date >= q.start && p.payment_date <= q.end);
      const qCollections = qPayments.reduce((acc, p) => acc + Number(p.amount || 0), 0);

      const qExpenses = expenses.filter((e) => e.expense_date >= q.start && e.expense_date <= q.end);
      const qExpensesPaid = qExpenses.reduce((acc, e) => acc + Number(e.amount_paid || 0), 0);

      quarterlyData.push({
        quarter: q.name,
        collections: Math.round(qCollections * 100) / 100,
        expenses_paid: Math.round(qExpensesPaid * 100) / 100,
        net_cash_flow: Math.round((qCollections - qExpensesPaid) * 100) / 100,
      });
    }

    const totalCollections = payments.reduce((acc, p) => acc + Number(p.amount || 0), 0);
    const totalExpensesPaid = expenses.reduce((acc, e) => acc + Number(e.amount_paid || 0), 0);
    const totalExpensesBilled = expenses.reduce((acc, e) => acc + Number(e.amount || 0), 0);

    return {
      financial_year: label,
      period: {
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
      },
      summary: {
        total_collections: Math.round(totalCollections * 100) / 100,
        total_expenses_billed: Math.round(totalExpensesBilled * 100) / 100,
        total_expenses_paid: Math.round(totalExpensesPaid * 100) / 100,
        total_pending_expenses: Math.round((totalExpensesBilled - totalExpensesPaid) * 100) / 100,
        net_cash_flow: Math.round((totalCollections - totalExpensesPaid) * 100) / 100,
      },
      quarterly_breakdown: quarterlyData,
      disclaimer: 'Financial Year Summary uses the Indian Fiscal Calendar (April 1 to March 31). This summary displays cash flow collections and expenses, not an audited P&L statement.',
    };
  }

  // -------------------------------------------------------------
  // 7. PRELIMINARY PROJECT MARGIN REPORT
  // -------------------------------------------------------------
  async getProjectMarginReport(query: { start_date?: string; end_date?: string; project_id?: string; client_id?: string }) {
    const whereProject: any = { deleted_at: null };
    if (query.project_id) {
      whereProject.id = Number(query.project_id);
    }
    if (query.client_id) {
      whereProject.client_id = Number(query.client_id);
    }

    const projects = await this.prisma.project.findMany({
      where: whereProject,
      include: {
        client: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
    });

    // Count active projects per client to prevent duplicate invoice attribution for multi-project clients
    const allActiveProjects = await this.prisma.project.findMany({
      where: { deleted_at: null },
      select: { id: true, client_id: true },
    });
    const clientProjectCountMap = new Map<number, number>();
    for (const p of allActiveProjects) {
      if (p.client_id) {
        clientProjectCountMap.set(p.client_id, (clientProjectCountMap.get(p.client_id) || 0) + 1);
      }
    }

    let startDateFilter: Date | null = null;
    let endDateFilter: Date | null = null;
    if (query.start_date) startDateFilter = new Date(`${query.start_date}T00:00:00.000Z`);
    if (query.end_date) endDateFilter = new Date(`${query.end_date}T23:59:59.999Z`);

    const reportRows = [];
    const processedInvoiceMap = new Map<number, { total: number; collections: number }>();
    const processedExpenseMap = new Map<number, { amount: number; amount_paid: number }>();

    for (const proj of projects) {
      const clientHasSingleProject = proj.client_id ? clientProjectCountMap.get(proj.client_id) === 1 : false;

      // Safe association strategy:
      // If a client has only 1 project, attribute invoices by client_id OR linked expenses.
      // If a client has multiple projects, attribute invoices ONLY if an expense is explicitly linked to this project.
      const invoiceWhere: any = clientHasSingleProject && proj.client_id
        ? {
            OR: [
              { client_id: proj.client_id },
              { expenses: { some: { project_id: proj.id } } },
            ],
          }
        : { expenses: { some: { project_id: proj.id } } };

      if (startDateFilter || endDateFilter) {
        invoiceWhere.issue_date = {};
        if (startDateFilter) invoiceWhere.issue_date.gte = startDateFilter;
        if (endDateFilter) invoiceWhere.issue_date.lte = endDateFilter;
      }

      const invoices = await this.prisma.invoice.findMany({
        where: invoiceWhere,
        include: {
          payments: startDateFilter || endDateFilter ? {
            where: {
              payment_date: {
                ...(startDateFilter ? { gte: startDateFilter } : {}),
                ...(endDateFilter ? { lte: endDateFilter } : {}),
              },
            },
          } : true,
        },
      });

      const totalInvoiced = invoices.reduce((sum, inv) => sum + Number(inv.total || 0), 0);
      const actualCollections = invoices.reduce((sum, inv) => {
        const invPayments = inv.payments.reduce((pSum, p) => pSum + Number(p.amount || 0), 0);
        return sum + invPayments;
      }, 0);

      // Store unique invoices to prevent duplicate counting in summary
      for (const inv of invoices) {
        const invPayments = inv.payments.reduce((pSum, p) => pSum + Number(p.amount || 0), 0);
        processedInvoiceMap.set(inv.id, {
          total: Number(inv.total || 0),
          collections: invPayments,
        });
      }

      // Find expenses linked to this project
      const expenseWhere: any = {
        project_id: proj.id,
        deleted_at: null,
      };
      if (startDateFilter || endDateFilter) {
        expenseWhere.expense_date = {};
        if (startDateFilter) expenseWhere.expense_date.gte = startDateFilter;
        if (endDateFilter) expenseWhere.expense_date.lte = endDateFilter;
      }

      const projectExpenses = await this.prisma.expense.findMany({
        where: expenseWhere,
      });

      const linkedExpensesBilled = projectExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
      const linkedExpensesPaid = projectExpenses.reduce((sum, e) => sum + Number(e.amount_paid || 0), 0);

      for (const exp of projectExpenses) {
        processedExpenseMap.set(exp.id, {
          amount: Number(exp.amount || 0),
          amount_paid: Number(exp.amount_paid || 0),
        });
      }

      const preliminaryMargin = actualCollections - linkedExpensesPaid;
      const marginPercentage = actualCollections > 0 ? (preliminaryMargin / actualCollections) * 100 : 0;

      reportRows.push({
        project_id: proj.id,
        project_name: proj.name,
        client_id: proj.client_id,
        client_name: proj.client?.name || 'Unassigned',
        invoice_count: invoices.length,
        total_invoiced_amount: Math.round(totalInvoiced * 100) / 100,
        actual_collections: Math.round(actualCollections * 100) / 100,
        expense_count: projectExpenses.length,
        linked_expenses_billed: Math.round(linkedExpensesBilled * 100) / 100,
        linked_expenses_paid: Math.round(linkedExpensesPaid * 100) / 100,
        preliminary_margin: Math.round(preliminaryMargin * 100) / 100,
        margin_percentage: Math.round(marginPercentage * 10) / 10,
      });
    }

    let grandTotalInvoiced = 0;
    let grandTotalCollections = 0;
    for (const invData of processedInvoiceMap.values()) {
      grandTotalInvoiced += invData.total;
      grandTotalCollections += invData.collections;
    }

    let grandTotalExpensesBilled = 0;
    let grandTotalExpensesPaid = 0;
    for (const expData of processedExpenseMap.values()) {
      grandTotalExpensesBilled += expData.amount;
      grandTotalExpensesPaid += expData.amount_paid;
    }

    const grandPreliminaryMargin = grandTotalCollections - grandTotalExpensesPaid;

    return {
      period: {
        start_date: query.start_date || null,
        end_date: query.end_date || null,
      },
      projects: reportRows,
      summary: {
        total_projects: reportRows.length,
        grand_total_invoiced: Math.round(grandTotalInvoiced * 100) / 100,
        grand_total_collections: Math.round(grandTotalCollections * 100) / 100,
        grand_total_expenses_billed: Math.round(grandTotalExpensesBilled * 100) / 100,
        grand_total_expenses_paid: Math.round(grandTotalExpensesPaid * 100) / 100,
        grand_preliminary_margin: Math.round(grandPreliminaryMargin * 100) / 100,
      },
      disclaimer: 'Preliminary Project Margin is calculated as (Actual Customer Collections - Actual Paid Linked Project Expenses). For clients with multiple active projects, invoices without direct project links are excluded from individual project margins to prevent duplicate revenue attribution across projects.',
    };
  }

  // -------------------------------------------------------------
  // 8. ACCOUNT-WISE CASH FLOW REPORT
  // -------------------------------------------------------------
  async getAccountCashFlowReport(query: { start_date?: string; end_date?: string }) {
    const now = new Date();
    const startDate = query.start_date
      ? new Date(`${query.start_date}T00:00:00.000Z`)
      : new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0));
    const endDate = query.end_date
      ? new Date(`${query.end_date}T23:59:59.999Z`)
      : new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999));

    const expenses = await this.prisma.expense.findMany({
      where: {
        deleted_at: null,
        expense_date: { gte: startDate, lte: endDate },
      },
      include: {
        category: true,
        client: { select: { name: true } },
        project: { select: { name: true } },
      },
      orderBy: { expense_date: 'desc' },
    });

    const accountLabels: Record<string, string> = {
      company_account: 'Company Current Account',
      owner_personal: "Owner's Personal Account",
      cash_in_hand: 'Cash in Hand',
      other: 'Other Account / Source',
      unspecified: 'Unspecified / Legacy',
    };

    const accountGroups: Record<string, {
      account_source: string;
      account_label: string;
      paid_transaction_count: number;
      total_paid: number;
      total_billed: number;
      total_unpaid: number;
      transactions: any[];
    }> = {
      company_account: { account_source: 'company_account', account_label: accountLabels.company_account, paid_transaction_count: 0, total_paid: 0, total_billed: 0, total_unpaid: 0, transactions: [] },
      owner_personal: { account_source: 'owner_personal', account_label: accountLabels.owner_personal, paid_transaction_count: 0, total_paid: 0, total_billed: 0, total_unpaid: 0, transactions: [] },
      cash_in_hand: { account_source: 'cash_in_hand', account_label: accountLabels.cash_in_hand, paid_transaction_count: 0, total_paid: 0, total_billed: 0, total_unpaid: 0, transactions: [] },
      other: { account_source: 'other', account_label: accountLabels.other, paid_transaction_count: 0, total_paid: 0, total_billed: 0, total_unpaid: 0, transactions: [] },
      unspecified: { account_source: 'unspecified', account_label: accountLabels.unspecified, paid_transaction_count: 0, total_paid: 0, total_billed: 0, total_unpaid: 0, transactions: [] },
    };

    let totalPaidOutflow = 0;
    let totalBilledExpenses = 0;
    let totalUnpaidExpenses = 0;

    for (const exp of expenses) {
      const sourceKey = exp.payment_account_source && accountGroups[exp.payment_account_source]
        ? exp.payment_account_source
        : 'unspecified';

      const billed = Number(exp.amount || 0);
      const paid = Number(exp.amount_paid || 0);
      const unpaid = Math.max(0, billed - paid);

      const grp = accountGroups[sourceKey];
      if (paid > 0) {
        grp.paid_transaction_count += 1;
      }
      grp.total_paid += paid;
      grp.total_billed += billed;
      grp.total_unpaid += unpaid;

      totalPaidOutflow += paid;
      totalBilledExpenses += billed;
      totalUnpaidExpenses += unpaid;

      grp.transactions.push({
        id: exp.id,
        title: exp.title,
        expense_date: exp.expense_date.toISOString().split('T')[0],
        category_name: exp.category?.name || 'Uncategorized',
        client_name: exp.client?.name || null,
        project_name: exp.project?.name || null,
        payment_method: exp.payment_method,
        payment_status: exp.payment_status,
        billed_amount: Math.round(billed * 100) / 100,
        paid_amount: Math.round(paid * 100) / 100,
        outstanding_amount: Math.round(unpaid * 100) / 100,
      });
    }

    const accountsList = Object.values(accountGroups).map((g) => ({
      ...g,
      total_paid: Math.round(g.total_paid * 100) / 100,
      total_billed: Math.round(g.total_billed * 100) / 100,
      total_unpaid: Math.round(g.total_unpaid * 100) / 100,
      percentage_of_total_outflow: totalPaidOutflow > 0 ? Math.round((g.total_paid / totalPaidOutflow) * 1000) / 10 : 0,
    }));

    return {
      period: {
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
      },
      accounts: accountsList,
      summary: {
        total_paid_cash_outflow: Math.round(totalPaidOutflow * 100) / 100,
        total_billed_expenses: Math.round(totalBilledExpenses * 100) / 100,
        total_unpaid_expenses: Math.round(totalUnpaidExpenses * 100) / 100,
      },
      disclaimer: 'Account-wise cash flow report summarizes actual cash outflows by funding source (e.g., Company Account, Owner Personal Funds). It does not compute live bank account balances or reconcile bank statements.',
    };
  }

  // -------------------------------------------------------------
  // 9. EXPORT DATA (CSV)
  // -------------------------------------------------------------
  async generateCsvExport(type: string, query: any): Promise<string> {
    if (type === 'ledger') {
      const ledger = await this.getExpenseLedger(query);
      const headers = ['ID', 'Date', 'Title', 'Category', 'Vendor', 'Ref No', 'Payment Method', 'Account Source', 'Status', 'Billed (INR)', 'Paid (INR)', 'Outstanding (INR)', 'Has Receipt'];
      const rows = ledger.entries.map((e: any) => [
        e.id,
        e.date,
        `"${e.title.replace(/"/g, '""')}"`,
        `"${e.category.replace(/"/g, '""')}"`,
        `"${e.vendor.replace(/"/g, '""')}"`,
        `"${e.reference_number.replace(/"/g, '""')}"`,
        e.payment_method,
        e.payment_account_source || 'unspecified',
        e.payment_status,
        e.billed_amount,
        e.paid_amount,
        e.outstanding_amount,
        e.has_receipt ? 'Yes' : 'No',
      ]);
      return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    } else if (type === 'income-expense') {
      const statement = await this.getIncomeExpenseStatement(query);
      let csv = `INCOME & EXPENSE STATEMENT (${statement.period.start_date} to ${statement.period.end_date})\n\n`;
      csv += `COLLECTIONS (INCOME)\nDate,Receipt No,Client,Invoice No,Payment Mode,Amount (INR)\n`;
      statement.collections.forEach((c) => {
        csv += `${c.date},"${c.receipt_number}","${c.client_name}","${c.invoice_number}",${c.payment_mode},${c.amount}\n`;
      });
      csv += `Total Collections,,,,,${statement.summary.total_collections}\n\n`;
      csv += `EXPENSES\nDate,Title,Category,Vendor,Payment Method,Amount Paid (INR)\n`;
      statement.expenses.forEach((e) => {
        csv += `${e.date},"${e.title.replace(/"/g, '""')}","${e.category_name}","${e.vendor}",${e.payment_method},${e.amount_paid}\n`;
      });
      csv += `Total Expenses Paid,,,,,${statement.summary.total_expenses_paid}\n\n`;
      csv += `Net Cash Flow,,,,,${statement.summary.net_cash_flow}\n`;
      return csv;
    } else if (type === 'project-margin') {
      const margin = await this.getProjectMarginReport(query);
      const headers = ['Project Name', 'Client', 'Invoices Count', 'Total Invoiced (INR)', 'Actual Collections (INR)', 'Expenses Count', 'Expenses Billed (INR)', 'Expenses Paid (INR)', 'Preliminary Margin (INR)', 'Margin %'];
      const rows = margin.projects.map((p) => [
        `"${p.project_name.replace(/"/g, '""')}"`,
        `"${p.client_name.replace(/"/g, '""')}"`,
        p.invoice_count,
        p.total_invoiced_amount,
        p.actual_collections,
        p.expense_count,
        p.linked_expenses_billed,
        p.linked_expenses_paid,
        p.preliminary_margin,
        `${p.margin_percentage}%`,
      ]);
      return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    } else if (type === 'account-cash-flow') {
      const accountReport = await this.getAccountCashFlowReport(query);
      const headers = ['Account Source', 'Paid Transactions', 'Total Expenses Paid (INR)', 'Total Expenses Billed (INR)', 'Total Unpaid (INR)', '% Outflow'];
      const rows = accountReport.accounts.map((a) => [
        `"${a.account_label.replace(/"/g, '""')}"`,
        a.paid_transaction_count,
        a.total_paid,
        a.total_billed,
        a.total_unpaid,
        `${a.percentage_of_total_outflow}%`,
      ]);
      return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    } else {
      const catReport = await this.getCategoryExpenseReport(query);
      const headers = ['Category', 'Billed Amount (INR)', 'Paid Amount (INR)', 'Pending Amount (INR)', '% of Paid Total', 'Expense Count'];
      const rows = catReport.categories.map((c) => [
        `"${c.name.replace(/"/g, '""')}"`,
        c.total_billed,
        c.total_paid,
        c.pending,
        `${c.percentage_of_paid}%`,
        c.count,
      ]);
      return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    }
  }
}
