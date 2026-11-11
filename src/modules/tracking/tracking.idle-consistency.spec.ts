import { Test, TestingModule } from '@nestjs/testing';
import { TrackingService, heartbeatTickSeconds } from './tracking.service';
import { PrismaService } from '../../core/prisma.service';
import { REPORTING_TIME_ZONE, parseTimelineQuery, reportingToday, sameReportingDay } from './tracking-timeline';

/**
 * Idle time consistency between Live Tracking (GET /tracking/employee-status) and the History Timeline
 * (GET /tracking/reports/timeline):
 * - heartbeat ticks are idle only when the tracker reports is_idle (threshold-based), in live heartbeats and offline batches;
 * - Live idle_time is the History Timeline's idle_seconds for today, computed by the same code from the same rows;
 * - "today" is the Asia/Kolkata calendar day, whatever the server's own time zone;
 * - stored history is only read, never rewritten.
 */

type Row = Record<string, any>;
const IST = 'Asia/Kolkata';
const DEVICE = 'jisha-pc';
const u = (s: string) => new Date(s);
const valueOf = (v: any) => (v instanceof Date ? v.getTime() : v);

/** In-memory stand-in for the Prisma calls the service makes (equality, null, in/notIn, not, gt/gte/lt/lte, OR/NOT). */
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

const makeTable = (defaults: Row, unique?: (a: Row, b: Row) => boolean) => {
  const rows: Row[] = [];
  let nextId = 5000;
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
      if (unique && rows.some((r) => unique(r, row))) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
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
  device_id: DEVICE, logout_time: null, is_active_session: true, last_desktop_ping: null, is_desktop_idle: false,
  mouse_moves: 0, key_presses: 0, clicks: 0, productive_seconds: 0, idle_seconds: 0, tracked_seconds: 0, activity_percentage: 0,
};
const ACTIVITY_DEFAULTS = { window_title: '', duration_seconds: 0, mouse_moves: 0, key_presses: 0, clicks: 0, productive_seconds: 0, productive_duration: 0, is_productive: true };
const EVENT_DEFAULTS = { session_id: null, source: 'desktop_client', reason: null, device_id: DEVICE, ended_at: null, metadata: null, client_event_id: null };

