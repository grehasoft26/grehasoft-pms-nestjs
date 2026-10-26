import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as nodeCrypto from 'crypto';
import { SeoService } from './seo.service';
import { CredentialCryptoService } from '../../core/credential-crypto.service';
import { CredentialAuditService } from '../credential-audit/credential-audit.service';

/**
 * Phase 2.2: SEO record-level authorization. Daily-log IDOR, item password exposure,
 * self-approval, task/reminder writes and SEO credentials. Since Stage 7 no response carries a
 * password (seo-credentials.http.spec covers the audited reveal endpoints).
 */
const CTX = { actorId: 1, actorUsername: 'tester', ipAddress: null, userAgent: null };
const MASK = '••••••••';
const manager = { id: 10, role: { name: 'SEO_MANAGER' } };
const exec = { id: 20, role: { name: 'SEO_EXECUTIVE' } };
const otherExec = { id: 21, role: { name: 'SEO_EXECUTIVE' } };
const member = { id: 30, role: { name: 'TEAM_MEMBER' } };
const client = { id: 40, client_id: 1, role: { name: 'CLIENT' } };
const otherClient = { id: 41, client_id: 2, role: { name: 'CLIENT' } };

const buildPrisma = () => ({
  sEODailyWorkLog: {
    findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, items: [] })),
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn(async ({ data }: any) => ({ id: 99, total_count: 0, items: [], ...data })),
    update: jest.fn(async ({ where, data }: any) => ({ id: where.id, items: [], ...data })),
    delete: jest.fn(async () => ({})),
  },
  sEODailyWorkLogItem: {
    create: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
    update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    findMany: jest.fn().mockResolvedValue([]),
  },
  credentialAuditLog: { create: jest.fn(async ({ data }: any) => data) },
  $transaction: jest.fn(),
  sEOTask: {
    findUnique: jest.fn(async ({ where }: any) => (where.id === 1 ? { id: 1, assigned_executive_id: exec.id } : null)),
    update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
  },
  sEOTaskTimeline: { create: jest.fn() },
  sEOReminder: {
    findUnique: jest.fn(async ({ where }: any) => (where.id === 1 ? { id: 1, assigned_executive_id: exec.id } : null)),
    update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    delete: jest.fn(async () => ({})),
  },
  sEOCredential: { findMany: jest.fn().mockResolvedValue([]) },
});

