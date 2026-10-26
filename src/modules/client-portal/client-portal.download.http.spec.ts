import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as jwt from 'jsonwebtoken';
import * as request from 'supertest';
import { PrismaService } from '../../core/prisma.service';

/**
 * GET /api/v1/dashboard/documents/:id/download: a CLIENT user downloads one of their own vault
 * documents with the Authorization header (the page fetches it as a blob). Real controller, guard
 * and JWT strategy over HTTP; files live in a temporary media/task_files (never the repository's).
 */
const SECRET = 'test-jwt-secret-for-document-download-spec';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'grehasoft-vault-'));
const TASK_FILES = path.join(ROOT, 'media', 'task_files');
fs.mkdirSync(TASK_FILES, { recursive: true });
fs.writeFileSync(
  path.join(TASK_FILES, 'task_7_report.pdf'),
  '%PDF-1.4 client ten deliverable',
);
fs.writeFileSync(
  path.join(TASK_FILES, 'task_8_page.html'),
  '<script>alert(1)</script>',
);
fs.writeFileSync(
  path.join(TASK_FILES, 'task_9_other.pdf'),
  '%PDF-1.4 client twenty secret',
);
fs.writeFileSync(path.join(ROOT, 'outside-secret.txt'), 'must never be served');

// The service fixes media/ from process.cwd() when its module loads
jest.spyOn(process, 'cwd').mockReturnValue(ROOT);
// (required, not imported, so they load after the spy above)
/* eslint-disable @typescript-eslint/no-require-imports */
const { ClientPortalController } = require('./client-portal.controller');
const { ClientPortalService } = require('./client-portal.service');
const { JwtStrategy } = require('../../core/guards/jwt.strategy');
/* eslint-enable @typescript-eslint/no-require-imports */

const role = (name: string) => ({
  id: name === 'CLIENT' ? 9 : 2,
  name,
  permissions: [],
  deleted_at: null,
});
const USERS: any[] = [
  {
    id: 50,
    username: 'client10',
    client_id: 10,
    is_active: true,
    deleted_at: null,
    role: role('CLIENT'),
  },
  {
    id: 60,
    username: 'client20',
    client_id: 20,
    is_active: true,
    deleted_at: null,
    role: role('CLIENT'),
  },
  {
    id: 7,
    username: 'staff',
    client_id: null,
    is_active: true,
    deleted_at: null,
    role: role('DEVELOPER'),
  },
];
const PROJECTS: any = {
  1: { id: 1, client_id: 10, deleted_at: null },
  2: { id: 2, client_id: 20, deleted_at: null },
  3: { id: 3, client_id: 10, deleted_at: new Date('2026-09-01') },
};
const file = (
  id: number,
  projectId: number,
  stored: string,
  name: string,
  extra: any = {},
) => ({
  id,
  file: stored,
  file_path: name,
  deleted_at: null,
  task: { deleted_at: null, project: PROJECTS[projectId] },
  ...extra,
});
const FILES = [
  file(7, 1, 'task_files/task_7_report.pdf', 'Homepage Design – FINAL.pdf'),
  file(8, 1, 'task_files/task_8_page.html', 'landing.html'),
  file(9, 2, 'task_files/task_9_other.pdf', 'Other-Corp-Contract.pdf'),
  file(10, 1, 'task_files/../../outside-secret.txt', 'innocent.pdf'), // traversal in the stored path
  file(11, 1, 'task_files/missing.pdf', 'missing.pdf'), // record without content
  file(12, 1, 'task_files/task_7_report.pdf', 'deleted.pdf', {
    deleted_at: new Date('2026-10-01'),
  }),
  file(13, 3, 'task_files/task_7_report.pdf', 'archived.pdf'), // project soft-deleted
  file(14, 1, '../outside-secret.txt', '../../etc/passwd'), // path outside task_files
];

/** Evaluates the service's nested `where` (id, deleted_at, task.deleted_at, task.project.{client_id,deleted_at}). */
const matches = (row: any, where: any): boolean =>
  Object.entries(where).every(([key, cond]: [string, any]) =>
    cond !== null && typeof cond === 'object' && !(cond instanceof Date)
      ? matches(row?.[key] ?? {}, cond)
      : row?.[key] === cond,
  );

