import { BackupCategory } from '../enums/backup-category.enum';

export type RestoreMode = 'FULL' | 'CATEGORY';

export class RestorePreviewDto {
  restoreMode: RestoreMode;
  categories?: BackupCategory[];
}
