import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  INestApplication,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as request from 'supertest';
import { BackupStatus, BackupType } from '@prisma/client';
import { BackupsService } from './backups.service';
import { BackupsController } from './backups.controller';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';

/**
 * GET :id/explorer/documents/download?path= serves only files below the selected backup's
 * documents/ directory (canonical path boundaries, links resolved). Two in-memory backup caches,
 * backup_5 and backup_50 (a string prefix of each other); every path touched is recorded.
 */
describe('Backup explorer document download', () => {
  let service: BackupsService;
  let cacheRoot: string;
  let files: Map<string, 'file' | 'dir'>;
  let links: Map<string, string>;
  let touched: string[];

  const at = (...parts: string[]) => path.join(cacheRoot, ...parts);
  const B5 = 'backup_5';
  const B50 = 'backup_50';

  beforeEach(async () => {
    jest.spyOn(BackupsService.prototype as any, 'ensureDirectoryExists').mockImplementation(() => undefined);
    const prisma: any = {
      backupRecord: {
        findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, filename: `b${where.id}.zip`, backup_type: BackupType.FULL_SYSTEM, status: BackupStatus.COMPLETED })),
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [BackupsService, { provide: PrismaService, useValue: prisma }, { provide: PdfService, useValue: {} }],
    }).compile();
    service = moduleRef.get(BackupsService);
    cacheRoot = (service as any).getCacheRootDir();
    // Same cache directory selection as ensureExtractedCache (extraction itself is not exercised)
    jest.spyOn(service as any, 'ensureExtractedCache').mockImplementation(async (id: any) => path.join(cacheRoot, `backup_${id}`));

    files = new Map();
    const add = (type: 'file' | 'dir', ...parts: string[]) => files.set(at(...parts), type);
    for (const id of [B5, B50]) {
      for (const dir of ['', 'documents', 'documents/invoices', 'documents/tasks', 'documents/hr', 'documents/hr/2026', 'data', 'database']) {
        add('dir', id, ...dir.split('/').filter(Boolean));
      }
      for (const file of ['manifest.json', 'data/servers.json', 'data/hr_documents.json', 'database/database.sql', 'database/hr.sql']) {
        add('file', id, ...file.split('/'));
      }
    }
    add('file', B5, 'documents', 'invoices', 'INV-2026.001.pdf');
    add('file', B5, 'documents', 'tasks', 'Design spec (v2) – final.pdf');
    add('file', B5, 'documents', 'tasks', 'Design spec (v2).pdf');
    add('file', B5, 'documents', 'hr', 'ശമ്പള സർട്ടിഫിക്കറ്റ്.pdf');
    add('file', B5, 'documents', 'tasks', 'say "hi" 100% [draft].pdf');
    add('file', B5, 'documents', 'hr', '2026', 'offer_letter_11.pdf');
    add('file', B50, 'documents', 'invoices', 'OTHER.pdf');
    add('file', 'outside.pdf');
    // documents/invoices/link.pdf is a link to another backup's document
    add('file', B5, 'documents', 'invoices', 'link.pdf');
    links = new Map([[at(B5, 'documents', 'invoices', 'link.pdf'), at(B50, 'documents', 'invoices', 'OTHER.pdf')]]);

    touched = [];
    const virtual = (p: any) => path.resolve(String(p)).startsWith(path.resolve(cacheRoot, '..'));
    const realExists = fs.existsSync;
    const realStat = fs.statSync;
    const realRealpath = fs.realpathSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      if (!virtual(p)) return realExists(p);
      touched.push(path.resolve(String(p)));
      return files.has(path.resolve(String(p)));
    });
    jest.spyOn(fs, 'statSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (!virtual(p)) return (realStat as any)(p, ...rest);
      touched.push(path.resolve(String(p)));
      const type = files.get(path.resolve(String(p)));
      if (!type) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isFile: () => type === 'file', isDirectory: () => type === 'dir', size: 1 };
    }) as any);
    jest.spyOn(fs, 'realpathSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (!virtual(p)) return (realRealpath as any)(p, ...rest);
      touched.push(path.resolve(String(p)));
      return links.get(path.resolve(String(p))) ?? path.resolve(String(p));
    }) as any);
    for (const op of ['readFileSync', 'createReadStream', 'readdirSync', 'writeFileSync', 'copyFileSync', 'mkdirSync', 'rmSync', 'unlinkSync'] as const) {
      jest.spyOn(fs, op).mockImplementation(((p: any, ...rest: any[]) => {
        if (virtual(p)) throw new Error(`unexpected ${op} in a backup cache`);
        return (jest.requireActual('fs') as any)[op](p, ...rest);
      }) as any);
    }
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const outsideDocuments = () => touched.filter((p) => !p.startsWith(at(B5, 'documents') + path.sep) && p !== at(B5, 'documents'));

  describe('valid documents', () => {
    it.each([
      ['documents/invoices/INV-2026.001.pdf', 'INV-2026.001.pdf'],
      ['documents/tasks/Design spec (v2) – final.pdf', 'Design spec (v2) – final.pdf'],
      ['documents/hr/2026/offer_letter_11.pdf', 'offer_letter_11.pdf'], // nested below a category
    ])('%s is served from backup 5', async (relativePath, filename) => {
      const result = await service.getExplorerDocumentPath(5, relativePath);
      expect(result).toEqual({ filePath: at(B5, ...relativePath.split('/')), filename });
      expect(outsideDocuments()).toEqual([]);
    });

    it('the same relative path resolves inside the requested backup only', async () => {
      await expect(service.getExplorerDocumentPath(50, 'documents/invoices/OTHER.pdf')).resolves.toMatchObject({ filePath: at(B50, 'documents', 'invoices', 'OTHER.pdf') });
      await expect(service.getExplorerDocumentPath(5, 'documents/invoices/OTHER.pdf')).rejects.toThrow(NotFoundException);
    });
  });

  describe('rejected paths (400, before extraction or any file access, input not echoed)', () => {
    const REJECTED: unknown[] = [
      // other backup files
      'data/servers.json', 'data/hr_documents.json', 'manifest.json', 'database/database.sql', 'database/hr.sql',
      'documents', 'documents/', 'Documents/invoices/INV-2026.001.pdf', 'documentsX/a.pdf',
      // traversal and dot segments
      'documents/../data/servers.json', 'documents/invoices/../../data/servers.json', 'documents/invoices/../../manifest.json',
      'documents/./invoices/INV-2026.001.pdf', 'documents/invoices/.', 'documents/..', '../backup_50/documents/invoices/OTHER.pdf',
      'documents/../../backup_50/documents/invoices/OTHER.pdf', 'documents/../../../outside.pdf', 'documents//invoices/INV-2026.001.pdf',
      // encoded and double-encoded
      'documents/%2e%2e/data/servers.json', 'documents/%2E%2E%2Fdata%2Fservers.json', 'documents%2F..%2Fdata%2Fservers.json',
      'documents/%252e%252e/data/servers.json', 'documents/invoices/%5c..%5cmanifest.json', 'documents/invoices/x.pdf%00',
      // backslashes, absolute, drive and UNC paths
      'documents\\invoices\\INV-2026.001.pdf', 'documents/invoices\\..\\..\\data\\servers.json', '..\\backup_50\\documents\\invoices\\OTHER.pdf',
      '/etc/passwd', '/documents/invoices/INV-2026.001.pdf', path.join(cacheRoot ?? '', B5, 'documents', 'invoices', 'INV-2026.001.pdf'),
      'C:\\Windows\\win.ini', 'C:/Windows/win.ini', 'documents/C:/Windows/win.ini', 'documents/c:x.pdf', '\\\\server\\share\\doc.pdf', '//server/share/doc.pdf',
      // malformed
      'documents/invoices/x\u0000.pdf', 'documents/invoices/x\n.pdf', 'documents/invoices/\u001b.pdf', `documents/${'a'.repeat(1100)}.pdf`,
      ['documents/invoices/INV-2026.001.pdf'], 42, {}, true,
    ];

    it.each(REJECTED.map((value) => [JSON.stringify(value)?.slice(0, 80) ?? String(value), value]))('%s', async (_label, value) => {
      const error = await service.getExplorerDocumentPath(5, value).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe('Invalid document path.');
      expect((service as any).ensureExtractedCache).not.toHaveBeenCalled();
      expect(touched).toEqual([]);
    });

    it.each([undefined, null, ''])('a missing path (%p) is a 400', async (value) => {
      await expect(service.getExplorerDocumentPath(5, value)).rejects.toThrow('Query parameter "path" is required.');
      expect(touched).toEqual([]);
    });
  });

  describe('cross-backup access', () => {
    it('backup_5 vs backup_50: the old string-prefix check would have accepted it; the new boundary does not', async () => {
      const b5 = at(B5);
      const escaped = path.resolve(b5, '../backup_50/documents/invoices/OTHER.pdf');
      expect(escaped.startsWith(b5)).toBe(true); // why a prefix check is not a boundary

      for (const attempt of ['../backup_50/documents/invoices/OTHER.pdf', 'documents/../../backup_50/documents/invoices/OTHER.pdf']) {
        await expect(service.getExplorerDocumentPath(5, attempt)).rejects.toThrow(BadRequestException);
      }
      expect(touched).toEqual([]);
    });

    it('a link inside documents/ that leads to another backup is not served', async () => {
      const error = await service.getExplorerDocumentPath(5, 'documents/invoices/link.pdf').catch((e) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe('Requested document was not found in backup #5.');
    });
  });

  describe('not found (404, path not echoed)', () => {
    it.each(['documents/invoices/missing.pdf', 'documents/invoices', 'documents/hr/2026', 'documents/nope/x.pdf'])('%s', async (relativePath) => {
      const error = await service.getExplorerDocumentPath(5, relativePath).catch((e) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe('Requested document was not found in backup #5.');
      expect(outsideDocuments()).toEqual([]);
    });
  });

  describe('over HTTP (real controller and guards; sendFile captured)', () => {
    let app: INestApplication;
    const role = (name: string, permissions: string[]) => ({ name, permissions, deleted_at: null });
    const USERS: Record<string, any> = {
      super: { id: 1, username: 'owner', is_superuser: true, role: role('SUPER_ADMIN', []) },
      admin: { id: 2, username: 'admin', role: role('ADMIN', ['MANAGE_BACKUPS']) },
      adminNoPerm: { id: 3, username: 'admin2', role: role('ADMIN', ['MANAGE_USERS']) },
      opsWithPerm: { id: 4, username: 'ops', role: role('OPS', ['MANAGE_BACKUPS']) },
    };

    class TestAuthGuard implements CanActivate {
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest();
        const user = USERS[req.headers['x-test-user']];
        if (!user) throw new UnauthorizedException();
        req.user = user;
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
      // Report the file the controller would send instead of reading it
      app.use((req: any, res: any, next: any) => {
        res.sendFile = (filePath: string) => res.json({ sent: path.relative(cacheRoot, filePath).split(path.sep).join('/') });
        next();
      });
      await app.init();
    });

    afterEach(async () => app.close());

    const download = (query: string, user = 'super') =>
      request(app.getHttpServer()).get(`/api/v1/backups/5/explorer/documents/download?${query}`).set('x-test-user', user);

    it('serves a valid document (also nested, with a URL-encoded name)', async () => {
      const res = await download('path=documents/invoices/INV-2026.001.pdf').expect(200);
      expect(res.body).toEqual({ sent: 'backup_5/documents/invoices/INV-2026.001.pdf' });
      expect(res.headers['content-disposition']).toBe(`inline; filename="INV-2026.001.pdf"; filename*=UTF-8''INV-2026.001.pdf`);
      await download(`path=${encodeURIComponent('documents/hr/2026/offer_letter_11.pdf')}`).expect(200);
      await download(`path=${encodeURIComponent('documents/tasks/Design spec (v2).pdf')}`).expect(200);
    });

    describe('Content-Disposition for any file name', () => {
      const filenameStar = (header: string) => decodeURIComponent(/filename\*=UTF-8''(.*)$/.exec(header)![1]);
      const fallback = (header: string) => /filename="([^"]*)"/.exec(header)![1];

      it.each([
        ['documents/tasks/Design spec (v2) – final.pdf', 'Design spec (v2) – final.pdf'],
        ['documents/hr/ശമ്പള സർട്ടിഫിക്കറ്റ്.pdf', 'ശമ്പള സർട്ടിഫിക്കറ്റ്.pdf'],
        ['documents/tasks/say "hi" 100% [draft].pdf', 'say "hi" 100% [draft].pdf'],
        ['documents/tasks/Design spec (v2).pdf', 'Design spec (v2).pdf'],
      ])('%s downloads (200, was a 500 for non-Latin-1 names) with the exact name in filename*', async (relativePath, name) => {
        const res = await download(`path=${encodeURIComponent(relativePath)}`).expect(200);
        expect(res.body).toEqual({ sent: `backup_5/${relativePath}` });
        const header = res.headers['content-disposition'];
        expect(header.startsWith('inline; ')).toBe(true);
        expect(filenameStar(header)).toBe(name);
        expect(fallback(header)).toMatch(/^[\x20-\x7e]+$/);
        expect(fallback(header)).not.toMatch(/["\\%]/);
      });

      it('a CR/LF in the resolved name cannot inject a header', async () => {
        jest.spyOn(service, 'getExplorerDocumentPath').mockResolvedValueOnce({
          filePath: at(B5, 'documents', 'invoices', 'INV-2026.001.pdf'),
          filename: 'evil\r\nSet-Cookie: session=stolen\r\nX-Injected: 1.pdf',
        });
        const res = await download('path=documents/invoices/INV-2026.001.pdf').expect(200);
        expect(res.headers['set-cookie']).toBeUndefined();
        expect(res.headers['x-injected']).toBeUndefined();
        expect(res.headers['content-disposition']).not.toMatch(/[\r\n]/);
        expect(filenameStar(res.headers['content-disposition'])).toBe('evilSet-Cookie: session=stolenX-Injected: 1.pdf');
      });
    });

    it.each([
      'path=data/servers.json',
      'path=data%2Fhr_documents.json',
      'path=manifest.json',
      'path=database/database.sql',
      'path=documents%2F..%2Fdata%2Fservers.json',
      'path=documents/%252e%252e/data/servers.json',
      'path=documents%5Cinvoices%5CINV-2026.001.pdf',
      'path=..%2Fbackup_50%2Fdocuments%2Finvoices%2FOTHER.pdf',
      'path=%2Fetc%2Fpasswd',
      'path=C%3A%5CWindows%5Cwin.ini',
      'path=documents/invoices/x.pdf%00',
      'path=documents/a.pdf&path=documents/b.pdf',
      'path[x]=documents/invoices/INV-2026.001.pdf',
    ])('?%s is a 400 that does not echo the path', async (query) => {
      const res = await download(query).expect(400);
      expect(JSON.stringify(res.body)).not.toMatch(/servers|hr_documents|manifest|database|backup_50|passwd|win\.ini/);
      expect(touched).toEqual([]);
    });

    it('a missing path is a 400 and a missing file a 404', async () => {
      await download('').expect(400);
      const res = await download('path=documents/invoices/missing.pdf').expect(404);
      expect(JSON.stringify(res.body)).not.toContain('missing.pdf');
    });

    it('keeps authentication and authorization: 401 without a user, 403 without MANAGE_BACKUPS or an admin role', async () => {
      const ok = 'path=documents/invoices/INV-2026.001.pdf';
      await request(app.getHttpServer()).get(`/api/v1/backups/5/explorer/documents/download?${ok}`).expect(401);
      await download(ok, 'adminNoPerm').expect(403);
      await download(ok, 'opsWithPerm').expect(403);
      await download(ok, 'admin').expect(200);
    });
  });
});
