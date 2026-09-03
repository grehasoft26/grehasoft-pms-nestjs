import { Module } from '@nestjs/common';
import { ClientPortalService } from './client-portal.service';
import { ClientPortalController } from './client-portal.controller';

@Module({
  controllers: [ClientPortalController],
  providers: [ClientPortalService],
  exports: [ClientPortalService],
})
export class ClientPortalModule {}
