import { Module } from '@nestjs/common';
import { SeoService } from './seo.service';
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
