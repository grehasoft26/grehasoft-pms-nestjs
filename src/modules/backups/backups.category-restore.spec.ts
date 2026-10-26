import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { BadRequestException, InternalServerErrorException, Logger } from '@nestjs/common';
import { BackupStatus, BackupType } from '@prisma/client';
import { BackupsService } from './backups.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { BackupCategory } from './enums/backup-category.enum';

/**
 * Category restore (P0 fix): only the selected categories' tables are written; users, roles,
 * departments and task_types never are; no password or "[REDACTED]" placeholder is ever written;
 * invalid selections fail before anything happens; partial failures report counts, not row values.
 * Filesystem and process access are stubbed: an in-memory backup, and any write fails the test.
 */
const CACHE = path.join(path.sep, 'virtual-backup-cache');

const MODELS = [
  'role', 'department', 'user', 'taskType', 'client', 'lead', 'leadAssignment', 'leadFollowup', 'portalUserAudit',
  'project', 'milestone', 'projectMember', 'projectActivityLog', 'task', 'taskAssignment', 'taskProgress', 'taskFile',
  'taskReview', 'taskComment', 'invoice', 'invoiceItem', 'invoicePayment', 'proposal', 'proposalItem', 'employee', 'hRDocument',
] as const;
const NEVER_RESTORED = ['role', 'user', 'department', 'taskType'] as const;

const FINANCE_TABLES = ['invoices', 'invoice_items', 'invoice_payments', 'proposals', 'proposal_items'];
const CLIENTS_TABLES = ['clients', 'leads', 'lead_assignments', 'lead_followups', 'portal_user_audit'];
const OPERATIONS_TABLES = [
  'projects', 'milestones', 'project_members', 'project_activity_logs', 'tasks',
  'task_assignments', 'task_progress', 'task_files', 'task_reviews', 'task_comments',
];
const HR_TABLES = ['employees', 'hr_documents'];

const delegate = () => ({
  findUnique: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
  update: jest.fn().mockResolvedValue({}),
  upsert: jest.fn().mockResolvedValue({}),
  updateMany: jest.fn().mockResolvedValue({}),
  createMany: jest.fn().mockResolvedValue({}),
  deleteMany: jest.fn().mockResolvedValue({}),
  delete: jest.fn().mockResolvedValue({}),
});

const fullBackup = { id: 1, filename: 'full.zip', backup_type: BackupType.FULL_SYSTEM, selected_categories: null, status: BackupStatus.COMPLETED };
const financeBackup = { id: 2, filename: 'cat.zip', backup_type: BackupType.CATEGORY, selected_categories: ['FINANCE', 'DOCUMENTS'], status: BackupStatus.COMPLETED };

