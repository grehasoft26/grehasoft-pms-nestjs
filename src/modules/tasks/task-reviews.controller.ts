import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { TaskReviewsService } from './task-reviews.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@Controller('api/v1/task-reviews')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TaskReviewsController {
  constructor(private readonly taskReviewsService: TaskReviewsService) {}

  @Get()
  @Permissions('VIEW_TASKS')
  async findAll(@CurrentUser() user: any, @Query() query: any) {
    return this.taskReviewsService.findAll(user, query);
  }

  @Get(':id')
  @Permissions('VIEW_TASKS')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.taskReviewsService.findOne(id);
  }

  @Post()
  @Permissions('MANAGE_PROJECTS')
  async create(@CurrentUser() user: any, @Body() body: any) {
    return this.taskReviewsService.create(user, body);
  }

  @Patch(':id')
  @Permissions('MANAGE_PROJECTS')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: any,
  ) {
    return this.taskReviewsService.update(id, user, body);
  }

  @Delete(':id')
  @Permissions('MANAGE_PROJECTS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.taskReviewsService.remove(id, user);
  }
}
