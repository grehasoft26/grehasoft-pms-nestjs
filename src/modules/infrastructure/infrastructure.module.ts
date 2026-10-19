import { Module } from '@nestjs/common';
import { InfrastructureService } from './infrastructure.service';
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
  providers: [InfrastructureService],
  exports: [InfrastructureService],
})
export class InfrastructureModule {}
