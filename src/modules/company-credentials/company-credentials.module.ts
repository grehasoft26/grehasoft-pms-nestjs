import { Module } from '@nestjs/common';
import { CompanyCredentialsController } from './company-credentials.controller';
import { CompanyCredentialsService } from './company-credentials.service';
import { CredentialAuditModule } from '../credential-audit/credential-audit.module';

@Module({
  imports: [CredentialAuditModule],
  controllers: [CompanyCredentialsController],
  providers: [CompanyCredentialsService],
})
export class CompanyCredentialsModule {}
