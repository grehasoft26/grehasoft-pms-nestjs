import { Module } from '@nestjs/common';
import { CredentialAuditController } from './credential-audit.controller';
import { CredentialAuditService } from './credential-audit.service';

@Module({
  controllers: [CredentialAuditController],
  providers: [CredentialAuditService],
  exports: [CredentialAuditService],
})
export class CredentialAuditModule {}
