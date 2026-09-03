import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { RolesService } from './roles.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';

@Controller('api/v1/roles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @Permissions('MANAGE_SETTINGS', 'MANAGE_USERS')
  async findAll(@Query() query: { all?: string }) {
    return this.rolesService.findAll(query);
  }

  @Get(':id')
  @Permissions('MANAGE_SETTINGS', 'MANAGE_USERS')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.rolesService.findOne(id);
  }

  @Post()
  @Permissions('MANAGE_SETTINGS')
  async create(@Body() body: any) {
    return this.rolesService.create(body);
  }

  @Patch(':id')
  @Permissions('MANAGE_SETTINGS')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.rolesService.update(id, body);
  }

  @Delete(':id')
  @Permissions('MANAGE_SETTINGS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.rolesService.remove(id);
  }
}
