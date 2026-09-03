import { Module } from '@nestjs/common';
import { InfrastructureService } from './infrastructure.service';
import {
  ServersController,
  DomainsController,
  CredentialsController,
} from './infrastructure.controller';

@Module({
  controllers: [
    ServersController,
    DomainsController,
    CredentialsController,
  ],
  providers: [InfrastructureService],
  exports: [InfrastructureService],
})
export class InfrastructureModule {}
