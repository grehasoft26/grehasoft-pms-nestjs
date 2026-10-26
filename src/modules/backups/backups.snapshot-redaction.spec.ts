import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { BackupStatus, BackupType } from '@prisma/client';
import { BackupsService } from './backups.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';

/**
 * servers.password (credential ciphertext) never leaves the backup module through JSON snapshots,
 * the explorer or the restore preview: it is omitted (no placeholder), also when an archive
 * written before this fix still contains it. Mocked records and an in-memory file system only.
 */
const CIPHERTEXT = 'gcm1:1:FAKEIVFAKEIV:FAKETAGFAKETAG:FAKECIPHERTEXT-test-fixture';
const serverRow = () => ({
  id: 1,
  name: 'Prod web',
  provider: 'Hetzner',
  owner: 'Grehasoft',
  server_ip: '203.0.113.10',
  ip_address: '203.0.113.11',
  notes: 'Primary',
  username: 'deploy',
  password: CIPHERTEXT,
  phone_number: '+91 0000000000',
  purchase_date: '2026-01-01T00:00:00.000Z',
  expiry_date: '2027-01-01T00:00:00.000Z',
  renewal_period_value: 1,
  renewal_period_unit: 'year',
  created_at: '2026-01-01T00:00:00.000Z',
});
const serverMetadata: Record<string, unknown> = serverRow();
delete serverMetadata.password;

// hr_documents are exported with employee.user, the full user row (fake bcrypt-shaped fixture)
const PASSWORD_HASH = '$2b$10$FAKEHASHFAKEHASHFAKEHASHtest-fixture-only';
const hrUser = () => ({ id: 31, username: 'jdoe', name: 'J Doe', email: 'jdoe@example.test', role_id: 2, is_active: true, password: PASSWORD_HASH });
const hrDocumentRow = () => ({
  id: 11,
  employee_id: 21,
  doc_type: 'offer_letter',
  pdf_file: null,
  payload: { salary: 1000, joining_date: '2026-02-01' },
  created_by_id: 1,
  created_at: '2026-02-01T00:00:00.000Z',
  employee: { id: 21, user_id: 31, position: 'Developer', department_id: 4, user: hrUser() },
});
const hrDocumentWithoutHash = () => {
  const row: any = hrDocumentRow();
  delete row.employee.user.password;
  return row;
};

const CACHE = path.join(path.sep, 'virtual-backup-cache');

