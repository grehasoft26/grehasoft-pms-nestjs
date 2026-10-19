import { Controller, Get, Post, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus, UseInterceptors, UploadedFile, Res } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { TaskFilesService } from './task-files.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { ClientAccess } from '../../core/decorators/client-access.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@Controller('api/v1/task-files')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TaskFilesController {
  constructor(private readonly taskFilesService: TaskFilesService) {}

  @Get()
  @Permissions('VIEW_TASKS')
  @ClientAccess()
  async findAll(@CurrentUser() user: any, @Query() query: any) {
    return this.taskFilesService.findAll(user, query);
  }

  @Get([':id/download', ':id/download/'])
  @Permissions('VIEW_TASKS')
  @ClientAccess()
  async download(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any, @Res() res: Response) {
    this.sendFile(res, await this.taskFilesService.getFileContent(id, user, 'download'));
  }

  @Get([':id/preview', ':id/preview/'])
  @Permissions('VIEW_TASKS')
  @ClientAccess()
  async preview(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any, @Res() res: Response) {
    this.sendFile(res, await this.taskFilesService.getFileContent(id, user, 'preview'));
  }

  private sendFile(res: Response, file: { buffer: Buffer; filename: string; contentType: string; inline: boolean }) {
    const asciiName = file.filename.replace(/[^\x20-\x7E]|["\\]/g, '_');
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `${file.inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Content-Length': String(file.buffer.length),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    });
    res.send(file.buffer);
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
