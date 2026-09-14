import { BackupType } from '@prisma/client';
import { BackupCategory } from '../enums/backup-category.enum';

export class GenerateBackupDto {
  backupType: BackupType;
  categories?: BackupCategory[];
}
