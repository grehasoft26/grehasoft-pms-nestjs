import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  Res,
  ForbiddenException,
} from '@nestjs/common';
import { Response } from 'express';
import { BackupsService } from './backups.service';
import { GenerateBackupDto } from './dto/generate-backup.dto';
import { RestorePreviewDto } from './dto/restore-preview.dto';
import { TriggerRestoreDto } from './dto/trigger-restore.dto';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@Controller('api/v1/backups')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BackupsController {
  constructor(private readonly backupsService: BackupsService) {}

  private checkAdminPermission(user: any): void {
    const isSuperUser = user?.is_superuser === true;
    const isSuperAdminRole = user?.role?.name === 'SUPER_ADMIN';
    const isAdminRole = user?.role?.name === 'ADMIN';

    if (!isSuperUser && !isSuperAdminRole && !isAdminRole) {
      throw new ForbiddenException('Backup operations are restricted to Admin users only.');
    }
  }

  @Post(['generate', 'generate/'])
  @HttpCode(HttpStatus.ACCEPTED)
  @Permissions('MANAGE_BACKUPS')
  async generateBackup(@CurrentUser() user: any, @Body() body: GenerateBackupDto) {
    this.checkAdminPermission(user);
    const record = await this.backupsService.generateBackup(user, body);
    return {
      message: 'Backup generation started.',
      backup: {
        id: record.id,
        filename: record.filename,
        backup_type: record.backup_type,
        selected_categories: record.selected_categories,
        status: record.status,
        created_at: record.created_at,
      },
    };
  }

  @Get(['', '/'])
  @Permissions('MANAGE_BACKUPS')
  async findAll(@CurrentUser() user: any) {
    this.checkAdminPermission(user);
    const backups = await this.backupsService.findAll();
    return backups.map((b: any) => ({
      id: b.id,
      filename: b.filename,
      backup_type: b.backup_type,
      selected_categories: b.selected_categories,
      status: b.status,
      size_bytes: b.size_bytes ? b.size_bytes.toString() : null,
      created_by: b.created_by
        ? {
            id: b.created_by.id,
            username: b.created_by.username,
            name: b.created_by.name,
          }
        : null,
      created_at: b.created_at,
      completed_at: b.completed_at,
      error_message: b.error_message,
    }));
  }

  @Get([':id/status', ':id/status/'])
  @Permissions('MANAGE_BACKUPS')
  async getStatus(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    this.checkAdminPermission(user);
    const b = await this.backupsService.findOne(id);
    return {
      id: b.id,
      filename: b.filename,
      backup_type: b.backup_type,
      selected_categories: b.selected_categories,
      status: b.status,
      size_bytes: b.size_bytes ? b.size_bytes.toString() : null,
      created_by_id: b.created_by_id,
      created_at: b.created_at,
      completed_at: b.completed_at,
      error_message: b.error_message,
    };
  }

  @Get([':id/download', ':id/download/'])
  @Permissions('MANAGE_BACKUPS')
  async downloadBackup(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Res() res: Response,
  ) {
    this.checkAdminPermission(user);
    const { filePath, filename } = await this.backupsService.getDownloadPath(id);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(filePath);
  }

  // ============================================================================
  // BACKUP EXPLORER ENDPOINTS
  // ============================================================================

  @Get([':id/explorer', ':id/explorer/'])
  @Permissions('MANAGE_BACKUPS')
  async getExplorerSummary(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    this.checkAdminPermission(user);
    return this.backupsService.getExplorerSummary(id);
  }

  @Get([':id/explorer/entities/:entityName', ':id/explorer/entities/:entityName/'])
  @Permissions('MANAGE_BACKUPS')
  async getExplorerEntityRecords(
    @Param('id', ParseIntPipe) id: number,
    @Param('entityName') entityName: string,
    @Query() query: { page?: string; limit?: string; search?: string },
    @CurrentUser() user: any,
  ) {
    this.checkAdminPermission(user);
    return this.backupsService.getExplorerEntityRecords(id, entityName, query);
  }

  @Get([':id/explorer/entities/:entityName/:recordId', ':id/explorer/entities/:entityName/:recordId/'])
  @Permissions('MANAGE_BACKUPS')
  async getExplorerRecordDetail(
    @Param('id', ParseIntPipe) id: number,
    @Param('entityName') entityName: string,
    @Param('recordId', ParseIntPipe) recordId: number,
    @CurrentUser() user: any,
  ) {
    this.checkAdminPermission(user);
    return this.backupsService.getExplorerRecordDetail(id, entityName, recordId);
  }

  @Get([':id/explorer/documents', ':id/explorer/documents/'])
  @Permissions('MANAGE_BACKUPS')
  async getExplorerDocuments(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    this.checkAdminPermission(user);
    return this.backupsService.getExplorerDocuments(id);
  }

  @Get([':id/explorer/documents/download', ':id/explorer/documents/download/'])
  @Permissions('MANAGE_BACKUPS')
  async getExplorerDocumentStream(
    @Param('id', ParseIntPipe) id: number,
    @Query('path') relPath: string,
    @CurrentUser() user: any,
    @Res() res: Response,
  ) {
    this.checkAdminPermission(user);
    const { filePath, filename } = await this.backupsService.getExplorerDocumentPath(id, relPath);

    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.sendFile(filePath);
  }

  // ============================================================================
  // RESTORE ENDPOINTS
  // ============================================================================

  @Post([':id/restore/preview', ':id/restore/preview/'])
  @HttpCode(HttpStatus.OK)
  @Permissions('MANAGE_BACKUPS')
  async previewRestore(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: RestorePreviewDto,
  ) {
    this.checkAdminPermission(user);
    return this.backupsService.previewRestore(id, body);
  }

  @Post([':id/restore', ':id/restore/'])
  @HttpCode(HttpStatus.OK)
  @Permissions('MANAGE_BACKUPS')
  async executeRestore(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: TriggerRestoreDto,
  ) {
    this.checkAdminPermission(user);
    return this.backupsService.executeRestore(id, user, body);
  }

  @Post([':id/cancel', ':id/cancel/'])
  @HttpCode(HttpStatus.OK)
  @Permissions('MANAGE_BACKUPS')
  async cancelBackup(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    this.checkAdminPermission(user);
    return this.backupsService.cancelBackup(id);
  }

  @Delete([':id', ':id/'])
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('MANAGE_BACKUPS')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    this.checkAdminPermission(user);
    await this.backupsService.remove(id);
  }
}
