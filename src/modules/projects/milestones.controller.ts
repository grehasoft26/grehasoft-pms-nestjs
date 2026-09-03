import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { MilestonesService } from './milestones.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@Controller('api/v1/milestones')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MilestonesController {
  constructor(private readonly milestonesService: MilestonesService) {}

  @Get()
  @Permissions('VIEW_PROJECTS')
  async findAll(@CurrentUser() user: any, @Query() query: any) {
    return this.milestonesService.findAll(user, query);
  }

  @Get(':id')
  @Permissions('VIEW_PROJECTS')
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.milestonesService.findOne(id, user);
  }

  @Post()
  @Permissions('MANAGE_PROJECTS')
  async create(@CurrentUser() user: any, @Body() body: any) {
    return this.milestonesService.create(user, body);
  }

  @Patch(':id')
  @Permissions('MANAGE_PROJECTS')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: any,
  ) {
    return this.milestonesService.update(id, user, body);
  }

  @Delete(':id')
  @Permissions('MANAGE_PROJECTS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.milestonesService.remove(id, user);
  }
}
