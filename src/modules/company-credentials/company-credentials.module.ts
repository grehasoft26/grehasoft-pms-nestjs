import { Module } from '@nestjs/common';
import { CompanyCredentialsController } from './company-credentials.controller';
import { CompanyCredentialsService } from './company-credentials.service';

@Module({
  controllers: [CompanyCredentialsController],
  providers: [CompanyCredentialsService],
})
export class CompanyCredentialsModule {}