describe('BackupsService server password redaction', () => {
  let service: BackupsService;
  let prismaRows: Record<string, any[]>;
  let written: Map<string, string>;
  let archive: Record<string, unknown>;

  beforeEach(async () => {
    jest.spyOn(BackupsService.prototype as any, 'ensureDirectoryExists').mockImplementation(() => undefined);
    prismaRows = {};
    const backupRecord = {
      findUnique: jest.fn().mockResolvedValue({ id: 1, filename: 'full.zip', backup_type: BackupType.FULL_SYSTEM, status: BackupStatus.COMPLETED }),
    };
    // Any other model: findMany returns prismaRows[model] (empty by default)
    const prisma = new Proxy({ backupRecord } as any, {
      get: (target, model: string) => target[model] ?? { findMany: jest.fn(async () => prismaRows[model] ?? []) },
    });

    const moduleRef = await Test.createTestingModule({
      providers: [BackupsService, { provide: PrismaService, useValue: prisma }, { provide: PdfService, useValue: {} }],
    }).compile();
    service = moduleRef.get(BackupsService);

    // An archive written before this fix: servers.json still holds the ciphertext
    archive = {
      'manifest.json': { manifest_version: '2.0', filename: 'full.zip' },
      'data/servers.json': [serverRow(), { ...serverRow(), id: 2, name: 'Staging', password: null }],
      'data/domains.json': [{ id: 3, domain_name: 'example.com', server_id: 1 }],
      // ...and hr_documents.json still holds the nested user password hash
      'data/hr_documents.json': [hrDocumentRow()],
      'data/employees.json': [{ id: 21, user_id: 31, position: 'Developer', department_id: 4 }],
      'data/users.json': [{ id: 31, username: 'jdoe', name: 'J Doe', password: '[REDACTED]' }],
    };
    // Case-insensitive lookup, like the Windows and macOS file systems
    const entry = (p: fs.PathLike) => {
      const rel = path.relative(CACHE, String(p));
      if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
      const key = rel.split(path.sep).join('/').toLowerCase();
      return Object.keys(archive).find((k) => k.toLowerCase() === key) ?? (key === '' || key === 'data' ? key : null);
    };
    const realExists = fs.existsSync;
    const realRead = fs.readFileSync;
    const realReaddir = fs.readdirSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      const key = entry(p);
      return key === undefined ? realExists(p) : key !== null;
    });
    jest.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      const key = entry(p);
      if (key === undefined) return (realRead as any)(p, ...rest);
      return JSON.stringify(archive[key as string]);
    }) as any);
    jest.spyOn(fs, 'readdirSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (entry(p) === undefined) return (realReaddir as any)(p, ...rest);
      return Object.keys(archive).filter((k) => k.startsWith('data/')).map((k) => k.slice(5));
    }) as any);
    // Snapshot writes are captured in memory; any other write fails the test
    written = new Map();
    jest.spyOn(fs, 'writeFileSync').mockImplementation(((p: any, data: any) => {
      if (!String(p).startsWith(CACHE)) throw new Error(`unexpected write outside the virtual backup: ${p}`);
      written.set(path.basename(String(p)), String(data));
    }) as any);
    for (const write of ['copyFileSync', 'mkdirSync', 'rmSync', 'unlinkSync'] as const) {
      jest.spyOn(fs, write).mockImplementation(() => {
        throw new Error(`unexpected filesystem write: ${write}`);
      });
    }
    jest.spyOn(service as any, 'ensureExtractedCache').mockResolvedValue(CACHE);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('sanitizeRecordForSnapshot', () => {
    const sanitize = (table: string, row: any) => (service as any).sanitizeRecordForSnapshot(table, row);

    it('omits the password field entirely and keeps all other server metadata', () => {
      const clean = sanitize('servers', serverRow());
      expect(clean).not.toHaveProperty('password');
      expect(clean).toEqual(serverMetadata);
    });

    it('does not modify the source record', () => {
      const source = serverRow();
      const before = JSON.parse(JSON.stringify(source));
      const clean = sanitize('servers', source);
      expect(source).toEqual(before);
      expect(source.password).toBe(CIPHERTEXT);
      expect(clean).not.toBe(source);
    });

    it.each(['servers', 'servers.json', 'SERVERS', 'Servers.JSON'])('applies to the table name variant %s', (table) => {
      expect(sanitize(table, serverRow())).not.toHaveProperty('password');
    });

    it('leaves other tables as before (users keep the placeholder; unrelated tables untouched)', () => {
      expect(sanitize('users', { id: 1, password: 'hash' })).toEqual({ id: 1, password: '[REDACTED]' });
      expect(sanitize('domains', { id: 3, password: 'not-a-secret-column' })).toEqual({ id: 3, password: 'not-a-secret-column' });
    });
  });

  describe('JSON snapshots', () => {
    it('a full-system snapshot writes servers.json without the password or its ciphertext', async () => {
      const source = [serverRow()];
      prismaRows.server = source;
      const counts: Record<string, number> = {};

      await (service as any).exportFullSnapshotsAndDocuments(path.join(CACHE, 'data'), path.join(CACHE, 'documents'), counts, {});

      const json = written.get('servers.json')!;
      expect(json).toBeDefined();
      expect(json).not.toContain(CIPHERTEXT);
      expect(json).not.toContain('"password"');
      expect(JSON.parse(json)).toEqual([serverMetadata]);
      expect(counts.servers).toBe(1);
      expect(source[0].password).toBe(CIPHERTEXT); // the fetched record is not mutated
      for (const [file, content] of written) {
        expect({ file, leaked: content.includes(CIPHERTEXT) }).toEqual({ file, leaked: false });
      }
    });
  });

  describe('explorer and preview (archive written before this fix)', () => {
    // Case and path variants never reach the file system (backups.explorer-entity.spec.ts)
    it.each(['servers'])('entity list (%s) omits the password', async (entityName) => {
      const res = await service.getExplorerEntityRecords(1, entityName, {});
      expect(res.total_count).toBe(2);
      expect(res.records[0]).toEqual(serverMetadata);
      for (const record of res.records) expect(record).not.toHaveProperty('password');
      expect(JSON.stringify(res)).not.toContain(CIPHERTEXT);
    });

    it('search cannot match on the omitted ciphertext but still finds metadata', async () => {
      expect((await service.getExplorerEntityRecords(1, 'servers', { search: 'FAKECIPHERTEXT' })).total_count).toBe(0);
      expect((await service.getExplorerEntityRecords(1, 'servers', { search: 'gcm1:' })).total_count).toBe(0);
      expect((await service.getExplorerEntityRecords(1, 'servers', { search: 'prod web' })).total_count).toBe(1);
    });

    it.each(['servers'])('record detail (%s) omits the password', async (entityName) => {
      const res = await service.getExplorerRecordDetail(1, entityName, 1);
      expect(res.record).toEqual(serverMetadata);
      expect(JSON.stringify(res)).not.toContain(CIPHERTEXT);
    });

    it('summary and restore preview contain counts and table names only', async () => {
      const summary = await service.getExplorerSummary(1);
      expect(summary.entities).toEqual(expect.arrayContaining([{ name: 'servers', display_name: 'Servers', count: 2 }]));
      expect(JSON.stringify(summary)).not.toContain(CIPHERTEXT);

      const preview = await service.previewRestore(1, { restoreMode: 'FULL' });
      expect(preview.tables_affected).toContain('servers');
      expect(JSON.stringify(preview)).not.toContain(CIPHERTEXT);
    });

    it('other tables are returned unchanged', async () => {
      const res = await service.getExplorerEntityRecords(1, 'domains', {});
      expect(res.records).toEqual([{ id: 3, domain_name: 'example.com', server_id: 1 }]);
    });
  });

  describe('nested employee.user password hash (hr_documents)', () => {
    const sanitize = (table: string, row: any) => (service as any).sanitizeRecordForSnapshot(table, row);
    const jsonFiles = () => [...written].filter(([file]) => file.endsWith('.json'));

    it('omits only the nested password and keeps all HR document, employee and user metadata', () => {
      expect(sanitize('hr_documents', hrDocumentRow())).toEqual(hrDocumentWithoutHash());
      expect(sanitize('hr_documents', hrDocumentRow()).employee.user).toEqual({
        id: 31,
        username: 'jdoe',
        name: 'J Doe',
        email: 'jdoe@example.test',
        role_id: 2,
        is_active: true,
      });
    });

    it.each(['hr_documents', 'hr_documents.json', 'HR_DOCUMENTS'])('applies to the table name variant %s', (table) => {
      expect(sanitize(table, hrDocumentRow()).employee.user).not.toHaveProperty('password');
    });

    it('does not modify the source record or share nested objects with it', () => {
      const source = hrDocumentRow();
      const before = JSON.parse(JSON.stringify(source));
      const clean = sanitize('hr_documents', source);
      expect(source).toEqual(before);
      expect(source.employee.user.password).toBe(PASSWORD_HASH);
      expect(clean.employee).not.toBe(source.employee);
      expect(clean.employee.user).not.toBe(source.employee.user);
    });

    it('leaves rows without a nested user unchanged', () => {
      const noEmployee = { id: 12, employee_id: 22, doc_type: 'payslip' };
      const nullEmployee = { ...noEmployee, employee: null };
      const nullUser = { ...noEmployee, employee: { id: 22, user: null } };
      for (const row of [noEmployee, nullEmployee, nullUser]) expect(sanitize('hr_documents', row)).toEqual(row);
    });

    it('full-system snapshot: hr_documents.json has no password hash', async () => {
      const source = [hrDocumentRow()];
      prismaRows.hRDocument = source;

      await (service as any).exportFullSnapshotsAndDocuments(path.join(CACHE, 'data'), path.join(CACHE, 'documents'), {}, {});

      expect(JSON.parse(written.get('hr_documents.json')!)).toEqual([hrDocumentWithoutHash()]);
      for (const [file, content] of jsonFiles()) expect({ file, leaked: content.includes(PASSWORD_HASH) }).toEqual({ file, leaked: false });
      expect(source[0].employee.user.password).toBe(PASSWORD_HASH);
    });

    it('HR category snapshot: hr_documents.json has no password hash (reference users keep the placeholder)', async () => {
      prismaRows.employee = [{ id: 21, user_id: 31, position: 'Developer', department_id: 4 }];
      prismaRows.hRDocument = [hrDocumentRow()];
      prismaRows.user = [hrUser()];

      await (service as any).exportCategorySnapshotsAndDocuments(
        ['HR'],
        path.join(CACHE, 'database', 'hr.sql'),
        path.join(CACHE, 'data'),
        path.join(CACHE, 'documents'),
        path.join(CACHE, 'media'),
        {},
        {},
      );

      expect(JSON.parse(written.get('hr_documents.json')!)).toEqual([hrDocumentWithoutHash()]);
      expect(JSON.parse(written.get('users.json')!)[0].password).toBe('[REDACTED]');
      for (const [file, content] of jsonFiles()) expect({ file, leaked: content.includes(PASSWORD_HASH) }).toEqual({ file, leaked: false });
    });

    it.each(['hr_documents'])('explorer list (%s) of an older archive omits the hash', async (entityName) => {
      const res = await service.getExplorerEntityRecords(1, entityName, {});
      expect(res.records).toEqual([hrDocumentWithoutHash()]);
      expect(JSON.stringify(res)).not.toContain(PASSWORD_HASH);
    });

    it('explorer search cannot match the hash but still finds user metadata', async () => {
      for (const probe of ['FAKEHASH', '$2b$10$', 'test-fixture-only']) {
        expect((await service.getExplorerEntityRecords(1, 'hr_documents', { search: probe })).total_count).toBe(0);
      }
      expect((await service.getExplorerEntityRecords(1, 'hr_documents', { search: 'jdoe' })).total_count).toBe(1);
    });

    it('explorer detail of an HR document omits the hash', async () => {
      const res = await service.getExplorerRecordDetail(1, 'hr_documents', 11);
      expect(res.record).toEqual(hrDocumentWithoutHash());
      expect(JSON.stringify(res)).not.toContain(PASSWORD_HASH);
    });

    it('explorer related records (employee detail -> hr_documents, user) omit the hash', async () => {
      const res = await service.getExplorerRecordDetail(1, 'employees', 21);
      expect(res.relations.hr_documents).toEqual([hrDocumentWithoutHash()]);
      expect(res.relations.user).toEqual({ id: 31, username: 'jdoe', name: 'J Doe', password: '[REDACTED]' });
      expect(JSON.stringify(res)).not.toContain(PASSWORD_HASH);
    });

    it('server password redaction still applies alongside it', async () => {
      const res = await service.getExplorerEntityRecords(1, 'servers', {});
      expect(JSON.stringify(res)).not.toContain(CIPHERTEXT);
    });
  });
});
