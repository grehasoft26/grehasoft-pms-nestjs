import { Test, TestingModule } from '@nestjs/testing';
import { TrackingService } from './tracking.service';
import { PrismaService } from '../../core/prisma.service';
import {
  IDLE_EFFECTIVE_DATE_ENV,
  IDLE_UNAVAILABLE_LABEL,
  readIdleEffectiveDate,
  reportIdleBasis,
  sumNullable,
} from './tracking-report-idle';

/**
 * P1-c (option B): report idle across the change to threshold idle.
 * legacy (before the effective date) = stored counters; mixed (the effective date) = unavailable (null, labelled);
 * threshold (after) = idle events through buildTrackingTimeline. Unset date = unchanged legacy reports.
 */

type Row = Record<string, any>;
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
  let nextId = 700000;
  const findMany = async ({ where, orderBy, take }: Row = {}) => {
    const found = sortRows(rows.filter((r) => matches(r, where)), orderBy);
    return take ? found.slice(0, take) : found;
  };
  return {
    rows,
    realFindMany: findMany,
    findFirst: jest.fn(async ({ where, orderBy }: Row = {}) => sortRows(rows.filter((r) => matches(r, where)), orderBy)[0] ?? null),
    findMany: jest.fn(findMany),
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
  device_id: 'pc', logout_time: null, is_active_session: false, last_desktop_ping: null, is_desktop_idle: false,
  mouse_moves: 0, key_presses: 0, clicks: 0, productive_seconds: 0, idle_seconds: 0, tracked_seconds: 0, activity_percentage: 0,
};
const EVENT_DEFAULTS = { session_id: null, source: 'desktop_client', reason: null, device_id: 'pc', ended_at: null, metadata: null };

