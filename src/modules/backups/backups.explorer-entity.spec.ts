import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { CanActivate, ExecutionContext, INestApplication, Logger, NotFoundException } from '@nestjs/common';
import * as request from 'supertest';
import { BackupStatus, BackupType } from '@prisma/client';
import { BackupsService } from './backups.service';
import { BackupsController } from './backups.controller';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';

/**
 * Backup explorer entityName policy: only the exact, case-sensitive names of the snapshot files the
 * exports write are accepted. Anything else (unknown, empty, paths, separators, dot segments,
 * encoded or case variants, non-strings) is a 404 "Unknown backup explorer entity." raised before
 * the archive is extracted or any file is touched. In-memory archive; every path read is recorded.
 */
const CACHE = path.join(path.sep, 'virtual-backup-cache');

// Independent of the service's allowlist: the names the export code writes
const SNAPSHOT_ENTITIES = [
  ...new Set(
    [...fs.readFileSync(path.join(__dirname, 'backups.service.ts'), 'utf8').matchAll(/writeJsonSnapshot\(dataDir, '([a-z_]+)'/g)].map((m) => m[1]),
  ),
].sort();

const REJECTED: unknown[] = [
  '', ' ', 'unknown', 'manifest', 'secret', 'data',
  'SERVERS', 'Servers', 'servers ', ' servers', 'servers\n', 'servers\0', 'servers.json', 'servers.JSON',
  '.', '..', './servers', '../servers', '..\\servers', 'data/servers', 'data\\servers', '../data/servers',
  '..\\data\\servers', 'servers/../users', 'servers/.', '....//servers', '/servers', '\\servers',
  '..%2Fdata%2Fservers', '%2e%2e%2fservers', '..%5cservers', 'servers%00', '%2e%2e',
  '/etc/passwd', 'C:\\Windows\\win.ini', '../../../../outside', '../manifest', '../documents/doc',
  'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf',
  undefined, null, 42, ['servers'], { toString: () => 'servers' },
];

describe('Backup explorer entityName validation', () => {
  let service: BackupsService;
  let archive: Record<string, unknown>;
  let touched: string[];

  beforeEach(async () => {
    jest.spyOn(BackupsService.prototype as any, 'ensureDirectoryExists').mockImplementation(() => undefined);
    const prisma: any = {
      backupRecord: { findUnique: jest.fn().mockResolvedValue({ id: 1, filename: 'full.zip', backup_type: BackupType.FULL_SYSTEM, status: BackupStatus.COMPLETED }) },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [BackupsService, { provide: PrismaService, useValue: prisma }, { provide: PdfService, useValue: {} }],
    }).compile();
    service = moduleRef.get(BackupsService);

    // Every supported entity, plus decoy JSON files outside the mapping (inside and outside the cache)
    archive = { 'manifest.json': { manifest_version: '2.0', decoy: 'manifest' } };
    for (const entity of SNAPSHOT_ENTITIES) archive[`data/${entity}.json`] = [{ id: 1, entity }];
    Object.assign(archive, {
      'data/secret.json': [{ id: 1, decoy: 'data-secret' }],
      'data/data.json': [{ id: 1, decoy: 'data-data' }],
      'documents/doc.json': [{ id: 1, decoy: 'documents' }],
      '../outside.json': [{ id: 1, decoy: 'outside-cache' }],
      '../../../../outside.json': [{ id: 1, decoy: 'far-outside' }],
    });
    const key = (p: fs.PathLike) => path.relative(CACHE, path.resolve(String(p))).split(path.sep).join('/');
    const virtualRoot = path.resolve(CACHE, '..');
    const isVirtual = (p: fs.PathLike) => path.resolve(String(p)).startsWith(virtualRoot);
    touched = [];
    const realExists = fs.existsSync;
    const realRead = fs.readFileSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      if (!isVirtual(p)) return realExists(p);
      touched.push(key(p));
      return key(p) in archive || ['', 'data', 'documents'].includes(key(p));
    });
    jest.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (!isVirtual(p)) return (realRead as any)(p, ...rest);
      touched.push(key(p));
      if (!(key(p) in archive)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return JSON.stringify(archive[key(p)]);
    }) as any);
    for (const write of ['writeFileSync', 'copyFileSync', 'mkdirSync', 'rmSync', 'unlinkSync'] as const) {
      jest.spyOn(fs, write).mockImplementation(() => {
        throw new Error(`unexpected filesystem write: ${write}`);
      });
    }
    jest.spyOn(service as any, 'ensureExtractedCache').mockResolvedValue(CACHE);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('the allowlist covers exactly the snapshot entities the exports write (50)', () => {
    expect(SNAPSHOT_ENTITIES).toHaveLength(50);
  });

  describe('supported entities', () => {
    it.each(SNAPSHOT_ENTITIES)('%s: list, search and detail read only data/%s.json', async (entity) => {
      const list = await service.getExplorerEntityRecords(1, entity, {});
      expect(list.entity).toBe(entity);
      expect(list.records).toHaveLength(1);
      expect(list.records[0]).toMatchObject({ id: 1, entity });
      expect((await service.getExplorerEntityRecords(1, entity, { search: entity })).total_count).toBe(1);
      expect(touched.every((p) => p === `data/${entity}.json`)).toBe(true);

      const detail = await service.getExplorerRecordDetail(1, entity, 1);
      expect(detail.entity).toBe(entity);
      expect(detail.record).toMatchObject({ id: 1, entity });
      // Related records come from fixed snapshot names only; documents/ is only probed for PDFs
      expect(touched.every((p) => p === 'documents' || /^documents\/[a-z]+\/[^/]+\.pdf$/.test(p) || /^data\/[a-z_]+\.json$/.test(p))).toBe(true);
      expect(touched.filter((p) => p.startsWith('data/')).every((p) => SNAPSHOT_ENTITIES.includes(p.slice(5, -5)))).toBe(true);
    });
  });

  describe('rejected entity names', () => {
    it.each(REJECTED.map((value) => [JSON.stringify(value) ?? String(value), value]))(
      '%s is a 404 before any file access, without echoing the input',
      async (_label, value) => {
        for (const call of [
          () => service.getExplorerEntityRecords(1, value as any, {}),
          () => service.getExplorerEntityRecords(1, value as any, { search: 'decoy' }),
          () => service.getExplorerRecordDetail(1, value as any, 1),
        ]) {
          const error = await call().catch((e) => e);
          expect(error).toBeInstanceOf(NotFoundException);
          expect(error.message).toBe('Unknown backup explorer entity.');
        }
        expect((service as any).ensureExtractedCache).not.toHaveBeenCalled();
        expect(touched).toEqual([]);
      },
    );

    it('no decoy file outside the snapshot mapping is ever read', async () => {
      for (const value of REJECTED) {
        await service.getExplorerEntityRecords(1, value as any, {}).catch(() => undefined);
        await service.getExplorerRecordDetail(1, value as any, 1).catch(() => undefined);
      }
      expect(touched).toEqual([]);
    });
  });

  describe('over HTTP (real controller, URL decoding by Express)', () => {
    let app: INestApplication;

    class TestAuthGuard implements CanActivate {
      canActivate(context: ExecutionContext) {
        context.switchToHttp().getRequest().user = { id: 1, username: 'owner', is_superuser: true, role: { name: 'SUPER_ADMIN', permissions: [] } };
        return true;
      }
    }

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [BackupsController],
        providers: [{ provide: BackupsService, useValue: service }],
      })
        .overrideGuard(JwtAuthGuard)
        .useClass(TestAuthGuard)
        .compile();
      app = moduleRef.createNestApplication();
      await app.init();
    });

    afterEach(async () => app.close());

    it('serves a supported entity (list and detail)', async () => {
      const list = await request(app.getHttpServer()).get('/api/v1/backups/1/explorer/entities/servers').expect(200);
      expect(list.body.records).toEqual([{ id: 1, entity: 'servers' }]);
      await request(app.getHttpServer()).get('/api/v1/backups/1/explorer/entities/servers/1/').expect(200);
    });

    it.each([
      '..%2Fdata%2Fservers',
      '..%2F..%2F..%2F..%2Foutside',
      '%2e%2e%2Fmanifest',
      '..%5Cdata%5Cservers',
      // (A bare "%2E%2E" segment is turned into ".." by the HTTP client itself; ".." is covered above)
      'servers%2Ejson',
      'SERVERS',
      'servers%00',
      'secret',
      '%252e%252e%252fmanifest',
    ])('GET .../entities/%s is a 404 and reads no file', async (encoded) => {
      for (const url of [`/api/v1/backups/1/explorer/entities/${encoded}`, `/api/v1/backups/1/explorer/entities/${encoded}/1`]) {
        const res = await request(app.getHttpServer()).get(url);
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain('decoy');
      }
      expect(touched).toEqual([]);
    });

    it('unencoded traversal never reaches a snapshot file', async () => {
      for (const url of ['/api/v1/backups/1/explorer/entities/../manifest', '/api/v1/backups/1/explorer/entities/data/servers/../../manifest']) {
        const res = await request(app.getHttpServer()).get(url);
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain('decoy');
      }
      expect(touched).toEqual([]);
    });
  });
});
