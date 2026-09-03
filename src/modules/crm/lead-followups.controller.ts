import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { LeadFollowupsService } from './lead-followups.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@Controller('api/v1/lead-followups')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LeadFollowupsController {
  constructor(private readonly leadFollowupsService: LeadFollowupsService) {}

  @Get()
  @Permissions('VIEW_LEADS')
  async findAll(@Query() query: any) {
    return this.leadFollowupsService.findAll(query);
  }

  @Get(':id')
  @Permissions('VIEW_LEADS')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.leadFollowupsService.findOne(id);
  }

  @Post()
  @Permissions('MANAGE_LEADS')
  async create(@CurrentUser() user: any, @Body() body: any) {
    return this.leadFollowupsService.create(user, body);
  }

  @Patch(':id')
  @Permissions('MANAGE_LEADS')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.leadFollowupsService.update(id, body);
  }

  @Delete(':id')
  @Permissions('MANAGE_LEADS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.leadFollowupsService.remove(id);
  }
}
