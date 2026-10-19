import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { RolesService } from './roles.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import { ROLE_MANAGEMENT_PERMISSION } from '../../core/utils/permission-catalog';

@Controller('api/v1/roles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @Permissions(ROLE_MANAGEMENT_PERMISSION, 'MANAGE_USERS')
  async findAll(@Query() query: { all?: string }) {
    return this.rolesService.findAll(query);
  }

  @Get(':id')
  @Permissions(ROLE_MANAGEMENT_PERMISSION, 'MANAGE_USERS')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.rolesService.findOne(id);
  }

  @Post()
  @Permissions(ROLE_MANAGEMENT_PERMISSION)
  async create(@CurrentUser() reqUser: any, @Body() body: any) {
    return this.rolesService.create(body, reqUser);
  }

  @Patch(':id')
  @Permissions(ROLE_MANAGEMENT_PERMISSION)
  async update(@CurrentUser() reqUser: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.rolesService.update(id, body, reqUser);
  }

  @Delete(':id')
  @Permissions(ROLE_MANAGEMENT_PERMISSION)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() reqUser: any, @Param('id', ParseIntPipe) id: number) {
    return this.rolesService.remove(id, reqUser);
  }
}