describe('Idle time: threshold-based heartbeat ticks, shared Live/History calculation, Asia/Kolkata day', () => {
  let service: TrackingService;
  let sessions: ReturnType<typeof makeTable>;
  let activities: ReturnType<typeof makeTable>;
  let events: ReturnType<typeof makeTable>;
  let prisma: Row;
  let eventId = 1;

  /** Only Date is faked; Nest's module compilation keeps real timers. */
  const at = (iso: string) => jest.setSystemTime(u(iso));
  const addSession = (data: Row): Row => {
    const row: Row = { ...SESSION_DEFAULTS, ...data };
    sessions.rows.push(row);
    return row;
  };
  const addEvent = (type: string, iso: string, sessionId: number | null, extra: Row = {}): Row => {
    const row: Row = { ...EVENT_DEFAULTS, id: eventId++, user_id: 1, activity_type: type, occurred_at: u(iso), timestamp: u(iso), session_id: sessionId, client_event_id: `t-${eventId}`, ...extra };
    events.rows.push(row);
    return row;
  };
  const tick = (extra: Row = {}) => ({ device_id: DEVICE, app_name: 'Code', window_title: 'tracking.service.ts', duration_seconds: 10, mouse_moves: 0, key_presses: 0, clicks: 0, is_idle: false, events_supported: true, ...extra });
  const live = async (): Promise<any> => service.getEmployeeStatus(1);
  const history = async (date: string, tz: string | undefined = IST): Promise<any> => service.getTrackingTimeline({ user_id: '1', date, ...(tz ? { tz } : {}) });

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    at('2026-11-11T09:00:00.000Z'); // 14:30 IST
    eventId = 1;
    sessions = makeTable(SESSION_DEFAULTS);
    activities = makeTable(ACTIVITY_DEFAULTS);
    events = makeTable(EVENT_DEFAULTS, (a, b) => a.user_id === b.user_id && a.client_event_id === b.client_event_id && b.client_event_id !== null);
    const users = [{ id: 1, name: 'Jisha', username: 'jisha', email: 'j@example.com', position: null, department: null, tracking_profile: { is_tracking_enabled: true, screenshots_enabled: true } }];
    prisma = {
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

  afterEach(() => jest.useRealTimers());

  // ------------------------------------------------------------------------------------------------ 1-3: tick rule
  describe('heartbeat tick classification', () => {
    it('the rule itself: is_idle decides, input does not; each tick lands in exactly one bucket', () => {
      expect(heartbeatTickSeconds(false, 10)).toEqual({ activeSeconds: 10, idleSeconds: 0 });
      expect(heartbeatTickSeconds(true, 10)).toEqual({ activeSeconds: 0, idleSeconds: 10 });
      expect(heartbeatTickSeconds(false, -5)).toEqual({ activeSeconds: 0, idleSeconds: 0 });
    });

    it('1. 10 s with no keyboard/mouse input but is_idle=false does NOT add idle (it is active time)', async () => {
      const s = addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T08:00:00Z'), last_ping: u('2026-11-11T08:59:55Z'), productive_seconds: 100 });
      await service.handleHeartbeat(1, tick({ is_idle: false, mouse_moves: 0, key_presses: 0, clicks: 0 }));
      expect(s.idle_seconds).toBe(0);
      expect(s.productive_seconds).toBe(110);
      expect(s.tracked_seconds).toBe(110);
    });

    it('2. a heartbeat with is_idle=true adds its duration to idle (and not to productive)', async () => {
      const s = addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T08:00:00Z'), last_ping: u('2026-11-11T08:59:55Z'), productive_seconds: 100 });
      await service.handleHeartbeat(1, tick({ is_idle: true }));
      expect(s.idle_seconds).toBe(10);
      expect(s.productive_seconds).toBe(100);
      expect(s.tracked_seconds).toBe(110);
    });

    it('3. offline batch-sync uses the same rule (no input + not idle = active; is_idle = idle)', async () => {
      const s = addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T08:00:00Z'), last_ping: u('2026-11-11T08:59:55Z') });
      const res: any = await service.handleActivityBatchSync(1, {
        device_id: DEVICE,
        activities: [
          { app_name: 'Code', timestamp: '2026-11-11T08:58:00Z', duration_seconds: 10, is_idle: false },
          { app_name: 'Code', timestamp: '2026-11-11T08:58:10Z', duration_seconds: 10, is_idle: true },
          { app_name: 'Code', timestamp: '2026-11-11T08:58:20Z', duration_seconds: 10, is_idle: true },
          { app_name: 'Code', timestamp: '2026-11-11T08:58:30Z', duration_seconds: 10, is_idle: false, mouse_moves: 4 },
        ],
      });
      expect(res.synced_count).toBe(4);
      expect(s.productive_seconds).toBe(20);
      expect(s.idle_seconds).toBe(20);
      expect(s.tracked_seconds).toBe(40);
    });
  });

  // ------------------------------------------------------------------------------------------------ 4-5: open / incomplete
  describe('idle intervals: ongoing and incomplete', () => {
    it('4. an open idle period in a live session counts up to now, identically in Live and History', async () => {
      addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T08:00:00Z'), last_ping: u('2026-11-11T08:59:55Z'), productive_seconds: 3000 });
      addEvent('session_start', '2026-11-11T08:00:00Z', 1);
      addEvent('idle_start', '2026-11-11T08:50:00Z', 1, { reason: 'inactivity_threshold' });

      const l = await live();
      const h = await history('2026-11-11');
      expect(h.summary.idle_seconds).toBe(600);
      expect(l.idle_seconds_today).toBe(600);
      expect(l.idle_time).toBe('00:10:00');
      expect(l.idle_ongoing).toBe(true);
      expect(l.idle_basis).toBe('threshold_events');
    });

    it('5. an idle period whose end is unknown (session ended) is not counted, in Live or History', async () => {
      addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T06:00:00Z'), last_ping: u('2026-11-11T08:30:00Z'), logout_time: u('2026-11-11T08:30:00Z'), is_active_session: false });
      addEvent('session_start', '2026-11-11T06:00:00Z', 1);
      addEvent('idle_start', '2026-11-11T07:00:00Z', 1);
      addEvent('idle_end', '2026-11-11T07:10:00Z', 1);
      addEvent('idle_start', '2026-11-11T08:20:00Z', 1); // never closed
      addEvent('session_end', '2026-11-11T08:30:00Z', 1);

      const l = await live();
      const h = await history('2026-11-11');
      expect(h.summary.idle_seconds).toBe(600);
      expect(h.summary.incomplete_interval_count).toBe(1);
      expect(l.idle_seconds_today).toBe(600);
      expect(l.idle_incomplete_count).toBe(1);
      expect(l.idle_ongoing).toBe(false);
    });
  });

  // ------------------------------------------------------------------------------------------------ 6-7: Asia/Kolkata day
  describe('reporting day is Asia/Kolkata, whatever the server time zone', () => {
    const originalTz = process.env.TZ;
    beforeEach(() => (process.env.TZ = 'UTC')); // production-like server clock
    afterEach(() => (process.env.TZ = originalTz));

    it('6a. today and its start are taken in Asia/Kolkata (UTC server)', () => {
      expect(REPORTING_TIME_ZONE).toBe(IST);
      expect(reportingToday(u('2026-11-11T18:29:59Z'))).toEqual({ date: '2026-11-11', start: u('2026-11-10T18:30:00Z') });
      expect(reportingToday(u('2026-11-11T18:30:00Z'))).toEqual({ date: '2026-11-12', start: u('2026-11-11T18:30:00Z') });
      expect(sameReportingDay(u('2026-11-11T18:29:59Z').getTime(), u('2026-11-11T18:30:00Z').getTime())).toBe(false);
      expect(sameReportingDay(u('2026-11-10T18:30:00Z').getTime(), u('2026-11-11T18:29:59Z').getTime())).toBe(true);
      // The History Timeline defaults to the same zone when the caller gives none
      const parsed: any = parseTimelineQuery({ user_id: '1' }, u('2026-11-11T19:00:00Z'));
      expect(parsed.query).toMatchObject({ tz: IST, from: '2026-11-12', to: '2026-11-12' });
    });

    it('6b. Live counts sessions from 00:00 IST (18:30 UTC), not from the server\'s midnight', async () => {
      at('2026-11-11T19:00:00Z'); // 00:30 IST on the 12th; 19:00 on the 11th for the UTC server
      addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T17:00:00Z'), last_ping: u('2026-11-11T18:00:00Z'), logout_time: u('2026-11-11T18:00:00Z'), is_active_session: false, productive_seconds: 3600 }); // 22:30-23:30 IST on the 11th
      addSession({ id: 2, user_id: 1, login_time: u('2026-11-11T18:40:00Z'), last_ping: u('2026-11-11T18:59:55Z'), productive_seconds: 1190 }); // 00:10 IST on the 12th

      const l = await live();
      expect(l.report_date).toBe('2026-11-12');
      expect(l.report_time_zone).toBe(IST);
      expect(l.productive_time).toBe('00:19:50'); // session 2 only
      // The employee's "today" sessions query (found by shape: the batched idle query runs first and filters differently)
      const statusQuery = sessions.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.OR?.[0]?.login_time?.gte);
      expect(statusQuery.where.OR[0].login_time.gte).toEqual(u('2026-11-11T18:30:00Z'));
    });

    it('7. a session crossing midnight IST splits its idle at 00:00 IST; Live (today) equals History (today)', async () => {
      at('2026-11-11T19:30:00Z'); // 01:00 IST on the 12th
      addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T18:00:00Z'), last_ping: u('2026-11-11T19:29:55Z') }); // from 23:30 IST
      addEvent('session_start', '2026-11-11T18:00:00Z', 1);
      addEvent('idle_start', '2026-11-11T18:05:00Z', 1);
      addEvent('idle_end', '2026-11-11T18:15:00Z', 1); // 10 min on the 11th
      addEvent('idle_start', '2026-11-11T18:25:00Z', 1);
      addEvent('idle_end', '2026-11-11T18:35:00Z', 1); // 5 min on the 11th + 5 min on the 12th

      const day11 = await history('2026-11-11');
      const day12 = await history('2026-11-12');
      expect(day11.summary.idle_seconds).toBe(900);
      expect(day12.summary.idle_seconds).toBe(300);
      const l = await live();
      expect(l.report_date).toBe('2026-11-12');
      expect(l.idle_seconds_today).toBe(day12.summary.idle_seconds);
    });
  });

  // ------------------------------------------------------------------------------------------------ 8: consistency
  describe('Live and History agree for the same employee and date', () => {
    it('8a. several closed periods, a duplicate, a server-recorded period and an ongoing one: identical totals', async () => {
      at('2026-11-11T12:00:00Z');
      addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T03:30:00Z'), last_ping: u('2026-11-11T07:00:00Z'), logout_time: u('2026-11-11T07:00:00Z'), is_active_session: false, idle_seconds: 1650 });
      addSession({ id: 2, user_id: 1, login_time: u('2026-11-11T08:00:00Z'), last_ping: u('2026-11-11T11:59:55Z') });
      addEvent('session_start', '2026-11-11T03:30:00Z', 1);
      addEvent('idle_start', '2026-11-11T04:00:00Z', 1);
      addEvent('idle_end', '2026-11-11T04:07:30Z', 1);
      addEvent('idle_start', '2026-11-11T04:00:20Z', 1); // duplicate within the duplicate window (suppressed)
      addEvent('idle_start', '2026-11-11T05:00:00Z', 1, { source: 'server_heartbeat', reason: 'heartbeat_state_change' });
      addEvent('idle_end', '2026-11-11T05:20:10Z', 1, { source: 'server_heartbeat', reason: 'heartbeat_state_change' });
      addEvent('session_end', '2026-11-11T07:00:00Z', 1);
      addEvent('session_start', '2026-11-11T08:00:00Z', 2);
      addEvent('idle_start', '2026-11-11T11:55:00Z', 2);

      const h = await history('2026-11-11');
      const l = await live();
      expect(h.summary.idle_seconds).toBe(450 + 1210 + 300);
      expect(l.idle_seconds_today).toBe(h.summary.idle_seconds);
      expect(l.idle_time).toBe('00:32:40');
      // The History Timeline without tz defaults to the same Asia/Kolkata day
      const hDefault = await history('2026-11-11', undefined);
      expect(hDefault.summary.idle_seconds).toBe(h.summary.idle_seconds);
      // Not the 1650 s in the old session counter
      expect(l.idle_seconds_today).not.toBe(1650);
    });

    it('8b. heartbeat counters and events agree within one heartbeat interval (legacy fallback events)', async () => {
      // A tracker without event support: the server records idle_start/idle_end at the heartbeat that reports the change
      let t = u('2026-11-11T08:00:00Z').getTime();
      const seq = [false, false, false, true, true, true, true, true, true, false, false];
      for (const idle of seq) {
        at(new Date(t).toISOString());
        await service.handleHeartbeat(1, tick({ is_idle: idle, events_supported: undefined, mouse_moves: idle ? 0 : 3, timestamp: new Date(t).toISOString() }));
        t += 10000;
      }
      const s = sessions.rows[0];
      expect(s.idle_seconds).toBe(60); // 6 idle ticks
      at(new Date(t).toISOString());
      const h = await history('2026-11-11');
      const l = await live();
      expect(Math.abs(h.summary.idle_seconds - s.idle_seconds)).toBeLessThanOrEqual(10);
      expect(l.idle_seconds_today).toBe(h.summary.idle_seconds);
    });

    it('falls back to the heartbeat counters, labelled, only when tracking events cannot be read', async () => {
      addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T08:00:00Z'), last_ping: u('2026-11-11T08:59:55Z'), productive_seconds: 3000, idle_seconds: 120 });
      events.findMany.mockImplementation(async () => { throw new Error('events table unavailable'); });
      const l = await live();
      expect(l.idle_basis).toBe('heartbeat_counters');
      expect(l.idle_seconds_today).toBe(120);
    });
  });

  // ------------------------------------------------------------------------------------------------ 9: legacy tracker
  describe('9. legacy trackers (no event support) stay compatible', () => {
    it('their is_idle heartbeats still create server idle events, and those events drive Live and History idle', async () => {
      addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T08:00:00Z'), last_ping: u('2026-11-11T08:59:50Z'), last_desktop_ping: u('2026-11-11T08:59:50Z'), is_desktop_idle: false });
      await service.handleHeartbeat(1, tick({ is_idle: true, events_supported: undefined }));
      const idleEvents = events.rows.filter((e) => e.activity_type === 'idle_start');
      expect(idleEvents).toHaveLength(1);
      expect(idleEvents[0]).toMatchObject({ source: 'server_heartbeat', session_id: 1 });
      expect(sessions.rows[0].idle_seconds).toBe(10);

      at('2026-11-11T09:05:00Z');
      sessions.rows[0].last_ping = u('2026-11-11T09:04:55Z');
      const l = await live();
      const h = await history('2026-11-11');
      expect(h.summary.idle_seconds).toBe(300);
      expect(l.idle_seconds_today).toBe(300);
      expect(l.idle_ongoing).toBe(true);
    });

    it('a tracker that sends its own events gets no duplicate server idle events (no double counting)', async () => {
      addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T08:00:00Z'), last_ping: u('2026-11-11T08:59:50Z'), last_desktop_ping: u('2026-11-11T08:59:50Z'), is_desktop_idle: false });
      await service.handleHeartbeat(1, tick({ is_idle: true, events_supported: true }));
      expect(events.rows.filter((e) => e.activity_type === 'idle_start')).toHaveLength(0);
      expect(sessions.rows[0].idle_seconds).toBe(10);
    });
  });

  // ------------------------------------------------------------------------------------------------ 10: history untouched
  describe('10. existing historical records remain unchanged', () => {
    it('Live and History only read: no session or event is created, updated or rewritten', async () => {
      const old = addSession({ id: 1, user_id: 1, login_time: u('2026-11-10T04:00:00Z'), last_ping: u('2026-11-10T08:00:00Z'), logout_time: u('2026-11-10T08:00:00Z'), is_active_session: false, productive_seconds: 12510, idle_seconds: 1650, tracked_seconds: 14160 });
      addSession({ id: 2, user_id: 1, login_time: u('2026-11-11T08:00:00Z'), last_ping: u('2026-11-11T08:59:55Z'), productive_seconds: 3000, idle_seconds: 420 });
      addEvent('idle_start', '2026-11-11T08:10:00Z', 2);
      addEvent('idle_end', '2026-11-11T08:15:00Z', 2);
      const before = JSON.stringify({ s: sessions.rows, e: events.rows });

      await live();
      await history('2026-11-10');
      await history('2026-11-11');

      for (const fn of [sessions.create, sessions.update, events.create, events.update, activities.create, activities.update]) expect(fn).not.toHaveBeenCalled();
      expect(JSON.stringify({ s: sessions.rows, e: events.rows })).toBe(before);
      expect(old).toMatchObject({ productive_seconds: 12510, idle_seconds: 1650, tracked_seconds: 14160 });
    });

    it('a new tick on a session that already holds old-rule seconds only adds the new tick (nothing is recalculated)', async () => {
      const s = addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T03:30:00Z'), last_ping: u('2026-11-11T08:59:55Z'), productive_seconds: 12510, idle_seconds: 1650 });
      await service.handleHeartbeat(1, tick({ is_idle: false }));
      expect(s.idle_seconds).toBe(1650);
      expect(s.productive_seconds).toBe(12520);
    });
  });
});
