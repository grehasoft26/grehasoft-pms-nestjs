import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { TrackingService } from './tracking.service';
import { PrismaService } from '../../core/prisma.service';
import { IDLE_EFFECTIVE_DATE_ENV, IDLE_UNAVAILABLE_LABEL, sessionSpansBoundary } from './tracking-report-idle';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ExcelJS = require('exceljs');

/**
 * Final P1 fixes:
 * - P1-A: a session that started before the effective-date boundary (00:00 Asia/Kolkata on the effective date) and ran
 *   across it, or is still open, makes its login-day row 'mixed' (its counters may hold both rules), conservatively;
 * - P1-B: CSV exports start with a UTF-8 byte order mark (EF BB BF); XLSX and PDF do not.
 *
 * Effective date 2026-11-11 (IST): boundary = 2026-11-11 00:00 IST = 2026-11-10T18:30:00Z. Process clock: UTC.
 */

type Row = Record<string, any>;
const EFFECTIVE = '2026-11-11';
const BOUNDARY = '2026-11-10T18:30:00.000Z';
const u = (s: string) => new Date(s);
const valueOf = (v: any) => (v instanceof Date ? v.getTime() : v);

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    if (key === 'NOT') return !matches(row, cond);
    const value = valueOf(row[key]);
    if (cond === null) return value === null || value === undefined;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond && !(cond.in as any[]).includes(row[key])) return false;
      if ('not' in cond && valueOf(row[key]) === valueOf(cond.not)) return false;
      if ('contains' in cond && !String(row[key] ?? '').includes(cond.contains)) return false;
      const has = value !== null && value !== undefined;
      if ('gte' in cond && !(has && value >= valueOf(cond.gte))) return false;
      if ('lte' in cond && !(has && value <= valueOf(cond.lte))) return false;
      if ('lt' in cond && !(has && value < valueOf(cond.lt))) return false;
      return true;
    }
    return value === valueOf(cond);
  });

const sortRows = (rows: Row[], orderBy?: Row | Row[]) => {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o));
  return [...rows].sort((a, b) => {
    for (const [f, d] of keys) {
      const x = (valueOf(a[f]) ?? 0) - (valueOf(b[f]) ?? 0);
      if (x) return d === 'desc' ? -x : x;
    }
    return 0;
  });
};

const makeTable = () => {
  const rows: Row[] = [];
  return {
    rows,
    findMany: jest.fn(async ({ where, orderBy, take }: Row = {}) => {
      const f = sortRows(rows.filter((r) => matches(r, where)), orderBy);
      return take ? f.slice(0, take) : f;
    }),
    findFirst: jest.fn(async ({ where, orderBy }: Row = {}) => sortRows(rows.filter((r) => matches(r, where)), orderBy)[0] ?? null),
    findUnique: jest.fn(async ({ where }: Row) => rows.find((r) => matches(r, where)) ?? null),
    create: jest.fn(async () => { throw new Error('write attempted'); }),
    update: jest.fn(async () => { throw new Error('write attempted'); }),
  };
};

