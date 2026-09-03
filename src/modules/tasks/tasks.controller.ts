import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@Controller('api/v1/tasks')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Get()
  @Permissions('VIEW_TASKS')
  async findAll(@CurrentUser() user: any, @Query() query: any) {
    return this.tasksService.findAll(user, query);
  }

  @Get(':id')
  @Permissions('VIEW_TASKS')
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.tasksService.findOne(id, user);
  }

  @Post()
  @Permissions('VIEW_TASKS')
  async create(@CurrentUser() user: any, @Body() body: any) {
    return this.tasksService.create(user, body);
  }

  @Patch(':id')
  @Permissions('VIEW_TASKS')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: any,
  ) {
    return this.tasksService.update(id, user, body);
  }

  @Delete(':id')
  @Permissions('VIEW_TASKS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.tasksService.remove(id, user);
  }
}
