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
import { CompanyCredentialsService } from './company-credentials.service';

// -------------------------------------------------------------
// GREHASOFT (COMPANY) CREDENTIALS CONTROLLER (/api/v1/infrastructure/company-credentials/)
// Separate from client credentials at /api/v1/infrastructure/credentials/.
// -------------------------------------------------------------
@Controller('api/v1/infrastructure/company-credentials')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions('MANAGE_INFRASTRUCTURE')
export class CompanyCredentialsController {
  constructor(private readonly companyCredentialsService: CompanyCredentialsService) {}

  @Get()
  async findAll(@Query() query: any) {
    return this.companyCredentialsService.findAll(query);
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.companyCredentialsService.findOne(id);
  }

  @Get(':id/password')
  async revealPassword(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.companyCredentialsService.revealPassword(req.user, id);
  }

  @Post()
  async create(@Body() body: any) {
    return this.companyCredentialsService.create(body);
  }

  @Put(':id')
  async updatePut(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.companyCredentialsService.update(id, body);
  }

  @Patch(':id')
  async updatePatch(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.companyCredentialsService.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.companyCredentialsService.remove(id);
  }
}
