import { Controller, Get, Post, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TaskFilesService } from './task-files.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@Controller('api/v1/task-files')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TaskFilesController {
  constructor(private readonly taskFilesService: TaskFilesService) {}

  @Get()
  @Permissions('VIEW_TASKS')
  async findAll(@CurrentUser() user: any, @Query() query: any) {
    return this.taskFilesService.findAll(user, query);
  }

  @Get(':id')
  @Permissions('VIEW_TASKS')
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.taskFilesService.findOne(id, user);
  }

  @Post()
  @Permissions('VIEW_TASKS')
  @UseInterceptors(FileInterceptor('file'))
  async create(
    @CurrentUser() user: any,
    @Body() body: any,
    @UploadedFile() file?: any,
  ) {
    return this.taskFilesService.create(user, body, file);
  }

  @Delete(':id')
  @Permissions('VIEW_TASKS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.taskFilesService.remove(id, user);
  }
}