describe('Report idle basis: legacy / mixed / threshold (P1-c, option B)', () => {
  let service: TrackingService;
  let sessions: ReturnType<typeof makeTable>;
  let events: ReturnType<typeof makeTable>;
  let activities: ReturnType<typeof makeTable>;
  let users: Row[];
  let eventId = 1;
  let sessionId = 1;
  const originalTz = process.env.TZ;
  const originalEffective = process.env[IDLE_EFFECTIVE_DATE_ENV];

  const at = (iso: string) => jest.setSystemTime(u(iso));
  const setEffective = (v: string | undefined) => {
    if (v === undefined) delete process.env[IDLE_EFFECTIVE_DATE_ENV];
    else process.env[IDLE_EFFECTIVE_DATE_ENV] = v;
  };
  const addUser = (id: number) =>
    users.push({ id, name: `Employee ${id}`, username: `emp${id}`, email: `e${id}@example.com`, position: null, department: { id: 1, name: 'Ops' } });
  const addSession = (data: Row): Row => {
    const row: Row = { ...SESSION_DEFAULTS, id: sessionId++, ...data };
    sessions.rows.push(row);
    return row;
  };
  const addEvent = (userId: number, type: string, iso: string, sid: number | null, extra: Row = {}): Row => {
    const row: Row = { ...EVENT_DEFAULTS, id: eventId++, user_id: userId, activity_type: type, occurred_at: u(iso), timestamp: u(iso), session_id: sid, client_event_id: `c-${eventId}`, device_id: `pc-${userId}`, ...extra };
    events.rows.push(row);
    return row;
  };
  /** A closed desktop session with stored counters and (optionally) one idle period of `idleMin` minutes. */
  const day = (userId: number, login: string, logout: string, counters: { prod: number; idle: number }, idleMin = 0, idleAt?: string) => {
    const s = addSession({ user_id: userId, device_id: `pc-${userId}`, login_time: u(login), last_ping: u(logout), logout_time: u(logout), productive_seconds: counters.prod, idle_seconds: counters.idle });
    addEvent(userId, 'session_start', login, s.id);
    if (idleMin > 0) {
      const start = u(idleAt ?? new Date(u(login).getTime() + 10 * 60000).toISOString());
      addEvent(userId, 'idle_start', start.toISOString(), s.id);
      addEvent(userId, 'idle_end', new Date(start.getTime() + idleMin * 60000).toISOString(), s.id);
    }
    addEvent(userId, 'session_end', logout, s.id);
    return s;
  };
  /**
   * Effective date 2026-11-11 (IST). Employee 1: 10 Nov (legacy), 11 Nov (mixed), 12 Nov (threshold, 5 min idle events,
   * counter says 500 s). Employee 2: 12 Nov (threshold, genuinely no idle).
   */
  const scenario = () => {
    addUser(1);
    addUser(2);
    day(1, '2026-11-10T04:00:00Z', '2026-11-10T05:00:00Z', { prod: 3000, idle: 600 }, 3);
    day(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z', { prod: 2700, idle: 900 }, 4);
    day(1, '2026-11-12T04:00:00Z', '2026-11-12T05:00:00Z', { prod: 3000, idle: 500 }, 5);
    day(2, '2026-11-12T04:00:00Z', '2026-11-12T05:00:00Z', { prod: 3600, idle: 0 }, 0);
  };
  const byDate = (rows: any[], userId: number, date: string) => rows.find((r) => r.user_id === userId && r.date === date);

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    at('2026-11-13T09:00:00Z');
    process.env.TZ = 'UTC'; // production-like server clock
    setEffective(undefined);
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
    setEffective(originalEffective);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------------------------- configuration
  describe('effective date configuration', () => {
    it('unset or empty = no effective date; strict YYYY-MM-DD real dates only', () => {
      expect(readIdleEffectiveDate({})).toEqual({ date: null, error: null });
      expect(readIdleEffectiveDate({ [IDLE_EFFECTIVE_DATE_ENV]: '  ' })).toEqual({ date: null, error: null });
      expect(readIdleEffectiveDate({ [IDLE_EFFECTIVE_DATE_ENV]: '2026-11-11' })).toEqual({ date: '2026-11-11', error: null });
      expect(readIdleEffectiveDate({ [IDLE_EFFECTIVE_DATE_ENV]: ' 2026-11-11 ' }).date).toBe('2026-11-11');
      for (const bad of ['2026-11-31', '2026-2-01', '11-11-2026', '2026/11/11', '2026-11-11T00:00:00Z', 'today']) {
        const r = readIdleEffectiveDate({ [IDLE_EFFECTIVE_DATE_ENV]: bad });
        expect(r.date).toBeNull();
        expect(r.error).toContain(IDLE_EFFECTIVE_DATE_ENV);
      }
    });

    it('basis by calendar date: before = legacy, equal = mixed, after = threshold; no date = legacy', () => {
      expect(reportIdleBasis('2026-11-10', '2026-11-11')).toBe('legacy');
      expect(reportIdleBasis('2026-11-11', '2026-11-11')).toBe('mixed');
      expect(reportIdleBasis('2026-11-12', '2026-11-11')).toBe('threshold');
      expect(reportIdleBasis('2030-01-01', null)).toBe('legacy');
    });

    it('an unavailable value makes a total null instead of adding zero; genuine zeros still count', () => {
      expect(sumNullable([{ date: 'a', v: 0 }, { date: 'b', v: 30 }], 'v')).toEqual({ total: 30, known: 30, unavailableDates: [] });
      expect(sumNullable([{ date: 'a', v: null }, { date: 'b', v: 30 }], 'v')).toEqual({ total: null, known: 30, unavailableDates: ['a'] });
    });
  });

  // ---------------------------------------------------------------------------------------------- daily rows
  describe('daily report rows', () => {
    it('unset effective date: every day legacy, values exactly the stored counters (unchanged behaviour)', async () => {
      scenario();
      const rows: any[] = await service.getDailyReport({ start_date: '2026-11-10', end_date: '2026-11-12' });
      expect(rows.map((r) => r.idle_basis)).toEqual(['legacy', 'legacy', 'legacy', 'legacy']);
      expect(byDate(rows, 1, '2026-11-11')).toMatchObject({ idle_time: '00:15:00', idle_available: true, raw_idle_seconds: 900, desktop_work_time: '01:00:00' });
      expect(byDate(rows, 1, '2026-11-12')).toMatchObject({ idle_time: '00:08:20', raw_idle_seconds: 500 });
      expect(events.findMany).not.toHaveBeenCalled(); // no event reads for legacy days
    });

    it('legacy day before the effective date: stored counters', async () => {
      setEffective('2026-11-11');
      scenario();
      const rows: any[] = await service.getDailyReport({ date: '2026-11-10' });
      expect(rows[0]).toMatchObject({ idle_basis: 'legacy', idle_available: true, idle_time: '00:10:00', raw_idle_seconds: 600, desktop_work_time: '01:00:00', activity_percentage: 83.33 });
    });

    it('mixed (deployment) day: idle and its derivatives are null, never zero; productive and the rest stay', async () => {
      setEffective('2026-11-11');
      scenario();
      const [r]: any[] = await service.getDailyReport({ date: '2026-11-11' });
      expect(r).toMatchObject({
        idle_basis: 'mixed', idle_available: false, idle_unavailable_reason: 'mixed_calculation',
        idle_time: null, raw_idle_seconds: null,
        desktop_work_time: null, total_tracked_time: null, total_engagement_time: null, unaccounted_time: null, activity_percentage: null,
        raw_tracked_seconds: null, raw_desktop_work_seconds: null, raw_total_engagement_seconds: null, raw_unaccounted_seconds: null,
        productive_time: '00:45:00', raw_productive_seconds: 2700, workday_span: '01:00:00',
      });
    });

    it('threshold day: idle from events (not the stored counter); a genuine zero is "00:00:00", not null', async () => {
      setEffective('2026-11-11');
      scenario();
      const rows: any[] = await service.getDailyReport({ date: '2026-11-12' });
      expect(byDate(rows, 1, '2026-11-12')).toMatchObject({
        idle_basis: 'threshold', idle_available: true, idle_time: '00:05:00', raw_idle_seconds: 300,
        productive_time: '00:50:00', desktop_work_time: '00:55:00', activity_percentage: 90.91,
      });
      expect(byDate(rows, 2, '2026-11-12')).toMatchObject({ idle_basis: 'threshold', idle_available: true, idle_time: '00:00:00', raw_idle_seconds: 0, activity_percentage: 100 });
    });

    it('threshold idle follows the IST calendar day and the report\'s login-day attribution', async () => {
      setEffective('2026-11-11');
      addUser(1);
      // 00:15 IST on 12 Nov (18:45 UTC on the 11th): a threshold day, not the mixed day
      day(1, '2026-11-11T18:45:00Z', '2026-11-11T19:45:00Z', { prod: 3000, idle: 600 }, 6);
      // Starts 23:00 IST on 12 Nov and runs past midnight: its idle after midnight stays on the 12th (login day)
      day(1, '2026-11-12T17:30:00Z', '2026-11-12T19:30:00Z', { prod: 6000, idle: 1200 }, 20, '2026-11-12T18:40:00Z');
      const rows: any[] = await service.getDailyReport({ start_date: '2026-11-11', end_date: '2026-11-13' });
      expect(rows.map((r) => [r.date, r.idle_basis, r.raw_idle_seconds])).toEqual([['2026-11-12', 'threshold', 360 + 1200]]);
    });

    it('a threshold day whose events cannot be read is unavailable (null), not zero and not the counter', async () => {
      setEffective('2026-11-11');
      scenario();
      events.findMany.mockImplementation(async () => { throw new Error('event table unavailable'); });
      const rows: any[] = await service.getDailyReport({ date: '2026-11-12' });
      expect(byDate(rows, 1, '2026-11-12')).toMatchObject({ idle_basis: 'threshold', idle_available: false, idle_unavailable_reason: 'events_unavailable', idle_time: null });
    });

    it('an invalid configured date is rejected and logged; reports stay legacy', async () => {
      setEffective('2026-13-01');
      scenario();
      const log = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
      const rows: any[] = await service.getDailyReport({ start_date: '2026-11-10', end_date: '2026-11-12' });
      expect(rows.every((r) => r.idle_basis === 'legacy' && r.idle_available)).toBe(true);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(IDLE_EFFECTIVE_DATE_ENV));
    });
  });

  // ---------------------------------------------------------------------------------------------- aggregation
  describe('weekly / monthly / analytics with a mixed day', () => {
    beforeEach(() => {
      setEffective('2026-11-11');
      scenario();
    });

    it('weekly: idle and tracked totals are null (not summed as zero); known-day sums and unavailable dates returned', async () => {
      const w: any = await service.getWeeklyReport({ start_date: '2026-11-08', end_date: '2026-11-14' });
      expect(w.total_idle_time).toBeNull();
      expect(w.total_weekly_hours).toBeNull();
      expect(w.total_idle_time_known_days).toBe('00:15:00'); // 600 (legacy) + 300 + 0 (threshold)
      expect(w.total_tracked_time_known_days).toBe('02:55:00');
      expect(w.idle_unavailable_dates).toEqual(['2026-11-11']);
      expect(w.idle_bases).toEqual(['legacy', 'mixed', 'threshold']);
      expect(w.activity_excludes_dates).toEqual(['2026-11-11']);
      expect(w.average_activity_percentage).toBe(91.43); // (3000 + 3000 + 3600) / (3600 + 3300 + 3600)
      expect(w.daily_productivity_trend.map((t: any) => [t.date, t.idle_hours, t.idle_basis])).toEqual([
        ['Tue, Nov 10', 0.17, 'legacy'], ['Wed, Nov 11', null, 'mixed'], ['Thu, Nov 12', 0.08, 'threshold'],
      ]);
      const emp1 = w.weekly_work_hours.find((h: any) => h.employee === 'Employee 1');
      expect(emp1).toMatchObject({ hours: null, hours_known_days: 1.92 });
      expect(w.weekly_work_hours.find((h: any) => h.employee === 'Employee 2')).toMatchObject({ hours: 1, hours_known_days: 1 });
      expect(w.idle_effective_date).toBe('2026-11-11');
    });

    it('monthly: totals null with known-day sums; ranking and trends mark the mixed day', async () => {
      const m: any = await service.getMonthlyReport({ year: 2026, month: 11 });
      expect(m.total_idle_hours).toBeNull();
      expect(m.total_monthly_work_hours).toBeNull();
      expect(m.total_productive_hours).toBe('03:25:00');
      expect(m.idle_unavailable_dates).toEqual(['2026-11-11']);
      const r1 = m.employee_ranking.find((r: any) => r.user_id === 1);
      expect(r1).toMatchObject({ tracked_hours: null, tracked_hours_known_days: 1.92, activity_percentage: 86.96, activity_excludes_dates: ['2026-11-11'] });
      expect(m.employee_ranking.find((r: any) => r.user_id === 2)).toMatchObject({ tracked_hours: 1, activity_percentage: 100, activity_excludes_dates: [] });
      expect(m.productivity_trends.find((t: any) => t.date === 'Nov 11')).toMatchObject({ idle_hours: null, idle_basis: 'mixed' });
      expect(m.productivity_trends.find((t: any) => t.date === 'Nov 12')).toMatchObject({ idle_hours: 0.08, idle_basis: 'threshold' });
    });

    it('employee analytics: idle-derived totals null over a range with the mixed day', async () => {
      const a: any = await service.getEmployeeAnalytics({ user_id: 1, start_date: '2026-11-10', end_date: '2026-11-12' });
      expect(a.totals).toMatchObject({
        idle_time: null, total_tracked_time: null, desktop_work_time: null, total_engagement_time: null, unaccounted_time: null,
        productive_time: '02:25:00', total_idle_time_known_days: '00:15:00', idle_unavailable_dates: ['2026-11-11'],
      });
      expect(a.daily_breakdown.map((r: any) => r.idle_basis)).toEqual(['legacy', 'mixed', 'threshold']);
      // Without the mixed day every total is available again
      const b: any = await service.getEmployeeAnalytics({ user_id: 1, start_date: '2026-11-12', end_date: '2026-11-12' });
      expect(b.totals).toMatchObject({ idle_time: '00:05:00', total_tracked_time: '00:55:00', idle_unavailable_dates: [] });
    });
  });

  // ---------------------------------------------------------------------------------------------- exports
  describe('exports label the mixed day explicitly', () => {
    const res = () => {
      const r: any = { headers: {}, body: null };
      r.set = jest.fn((h: Row) => Object.assign(r.headers, h));
      r.send = jest.fn((b: any) => (r.body = b));
      return r;
    };
    beforeEach(() => {
      setEffective('2026-11-11');
      scenario();
    });

    it('daily CSV: the mixed day shows "Mixed calculation – unavailable"; real zero stays 00:00:00', async () => {
      const r = res();
      await service.exportReport(r, { type: 'daily', format: 'csv', start_date: '2026-11-10', end_date: '2026-11-12' });
      const lines = String(r.body).trim().split('\n');
      const line = (date: string, emp: string) => lines.find((l) => l.includes(`"${date}"`) && l.includes(emp))!;
      const mixed = line('2026-11-11', 'Employee 1');
      expect(mixed.split(`"${IDLE_UNAVAILABLE_LABEL}"`).length - 1).toBe(5); // idle, desktop work, unaccounted, engagement, activity
      expect(mixed).toContain('"00:45:00"'); // productive time is still shown
      expect(line('2026-11-10', 'Employee 1')).toContain('"00:10:00"');
      expect(line('2026-11-12', 'Employee 2')).toContain('"00:00:00"');
      expect(line('2026-11-12', 'Employee 2')).not.toContain(IDLE_UNAVAILABLE_LABEL);
    });

    it('weekly and monthly CSV: unavailable idle / tracked values are labelled; columns unchanged', async () => {
      const w = res();
      await service.exportReport(w, { type: 'weekly', format: 'csv', start_date: '2026-11-08', end_date: '2026-11-14' });
      const wl = String(w.body).trim().split('\n');
      expect(wl[0]).toBe('Date,Productive Hours,Idle Hours,Total Tracked');
      expect(wl.find((l) => l.includes('Nov 11'))).toBe(`"Wed, Nov 11","0.75","${IDLE_UNAVAILABLE_LABEL}","${IDLE_UNAVAILABLE_LABEL}"`);

      const m = res();
      await service.exportReport(m, { type: 'monthly', format: 'csv', year: 2026, month: 11 });
      const ml = String(m.body).trim().split('\n');
      expect(ml[0]).toBe('user_id,full_name,employee_code,department,productive_hours,tracked_hours,activity_percentage');
      expect(ml.find((l) => l.startsWith('"1"'))).toContain(`"${IDLE_UNAVAILABLE_LABEL}"`);
      expect(ml.find((l) => l.startsWith('"2"'))).toContain('"1"');
    });

    it('PDF: the rows passed to the PDF carry the label, and the PDF (with its legend) is generated', async () => {
      const spy = jest.spyOn(service as any, 'generateReportPdf');
      const r = res();
      await service.exportReport(r, { type: 'daily', format: 'pdf', start_date: '2026-11-10', end_date: '2026-11-12' });
      const data = (spy.mock.calls[0] as any[])[4];
      expect(data.find((d: any) => d.date === '2026-11-11')).toMatchObject({ idle_time: IDLE_UNAVAILABLE_LABEL, activity_percentage: IDLE_UNAVAILABLE_LABEL, productive_time: '00:45:00' });
      expect(data.find((d: any) => d.date === '2026-11-10')).toMatchObject({ idle_time: '00:10:00' });
      expect(Buffer.isBuffer(r.body) && r.body.length > 1000).toBe(true);
      expect(r.body.subarray(0, 5).toString()).toBe('%PDF-');
    });
  });

  // ---------------------------------------------------------------------------------------------- history untouched
  it('historical rows are only read: counters and events unchanged by every report and export', async () => {
    setEffective('2026-11-11');
    scenario();
    const before = JSON.stringify({ s: sessions.rows, e: events.rows });
    await service.getDailyReport({ start_date: '2026-11-10', end_date: '2026-11-12' });
    await service.getWeeklyReport({ start_date: '2026-11-08', end_date: '2026-11-14' });
    await service.getMonthlyReport({ year: 2026, month: 11 });
    await service.getEmployeeAnalytics({ user_id: 1, start_date: '2026-11-10', end_date: '2026-11-12' });
    await service.exportReport({ set: jest.fn(), send: jest.fn() }, { type: 'daily', format: 'csv', start_date: '2026-11-10', end_date: '2026-11-12' });
    for (const fn of [sessions.create, sessions.update, events.create, events.update, activities.create, activities.update]) expect(fn).not.toHaveBeenCalled();
    expect(JSON.stringify({ s: sessions.rows, e: events.rows })).toBe(before);
    expect(sessions.rows.find((s) => s.idle_seconds === 900)).toMatchObject({ productive_seconds: 2700 }); // the mixed day's counter
  });

  // ---------------------------------------------------------------------------------------------- P1-a safety limit
  it('Live idle: a batched result reaching its safety limit is redone per employee, with identical values', async () => {
    at('2026-11-12T09:00:00Z');
    addUser(1);
    addUser(2);
    for (const id of [1, 2]) {
      const s = addSession({ user_id: id, device_id: `pc-${id}`, login_time: u('2026-11-12T03:30:00Z'), last_ping: u('2026-11-12T08:59:55Z'), is_active_session: true, productive_seconds: 10000 });
      addEvent(id, 'session_start', '2026-11-12T03:30:00Z', s.id);
      addEvent(id, 'idle_start', '2026-11-12T05:00:00Z', s.id);
      addEvent(id, 'idle_end', new Date(u('2026-11-12T05:00:00Z').getTime() + id * 60000).toISOString(), s.id);
    }
    // The batched (user_id IN) event query comes back "full": the service must not trust it
    events.findMany.mockImplementation(async (args: Row) =>
      args?.where?.user_id?.in && args.where.user_id.in.length > 1 && args.take > 5000
        ? Array.from({ length: args.take }, (_, i) => ({ id: -i, user_id: 1, session_id: null, activity_type: 'lock', occurred_at: u('2026-11-12T04:00:00Z') }))
        : events.realFindMany(args));
    const status: any[] = (await service.getEmployeeStatus()) as any;
    const single = events.findMany.mock.calls.filter((c: any[]) => typeof c[0]?.where?.user_id === 'number');
    expect(single).toHaveLength(2); // the per-employee fallback ran
    expect(status.map((s) => s.idle_seconds_today)).toEqual([60, 120]);
    for (const s of status) {
      const h: any = await service.getTrackingTimeline({ user_id: String(s.user_id), date: '2026-11-12', tz: 'Asia/Kolkata' });
      expect(s.idle_seconds_today).toBe(h.summary.idle_seconds);
    }
  });
});
