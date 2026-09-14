import { Test, TestingModule } from '@nestjs/testing';
import { BackupsService } from './backups.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { BackupType, BackupStatus } from '@prisma/client';
import { BackupCategory } from './enums/backup-category.enum';
import {
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';

describe('BackupsService', () => {
  let service: BackupsService;
  let prismaService: any;

  const mockAdminUser = {
    id: 1,
    username: 'admin',
    email: 'admin@grehasoft.com',
    is_superuser: true,
    role: { name: 'SUPER_ADMIN' },
  };

  const mockPrismaService = {
    $transaction: jest.fn(),
    backupRecord: {
      findFirst: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    invoice: { findMany: jest.fn().mockResolvedValue([]) },
    invoiceItem: { findMany: jest.fn().mockResolvedValue([]) },
    invoicePayment: { findMany: jest.fn().mockResolvedValue([]) },
    proposal: { findMany: jest.fn().mockResolvedValue([]) },
    proposalItem: { findMany: jest.fn().mockResolvedValue([]) },
    client: { findMany: jest.fn().mockResolvedValue([]) },
    lead: { findMany: jest.fn().mockResolvedValue([]) },
    leadAssignment: { findMany: jest.fn().mockResolvedValue([]) },
    leadFollowup: { findMany: jest.fn().mockResolvedValue([]) },
    portalUserAudit: { findMany: jest.fn().mockResolvedValue([]) },
    project: { findMany: jest.fn().mockResolvedValue([]) },
    milestone: { findMany: jest.fn().mockResolvedValue([]) },
    projectMember: { findMany: jest.fn().mockResolvedValue([]) },
    projectActivityLog: { findMany: jest.fn().mockResolvedValue([]) },
    task: { findMany: jest.fn().mockResolvedValue([]) },
    taskAssignment: { findMany: jest.fn().mockResolvedValue([]) },
    taskProgress: { findMany: jest.fn().mockResolvedValue([]) },
    taskFile: { findMany: jest.fn().mockResolvedValue([]) },
    taskReview: { findMany: jest.fn().mockResolvedValue([]) },
    taskComment: { findMany: jest.fn().mockResolvedValue([]) },
    employee: { findMany: jest.fn().mockResolvedValue([]) },
    hRDocument: { findMany: jest.fn().mockResolvedValue([]) },
    sEODailyWorkProof: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    role: { findMany: jest.fn().mockResolvedValue([]) },
    department: { findMany: jest.fn().mockResolvedValue([]) },
    taskType: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const mockPdfService = {
    generateInvoicePdf: jest.fn().mockResolvedValue(Buffer.from('PDF')),
    generateProposalPdf: jest.fn().mockResolvedValue(Buffer.from('PDF')),
    generateHrDocumentPdf: jest.fn().mockResolvedValue(Buffer.from('PDF')),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: PdfService, useValue: mockPdfService },
      ],
    }).compile();

    service = module.get<BackupsService>(BackupsService);
    prismaService = module.get(PrismaService);
    jest.spyOn(service as any, 'executeBackupJob').mockImplementation(() => Promise.resolve());
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateBackup', () => {
    it('should throw ConflictException if a backup is already running or pending', async () => {
      mockPrismaService.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          backupRecord: {
            findFirst: jest.fn().mockResolvedValue({ id: 99, status: BackupStatus.RUNNING }),
          },
        };
        return cb(txMock);
      });

      await expect(
        service.generateBackup(mockAdminUser, { backupType: BackupType.FULL_SYSTEM }),
      ).rejects.toThrow(ConflictException);
    });

    it('should create BackupRecord in PENDING state when no active backup exists', async () => {
      const mockRecord = {
        id: 10,
        filename: 'grehasoft-backup-full-20260914.zip',
        backup_type: BackupType.FULL_SYSTEM,
        status: BackupStatus.PENDING,
        created_by_id: 1,
        created_at: new Date(),
      };

      mockPrismaService.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          backupRecord: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue(mockRecord),
          },
        };
        return cb(txMock);
      });

      const result = await service.generateBackup(mockAdminUser, { backupType: BackupType.FULL_SYSTEM });
      expect(result.id).toBe(10);
      expect(result.status).toBe(BackupStatus.PENDING);
    });
  });

  describe('getDownloadPath', () => {
    it('should throw BadRequestException if backup status is not COMPLETED', async () => {
      mockPrismaService.backupRecord.findUnique.mockResolvedValue({
        id: 1,
        filename: 'backup.zip',
        status: BackupStatus.PENDING,
      });

      await expect(service.getDownloadPath(1)).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if backup record does not exist', async () => {
      mockPrismaService.backupRecord.findUnique.mockResolvedValue(null);
      await expect(service.getDownloadPath(999)).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if path traversal is attempted', async () => {
      mockPrismaService.backupRecord.findUnique.mockResolvedValue({
        id: 1,
        filename: '../../../../etc/passwd',
        status: BackupStatus.COMPLETED,
      });

      await expect(service.getDownloadPath(1)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('remove', () => {
    it('should throw NotFoundException if trying to remove non-existent backup', async () => {
      mockPrismaService.backupRecord.findUnique.mockResolvedValue(null);
      await expect(service.remove(999)).rejects.toThrow(NotFoundException);
    });

    it('should delete existing record and clean file safely', async () => {
      mockPrismaService.backupRecord.findUnique.mockResolvedValue({
        id: 5,
        filename: 'grehasoft-backup-full-20260914.zip',
        status: BackupStatus.COMPLETED,
      });
      mockPrismaService.backupRecord.delete.mockResolvedValue({});

      await service.remove(5);
      expect(mockPrismaService.backupRecord.delete).toHaveBeenCalledWith({ where: { id: 5 } });
    });
  });

  describe('previewRestore', () => {
    it('should throw BadRequestException if backup is not COMPLETED', async () => {
      mockPrismaService.backupRecord.findUnique.mockResolvedValue({
        id: 1,
        filename: 'backup.zip',
        status: BackupStatus.PENDING,
      });

      await expect(
        service.previewRestore(1, { restoreMode: 'FULL' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should return preview summary and require exact confirmation code', async () => {
      mockPrismaService.backupRecord.findUnique.mockResolvedValue({
        id: 1,
        filename: 'grehasoft-backup-full-2026.zip',
        backup_type: BackupType.FULL_SYSTEM,
        status: BackupStatus.COMPLETED,
      });

      jest.spyOn(service as any, 'ensureExtractedCache').mockResolvedValue('/tmp/fake-cache');

      const preview = await service.previewRestore(1, { restoreMode: 'FULL' });

      expect(preview.backup_id).toBe(1);
      expect(preview.confirmation_required).toBe('RESTORE DATABASE 1');
      expect(preview.pre_restore_backup_notice).toBeDefined();
    });

    it('should throw BadRequestException for category restore on legacy backups', async () => {
      mockPrismaService.backupRecord.findUnique.mockResolvedValue({
        id: 2,
        filename: 'legacy.zip',
        backup_type: BackupType.FULL_SYSTEM,
        status: BackupStatus.COMPLETED,
      });

      jest.spyOn(service as any, 'ensureExtractedCache').mockResolvedValue('/tmp/fake-cache');

      await expect(
        service.previewRestore(2, { restoreMode: 'CATEGORY', categories: [BackupCategory.FINANCE] }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('executeRestore', () => {
    it('should throw BadRequestException if confirmation code is incorrect', async () => {
      mockPrismaService.backupRecord.findUnique.mockResolvedValue({
        id: 1,
        filename: 'backup.zip',
        status: BackupStatus.COMPLETED,
      });

      await expect(
        service.executeRestore(1, mockAdminUser, {
          restoreMode: 'FULL',
          conflictStrategy: 'UPSERT',
          confirmationCode: 'WRONG_CODE',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ForbiddenException in production if ALLOW_PRODUCTION_RESTORE is not true', async () => {
      const origEnv = process.env.NODE_ENV;
      const origAllow = process.env.ALLOW_PRODUCTION_RESTORE;

      process.env.NODE_ENV = 'production';
      delete process.env.ALLOW_PRODUCTION_RESTORE;

      mockPrismaService.backupRecord.findUnique.mockResolvedValue({
        id: 1,
        filename: 'backup.zip',
        status: BackupStatus.COMPLETED,
      });

      await expect(
        service.executeRestore(1, mockAdminUser, {
          restoreMode: 'FULL',
          conflictStrategy: 'UPSERT',
          confirmationCode: 'RESTORE DATABASE 1',
        }),
      ).rejects.toThrow(ForbiddenException);

      process.env.NODE_ENV = origEnv;
      process.env.ALLOW_PRODUCTION_RESTORE = origAllow;
    });

    it('should throw ConflictException if a backup or restore job is running', async () => {
      mockPrismaService.backupRecord.findUnique.mockResolvedValue({
        id: 1,
        filename: 'backup.zip',
        status: BackupStatus.COMPLETED,
      });

      mockPrismaService.backupRecord.findFirst.mockResolvedValue({
        id: 99,
        status: BackupStatus.RUNNING,
      });

      await expect(
        service.executeRestore(1, mockAdminUser, {
          restoreMode: 'FULL',
          conflictStrategy: 'UPSERT',
          confirmationCode: 'RESTORE DATABASE 1',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should abort restore if pre-restore safety backup fails', async () => {
      mockPrismaService.backupRecord.findUnique.mockImplementation(async (args: any) => {
        if (args.where.id === 1) {
          return { id: 1, filename: 'backup.zip', status: BackupStatus.COMPLETED };
        }
        if (args.where.id === 100) {
          return { id: 100, filename: 'pre-restore.zip', status: BackupStatus.FAILED };
        }
        return null;
      });

      mockPrismaService.backupRecord.findFirst.mockResolvedValue(null);

      jest.spyOn(service, 'generateBackup').mockResolvedValue({
        id: 100,
        filename: 'pre-restore.zip',
        status: BackupStatus.PENDING,
      } as any);

      jest.spyOn(service as any, 'ensureExtractedCache').mockResolvedValue('/tmp/fake-cache');

      await expect(
        service.executeRestore(1, mockAdminUser, {
          restoreMode: 'FULL',
          conflictStrategy: 'UPSERT',
          confirmationCode: 'RESTORE DATABASE 1',
        }),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('cancelBackup', () => {
    it('should throw BadRequestException when trying to cancel COMPLETED backup', async () => {
      mockPrismaService.backupRecord.findUnique.mockResolvedValue({
        id: 1,
        filename: 'backup.zip',
        status: BackupStatus.COMPLETED,
      });

      await expect(service.cancelBackup(1)).rejects.toThrow(BadRequestException);
    });

    it('should update PENDING/RUNNING backup to FAILED with cancellation message', async () => {
      mockPrismaService.backupRecord.findUnique.mockResolvedValue({
        id: 2,
        filename: 'backup.zip',
        status: BackupStatus.RUNNING,
      });
      mockPrismaService.backupRecord.update.mockResolvedValue({
        id: 2,
        status: BackupStatus.FAILED,
        error_message: 'Operation cancelled by administrator.',
      });

      const res = await service.cancelBackup(2);
      expect(res.message).toBe('Backup operation cancelled.');
      expect(res.backup_id).toBe(2);
      expect(mockPrismaService.backupRecord.update).toHaveBeenCalledWith({
        where: { id: 2 },
        data: expect.objectContaining({
          status: BackupStatus.FAILED,
          error_message: 'Operation cancelled by administrator.',
        }),
      });
    });

    it('should handle idempotency when cancelling an already cancelled backup', async () => {
      mockPrismaService.backupRecord.findUnique.mockResolvedValue({
        id: 3,
        filename: 'backup.zip',
        status: BackupStatus.FAILED,
        error_message: 'Operation cancelled by administrator.',
      });

      const res = await service.cancelBackup(3);
      expect(res.message).toBe('Backup operation is already cancelled.');
    });
  });
});