describe('SeoService security (Phase 2.2)', () => {
  let prisma: ReturnType<typeof buildPrisma>;
  let service: SeoService;
  let encrypted: string;
  let crypto: CredentialCryptoService;
  const KEY = nodeCrypto.randomBytes(32).toString('base64');

  const log = (overrides: any = {}) => ({
    id: 5,
    executive_id: exec.id,
    website_id: 3,
    website: { id: 3, client_id: 1, website_name: 'acme.test' },
    status: 'approved',
    total_count: 1,
    items: [{ id: 1, activity_type_id: 1, password: encrypted }],
    ...overrides,
  });

  beforeEach(() => {
    prisma = buildPrisma();
    prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));
    const config: any = { get: (k: string) => ({ CREDENTIAL_KEYS: `1:${KEY}`, CREDENTIAL_ACTIVE_KEY_VERSION: '1' } as any)[k] };
    crypto = new CredentialCryptoService(config);
    service = new SeoService(prisma as any, crypto, new CredentialAuditService(prisma as any));
    encrypted = crypto.encrypt('s3cret', { table: 'seo_daily_work_log_item', field: 'password', recordId: 1 });
  });

  describe('GET /seo-daily-logs/:id scope', () => {
    it('clients read approved logs of their own websites only', async () => {
      prisma.sEODailyWorkLog.findUnique.mockResolvedValue(log());
      await expect(service.getDailyLogById(client, 5)).resolves.toMatchObject({ id: 5 });
      await expect(service.getDailyLogById(otherClient, 5)).rejects.toThrow(NotFoundException);

      prisma.sEODailyWorkLog.findUnique.mockResolvedValue(log({ status: 'submitted' }));
      await expect(service.getDailyLogById(client, 5)).rejects.toThrow(NotFoundException);
    });

    it('executives read only their own logs; managers read any', async () => {
      prisma.sEODailyWorkLog.findUnique.mockResolvedValue(log());
      await expect(service.getDailyLogById(exec, 5)).resolves.toMatchObject({ id: 5 });
      await expect(service.getDailyLogById(otherExec, 5)).rejects.toThrow(NotFoundException);
      await expect(service.getDailyLogById(manager, 5)).resolves.toMatchObject({ id: 5 });
    });
  });

  describe('daily-log item passwords', () => {
    beforeEach(() => prisma.sEODailyWorkLog.findUnique.mockResolvedValue(log()));

    it('are never returned, even to managers and the log executive (masked; no decrypted_password)', async () => {
      for (const viewer of [manager, exec]) {
        const result: any = await service.getDailyLogById(viewer, 5);
        expect(result.items[0].password).toBe(MASK);
        expect(result.items[0]).not.toHaveProperty('decrypted_password');
        expect(JSON.stringify(result)).not.toMatch(/s3cret|gcm1/);
      }
    });

    it('are blank for clients and other staff', async () => {
      for (const viewer of [client, member]) {
        const result: any = await service.getDailyLogById(viewer, 5);
        expect(result.items[0].password).toBe('');
        expect(result.items[0]).not.toHaveProperty('decrypted_password');
        expect(JSON.stringify(result)).not.toMatch(/s3cret|gcm1/);
      }
    });

    it('are blank in list responses for clients', async () => {
      prisma.sEODailyWorkLog.findMany.mockResolvedValue([log()]);
      const rows: any = await service.getDailyLogs(client, { all: 'true' });
      expect(rows[0].items[0].password).toBe('');
      expect(JSON.stringify(rows)).not.toMatch(/s3cret|gcm1/);
    });
  });

  describe('GET /seo-daily-logs query filters cannot widen the forced scope', () => {
    it('clients stay on approved logs of their own websites', async () => {
      await service.getDailyLogs(client, { all: 'true', status: 'draft', executive: '21' });
      const where = prisma.sEODailyWorkLog.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ status: 'approved', website: { client_id: 1 } });
      expect(where.executive_id).toBeUndefined();
    });

    it('executives stay on their own logs', async () => {
      await service.getDailyLogs(exec, { all: 'true', executive: '21' });
      expect(prisma.sEODailyWorkLog.findMany.mock.calls[0][0].where.executive_id).toBe(exec.id);
    });

    it('managers can still filter by executive and status', async () => {
      await service.getDailyLogs(manager, { all: 'true', executive: '21', status: 'draft' });
      expect(prisma.sEODailyWorkLog.findMany.mock.calls[0][0].where).toMatchObject({ executive_id: 21, status: 'draft' });
    });
  });

  describe('creating and adding to daily logs', () => {
    const body = { website: 3, log_date: '2026-10-17', items: [{ activity_type: 1, count: 1 }] };

    it('executives cannot log work for another executive', async () => {
      await expect(service.createDailyLog(exec, { ...body, executive: otherExec.id }, CTX)).rejects.toThrow(ForbiddenException);
      expect(prisma.sEODailyWorkLog.create).not.toHaveBeenCalled();
    });

    it('executives cannot self-approve', async () => {
      await expect(service.createDailyLog(exec, { ...body, status: 'approved' }, CTX)).rejects.toThrow(BadRequestException);
      await expect(service.addItemsToDailyLog(exec, { ...body, status: 'approved' }, CTX)).rejects.toThrow(BadRequestException);
      expect(prisma.sEODailyWorkLog.create).not.toHaveBeenCalled();
    });

    it('executives can still save their own drafts and submissions', async () => {
      await expect(service.createDailyLog(exec, { ...body, status: 'submitted' }, CTX)).resolves.toBeTruthy();
      expect(prisma.sEODailyWorkLog.create.mock.calls[0][0].data).toMatchObject({ executive_id: exec.id, status: 'submitted' });
    });

    it('managers can log on behalf of an executive', async () => {
      await service.createDailyLog(manager, { ...body, executive: exec.id, status: 'approved' }, CTX);
      expect(prisma.sEODailyWorkLog.create.mock.calls[0][0].data).toMatchObject({ executive_id: exec.id, status: 'approved' });
    });

    it('clients cannot add items', async () => {
      await expect(service.addItemsToDailyLog(client, body, CTX)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('editing and deleting daily logs', () => {
    beforeEach(() => prisma.sEODailyWorkLog.findUnique.mockResolvedValue(log({ status: 'draft' })));

    it('other staff roles cannot edit logs', async () => {
      await expect(service.updateDailyLog(member, 5, { status: 'approved' })).rejects.toThrow(ForbiddenException);
      expect(prisma.sEODailyWorkLog.update).not.toHaveBeenCalled();
    });

    it('executives edit only their own logs', async () => {
      await expect(service.updateDailyLog(otherExec, 5, { remarks: 'x' })).rejects.toThrow(ForbiddenException);
      await expect(service.updateDailyLog(exec, 5, { remarks: 'x' })).resolves.toBeTruthy();
    });

    it('only managers or the log executive can delete', async () => {
      await expect(service.deleteDailyLog(otherExec, 5, CTX)).rejects.toThrow(ForbiddenException);
      await expect(service.deleteDailyLog(member, 5, CTX)).rejects.toThrow(ForbiddenException);
      expect(prisma.sEODailyWorkLog.delete).not.toHaveBeenCalled();
      await expect(service.deleteDailyLog(exec, 5, CTX)).resolves.not.toThrow();
      await expect(service.deleteDailyLog(manager, 5, CTX)).resolves.not.toThrow();
    });
  });

  describe('SEO tasks and reminders', () => {
    it('only managers and the assigned executive can update a task', async () => {
      for (const u of [client, member, otherExec]) {
        await expect(service.updateTask(u, 1, { status: 'completed' })).rejects.toThrow(ForbiddenException);
      }
      expect(prisma.sEOTask.update).not.toHaveBeenCalled();
      await expect(service.updateTask(exec, 1, { status: 'in_progress' })).resolves.toMatchObject({ id: 1 });
      await expect(service.updateTask(manager, 1, { status: 'completed' })).resolves.toMatchObject({ id: 1 });
    });

    it('only managers and the assigned executive can update a reminder', async () => {
      await expect(service.updateReminder(exec, 404, { status: 'done' })).rejects.toThrow(NotFoundException);
      for (const u of [client, member, otherExec]) {
        await expect(service.updateReminder(u, 1, { status: 'done' })).rejects.toThrow(ForbiddenException);
      }
      expect(prisma.sEOReminder.update).not.toHaveBeenCalled();
      await expect(service.updateReminder(exec, 1, { status: 'done' })).resolves.toMatchObject({ id: 1 });
    });

    it('only managers can delete reminders', async () => {
      await expect(service.deleteReminder(exec, 1)).rejects.toThrow(ForbiddenException);
      expect(prisma.sEOReminder.delete).not.toHaveBeenCalled();
      await expect(service.deleteReminder(manager, 1)).resolves.toBeDefined();
    });
  });

  describe('SEO credential metadata', () => {
    beforeEach(() => prisma.sEOCredential.findMany.mockResolvedValue([{ id: 1, website_id: 3, password: encrypted }]));

    it('are refused to clients and other staff', async () => {
      await expect(service.getCredentials(client)).rejects.toThrow(ForbiddenException);
      await expect(service.getCredentials(member)).rejects.toThrow(ForbiddenException);
      expect(prisma.sEOCredential.findMany).not.toHaveBeenCalled();
    });

    it('are limited to assigned websites for executives', async () => {
      const rows = await service.getCredentials(exec);
      expect(prisma.sEOCredential.findMany.mock.calls[0][0].where).toEqual({ website: { assigned_executive_id: exec.id } });
      expect(rows[0].password).toBe(MASK);
      expect(JSON.stringify(rows)).not.toMatch(/s3cret|gcm1/);
    });

    it('are returned in full to managers', async () => {
      await service.getCredentials(manager);
      expect(prisma.sEOCredential.findMany.mock.calls[0][0].where).toEqual({});
    });
  });
});
