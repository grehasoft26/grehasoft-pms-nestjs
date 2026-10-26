import { Module } from '@nestjs/common';
import { SeoService } from './seo.service';
import { CredentialAuditModule } from '../credential-audit/credential-audit.module';
import {
  WebsitesController,
  SeoActivityTypesController,
  SeoKeywordsController,
  SeoDailyLogsController,
  SeoMonthlyTargetsController,
  SeoTasksController,
  SeoRemindersController,
  SeoCredentialsController,
} from './seo.controller';

@Module({
  imports: [CredentialAuditModule],
  controllers: [
    WebsitesController,
    SeoActivityTypesController,
    SeoKeywordsController,
    SeoDailyLogsController,
    SeoMonthlyTargetsController,
    SeoTasksController,
    SeoRemindersController,
    SeoCredentialsController,
  ],
  providers: [SeoService],
  exports: [SeoService],
})
export class SeoModule {}
