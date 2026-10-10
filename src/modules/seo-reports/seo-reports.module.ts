import { Module } from '@nestjs/common';
import { SeoReportsController } from './seo-reports.controller';
import { SeoReportsService } from './seo-reports.service';
import { PdfService } from '../../core/pdf.service';

@Module({
  controllers: [SeoReportsController],
  providers: [SeoReportsService, PdfService],
  exports: [SeoReportsService],
})
export class SeoReportsModule {}
