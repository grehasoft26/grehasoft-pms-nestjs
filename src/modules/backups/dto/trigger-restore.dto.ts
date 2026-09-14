import { BackupCategory } from '../enums/backup-category.enum';
import { RestoreMode } from './restore-preview.dto';

export type ConflictStrategy = 'UPSERT' | 'SKIP_EXISTING';

export class TriggerRestoreDto {
  restoreMode: RestoreMode;
  categories?: BackupCategory[];
  conflictStrategy: ConflictStrategy;
  confirmationCode: string;
}