describe('Report idle: sessions spanning the effective-date boundary (P1-A) and CSV UTF-8 BOM (P1-B)', () => {
  let service: TrackingService;
  let sessions: ReturnType<typeof makeTable>;
  let events: ReturnType<typeof makeTable>;
  let activities: ReturnType<typeof makeTable>;
  let users: Row[];
  let sid = 1;
  const originalTz = process.env.TZ;
  const originalEffective = process.env[IDLE_EFFECTIVE_DATE_ENV];

  const setEffective = (v: string | undefined) => {
    if (v === undefined) delete process.env[IDLE_EFFECTIVE_DATE_ENV];
    else process.env[IDLE_EFFECTIVE_DATE_ENV] = v;
  };
  const addUser = (id: number, name = `Employee ${id}`) =>
    users.push({ id, name, username: `emp${id}`, email: `e${id}@example.com`, position: null, department: { id: 1, name: 'Ops' } });
  /** A desktop session with stored counters; `logout` null = still open (is_active_session). */
  const session = (userId: number, login: string, logout: string | null, prod: number, idle: number, extra: Row = {}): Row => {
    const row: Row = {
      id: sid++, user_id: userId, device_id: `pc-${userId}`, login_time: u(login), logout_time: logout ? u(logout) : null,
      last_ping: logout ? u(logout) : u('2026-11-13T08:59:00Z'), is_active_session: logout === null,
      productive_seconds: prod, idle_seconds: idle, tracked_seconds: prod + idle, mouse_moves: 0, key_presses: 0, clicks: 0, ...extra,
    };
    sessions.rows.push(row);
    return row;
  };
  const byDate = (rows: any[], userId: number, date: string) => rows.find((r) => r.user_id === userId && r.date === date);

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    jest.setSystemTime(u('2026-11-13T09:00:00Z')); // 14:30 IST on 13 Nov
    process.env.TZ = 'UTC';
    setEffective(EFFECTIVE);
    sid = 1;
    users = [];
    sessions = makeTable();
    events = makeTable();
    activities = makeTable();
    const prisma = {
      user: {
        findMany: jest.fn(async ({ where }: Row = {}) => users.filter((x) => matches(x, where || {}))),
        findUnique: jest.fn(async ({ where }: Row) => users.find((x) => x.id === where.id) ?? null),
      },
      workSession: sessions,
      appActivity: activities,
      trackingActivityLog: events,
    };
    const module: TestingModule = await Test.createTestingModule({ providers: [TrackingService, { provide: PrismaService, useValue: prisma }] }).compile();
    service = module.get(TrackingService);
  });

  afterEach(() => {
    process.env.TZ = originalTz;
    setEffective(originalEffective);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ============================================================================================ P1-A rule
  describe('boundary rule', () => {
    const b = u(BOUNDARY).getTime();
    it('started before 00:00 IST of the effective date and ended at/after it (or still open) = spanning', () => {
      expect(sessionSpansBoundary({ login_time: '2026-11-10T16:30:00Z', logout_time: '2026-11-10T19:15:00Z' }, b)).toBe(true); // 22:00 -> 00:45 IST
      expect(sessionSpansBoundary({ login_time: '2026-11-07T04:30:00Z', logout_time: null, is_active_session: true }, b)).toBe(true);
      expect(sessionSpansBoundary({ login_time: '2026-11-10T16:30:00Z', logout_time: BOUNDARY }, b)).toBe(true); // ends exactly at 00:00 IST
      expect(sessionSpansBoundary({ login_time: '2026-11-10T16:30:00Z', logout_time: '2026-11-10T18:29:59Z' }, b)).toBe(false);
      expect(sessionSpansBoundary({ login_time: '2026-11-10T16:30:00Z', logout_time: null, last_ping: '2026-11-10T18:45:00Z' }, b)).toBe(true); // closed by heartbeat only
      expect(sessionSpansBoundary({ login_time: '2026-11-10T16:30:00Z', logout_time: null, last_ping: null }, b)).toBe(true); // end unknown
      expect(sessionSpansBoundary({ login_time: BOUNDARY, logout_time: '2026-11-10T19:00:00Z' }, b)).toBe(false); // starts on the effective date
    });
  });

  // ============================================================================================ P1-A rows
  describe('daily rows', () => {
    it('a session from 22:00 IST the day before to 00:45 IST on the effective date makes its login day mixed', async () => {
      addUser(1);
      session(1, '2026-11-10T16:30:00Z', '2026-11-10T19:15:00Z', 8000, 1900);
      const [r]: any[] = await service.getDailyReport({ date: '2026-11-10' });
      expect(r).toMatchObject({
        date: '2026-11-10', idle_basis: 'mixed', idle_available: false, idle_unavailable_reason: 'spans_effective_date',
        idle_time: null, raw_idle_seconds: null, desktop_work_time: null, total_tracked_time: null, total_engagement_time: null,
        unaccounted_time: null, activity_percentage: null, raw_tracked_seconds: null,
        productive_time: '02:13:20', // the stored counter is still shown, as on the effective date itself
      });
    });

    it('a session that started several days before and is still open makes its login day mixed', async () => {
      addUser(1);
      session(1, '2026-11-07T04:30:00Z', null, 90000, 20000); // 7 Nov 10:00 IST, never closed
      const [r]: any[] = await service.getDailyReport({ date: '2026-11-07' });
      expect(r).toMatchObject({ date: '2026-11-07', idle_basis: 'mixed', idle_time: null, idle_unavailable_reason: 'spans_effective_date' });
    });

    it('a session ending exactly at 00:00 IST of the effective date is mixed; one second earlier stays legacy', async () => {
      addUser(1);
      addUser(2);
      session(1, '2026-11-10T16:30:00Z', BOUNDARY, 6000, 1200);
      session(2, '2026-11-10T16:30:00Z', '2026-11-10T18:29:59Z', 6000, 1199);
      const rows: any[] = await service.getDailyReport({ date: '2026-11-10' });
      expect(byDate(rows, 1, '2026-11-10')).toMatchObject({ idle_basis: 'mixed', idle_time: null });
      expect(byDate(rows, 2, '2026-11-10')).toMatchObject({ idle_basis: 'legacy', idle_available: true, idle_time: '00:19:59', raw_idle_seconds: 1199, idle_unavailable_reason: null });
    });

    it('a normal legacy session with no overlap is unchanged (identical to the unset-date report)', async () => {
      addUser(1);
      session(1, '2026-11-09T04:00:00Z', '2026-11-09T12:00:00Z', 24000, 4800);
      const withDate: any[] = await service.getDailyReport({ date: '2026-11-09' });
      setEffective(undefined);
      const unset: any[] = await service.getDailyReport({ date: '2026-11-09' });
      expect(withDate).toEqual(unset);
      expect(withDate[0]).toMatchObject({ idle_basis: 'legacy', idle_time: '01:20:00', activity_percentage: 83.33 });
    });

    it('one employee, several sessions: only the login day of the overlapping session becomes mixed', async () => {
      addUser(1);
      session(1, '2026-11-09T04:00:00Z', '2026-11-09T08:00:00Z', 12000, 2400); // 9 Nov, legacy
      session(1, '2026-11-10T03:30:00Z', '2026-11-10T07:30:00Z', 12600, 1800); // 10 Nov morning
      session(1, '2026-11-10T17:00:00Z', '2026-11-10T19:00:00Z', 6000, 1200); // 10 Nov 22:30 -> 11 Nov 00:30 IST: spans
      session(1, '2026-11-12T04:00:00Z', '2026-11-12T05:00:00Z', 3000, 600); // threshold day (no events: zero idle)
      const rows: any[] = await service.getDailyReport({ start_date: '2026-11-09', end_date: '2026-11-12' });
      expect(rows.map((r) => [r.date, r.idle_basis, r.idle_time])).toEqual([
        ['2026-11-09', 'legacy', '00:40:00'],
        ['2026-11-10', 'mixed', null], // the morning session shares the row, so the whole row is unavailable
        ['2026-11-12', 'threshold', '00:00:00'],
      ]);
    });

    it('effective date unset: spanning sessions keep the exact legacy values', async () => {
      setEffective(undefined);
      addUser(1);
      session(1, '2026-11-10T16:30:00Z', '2026-11-10T19:15:00Z', 8000, 1900);
      session(1, '2026-11-07T04:30:00Z', null, 90000, 20000);
      const rows: any[] = await service.getDailyReport({ start_date: '2026-11-07', end_date: '2026-11-10' });
      expect(rows.map((r) => [r.date, r.idle_basis, r.idle_available, r.raw_idle_seconds])).toEqual([
        ['2026-11-07', 'legacy', true, expect.any(Number)],
        ['2026-11-10', 'legacy', true, 1900],
      ]);
      expect(events.findMany).not.toHaveBeenCalled();
    });
  });

  // ============================================================================================ P1-A aggregation
  describe('weekly / monthly / analytics propagate a mixed legacy login day', () => {
    beforeEach(() => {
      addUser(1);
      addUser(2);
      session(1, '2026-11-09T04:00:00Z', '2026-11-09T05:00:00Z', 3000, 600); // legacy
      session(1, '2026-11-10T16:30:00Z', '2026-11-10T19:15:00Z', 8000, 1900); // spans -> 10 Nov mixed
      session(2, '2026-11-10T04:00:00Z', '2026-11-10T05:00:00Z', 3300, 300); // legacy, same date, not spanning
    });

    it('weekly: totals null, the legacy date listed as unavailable, the trend point mixed', async () => {
      const w: any = await service.getWeeklyReport({ start_date: '2026-11-08', end_date: '2026-11-14' });
      expect(w).toMatchObject({ total_idle_time: null, total_weekly_hours: null, idle_unavailable_dates: ['2026-11-10'], total_idle_time_known_days: '00:15:00' });
      expect(w.idle_bases).toEqual(['legacy', 'mixed']);
      expect(w.daily_productivity_trend.map((t: any) => [t.date, t.idle_hours, t.idle_basis])).toEqual([
        ['Mon, Nov 09', 0.17, 'legacy'],
        ['Tue, Nov 10', null, 'mixed'], // employee 2's legacy row is available, but the date total is not
      ]);
    });

    it('monthly: totals null; only the affected employee loses tracked hours', async () => {
      const m: any = await service.getMonthlyReport({ year: 2026, month: 11 });
      expect(m).toMatchObject({ total_idle_hours: null, total_monthly_work_hours: null, idle_unavailable_dates: ['2026-11-10'] });
      expect(m.employee_ranking.find((r: any) => r.user_id === 1)).toMatchObject({ tracked_hours: null, tracked_hours_known_days: 1, activity_excludes_dates: ['2026-11-10'] });
      expect(m.employee_ranking.find((r: any) => r.user_id === 2)).toMatchObject({ tracked_hours: 1, activity_excludes_dates: [] });
      expect(m.productivity_trends.find((t: any) => t.date === 'Nov 10')).toMatchObject({ idle_hours: null, idle_basis: 'mixed' });
    });

    it('employee analytics: idle-derived totals null for the affected employee only', async () => {
      const a1: any = await service.getEmployeeAnalytics({ user_id: 1, start_date: '2026-11-09', end_date: '2026-11-10' });
      expect(a1.totals).toMatchObject({ idle_time: null, total_tracked_time: null, total_idle_time_known_days: '00:10:00', idle_unavailable_dates: ['2026-11-10'] });
      const a2: any = await service.getEmployeeAnalytics({ user_id: 2, start_date: '2026-11-09', end_date: '2026-11-10' });
      expect(a2.totals).toMatchObject({ idle_time: '00:05:00', total_tracked_time: '01:00:00', idle_unavailable_dates: [] });
    });
  });

  // ============================================================================================ exports
  describe('exports: mixed label and CSV UTF-8 BOM', () => {
    const MALAYALAM = 'ജിഷ ഉണ്ണികൃഷ്ണൻ';
    const resOf = () => {
      const r: any = { headers: {}, body: null };
      r.set = jest.fn((h: Row) => Object.assign(r.headers, h));
      r.send = jest.fn((b: any) => (r.body = b));
      return r;
    };
    const csvBytes = (body: string) => Buffer.from(body, 'utf8'); // exactly what Express sends for a string body

    beforeEach(() => {
      addUser(1, MALAYALAM);
      session(1, '2026-11-10T16:30:00Z', '2026-11-10T19:15:00Z', 8000, 1900); // spans -> mixed
      session(1, '2026-11-09T04:00:00Z', '2026-11-09T05:00:00Z', 3000, 600); // legacy
    });

    it('CSV bytes start with EF BB BF exactly once; UTF-8 decoding keeps the label, the Malayalam name, headers and values', async () => {
      const r = resOf();
      await service.exportReport(r, { type: 'daily', format: 'csv', start_date: '2026-11-09', end_date: '2026-11-10' });
      const bytes = csvBytes(r.body);
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect([...bytes.subarray(3, 6)]).not.toEqual([0xef, 0xbb, 0xbf]); // no duplicated BOM
      // Excel-style decoding: UTF-8 chosen because of the BOM, which is not part of the text
      const text = new TextDecoder('utf-8').decode(bytes);
      expect(text.charCodeAt(0)).not.toBe(0xfeff);
      const lines = text.split('\n');
      expect(lines[0]).toBe('Employee Name,Employee Code,Department,Date,Productive Time,Idle Time,Desktop Work Time,Portal Active Time,Break Time,Unaccounted Time,Total Engagement Time,Workday Span,Activity Percentage,Status');
      expect(lines[1]).toBe(`"${MALAYALAM}","GS-26-001","Ops","2026-11-09","00:50:00","00:10:00","01:00:00","00:00:00","00:00:00","00:00:00","01:00:00","01:00:00","83.33","Offline"`);
      expect(lines[2]).toContain(`"${MALAYALAM}","GS-26-001","Ops","2026-11-10","02:13:20","${IDLE_UNAVAILABLE_LABEL}"`);
      expect(lines[2].split(`"${IDLE_UNAVAILABLE_LABEL}"`)).toHaveLength(6); // idle, desktop work, unaccounted, engagement, activity
      // The label's en dash is the UTF-8 sequence E2 80 93 (not a cp1252 byte)
      expect(bytes.includes(Buffer.from([0xe2, 0x80, 0x93]))).toBe(true);
    });

    it('weekly, monthly, employee and empty CSVs all carry the BOM; columns unchanged', async () => {
      for (const q of [
        { type: 'weekly', start_date: '2026-11-08', end_date: '2026-11-14', header: 'Date,Productive Hours,Idle Hours,Total Tracked' },
        { type: 'monthly', year: 2026, month: 11, header: 'user_id,full_name,employee_code,department,productive_hours,tracked_hours,activity_percentage' },
        { type: 'employee', user_id: 1, start_date: '2026-11-09', end_date: '2026-11-10', header: 'Employee Name,Employee Code,Department,Date,Productive Time' },
        { type: 'daily', date: '2026-12-25', header: 'Employee Name,Employee Code,Department,Date' }, // no rows: headers only
      ]) {
        const r = resOf();
        const { header, ...query } = q;
        await service.exportReport(r, { format: 'csv', ...query });
        const bytes = csvBytes(r.body);
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        expect(new TextDecoder('utf-8').decode(bytes).startsWith(header)).toBe(true);
      }
    });

    it('over HTTP the CSV response body really starts with EF BB BF and is declared UTF-8', async () => {
      const app = express();
      app.get('/export', (req: any, res: any) => service.exportReport(res, req.query));
      const resp = await request(app)
        .get('/export?type=daily&format=csv&start_date=2026-11-09&end_date=2026-11-10')
        .buffer(true)
        .parse((res: any, cb: any) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(resp.status).toBe(200);
      expect(resp.headers['content-type']).toMatch(/^text\/csv; charset=utf-8$/i);
      const body: Buffer = resp.body;
      expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(new TextDecoder('utf-8').decode(body)).toContain(MALAYALAM);
    });

    it('XLSX has no BOM and keeps the label and the Malayalam name; PDF has no BOM and gets the labelled rows', async () => {
      const x = resOf();
      await service.exportReport(x, { type: 'daily', format: 'excel', start_date: '2026-11-09', end_date: '2026-11-10' });
      expect(x.body.subarray(0, 2).toString()).toBe('PK'); // a ZIP container, no BOM
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(x.body);
      const values = wb.worksheets[0].getRow(3).values.slice(1);
      expect(values.slice(0, 6)).toEqual([MALAYALAM, 'GS-26-001', 'Ops', '2026-11-10', '02:13:20', IDLE_UNAVAILABLE_LABEL]);

      const spy = jest.spyOn(service as any, 'generateReportPdf');
      const p = resOf();
      await service.exportReport(p, { type: 'daily', format: 'pdf', start_date: '2026-11-09', end_date: '2026-11-10' });
      expect(p.body.subarray(0, 5).toString()).toBe('%PDF-');
      const data = (spy.mock.calls[0] as any[])[4];
      expect(data.find((d: any) => d.date === '2026-11-10')).toMatchObject({ idle_time: IDLE_UNAVAILABLE_LABEL, activity_percentage: IDLE_UNAVAILABLE_LABEL });
      expect(data.find((d: any) => d.date === '2026-11-09')).toMatchObject({ idle_time: '00:10:00' });
    });
  });

  it('stored sessions are only read', async () => {
    addUser(1);
    session(1, '2026-11-10T16:30:00Z', '2026-11-10T19:15:00Z', 8000, 1900);
    const before = JSON.stringify(sessions.rows);
    await service.getDailyReport({ date: '2026-11-10' });
    await service.getWeeklyReport({ start_date: '2026-11-08', end_date: '2026-11-14' });
    await service.exportReport({ set: jest.fn(), send: jest.fn() }, { type: 'daily', format: 'csv', date: '2026-11-10' });
    expect(JSON.stringify(sessions.rows)).toBe(before);
    for (const fn of [sessions.create, sessions.update, events.create, events.update]) expect(fn).not.toHaveBeenCalled();
  });
});
