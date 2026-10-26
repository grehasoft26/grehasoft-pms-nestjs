import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CredentialAuditService } from './credential-audit.service';

// -------------------------------------------------------------
// CREDENTIAL AUDIT LOG (/api/v1/credential-audit/) - read only, credential events only
// -------------------------------------------------------------
@Controller('api/v1/credential-audit')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions('VIEW_CREDENTIAL_AUDIT')
export class CredentialAuditController {
  constructor(private readonly credentialAuditService: CredentialAuditService) {}

  @Get()
  async findAll(@Query() query: any) {
    return this.credentialAuditService.findAll(query);
  }
}
