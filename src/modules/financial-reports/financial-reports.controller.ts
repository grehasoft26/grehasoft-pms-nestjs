import { Controller, Get, Query, UseGuards, Res } from '@nestjs/common';
import { Response } from 'express';
import { FinancialReportsService } from './financial-reports.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@Controller('api/v1/financial')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FinancialReportsController {
  constructor(private readonly financialReportsService: FinancialReportsService) {}

  @Get('dashboard')
  @Permissions('VIEW_FINANCIAL_REPORTS', 'VIEW_EXPENSES')
  async getDashboard(@CurrentUser() user: any) {
    return this.financialReportsService.getDashboardData(user);
  }

  @Get('reports/income-expense')
  @Permissions('VIEW_FINANCIAL_REPORTS')
  async getIncomeExpenseStatement(@Query() query: any) {
    return this.financialReportsService.getIncomeExpenseStatement(query);
  }

  @Get('reports/comparison')
  @Permissions('VIEW_FINANCIAL_REPORTS')
  async getMonthComparisonReport(@Query() query: any) {
    return this.financialReportsService.getMonthComparisonReport(query);
  }

  @Get('reports/category-breakdown')
  @Permissions('VIEW_FINANCIAL_REPORTS')
  async getCategoryExpenseReport(@Query() query: any) {
    return this.financialReportsService.getCategoryExpenseReport(query);
  }

  @Get('reports/expense-ledger')
  @Permissions('VIEW_FINANCIAL_REPORTS')
  async getExpenseLedger(@Query() query: any) {
    return this.financialReportsService.getExpenseLedger(query);
  }

  @Get('reports/financial-year-summary')
  @Permissions('VIEW_FINANCIAL_REPORTS')
  async getFinancialYearSummary(@Query() query: any) {
    return this.financialReportsService.getFinancialYearSummary(query);
  }

  @Get('reports/project-margin')
  @Permissions('VIEW_FINANCIAL_REPORTS')
  async getProjectMarginReport(@Query() query: any) {
    return this.financialReportsService.getProjectMarginReport(query);
  }

  @Get('reports/account-cash-flow')
  @Permissions('VIEW_FINANCIAL_REPORTS')
  async getAccountCashFlowReport(@Query() query: any) {
    return this.financialReportsService.getAccountCashFlowReport(query);
  }

  @Get('reports/export/csv')
  @Permissions('VIEW_FINANCIAL_REPORTS')
  async exportCsv(@Query('type') type: string, @Query() query: any, @Res() res: Response) {
    const csvContent = await this.financialReportsService.generateCsvExport(type || 'ledger', query);
    const filename = `financial_report_${type || 'ledger'}_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  }
}
