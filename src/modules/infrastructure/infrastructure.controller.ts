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
} from '@nestjs/common';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { InfrastructureService } from './infrastructure.service';

// -------------------------------------------------------------
// 0. SUMMARY (/api/v1/infrastructure/summary/) — overview card totals
// -------------------------------------------------------------
// Same access as the list endpoints it summarises (signed in; their GETs need no permission),
// with the same record scoping in the service.
@Controller('api/v1/infrastructure/summary')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InfrastructureSummaryController {
  constructor(private readonly infraService: InfrastructureService) {}

  @Get()
  async getSummary(@Request() req: any) {
    return this.infraService.getSummary(req.user);
  }
}

// -------------------------------------------------------------
// 1. SERVERS CONTROLLER (/api/v1/infrastructure/servers/)
// -------------------------------------------------------------
@Controller('api/v1/infrastructure/servers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ServersController {
  constructor(private readonly infraService: InfrastructureService) {}

  @Get()
  async findAll(@Request() req: any, @Query() query: any) {
    return this.infraService.getServers(req.user, query);
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.infraService.getServerById(req.user, id);
  }

  @Post()
  @Permissions('MANAGE_INFRASTRUCTURE')
  async create(@Request() req: any, @Body() body: any) {
    return this.infraService.createServer(req.user, body);
  }

  @Put(':id')
  @Permissions('MANAGE_INFRASTRUCTURE')
  async updatePut(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.infraService.updateServer(req.user, id, body);
  }

  @Patch(':id')
  @Permissions('MANAGE_INFRASTRUCTURE')
  async updatePatch(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.infraService.updateServer(req.user, id, body);
  }

  @Delete(':id')
  @Permissions('MANAGE_INFRASTRUCTURE')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.infraService.deleteServer(req.user, id);
  }
}

// -------------------------------------------------------------
// 2. DOMAINS CONTROLLER (/api/v1/infrastructure/domains/)
// -------------------------------------------------------------
@Controller('api/v1/infrastructure/domains')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DomainsController {
  constructor(private readonly infraService: InfrastructureService) {}

  @Get()
  async findAll(@Request() req: any, @Query() query: any) {
    return this.infraService.getDomains(req.user, query);
  }

  // Name availability for the New/Edit Domain form: { exists }. Same permission as saving a
  // domain (names are unique across all domains, so this is checked across all of them).
  @Get('check-name')
  @Permissions('MANAGE_INFRASTRUCTURE')
  async checkName(@Query('name') name: string, @Query('exclude') exclude?: string) {
    return this.infraService.checkDomainName(name, exclude);
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.infraService.getDomainById(req.user, id);
  }

  @Post()
  @Permissions('MANAGE_INFRASTRUCTURE')
  async create(@Request() req: any, @Body() body: any) {
    return this.infraService.createDomain(req.user, body);
  }

  @Put(':id')
  @Permissions('MANAGE_INFRASTRUCTURE')
  async updatePut(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.infraService.updateDomain(req.user, id, body);
  }

  @Patch(':id')
  @Permissions('MANAGE_INFRASTRUCTURE')
  async updatePatch(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.infraService.updateDomain(req.user, id, body);
  }

  @Delete(':id')
  @Permissions('MANAGE_INFRASTRUCTURE')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.infraService.deleteDomain(req.user, id);
  }
}

// -------------------------------------------------------------
// 3. CREDENTIALS CONTROLLER (/api/v1/infrastructure/credentials/)
// -------------------------------------------------------------
@Controller('api/v1/infrastructure/credentials')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CredentialsController {
  constructor(private readonly infraService: InfrastructureService) {}

  @Get()
  async findAll(@Request() req: any, @Query() query: any) {
    return this.infraService.getCredentials(req.user, query);
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.infraService.getCredentialById(req.user, id);
  }

  @Post()
  @Permissions('MANAGE_INFRASTRUCTURE')
  async create(@Request() req: any, @Body() body: any) {
    return this.infraService.createCredential(req.user, body);
  }

  @Put(':id')
  @Permissions('MANAGE_INFRASTRUCTURE')
  async updatePut(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.infraService.updateCredential(req.user, id, body);
  }

  @Patch(':id')
  @Permissions('MANAGE_INFRASTRUCTURE')
  async updatePatch(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.infraService.updateCredential(req.user, id, body);
  }

  @Delete(':id')
  @Permissions('MANAGE_INFRASTRUCTURE')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.infraService.deleteCredential(req.user, id);
  }
}
