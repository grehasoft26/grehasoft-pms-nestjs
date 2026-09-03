import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { LeadsService } from './leads.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@Controller('api/v1/leads')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get()
  @Permissions('VIEW_LEADS')
  async findAll(@CurrentUser() user: any, @Query() query: any) {
    return this.leadsService.findAll(user, query);
  }

  @Get(':id')
  @Permissions('VIEW_LEADS')
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.leadsService.findOne(id, user);
  }

  @Post()
  @Permissions('MANAGE_LEADS')
  async create(@CurrentUser() user: any, @Body() body: any) {
    return this.leadsService.create(user, body);
  }

  @Patch(':id')
  @Permissions('MANAGE_LEADS')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: any,
  ) {
    return this.leadsService.update(id, user, body);
  }

  @Delete(':id')
  @Permissions('MANAGE_LEADS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.leadsService.remove(id, user);
  }

  @Post(':id/convert_to_project')
  @Permissions('MANAGE_LEADS')
  async convertToProject(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: any,
  ) {
    return this.leadsService.convertToProject(id, user, body);
  }
}
