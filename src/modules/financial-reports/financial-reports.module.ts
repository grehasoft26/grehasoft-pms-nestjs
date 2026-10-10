import { Module } from '@nestjs/common';
import { FinancialReportsService } from './financial-reports.service';
import { FinancialReportsController } from './financial-reports.controller';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';

@Module({
  controllers: [FinancialReportsController],
  providers: [FinancialReportsService, PrismaService, PdfService],
  exports: [FinancialReportsService],
})
export class FinancialReportsModule {}
