import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  Header,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CompanyCredentialsService } from './company-credentials.service';
import { auditContextFrom } from '../credential-audit/credential-audit.service';

// -------------------------------------------------------------
// GREHASOFT (COMPANY) CREDENTIALS CONTROLLER (/api/v1/infrastructure/company-credentials/)
// Separate from client credentials at /api/v1/infrastructure/credentials/.
// Metadata (never passwords): MANAGE_CREDENTIALS or REVEAL_CREDENTIALS; MANAGE_INFRASTRUCTURE is
// accepted for reading during the transition so existing infrastructure roles keep the page.
// Writes: MANAGE_CREDENTIALS. Reveal: REVEAL_CREDENTIALS, checked and audited in the service.
// -------------------------------------------------------------
@Controller('api/v1/infrastructure/company-credentials')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CompanyCredentialsController {
  constructor(private readonly companyCredentialsService: CompanyCredentialsService) {}

  @Get()
  @Permissions('MANAGE_CREDENTIALS', 'REVEAL_CREDENTIALS', 'MANAGE_INFRASTRUCTURE')
  async findAll(@Query() query: any) {
    return this.companyCredentialsService.findAll(query);
  }

  @Get(':id')
  @Permissions('MANAGE_CREDENTIALS', 'REVEAL_CREDENTIALS', 'MANAGE_INFRASTRUCTURE')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.companyCredentialsService.findOne(id);
  }

  // No @Permissions on purpose: REVEAL_CREDENTIALS is checked in the service so that refused
  // attempts are audited too (the guard would reject them before anything is recorded)
  @Post(':id/reveal')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  async revealPassword(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.companyCredentialsService.revealPassword(req.user, id, auditContextFrom(req));
  }

  @Post()
  @Permissions('MANAGE_CREDENTIALS')
  async create(@Request() req: any, @Body() body: any) {
    return this.companyCredentialsService.create(body, auditContextFrom(req));
  }

  @Put(':id')
  @Permissions('MANAGE_CREDENTIALS')
  async updatePut(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.companyCredentialsService.update(id, body, auditContextFrom(req));
  }

  @Patch(':id')
  @Permissions('MANAGE_CREDENTIALS')
  async updatePatch(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.companyCredentialsService.update(id, body, auditContextFrom(req));
  }

  @Delete(':id')
  @Permissions('MANAGE_CREDENTIALS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.companyCredentialsService.remove(id, auditContextFrom(req));
  }
}
