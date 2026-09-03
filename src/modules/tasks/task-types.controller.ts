import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { TaskTypesService } from './task-types.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';

@Controller('api/v1/task-types')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TaskTypesController {
  constructor(private readonly taskTypesService: TaskTypesService) {}

  @Get()
  @Permissions('VIEW_TASKS')
  async findAll(@Query() query: any) {
    return this.taskTypesService.findAll(query);
  }

  @Get(':id')
  @Permissions('VIEW_TASKS')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.taskTypesService.findOne(id);
  }

  @Post()
  @Permissions('MANAGE_PROJECTS')
  async create(@Body() body: any) {
    return this.taskTypesService.create(body);
  }

  @Patch(':id')
  @Permissions('MANAGE_PROJECTS')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.taskTypesService.update(id, body);
  }

  @Delete(':id')
  @Permissions('MANAGE_PROJECTS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.taskTypesService.remove(id);
  }
}
