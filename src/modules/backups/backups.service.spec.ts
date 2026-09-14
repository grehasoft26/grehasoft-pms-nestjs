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
});
