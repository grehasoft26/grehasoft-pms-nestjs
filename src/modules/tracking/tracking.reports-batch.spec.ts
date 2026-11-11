import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { PrismaService } from '../../core/prisma.service';
import * as timeline from './tracking-timeline';
import { TIMELINE_MAX_EVENTS, TIMELINE_MAX_SESSIONS, zonedRange } from './tracking-timeline';

/**
 * P1 tracking performance and reporting boundaries:
 * - Live Tracking's idle time is loaded for all employees with two queries in total (batched), grouped per employee,
 *   with the History Timeline's per-employee caps, and gives exactly the History Timeline's values;
 * - Daily / Weekly / Monthly / Analytics / Export use Asia/Kolkata calendar days, whatever the server's time zone;
 * - reports only read: stored counters are never changed.
 */

type Row = Record<string, any>;
const IST = 'Asia/Kolkata';
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
      if ('notIn' in cond && (cond.notIn as any[]).includes(row[key])) return false;
      if ('not' in cond && valueOf(row[key]) === valueOf(cond.not)) return false;
      if ('contains' in cond && !String(row[key] ?? '').includes(cond.contains)) return false;
      const has = value !== null && value !== undefined;
      if ('gte' in cond && !(has && value >= valueOf(cond.gte))) return false;
      if ('gt' in cond && !(has && value > valueOf(cond.gt))) return false;
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
    for (const [field, dir] of keys) {
      const diff = (valueOf(a[field]) ?? 0) - (valueOf(b[field]) ?? 0);
      if (diff !== 0) return dir === 'desc' ? -diff : diff;
    }
    return 0;
  });
};

const makeTable = (defaults: Row) => {
  const rows: Row[] = [];
  let nextId = 900000;
  return {
    rows,
    findFirst: jest.fn(async ({ where, orderBy }: Row = {}) => sortRows(rows.filter((r) => matches(r, where)), orderBy)[0] ?? null),
    findMany: jest.fn(async ({ where, orderBy, take }: Row = {}) => {
      const found = sortRows(rows.filter((r) => matches(r, where)), orderBy);
      return take ? found.slice(0, take) : found;
    }),
    findUnique: jest.fn(async ({ where }: Row) => rows.find((r) => matches(r, where)) ?? null),
    create: jest.fn(async ({ data }: Row) => {
      const row = { id: nextId++, ...defaults, ...data };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: Row) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error(`row ${where.id} not found`);
      Object.assign(row, data);
      return row;
    }),
  };
};

const SESSION_DEFAULTS = {
  device_id: 'pc', logout_time: null, is_active_session: true, last_desktop_ping: null, is_desktop_idle: false,
  mouse_moves: 0, key_presses: 0, clicks: 0, productive_seconds: 0, idle_seconds: 0, tracked_seconds: 0, activity_percentage: 0,
};
const EVENT_DEFAULTS = { session_id: null, source: 'desktop_client', reason: null, device_id: 'pc', ended_at: null, metadata: null };