describe('Client document download (GET /dashboard/documents/:id/download)', () => {
  let app: INestApplication;
  const findFile = jest.fn(async ({ where, select }: any) => {
    const hit = FILES.find((f) => matches(f, where));
    return hit
      ? Object.fromEntries(Object.keys(select).map((k) => [k, (hit as any)[k]]))
      : null;
  });
  const sign = (sub: number) => jwt.sign({ sub }, SECRET, { expiresIn: '5m' });
  const get = (url: string, sub?: number) => {
    const req = request(app.getHttpServer())
      .get(url)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    return sub ? req.set('Authorization', `Bearer ${sign(sub)}`) : req;
  };

  beforeAll(async () => {
    const prisma = {
      user: {
        findFirst: jest.fn(
          async ({ where }: any) =>
            USERS.find((u) => u.id === where.id && u.is_active) ?? null,
        ),
      },
      client: {
        findFirst: jest.fn(async ({ where }: any) =>
          [10, 20].includes(where.id) ? { id: where.id } : null,
        ),
        findMany: jest.fn(async () => []),
      },
      taskFile: { findFirst: findFile },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [ClientPortalController],
      providers: [
        ClientPortalService,
        JwtStrategy,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'JWT_SECRET' ? SECRET : undefined),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('the owning client downloads the file: exact bytes, attachment, opaque type, no caching', async () => {
    const res = await get(
      '/api/v1/dashboard/documents/taskfile-7/download/',
      50,
    );
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('%PDF-1.4 client ten deliverable');
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Homepage Design _ FINAL.pdf"; filename*=UTF-8''Homepage%20Design%20%E2%80%93%20FINAL.pdf`,
    );
    expect(res.headers['content-length']).toBe(
      String('%PDF-1.4 client ten deliverable'.length),
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    // A bare id works too (and without the trailing slash)
    expect(
      (await get('/api/v1/dashboard/documents/7/download', 50)).status,
    ).toBe(200);
  });

  it('an uploaded HTML file is still only an opaque attachment (never rendered)', async () => {
    const res = await get(
      '/api/v1/dashboard/documents/taskfile-8/download/',
      50,
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; sandbox",
    );
  });

  it("another client's document is a 404, exactly like a missing one (no IDOR, no probing)", async () => {
    const other = await get(
      '/api/v1/dashboard/documents/taskfile-9/download/',
      50,
    );
    const missing = await get(
      '/api/v1/dashboard/documents/taskfile-999/download/',
      50,
    );
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(other.body.toString()).toBe(missing.body.toString());
    expect(other.body.toString()).not.toContain('client twenty secret');
    // The owner of that document can download it
    expect(
      (await get('/api/v1/dashboard/documents/taskfile-9/download/', 60))
        .status,
    ).toBe(200);
  });

  it('deleted files and files of deleted projects are not served', async () => {
    for (const id of [12, 13])
      expect(
        (await get(`/api/v1/dashboard/documents/taskfile-${id}/download/`, 50))
          .status,
      ).toBe(404);
  });

  it('stored paths outside media/task_files and missing content are never read (404)', async () => {
    for (const id of [10, 11, 14]) {
      const res = await get(
        `/api/v1/dashboard/documents/taskfile-${id}/download/`,
        50,
      );
      expect({ id, status: res.status }).toEqual({ id, status: 404 });
      expect(res.body.toString()).not.toContain('must never be served');
    }
  });

  it('malformed ids are a 404 (no path or other entity type reaches the lookup)', async () => {
    findFile.mockClear();
    for (const id of [
      'proposal-7',
      'taskfile-0',
      'taskfile-7x',
      '..%2F..%2Foutside-secret.txt',
      'taskfile-99999999999',
    ]) {
      expect({
        id,
        status: (await get(`/api/v1/dashboard/documents/${id}/download/`, 50))
          .status,
      }).toEqual({ id, status: 404 });
    }
    expect(findFile).not.toHaveBeenCalled();
  });

  it('invalid authentication: no token, a bad token or a token in the URL is a 401', async () => {
    expect(
      (await get('/api/v1/dashboard/documents/taskfile-7/download/')).status,
    ).toBe(401);
    const bad = await request(app.getHttpServer())
      .get('/api/v1/dashboard/documents/taskfile-7/download/')
      .set('Authorization', `Bearer ${jwt.sign({ sub: 50 }, 'wrong-secret')}`);
    expect(bad.status).toBe(401);
    expect(
      (
        await get(
          `/api/v1/dashboard/documents/taskfile-7/download/?token=${sign(50)}`,
        )
      ).status,
    ).toBe(401);
  });

  it('staff users are refused (the vault belongs to client-portal users)', async () => {
    expect(
      (await get('/api/v1/dashboard/documents/taskfile-7/download/', 7)).status,
    ).toBe(403);
  });
});
