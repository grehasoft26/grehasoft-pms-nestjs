import { Module } from '@nestjs/common';
import { InfrastructureService } from './infrastructure.service';
import { AssetRenewalsService } from './asset-renewals.service';
import { WebsiteCredentialsService } from './website-credentials.service';
import { CredentialAuditModule } from '../credential-audit/credential-audit.module';
import {
  InfrastructureSummaryController,
  ServersController,
  DomainsController,
  CredentialsController,
} from './infrastructure.controller';

@Module({
  imports: [CredentialAuditModule],
  controllers: [
    InfrastructureSummaryController,
    ServersController,
    DomainsController,
    CredentialsController,
  ],
  providers: [InfrastructureService, AssetRenewalsService, WebsiteCredentialsService],
  exports: [InfrastructureService, AssetRenewalsService],
})
export class InfrastructureModule {}
