import { Test, TestingModule } from '@nestjs/testing';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';
import { BackupType, BackupStatus } from '@prisma/client';
import { BackupCategory } from './enums/backup-category.enum';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Response } from 'express';

describe('BackupsController', () => {
  let controller: BackupsController;
  let service: BackupsService;

  const mockAdminUser = {
    id: 1,
    username: 'admin',
    email: 'admin@grehasoft.com',
    is_superuser: true,
    role: { name: 'SUPER_ADMIN' },
  };

  const mockNonAdminUser = {
    id: 2,
    username: 'john',
    email: 'john@grehasoft.com',
    is_superuser: false,
    role: { name: 'EMPLOYEE' },
  };

  const mockBackupsService = {
    generateBackup: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    getDownloadPath: jest.fn(),
    remove: jest.fn(),
    previewRestore: jest.fn(),
    executeRestore: jest.fn(),
    cancelBackup: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BackupsController],
      providers: [
        { provide: BackupsService, useValue: mockBackupsService },
      ],
    }).compile();

    controller = module.get<BackupsController>(BackupsController);
    service = module.get<BackupsService>(BackupsService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('Authorization Check', () => {
    it('should reject non-admin users with ForbiddenException', async () => {
      await expect(
        controller.generateBackup(mockNonAdminUser, { backupType: BackupType.FULL_SYSTEM }),
      ).rejects.toThrow(ForbiddenException);

      await expect(controller.findAll(mockNonAdminUser)).rejects.toThrow(ForbiddenException);
      await expect(controller.getStatus(1, mockNonAdminUser)).rejects.toThrow(ForbiddenException);
      await expect(controller.remove(1, mockNonAdminUser)).rejects.toThrow(ForbiddenException);
    });

    it('should allow admin users', async () => {
      mockBackupsService.generateBackup.mockResolvedValue({
        id: 1,
        filename: 'backup.zip',
        backup_type: BackupType.FULL_SYSTEM,
        status: BackupStatus.PENDING,
        created_at: new Date(),
      });

      const res = await controller.generateBackup(mockAdminUser, { backupType: BackupType.FULL_SYSTEM });
      expect(res.message).toBe('Backup generation started.');
      expect(res.backup.id).toBe(1);
    });
  });

  describe('generateBackup', () => {
    it('should trigger category backup for valid admin request', async () => {
      const dto = {
        backupType: BackupType.CATEGORY,
        categories: [BackupCategory.FINANCE, BackupCategory.OPERATIONS],
      };

      mockBackupsService.generateBackup.mockResolvedValue({
        id: 2,
        filename: 'grehasoft-backup-category-20260914.zip',
        backup_type: BackupType.CATEGORY,
        selected_categories: dto.categories,
        status: BackupStatus.PENDING,
        created_at: new Date(),
      });

      const result = await controller.generateBackup(mockAdminUser, dto);
      expect(result.backup.backup_type).toBe(BackupType.CATEGORY);
      expect(result.backup.status).toBe(BackupStatus.PENDING);
    });
  });

  describe('getStatus', () => {
    it('should return backup record details for admin', async () => {
      mockBackupsService.findOne.mockResolvedValue({
        id: 1,
        filename: 'backup.zip',
        backup_type: BackupType.FULL_SYSTEM,
        status: BackupStatus.COMPLETED,
        size_bytes: BigInt(1024500),
        created_by_id: 1,
        created_at: new Date(),
        completed_at: new Date(),
        error_message: null,
      });

      const result = await controller.getStatus(1, mockAdminUser);
      expect(result.id).toBe(1);
      expect(result.status).toBe(BackupStatus.COMPLETED);
      expect(result.size_bytes).toBe('1024500');
    });

    it('should throw NotFoundException if backup ID is invalid', async () => {
      mockBackupsService.findOne.mockRejectedValue(new NotFoundException('Backup not found'));
      await expect(controller.getStatus(999, mockAdminUser)).rejects.toThrow(NotFoundException);
    });
  });

  describe('downloadBackup', () => {
    it('should set headers and stream file for completed backup', async () => {
      const mockRes = {
        setHeader: jest.fn(),
        sendFile: jest.fn(),
      } as unknown as Response;

      mockBackupsService.getDownloadPath.mockResolvedValue({
        filePath: 'C:/storage/backups/backup.zip',
        filename: 'backup.zip',
      });

      await controller.downloadBackup(1, mockAdminUser, mockRes);
      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/zip');
      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="backup.zip"');
      expect(mockRes.sendFile).toHaveBeenCalledWith('C:/storage/backups/backup.zip');
    });
  });

  describe('remove', () => {
    it('should delete backup for authorized admin', async () => {
      mockBackupsService.remove.mockResolvedValue(undefined);
      await controller.remove(1, mockAdminUser);
      expect(mockBackupsService.remove).toHaveBeenCalledWith(1);
    });
  });

  describe('previewRestore', () => {
    it('should delegate to service previewRestore for admin', async () => {
      const mockResult = { backup_id: 1, confirmation_required: 'RESTORE DATABASE 1' };
      mockBackupsService.previewRestore.mockResolvedValue(mockResult);

      const res = await controller.previewRestore(1, mockAdminUser, { restoreMode: 'FULL' });
      expect(res).toEqual(mockResult);
      expect(mockBackupsService.previewRestore).toHaveBeenCalledWith(1, { restoreMode: 'FULL' });
    });

    it('should reject non-admin user with ForbiddenException', async () => {
      await expect(
        controller.previewRestore(1, mockNonAdminUser, { restoreMode: 'FULL' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('executeRestore', () => {
    it('should delegate to service executeRestore for admin', async () => {
      const dto = { restoreMode: 'FULL' as const, conflictStrategy: 'UPSERT' as const, confirmationCode: 'RESTORE DATABASE 1' };
      const mockResult = { message: 'Restore operation completed successfully.' };
      mockBackupsService.executeRestore.mockResolvedValue(mockResult);

      const res = await controller.executeRestore(1, mockAdminUser, dto);
      expect(res).toEqual(mockResult);
      expect(mockBackupsService.executeRestore).toHaveBeenCalledWith(1, mockAdminUser, dto);
    });

    it('should reject non-admin user with ForbiddenException', async () => {
      const dto = { restoreMode: 'FULL' as const, conflictStrategy: 'UPSERT' as const, confirmationCode: 'RESTORE DATABASE 1' };
      await expect(
        controller.executeRestore(1, mockNonAdminUser, dto),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('cancelBackup', () => {
    it('should delegate to service cancelBackup for admin', async () => {
      const mockResult = { message: 'Backup operation cancelled.', backup_id: 1 };
      mockBackupsService.cancelBackup.mockResolvedValue(mockResult);

      const res = await controller.cancelBackup(1, mockAdminUser);
      expect(res).toEqual(mockResult);
      expect(mockBackupsService.cancelBackup).toHaveBeenCalledWith(1);
    });

    it('should reject non-admin user with ForbiddenException', async () => {
      await expect(controller.cancelBackup(1, mockNonAdminUser)).rejects.toThrow(ForbiddenException);
    });
  });
});
