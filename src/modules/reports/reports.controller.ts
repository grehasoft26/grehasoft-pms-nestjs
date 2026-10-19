import { Controller, Get, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { ReportsService } from './reports.service';
import { INVOICE_READ_PERMISSIONS } from '../../core/utils/permission-catalog';

@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('api/v1/dashboard/stats')
  async getDashboardStats(@Request() req: any) {
    return this.reportsService.getDashboardStats(req.user);
  }

  // Company-wide project/task totals and revenue. The Dashboard only requests it from the
  // "Quarterly Report" button, which is shown with MANAGE_SETTINGS; previously any user could call it.
  @Get('api/v1/dashboard/quarterly-report')
  @Permissions('MANAGE_SETTINGS')
  async getQuarterlyReport() {
    return this.reportsService.getQuarterlyReport();
  }

  // Duplicate of InvoicesController's route (unscoped company totals): same permissions
  @Get('api/v1/invoices/analytics')
  @Permissions(...INVOICE_READ_PERMISSIONS)
  async getInvoiceAnalytics() {
    return this.reportsService.getInvoiceAnalytics();
  }
}