describe('BackupsService category restore', () => {
  let service: BackupsService;
  let prisma: any;
  let snapshot: Record<string, unknown>;
  let warn: jest.SpyInstance;

  /** Every write-capable call on any delegate. */
  const writesTo = (model: string) =>
    ['create', 'update', 'upsert', 'updateMany', 'createMany', 'deleteMany', 'delete'].flatMap((m) => prisma[model][m].mock.calls);
  const allWriteData = () => MODELS.flatMap((m) => writesTo(m)).map(([args]) => args?.data);

  const restore = (record: any, dto: any) => {
    prisma.backupRecord.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 100 ? { id: 100, filename: 'pre.zip', status: BackupStatus.COMPLETED } : record,
    );
    return service.executeRestore(record.id, { id: 1, username: 'admin', is_superuser: true }, {
      restoreMode: 'CATEGORY',
      conflictStrategy: 'UPSERT',
      confirmationCode: `RESTORE DATABASE ${record.id}`,
      ...dto,
    });
  };

  beforeEach(async () => {
    // Constructor creates storage directories: not in tests
    jest.spyOn(BackupsService.prototype as any, 'ensureDirectoryExists').mockImplementation(() => undefined);
    prisma = { backupRecord: { findUnique: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) } };
    for (const model of MODELS) prisma[model] = delegate();

    const moduleRef = await Test.createTestingModule({
      providers: [
        BackupsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PdfService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(BackupsService);

    // In-memory extracted backup (manifest v2 + data/<table>.json)
    snapshot = {
      'manifest.json': { manifest_version: '2.0' },
      'data/invoices.json': [{ id: 1, client_id: 5, total: 100, client: { id: 5 } }, { id: 2, client_id: 5, total: 200 }],
      'data/invoice_items.json': [{ id: 1, invoice_id: 1 }],
      'data/clients.json': [{ id: 5, name: 'Client' }],
      'data/projects.json': [{ id: 7, name: 'Project' }],
      'data/employees.json': [{ id: 3, user_id: 9 }],
      'data/users.json': [{ id: 9, username: 'u', password: '[REDACTED]', role_id: 2 }],
      'data/roles.json': [{ id: 2, name: 'ADMIN', permissions: ['MANAGE_CREDENTIALS', 'REVEAL_CREDENTIALS'] }],
      'data/departments.json': [{ id: 4, name: 'Dept' }],
      'data/task_types.json': [{ id: 6, name: 'Type' }],
    };
    const virtual = (p: fs.PathLike) => {
      const rel = path.relative(CACHE, String(p));
      return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel.split(path.sep).join('/');
    };
    const realExists = fs.existsSync;
    const realRead = fs.readFileSync;
    const realReaddir = fs.readdirSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      const rel = virtual(p);
      if (rel === undefined) return realExists(p);
      return rel === '' || rel === 'data' || rel in snapshot;
    });
    jest.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      const rel = virtual(p);
      if (rel === undefined) return (realRead as any)(p, ...rest);
      const value = snapshot[rel];
      return typeof value === 'string' ? value : JSON.stringify(value);
    }) as any);
    jest.spyOn(fs, 'readdirSync').mockImplementation(((p: any, ...rest: any[]) => {
      const rel = virtual(p);
      if (rel === undefined) return (realReaddir as any)(p, ...rest);
      return Object.keys(snapshot).filter((k) => k.startsWith('data/')).map((k) => k.slice(5));
    }) as any);
    for (const write of ['writeFileSync', 'copyFileSync', 'mkdirSync', 'rmSync', 'unlinkSync'] as const) {
      jest.spyOn(fs, write).mockImplementation(() => {
        throw new Error(`unexpected filesystem write: ${write}`);
      });
    }

    jest.spyOn(service as any, 'ensureExtractedCache').mockResolvedValue(CACHE);
    jest.spyOn(service as any, 'restoreMediaFiles').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'runFullSqlRestore').mockRejectedValue(new Error('full SQL restore must not run'));
    jest.spyOn(service, 'generateBackup').mockResolvedValue({ id: 100, status: BackupStatus.PENDING } as any);
    // The safety-backup poll waits 1 s per check
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as any);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('category selection', () => {
    it('maps each category to exactly its own tables, in restore order, never users/roles/departments/task_types', () => {
      const resolve = (categories: string[]) => (service as any).resolveCategoryRestore(fullBackup, categories);
      expect(resolve(['FINANCE']).tables).toEqual(FINANCE_TABLES);
      expect(resolve(['CLIENTS']).tables).toEqual(CLIENTS_TABLES);
      expect(resolve(['OPERATIONS']).tables).toEqual(OPERATIONS_TABLES);
      expect(resolve(['HR']).tables).toEqual(HR_TABLES);
      expect(resolve(['DOCUMENTS']).tables).toEqual([]);
      const all = resolve(['HR', 'FINANCE', 'OPERATIONS', 'CLIENTS', 'DOCUMENTS', 'HR']);
      expect(all.categories).toEqual(['HR', 'FINANCE', 'OPERATIONS', 'CLIENTS', 'DOCUMENTS']);
      expect(all.tables).toEqual([...CLIENTS_TABLES, ...OPERATIONS_TABLES, ...FINANCE_TABLES, ...HR_TABLES]);
      for (const table of ['users', 'roles', 'departments', 'task_types']) expect(all.tables).not.toContain(table);
    });

    it('restores only the selected tables; unselected tables in the backup are never touched', async () => {
      const result = await restore(fullBackup, { categories: [BackupCategory.FINANCE] });

      expect(result).toMatchObject({ selected_categories: ['FINANCE'], restored_tables: ['invoices', 'invoice_items'], attempted: 3, restored: 3, failed: 0 });
      expect(prisma.invoice.create).toHaveBeenCalledTimes(2);
      expect(prisma.invoiceItem.create).toHaveBeenCalledTimes(1);
      for (const model of MODELS.filter((m) => !['invoice', 'invoiceItem', 'invoicePayment', 'proposal', 'proposalItem'].includes(m))) {
        expect(prisma[model].findUnique).not.toHaveBeenCalled();
        expect(writesTo(model)).toEqual([]);
      }
      expect((service as any).runFullSqlRestore).not.toHaveBeenCalled();
    });

    it('restores several selected categories and nothing else', async () => {
      const result = await restore(fullBackup, { categories: [BackupCategory.HR, BackupCategory.CLIENTS] });

      expect(result.restored_tables).toEqual(['clients', 'employees']);
      expect(prisma.client.create).toHaveBeenCalledTimes(1);
      expect(prisma.employee.create).toHaveBeenCalledTimes(1);
      expect(writesTo('invoice')).toEqual([]);
      expect(writesTo('project')).toEqual([]);
    });

    it('DOCUMENTS alone writes no table', async () => {
      const result = await restore(fullBackup, { categories: [BackupCategory.DOCUMENTS] });
      expect(result).toMatchObject({ restored_tables: [], attempted: 0, restored: 0 });
      expect(allWriteData()).toEqual([]);
    });

    it.each([
      ['missing', undefined, /Select at least one category/],
      ['empty', [], /Select at least one category/],
      ['not an array', 'FINANCE', /Select at least one category/],
      ['unknown value', ['PAYROLL'], /Invalid category/],
      ['non-string value', [42], /Invalid category/],
      ['CUSTOM (nothing to restore)', ['CUSTOM'], /CUSTOM category cannot be restored/],
    ])('rejects a %s selection before the safety backup or any write', async (_label, categories, message) => {
      await expect(restore(fullBackup, { categories })).rejects.toThrow(BadRequestException);
      await expect(restore(fullBackup, { categories })).rejects.toThrow(message);
      expect(service.generateBackup).not.toHaveBeenCalled();
      expect(allWriteData()).toEqual([]);
    });

    it('rejects categories a category backup does not contain (no fallback to the backup categories)', async () => {
      await expect(restore(financeBackup, { categories: [BackupCategory.FINANCE, BackupCategory.HR] })).rejects.toThrow(
        'Backup #2 does not contain: HR. It contains: FINANCE, DOCUMENTS.',
      );
      await expect(restore(financeBackup, { categories: undefined })).rejects.toThrow(/Select at least one category/);
      expect(service.generateBackup).not.toHaveBeenCalled();
      expect(allWriteData()).toEqual([]);

      await expect(restore(financeBackup, { categories: [BackupCategory.FINANCE] })).resolves.toMatchObject({ restored: 3 });
    });

    it('does not echo an invalid category value back', async () => {
      const error = await restore(fullBackup, { categories: ['<script>x</script>'] }).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).not.toContain('<script>');
    });
  });

  describe('passwords, users and roles', () => {
    it('never writes users or roles, even when selected categories reference them and the backup contains them', async () => {
      await restore(fullBackup, { categories: [BackupCategory.HR, BackupCategory.OPERATIONS, BackupCategory.CLIENTS, BackupCategory.FINANCE] });

      for (const model of NEVER_RESTORED) {
        expect(prisma[model].findUnique).not.toHaveBeenCalled();
        expect(writesTo(model)).toEqual([]);
      }
    });

    it('never writes a password field or the [REDACTED] placeholder (create and update)', async () => {
      snapshot['data/clients.json'] = [
        { id: 5, name: 'Existing', password: '[REDACTED]', notes: '[REDACTED]' },
        { id: 6, name: 'New', password: '$2b$10$snapshot-hash-must-not-be-written' },
      ];
      prisma.client.findUnique.mockImplementation(async ({ where }: any) => (where.id === 5 ? { id: 5 } : null));

      await restore(fullBackup, { categories: [BackupCategory.CLIENTS] });

      expect(prisma.client.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { id: 5, name: 'Existing' } });
      expect(prisma.client.create).toHaveBeenCalledWith({ data: { id: 6, name: 'New' } });
      for (const data of allWriteData()) {
        expect(data).not.toHaveProperty('password');
        expect(JSON.stringify(data)).not.toContain('[REDACTED]');
      }
    });

    it('keeps the existing strategies: UPSERT updates existing rows, SKIP_EXISTING leaves them; missing rows are created', async () => {
      prisma.invoice.findUnique.mockImplementation(async ({ where }: any) => (where.id === 1 ? { id: 1 } : null));

      const skipped = await restore(fullBackup, { categories: [BackupCategory.FINANCE], conflictStrategy: 'SKIP_EXISTING' });
      expect(skipped).toMatchObject({ attempted: 3, restored: 2, skipped: 1 });
      expect(prisma.invoice.update).not.toHaveBeenCalled();
      expect(prisma.invoice.create).toHaveBeenCalledWith({ data: { id: 2, client_id: 5, total: 200 } });

      prisma.invoice.create.mockClear();
      const upserted = await restore(fullBackup, { categories: [BackupCategory.FINANCE], conflictStrategy: 'UPSERT' });
      expect(upserted).toMatchObject({ attempted: 3, restored: 3, skipped: 0 });
      // Relation objects are stripped, as before
      expect(prisma.invoice.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { id: 1, client_id: 5, total: 100 } });
    });
  });

  describe('partial failures', () => {
    const SECRET_ROW_VALUE = 'row-value-4111-1111-1111-1111';

    it('reports exact counts per table without database messages or row values, and does not roll back', async () => {
      prisma.invoice.create.mockImplementation(async ({ data }: any) => {
        if (data.id === 2) {
          throw Object.assign(new Error(`Foreign key constraint failed on the field: \`client_id\` value ${SECRET_ROW_VALUE}`), { code: 'P2003' });
        }
        return {};
      });

      const error = await restore(fullBackup, { categories: [BackupCategory.FINANCE] }).catch((e) => e);

      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect(error.message).toContain('Category restore partially failed: 1 of 3 record(s) could not be restored (invoices: 1)');
      expect(error.message).toContain('2 record(s) were restored and 0 skipped; restored records were not rolled back.');
      expect(error.message).toContain('pre-restore safety backup (#100)');
      expect(error.message).not.toContain(SECRET_ROW_VALUE);
      expect(error.message).not.toContain('Foreign key');
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('invoices row #2 failed (P2003)');
      expect(logged).not.toContain(SECRET_ROW_VALUE);
    });

    it('reports an unreadable snapshot file instead of silently skipping it', async () => {
      snapshot['data/invoice_items.json'] = '{not json';

      const error = await restore(fullBackup, { categories: [BackupCategory.FINANCE] }).catch((e) => e);

      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect(error.message).toContain('unreadable snapshot file(s): invoice_items');
      expect(error.message).toContain('2 record(s) were restored');
      expect(prisma.invoiceItem.create).not.toHaveBeenCalled();
    });
  });

  describe('previewRestore', () => {
    it('lists only the selected categories\' tables and their record counts', async () => {
      prisma.backupRecord.findUnique.mockResolvedValue(fullBackup);
      const preview = await service.previewRestore(1, { restoreMode: 'CATEGORY', categories: [BackupCategory.FINANCE] });
      expect(preview.tables_affected.sort()).toEqual(['invoice_items', 'invoices']);
      expect(preview.total_records_in_snapshot).toBe(3);
      expect(preview.selected_categories).toEqual(['FINANCE']);
    });

    it('rejects an invalid selection', async () => {
      prisma.backupRecord.findUnique.mockResolvedValue(financeBackup);
      await expect(service.previewRestore(2, { restoreMode: 'CATEGORY', categories: [] })).rejects.toThrow(BadRequestException);
      await expect(service.previewRestore(2, { restoreMode: 'CATEGORY', categories: [BackupCategory.HR] })).rejects.toThrow(BadRequestException);
    });

    it('FULL preview is unchanged and still lists every table', async () => {
      prisma.backupRecord.findUnique.mockResolvedValue(fullBackup);
      const preview = await service.previewRestore(1, { restoreMode: 'FULL' });
      expect(preview.tables_affected).toEqual(expect.arrayContaining(['users', 'roles', 'invoices', 'clients']));
    });
  });
});
