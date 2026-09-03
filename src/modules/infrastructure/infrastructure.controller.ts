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
import { InfrastructureService } from './infrastructure.service';

// -------------------------------------------------------------
// 1. SERVERS CONTROLLER (/api/v1/infrastructure/servers/)
// -------------------------------------------------------------
@Controller('api/v1/infrastructure/servers')
@UseGuards(JwtAuthGuard)
export class ServersController {
  constructor(private readonly infraService: InfrastructureService) {}

  @Get()
  async findAll(@Request() req: any) {
    return this.infraService.getServers(req.user);
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.infraService.getServerById(req.user, id);
  }

  @Post()
  async create(@Request() req: any, @Body() body: any) {
    return this.infraService.createServer(req.user, body);
  }

  @Put(':id')
  async updatePut(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.infraService.updateServer(req.user, id, body);
  }

  @Patch(':id')
  async updatePatch(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.infraService.updateServer(req.user, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.infraService.deleteServer(req.user, id);
  }
}

// -------------------------------------------------------------
// 2. DOMAINS CONTROLLER (/api/v1/infrastructure/domains/)
// -------------------------------------------------------------
@Controller('api/v1/infrastructure/domains')
@UseGuards(JwtAuthGuard)
export class DomainsController {
  constructor(private readonly infraService: InfrastructureService) {}

  @Get()
  async findAll(@Request() req: any, @Query('search') search?: string) {
    return this.infraService.getDomains(req.user, search);
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.infraService.getDomainById(req.user, id);
  }

  @Post()
  async create(@Request() req: any, @Body() body: any) {
    return this.infraService.createDomain(req.user, body);
  }

  @Put(':id')
  async updatePut(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.infraService.updateDomain(req.user, id, body);
  }

  @Patch(':id')
  async updatePatch(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.infraService.updateDomain(req.user, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.infraService.deleteDomain(req.user, id);
  }
}

// -------------------------------------------------------------
// 3. CREDENTIALS CONTROLLER (/api/v1/infrastructure/credentials/)
// -------------------------------------------------------------
@Controller('api/v1/infrastructure/credentials')
@UseGuards(JwtAuthGuard)
export class CredentialsController {
  constructor(private readonly infraService: InfrastructureService) {}

  @Get()
  async findAll(@Request() req: any) {
    return this.infraService.getCredentials(req.user);
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.infraService.getCredentialById(req.user, id);
  }

  @Post()
  async create(@Request() req: any, @Body() body: any) {
    return this.infraService.createCredential(req.user, body);
  }

  @Put(':id')
  async updatePut(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.infraService.updateCredential(req.user, id, body);
  }

  @Patch(':id')
  async updatePatch(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.infraService.updateCredential(req.user, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.infraService.deleteCredential(req.user, id);
  }
}
