import { Controller, Get, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { ReportsService } from './reports.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('api/v1/dashboard/stats')
  async getDashboardStats(@Request() req: any) {
    return this.reportsService.getDashboardStats(req.user);
  }

  @Get('api/v1/dashboard/quarterly-report')
  async getQuarterlyReport() {
    return this.reportsService.getQuarterlyReport();
  }

  @Get('api/v1/invoices/analytics')
  async getInvoiceAnalytics() {
    return this.reportsService.getInvoiceAnalytics();
  }
}
