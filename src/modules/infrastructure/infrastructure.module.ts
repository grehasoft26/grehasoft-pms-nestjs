import { Module } from '@nestjs/common';
import { InfrastructureService } from './infrastructure.service';
import { AssetRenewalsService } from './asset-renewals.service';
import {
  InfrastructureSummaryController,
  ServersController,
  DomainsController,
  CredentialsController,
} from './infrastructure.controller';

@Module({
  controllers: [
    InfrastructureSummaryController,
    ServersController,
    DomainsController,
    CredentialsController,
  ],
  providers: [InfrastructureService, AssetRenewalsService],
  exports: [InfrastructureService, AssetRenewalsService],
})
export class InfrastructureModule {}