describe('P1: batched Live idle, Asia/Kolkata report days, read-only reports', () => {
  let service: TrackingService;
  let sessions: ReturnType<typeof makeTable>;
  let events: ReturnType<typeof makeTable>;
  let activities: ReturnType<typeof makeTable>;
  let users: Row[];
  let eventId = 1;
  let sessionId = 1;
  const originalTz = process.env.TZ;

  const at = (iso: string) => jest.setSystemTime(u(iso));
  const addUser = (id: number) => {
    users.push({ id, name: `Employee ${id}`, username: `emp${id}`, email: `e${id}@example.com`, position: null, department: { id: 1, name: 'Ops' }, tracking_profile: { is_tracking_enabled: true, screenshots_enabled: true } });
  };
  const addSession = (data: Row): Row => {
    const row: Row = { ...SESSION_DEFAULTS, id: sessionId++, ...data };
    sessions.rows.push(row);
    return row;
  };
  const addEvent = (userId: number, type: string, iso: string, sid: number | null, extra: Row = {}): Row => {
    const row: Row = { ...EVENT_DEFAULTS, id: eventId++, user_id: userId, activity_type: type, occurred_at: u(iso), timestamp: u(iso), session_id: sid, client_event_id: `c-${eventId}`, ...extra };
    events.rows.push(row);
    return row;
  };
  /** An employee working today from 03:30 UTC (09:00 IST), live, with `idleMinutes` of closed idle and one open idle period. */
  const workingDay = (userId: number, idleMinutes: number) => {
    const s = addSession({ user_id: userId, device_id: `pc-${userId}`, login_time: u('2026-11-11T03:30:00Z'), last_ping: u('2026-11-11T08:59:55Z'), productive_seconds: 15000, idle_seconds: 900 });
    addEvent(userId, 'session_start', '2026-11-11T03:30:00Z', s.id, { device_id: `pc-${userId}` });
    addEvent(userId, 'idle_start', '2026-11-11T05:00:00Z', s.id, { device_id: `pc-${userId}` });
    addEvent(userId, 'idle_end', new Date(u('2026-11-11T05:00:00Z').getTime() + idleMinutes * 60000).toISOString(), s.id, { device_id: `pc-${userId}` });
    addEvent(userId, 'idle_start', '2026-11-11T08:55:00Z', s.id, { device_id: `pc-${userId}` });
    return s;
  };
  const history = async (userId: number, date = '2026-11-11'): Promise<any> => service.getTrackingTimeline({ user_id: String(userId), date, tz: IST });

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    at('2026-11-11T09:00:00.000Z'); // 14:30 IST
    process.env.TZ = 'UTC'; // production-like server clock
    eventId = 1;
    sessionId = 1;
    users = [];
    sessions = makeTable(SESSION_DEFAULTS);
    events = makeTable(EVENT_DEFAULTS);
    activities = makeTable({ window_title: '', duration_seconds: 0, mouse_moves: 0, key_presses: 0, clicks: 0, productive_seconds: 0, productive_duration: 0, is_productive: true });
    const prisma = {
      user: {
        findMany: jest.fn(async ({ where }: Row = {}) => users.filter((x) => matches(x, where || {}))),
        findUnique: jest.fn(async ({ where }: Row) => users.find((x) => x.id === where.id) ?? null),
      },
      trackingUserProfile: { findUnique: jest.fn(async ({ where }: Row) => ({ id: 1, user_id: where.user_id, is_tracking_enabled: true, screenshots_enabled: true })) },
      workSession: sessions,
      appActivity: activities,
      trackingActivityLog: events,
    };
    const module: TestingModule = await Test.createTestingModule({ providers: [TrackingService, { provide: PrismaService, useValue: prisma }] }).compile();
    service = module.get(TrackingService);
  });

  afterEach(() => {
    process.env.TZ = originalTz;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ============================================================================================ P1-a batching
  describe('Live idle: two queries per request, per-employee results identical to the History Timeline', () => {
    for (const n of [10, 50, 100]) {
      it(`${n} employees: two idle queries in total (was 2 per employee), values unchanged`, async () => {
        for (let id = 1; id <= n; id++) {
          addUser(id);
          workingDay(id, id % 7);
        }
        const status: any[] = (await service.getEmployeeStatus()) as any;

        // Events: one query for open breaks + one batched idle query; before batching this was 1 + n
        expect(events.findMany).toHaveBeenCalledTimes(2);
        // Sessions: one "today" query per employee (unchanged) + one batched idle query; before batching n + n
        expect(sessions.findMany).toHaveBeenCalledTimes(n + 1);
        const batched = sessions.findMany.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a?.where?.user_id?.in);
        expect(batched).toHaveLength(1);
        expect(batched[0].where.user_id.in).toHaveLength(n);

        // Identical to the single-employee History Timeline for every employee
        for (const s of status) {
          const h = await history(s.user_id);
          expect(s.idle_basis).toBe('threshold_events');
          expect(s.idle_seconds_today).toBe(h.summary.idle_seconds);
          expect(s.idle_ongoing).toBe(true);
          expect(s.idle_seconds_today).toBe((s.user_id % 7) * 60 + 300);
        }
      });
    }

    it('groups sessions and events per employee; an event naming another employee\'s session is never counted', async () => {
      addUser(1);
      addUser(2);
      const s1 = workingDay(1, 10);
      workingDay(2, 3);
      // Malformed: an employee-2 idle period recorded against employee 1's session
      addEvent(2, 'idle_start', '2026-11-11T06:00:00Z', s1.id);
      addEvent(2, 'idle_end', '2026-11-11T06:30:00Z', s1.id);

      const [a, b]: any[] = (await service.getEmployeeStatus()) as any;
      const [h1, h2] = [await history(1), await history(2)];
      expect(a.idle_seconds_today).toBe(h1.summary.idle_seconds);
      expect(b.idle_seconds_today).toBe(h2.summary.idle_seconds);
      expect(a.idle_seconds_today).toBe(600 + 300);
      expect(b.idle_seconds_today).toBe(180 + 300);
    });

    it('applies the 5,000-event and 500-session caps per employee, exactly like the single-employee query', async () => {
      addUser(1);
      addUser(2);
      addUser(3);
      const s1 = workingDay(1, 5);
      workingDay(2, 5);
      // Employee 1: more events than the cap
      for (let i = 0; i < TIMELINE_MAX_EVENTS; i++) addEvent(1, i % 2 ? 'unlock' : 'lock', new Date(u('2026-11-11T03:31:00Z').getTime() + i * 1000).toISOString(), s1.id, { device_id: 'pc-1' });
      // Employee 3: more sessions than the cap
      for (let i = 0; i <= TIMELINE_MAX_SESSIONS; i++) addSession({ user_id: 3, device_id: 'pc-3', login_time: new Date(u('2026-11-10T18:31:00Z').getTime() + i * 1000), last_ping: u('2026-11-11T01:00:00Z'), logout_time: u('2026-11-11T01:00:00Z'), is_active_session: false });

      const { start, end } = zonedRange('2026-11-11', '2026-11-11', IST);
      const svc: any = service;
      const batch: Map<number, any> = await svc.loadTimelineRowsForUsers([1, 2, 3], start, end);
      for (const id of [1, 2, 3]) {
        const single = await svc.loadTimelineRows(id, start, end);
        const got = batch.get(id);
        expect(got.truncated).toBe(single.truncated);
        expect(got.sessionRows.map((s: Row) => s.id)).toEqual(single.sessionRows.map((s: Row) => s.id));
        expect(got.events.map((e: Row) => e.id)).toEqual(single.events.map((e: Row) => e.id));
      }
      expect(batch.get(1)).toMatchObject({ truncated: true });
      expect(batch.get(1).events).toHaveLength(TIMELINE_MAX_EVENTS);
      expect(batch.get(2)).toMatchObject({ truncated: false });
      expect(batch.get(3)).toMatchObject({ truncated: true });
      expect(batch.get(3).sessionRows).toHaveLength(TIMELINE_MAX_SESSIONS);
    });

    it('if the batched event query fails, every employee falls back to its own counters, labelled', async () => {
      addUser(1);
      addUser(2);
      workingDay(1, 5).idle_seconds = 111;
      workingDay(2, 5).idle_seconds = 222;
      events.findMany.mockImplementation(async (args: Row) => {
        if (args?.where?.activity_type?.in?.length === 2) return []; // open-break query still works
        throw new Error('event table unavailable');
      });
      const [a, b]: any[] = (await service.getEmployeeStatus()) as any;
      expect(a).toMatchObject({ idle_basis: 'heartbeat_counters', idle_seconds_today: 111 });
      expect(b).toMatchObject({ idle_basis: 'heartbeat_counters', idle_seconds_today: 222 });
    });

    it('if one employee\'s timeline cannot be built, only that employee falls back', async () => {
      addUser(1);
      addUser(2);
      workingDay(1, 4);
      workingDay(2, 4).idle_seconds = 222;
      const real = timeline.buildTrackingTimeline;
      jest.spyOn(timeline, 'buildTrackingTimeline').mockImplementation((input: any) => {
        if (input.query.userId === 2) throw new Error('corrupt row');
        return real(input);
      });
      const [a, b]: any[] = (await service.getEmployeeStatus()) as any;
      expect(a).toMatchObject({ idle_basis: 'threshold_events', idle_seconds_today: 240 + 300 });
      expect(b).toMatchObject({ idle_basis: 'heartbeat_counters', idle_seconds_today: 222 });
    });
  });

  // ============================================================================================ report days (IST)
  describe('reports use Asia/Kolkata calendar days on a UTC server', () => {
    const reportSession = (userId: number, login: string, logout: string, extra: Row = {}) =>
      addSession({ user_id: userId, device_id: `pc-${userId}`, login_time: u(login), last_ping: u(logout), logout_time: u(logout), is_active_session: false, productive_seconds: 1200, idle_seconds: 300, ...extra });

    it('a daily report covers 00:00-24:00 IST: 23:30 IST belongs to the previous day, 00:30 IST to this one', async () => {
      addUser(1);
      reportSession(1, '2026-11-11T18:00:00Z', '2026-11-11T18:20:00Z'); // 23:30-23:50 IST on the 11th
      reportSession(1, '2026-11-11T19:00:00Z', '2026-11-11T19:30:00Z'); // 00:30-01:00 IST on the 12th
      const rows: any[] = await service.getDailyReport({ date: '2026-11-12' });
      const q = sessions.findMany.mock.calls.at(-1)![0];
      expect(q.where.login_time).toEqual({ gte: u('2026-11-11T18:30:00Z'), lt: u('2026-11-12T18:30:00Z') });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ date: '2026-11-12', idle_time: '00:05:00', productive_time: '00:20:00' });

      const range: any[] = await service.getDailyReport({ start_date: '2026-11-11', end_date: '2026-11-12' });
      expect(range.map((r) => r.date)).toEqual(['2026-11-11', '2026-11-12']);
    });

    it('Today defaults to the IST date (00:30 IST is already the next day on a UTC server)', async () => {
      at('2026-11-11T19:00:00Z');
      addUser(1);
      reportSession(1, '2026-11-11T18:40:00Z', '2026-11-11T18:59:00Z');
      const rows: any[] = await service.getDailyReport({});
      expect(rows.map((r) => r.date)).toEqual(['2026-11-12']);
    });

    it('month-end and year-end: December runs from 1 Dec 00:00 IST to 1 Jan 00:00 IST', async () => {
      addUser(1);
      reportSession(1, '2026-11-30T18:45:00Z', '2026-11-30T19:00:00Z'); // 1 Dec 00:15 IST: December
      reportSession(1, '2026-12-31T18:00:00Z', '2026-12-31T18:10:00Z'); // 31 Dec 23:30 IST: December
      reportSession(1, '2026-12-31T18:45:00Z', '2026-12-31T19:00:00Z'); // 1 Jan 2027 00:15 IST: not December
      const m: any = await service.getMonthlyReport({ year: 2026, month: 12 });
      expect(m.attendance_summary).toMatchObject({ total_sessions: 2, unique_days_worked: 2 });
      expect(m.productivity_trends.map((t: any) => t.date)).toEqual(['Dec 01', 'Dec 31']);
      const q = sessions.findMany.mock.calls.at(-1)![0];
      expect(q.where.login_time).toEqual({ gte: u('2026-11-30T18:30:00Z'), lt: u('2026-12-31T18:30:00Z') });

      // The default month is the IST month: 00:15 IST on 1 Jan 2027 is January 2027, not December
      at('2026-12-31T18:45:00Z');
      sessions.findMany.mockClear();
      await service.getMonthlyReport({});
      const q2 = sessions.findMany.mock.calls.at(-1)![0];
      expect(q2.where.login_time).toEqual({ gte: u('2026-12-31T18:30:00Z'), lt: u('2027-01-31T18:30:00Z') });
    });

    it('weekly aggregation sums the daily rows and labels days by their calendar date', async () => {
      addUser(1);
      addUser(2);
      reportSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z', { productive_seconds: 3000, idle_seconds: 600 });
      reportSession(2, '2026-11-12T04:00:00Z', '2026-11-12T05:00:00Z', { productive_seconds: 3300, idle_seconds: 300 });
      const daily: any[] = await service.getDailyReport({ start_date: '2026-11-08', end_date: '2026-11-14' });
      const w: any = await service.getWeeklyReport({ start_date: '2026-11-08', end_date: '2026-11-14' });
      const sum = (k: string) => daily.reduce((a, r) => a + r[k], 0);
      expect(sum('raw_idle_seconds')).toBe(900);
      expect(w.total_idle_time).toBe('00:15:00');
      expect(w.most_productive_day).toBe('Thursday (Nov 12)');
      expect(w.daily_productivity_trend.map((t: any) => t.date)).toEqual(['Wed, Nov 11', 'Thu, Nov 12']);
      expect(w.attendance_days).toBe(2);
    });

    it('offline gaps are split by IST days, not by the server\'s (UTC) days', () => {
      // 23:30-23:50 UTC and 00:10-00:30 UTC are both on 12 Nov in IST (05:00-06:00): one IST day, so the gap counts
      const r = service.detectBreaksAndGaps([
        { id: 1, device_id: 'pc', login_time: u('2026-11-11T23:30:00Z'), logout_time: u('2026-11-11T23:50:00Z') },
        { id: 2, device_id: 'pc', login_time: u('2026-11-12T00:10:00Z'), logout_time: u('2026-11-12T00:30:00Z') },
      ], []);
      expect(r.breaksList.filter((b: any) => b.type === 'offline').map((b: any) => b.duration)).toEqual([1200]);
      // 18:00-18:20 UTC (23:30 IST on the 11th) and 18:40 UTC (00:10 IST on the 12th): different IST days, no gap
      const r2 = service.detectBreaksAndGaps([
        { id: 1, device_id: 'pc', login_time: u('2026-11-11T18:00:00Z'), logout_time: u('2026-11-11T18:20:00Z') },
        { id: 2, device_id: 'pc', login_time: u('2026-11-11T18:40:00Z'), logout_time: u('2026-11-11T19:00:00Z') },
      ], []);
      expect(r2.breaksList).toHaveLength(0);
    });

    it('employee analytics: seven IST days ending today by default', async () => {
      at('2026-11-11T19:00:00Z'); // 00:30 IST on the 12th
      addUser(1);
      reportSession(1, '2026-11-06T04:00:00Z', '2026-11-06T05:00:00Z');
      reportSession(1, '2026-11-11T19:00:00Z', '2026-11-11T19:10:00Z');
      const a: any = await service.getEmployeeAnalytics({ user_id: 1 });
      expect(a.daily_breakdown.map((r: any) => r.date)).toEqual(['2026-11-06', '2026-11-12']);
      const actQ = activities.findMany.mock.calls.at(-1)![0];
      expect(actQ.where.timestamp).toEqual({ gte: u('2026-11-05T18:30:00Z'), lt: u('2026-11-12T18:30:00Z') });
    });

    it('rejects a date that is not a date', async () => {
      await expect(service.getDailyReport({ date: 'yesterday-ish' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ============================================================================================ exports
  describe('CSV / PDF exports carry exactly the report values', () => {
    const res = () => {
      const r: any = { headers: {}, body: null };
      r.set = jest.fn((h: Row) => Object.assign(r.headers, h));
      r.send = jest.fn((b: any) => (r.body = b));
      return r;
    };

    beforeEach(() => {
      addUser(1);
      addSession({ user_id: 1, device_id: 'pc-1', login_time: u('2026-11-11T19:00:00Z'), last_ping: u('2026-11-11T20:00:00Z'), logout_time: u('2026-11-11T20:00:00Z'), is_active_session: false, productive_seconds: 3000, idle_seconds: 600 });
    });

    it('CSV rows equal the daily report rows (date, idle, productive)', async () => {
      const rows: any[] = await service.getDailyReport({ date: '2026-11-12' });
      const r = res();
      await service.exportReport(r, { type: 'daily', format: 'csv', date: '2026-11-12' });
      const lines = String(r.body).trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain(`"${rows[0].date}"`);
      expect(lines[1]).toContain(`"${rows[0].idle_time}"`);
      expect(lines[1]).toContain(`"${rows[0].productive_time}"`);
      expect(r.headers['Content-Disposition']).toContain('daily_report_2026-11-12.csv');
    });

    it('PDF receives the same rows and the IST date range (default: today in IST)', async () => {
      at('2026-11-11T19:30:00Z'); // 01:00 IST on the 12th
      const rows: any[] = await service.getDailyReport({});
      const spy = jest.spyOn(service as any, 'generateReportPdf').mockImplementation(() => undefined);
      const r = res();
      await service.exportReport(r, { type: 'daily', format: 'pdf' });
      const [, type, from, to, data] = spy.mock.calls[0] as any[];
      expect([type, from, to]).toEqual(['daily', '2026-11-12', '2026-11-12']);
      expect(data).toEqual(rows);
      expect(r.headers['Content-Disposition']).toContain('daily_report_2026-11-12.pdf');
    });
  });

  // ============================================================================================ history untouched
  it('reports, exports and Live only read: stored counters are unchanged', async () => {
    addUser(1);
    const old = addSession({ user_id: 1, device_id: 'pc-1', login_time: u('2026-11-10T04:00:00Z'), last_ping: u('2026-11-10T08:00:00Z'), logout_time: u('2026-11-10T08:00:00Z'), is_active_session: false, productive_seconds: 12510, idle_seconds: 1650, tracked_seconds: 14160 });
    workingDay(1, 5);
    const before = JSON.stringify({ s: sessions.rows, e: events.rows });
    await service.getEmployeeStatus();
    await service.getDailyReport({ start_date: '2026-11-10', end_date: '2026-11-11' });
    await service.getWeeklyReport({ start_date: '2026-11-08', end_date: '2026-11-14' });
    await service.getMonthlyReport({ year: 2026, month: 11 });
    await service.getEmployeeAnalytics({ user_id: 1 });
    const r: any = { set: jest.fn(), send: jest.fn() };
    await service.exportReport(r, { type: 'daily', format: 'csv', start_date: '2026-11-10', end_date: '2026-11-11' });
    for (const fn of [sessions.create, sessions.update, events.create, events.update, activities.create, activities.update]) expect(fn).not.toHaveBeenCalled();
    expect(JSON.stringify({ s: sessions.rows, e: events.rows })).toBe(before);
    expect(old).toMatchObject({ productive_seconds: 12510, idle_seconds: 1650, tracked_seconds: 14160 });
  });
});
