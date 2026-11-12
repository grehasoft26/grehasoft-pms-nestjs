import { Test, TestingModule } from '@nestjs/testing';
import { TrackingService } from './tracking.service';
import { PrismaService } from '../../core/prisma.service';
import { ACTIVE_EXCLUDED_KINDS } from './tracking-timeline';

/**
 * Unified Active Time: the History Timeline's calculation (buildTrackingTimeline summary.active_seconds) is the single
 * source of truth for Live Tracking (GET /tracking/employee-status active_* fields) and the desktop tracker's Today's Work.
 *
 * Active Time = merged desktop session time within the Asia/Kolkata day, minus merged idle, locked and sleep periods and
 * completed manual breaks. Offline time while the tracker runs counts by its own events; time without a tracker session
 * is excluded. Unfinished periods are closed at the last known boundary and flagged active_estimated.
 */

type Row = Record<string, any>;
const IST = 'Asia/Kolkata';
const DEVICE = 'jisha-pc';
const u = (s: string) => new Date(s);
const valueOf = (v: any) => (v instanceof Date ? v.getTime() : v);

/** In-memory stand-in for the Prisma calls the service makes (same as tracking.idle-consistency.spec.ts). */
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

describe('Unified Active Time (History Timeline = Live Tracking = desktop Today\'s Work)', () => {
  let service: TrackingService;
  let sessions: ReturnType<typeof makeTable>;
  let activities: ReturnType<typeof makeTable>;
  let events: ReturnType<typeof makeTable>;
  let eventId = 1;

  const at = (iso: string) => jest.setSystemTime(u(iso));
  const addSession = (data: Row): Row => {
    const row: Row = { ...SESSION_DEFAULTS, ...data };
    sessions.rows.push(row);
    return row;
  };
  /** A closed desktop session with its desktop start and end events. */
  const closedSession = (id: number, from: string, to: string, extra: Row = {}): Row => {
    const s = addSession({ id, user_id: 1, login_time: u(from), last_ping: u(to), logout_time: u(to), is_active_session: false, ...extra });
    addEvent('session_start', from, id);
    addEvent('session_end', to, id);
    return s;
  };
  const addEvent = (type: string, iso: string, sessionId: number | null, extra: Row = {}): Row => {
    const row: Row = { ...EVENT_DEFAULTS, id: eventId++, user_id: 1, activity_type: type, occurred_at: u(iso), timestamp: u(iso), session_id: sessionId, client_event_id: `t-${eventId}`, ...extra };
    events.rows.push(row);
    return row;
  };
  const tick = (extra: Row = {}) => ({ device_id: DEVICE, app_name: 'Code', window_title: 'tracking.service.ts', duration_seconds: 30, mouse_moves: 3, key_presses: 0, clicks: 0, is_idle: false, events_supported: true, ...extra });
  const live = async (): Promise<any> => service.getEmployeeStatus(1);
  const history = async (date = '2026-11-11'): Promise<any> => service.getTrackingTimeline({ user_id: '1', date, tz: IST });
  /** Live and History for today must agree exactly; returns History's summary. */
  const both = async (date = '2026-11-11') => {
    const h = await history(date);
    const l = await live();
    expect(l.report_date).toBe(date);
    expect(l.active_basis).toBe('timeline');
    expect(l.active_seconds_today).toBe(h.summary.active_seconds);
    expect(l.active_estimated).toBe(h.summary.active_estimated);
    return { h: h.summary, l };
  };

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    at('2026-11-11T09:00:00.000Z'); // 14:30 IST
    eventId = 1;
    sessions = makeTable(SESSION_DEFAULTS);
    activities = makeTable(ACTIVITY_DEFAULTS);
    events = makeTable(EVENT_DEFAULTS, (a, b) => a.user_id === b.user_id && a.client_event_id === b.client_event_id && b.client_event_id !== null);
    const users = [{ id: 1, name: 'Jisha', username: 'jisha', email: 'j@example.com', position: null, department: null, tracking_profile: { is_tracking_enabled: true, screenshots_enabled: true } }];
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

  afterEach(() => jest.useRealTimers());

  it('subtracts idle, locked and sleep (never offline)', () => {
    expect([...ACTIVE_EXCLUDED_KINDS].sort()).toEqual(['idle', 'locked', 'sleep']);
  });

  describe('complete data (active_estimated: false)', () => {
    it('1. a normal active session counts its whole duration', async () => {
      closedSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z');
      const { h, l } = await both();
      expect(h).toMatchObject({ active_seconds: 3600, active_estimated: false, active_reliable: true });
      expect(l.active_time).toBe('01:00:00');
    });

    it('2. idle with the 120-second threshold: the 2 minutes before idle_start stay active', async () => {
      closedSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z');
      // Last input 04:10:00; the tracker records idle_start at last input + 120 s
      addEvent('idle_start', '2026-11-11T04:12:00Z', 1, { reason: 'inactivity_threshold' });
      addEvent('idle_end', '2026-11-11T04:20:00Z', 1);
      const { h } = await both();
      expect(h).toMatchObject({ idle_seconds: 480, active_seconds: 3600 - 480, active_estimated: false });
    });

    it('3a. a lock shorter than 2 minutes is excluded in full', async () => {
      closedSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z');
      addEvent('lock', '2026-11-11T04:10:00Z', 1);
      addEvent('unlock', '2026-11-11T04:11:30Z', 1);
      const { h } = await both();
      expect(h).toMatchObject({ locked_seconds: 90, active_seconds: 3600 - 90 });
    });

    it('3b. a lock longer than 2 minutes, with the idle it causes, is excluded once', async () => {
      closedSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z');
      addEvent('lock', '2026-11-11T04:10:00Z', 1);
      addEvent('idle_start', '2026-11-11T04:12:00Z', 1);
      addEvent('idle_end', '2026-11-11T04:20:00Z', 1);
      addEvent('unlock', '2026-11-11T04:20:00Z', 1);
      const { h } = await both();
      expect(h).toMatchObject({ locked_seconds: 600, idle_seconds: 480, active_seconds: 3600 - 600 });
    });

    it('4. sleep until resume is excluded', async () => {
      closedSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z');
      addEvent('sleep', '2026-11-11T04:10:00Z', 1);
      addEvent('resume', '2026-11-11T04:25:00Z', 1);
      const { h } = await both();
      expect(h).toMatchObject({ sleep_seconds: 900, active_seconds: 2700 });
    });

    it('5. completed manual breaks are excluded; an ongoing break adds nothing', async () => {
      closedSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z');
      addEvent('break_start', '2026-11-11T05:00:00Z', 1);
      addEvent('break_end', '2026-11-11T05:30:00Z', 2);
      closedSession(2, '2026-11-11T05:30:00Z', '2026-11-11T06:00:00Z');
      addEvent('break_start', '2026-11-11T06:00:00Z', 2); // still on break now
      const { h, l } = await both();
      expect(h).toMatchObject({ break_seconds: 1800, active_seconds: 5400, active_estimated: false });
      expect(l.status).toBe('On Break');
    });

    it('5b. a completed break overlapping session time (clock skew) is subtracted once, never twice', async () => {
      closedSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z');
      addEvent('break_start', '2026-11-11T04:50:00Z', 1);
      addEvent('idle_start', '2026-11-11T04:50:00Z', 1);
      addEvent('idle_end', '2026-11-11T05:00:00Z', 1);
      addEvent('break_end', '2026-11-11T05:10:00Z', 1);
      const { h } = await both();
      expect(h.active_seconds).toBe(3000);
    });

    it('6. offline with queued inactivity events: only the idle part is excluded', async () => {
      closedSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z');
      addEvent('offline_start', '2026-11-11T04:10:00Z', 1);
      addEvent('idle_start', '2026-11-11T04:20:00Z', 1); // recorded offline, synced later
      addEvent('idle_end', '2026-11-11T04:30:00Z', 1);
      addEvent('offline_end', '2026-11-11T04:40:00Z', 1);
      const { h } = await both();
      expect(h).toMatchObject({ offline_seconds: 1800, idle_seconds: 600, active_seconds: 3000, active_estimated: false });
    });

    it('7. offline with no inactivity events counts as active (the tracker kept running)', async () => {
      closedSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z');
      addEvent('offline_start', '2026-11-11T04:10:00Z', 1);
      addEvent('offline_end', '2026-11-11T04:40:00Z', 1);
      const { h } = await both();
      expect(h).toMatchObject({ offline_seconds: 1800, active_seconds: 3600 });
    });

    it('9. overlapping idle, lock and sleep are merged before subtracting', async () => {
      closedSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z');
      addEvent('idle_start', '2026-11-11T04:10:00Z', 1);
      addEvent('lock', '2026-11-11T04:15:00Z', 1);
      addEvent('sleep', '2026-11-11T04:20:00Z', 1);
      addEvent('unlock', '2026-11-11T04:25:00Z', 1);
      addEvent('idle_end', '2026-11-11T04:30:00Z', 1);
      addEvent('resume', '2026-11-11T04:40:00Z', 1);
      const { h } = await both();
      expect(h.active_seconds).toBe(3600 - 1800); // union 04:10-04:40
    });

    it('10. a session crossing midnight IST is split at 00:00 IST; Live (today) equals History (today)', async () => {
      at('2026-11-11T19:30:00Z'); // 01:00 IST on the 12th
      closedSession(1, '2026-11-11T18:00:00Z', '2026-11-11T19:00:00Z'); // 23:30 -> 00:30 IST
      addEvent('idle_start', '2026-11-11T18:20:00Z', 1);
      addEvent('idle_end', '2026-11-11T18:40:00Z', 1); // 10 min each side of midnight
      expect((await history('2026-11-11')).summary.active_seconds).toBe(1800 - 600);
      const { h } = await both('2026-11-12');
      expect(h.active_seconds).toBe(1800 - 600);
    });

    it('11. multiple sessions: overlaps are merged, gaps between sessions are not counted', async () => {
      closedSession(1, '2026-11-11T03:30:00Z', '2026-11-11T04:30:00Z');
      closedSession(2, '2026-11-11T04:00:00Z', '2026-11-11T04:45:00Z', { device_id: 'laptop-2' });
      closedSession(3, '2026-11-11T05:00:00Z', '2026-11-11T06:00:00Z');
      const { h } = await both();
      expect(h.active_seconds).toBe(75 * 60 + 60 * 60);
    });

    it('12. an ongoing session grows with the clock, minus an ongoing idle period', async () => {
      addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T08:00:00Z'), last_ping: u('2026-11-11T08:59:50Z') });
      addEvent('session_start', '2026-11-11T08:00:00Z', 1);
      let r = await both();
      expect(r.h).toMatchObject({ active_seconds: 3600, active_estimated: false, includes_ongoing: true });

      at('2026-11-11T09:01:00Z');
      r = await both();
      expect(r.h.active_seconds).toBe(3660);

      addEvent('idle_start', '2026-11-11T09:00:00Z', 1);
      at('2026-11-11T09:02:00Z');
      r = await both();
      expect(r.h.active_seconds).toBe(3600); // 3720 elapsed - 120 idle so far
    });
  });

  describe('offline batch synchronisation', () => {
    it('8. queued heartbeats extend the session they belong to; a re-sent batch never double counts', async () => {
      const beat = async (iso: string) => {
        at(iso);
        await service.handleHeartbeat(1, tick({ timestamp: iso }));
      };
      await beat('2026-11-11T08:00:00Z');
      await beat('2026-11-11T08:05:00Z');
      // Network down 08:05 -> 08:20: the tracker keeps running and queues a heartbeat every 30 s
      await beat('2026-11-11T08:20:00Z'); // timeout: session 1 closed at 08:05, session 2 opened at 08:20
      for (const iso of ['2026-11-11T08:23:00Z', '2026-11-11T08:26:00Z', '2026-11-11T08:29:50Z']) await beat(iso);
      at('2026-11-11T08:30:00Z');

      // Before the queue is synced the gap has no tracker data: not counted
      let r = await both();
      expect(r.h.active_seconds).toBe(300 + 600);

      const queued = Array.from({ length: 29 }, (_, i) => ({
        app_name: 'Code', window_title: 'tracking.service.ts', duration_seconds: 30, is_idle: false, mouse_moves: 2,
        timestamp: new Date(u('2026-11-11T08:05:30Z').getTime() + i * 30000).toISOString(),
      }));
      await service.handleActivityBatchSync(1, { device_id: DEVICE, activities: queued });
      r = await both();
      expect(r.h.active_seconds).toBe(19 * 60 + 30 + 600); // 08:00-08:19:30 and 08:20-08:30
      expect(r.h.active_estimated).toBe(false);

      // The same batch again (e.g. its response was lost): Active Time is unchanged
      await service.handleActivityBatchSync(1, { device_id: DEVICE, activities: queued });
      expect((await both()).h.active_seconds).toBe(19 * 60 + 30 + 600);
    });
  });

  describe('incomplete data (conservative, active_estimated: true)', () => {
    it('13. a crashed session counts only up to its last heartbeat', async () => {
      addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T04:00:00Z'), last_ping: u('2026-11-11T07:00:00Z') }); // still flagged active
      addEvent('session_start', '2026-11-11T04:00:00Z', 1);
      const { h, l } = await both();
      expect(h).toMatchObject({ active_seconds: 3 * 3600, active_estimated: true, active_reliable: false });
      expect(l.active_time).toBe('03:00:00');
    });

    it('14a. an idle, lock or sleep period without an end is inactive until its session\'s last known boundary', async () => {
      closedSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z');
      addEvent('idle_start', '2026-11-11T04:45:00Z', 1); // never closed
      const { h } = await both();
      expect(h).toMatchObject({ idle_seconds: 0, active_seconds: 2700, active_estimated: true });
    });

    it('14b. a crash during sleep: the sleep runs to the last heartbeat, never beyond', async () => {
      addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T04:00:00Z'), last_ping: u('2026-11-11T07:00:00Z') });
      addEvent('session_start', '2026-11-11T04:00:00Z', 1);
      addEvent('sleep', '2026-11-11T06:30:00Z', 1);
      const { h } = await both();
      expect(h).toMatchObject({ active_seconds: 2.5 * 3600, active_estimated: true });
    });

    it('14c. a closing event without its opening is inactive since the previous recorded event of the session', async () => {
      closedSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z');
      addEvent('idle_start', '2026-11-11T04:10:00Z', 1);
      addEvent('idle_end', '2026-11-11T04:20:00Z', 1);
      addEvent('unlock', '2026-11-11T04:30:00Z', 1); // its lock was never recorded
      const { h } = await both();
      expect(h).toMatchObject({ active_seconds: 3600 - 600 - 600, active_estimated: true });
    });

    it('14d. one session\'s unfinished period never removes time from a later session', async () => {
      closedSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z');
      addEvent('lock', '2026-11-11T04:50:00Z', 1); // never closed in session 1
      closedSession(2, '2026-11-11T06:00:00Z', '2026-11-11T07:00:00Z');
      addEvent('unlock', '2026-11-11T06:10:00Z', 2); // not paired across sessions; inactive 06:00-06:10 only
      const { h } = await both();
      expect(h.active_seconds).toBe(3000 + 3000);
    });
  });

  describe('Employee status API', () => {
    it('15. returns the Active Time fields next to the unchanged productive_time (backward compatible)', async () => {
      addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T08:00:00Z'), last_ping: u('2026-11-11T08:59:50Z'), productive_seconds: 1234, idle_seconds: 60 });
      addEvent('session_start', '2026-11-11T08:00:00Z', 1);
      addEvent('lock', '2026-11-11T08:30:00Z', 1);
      addEvent('unlock', '2026-11-11T08:31:00Z', 1);
      const l = await live();
      expect(l).toMatchObject({
        active_seconds_today: 3540,
        active_time: '00:59:00',
        active_basis: 'timeline',
        active_estimated: false,
        as_of: '2026-11-11T09:00:00.000Z',
        report_date: '2026-11-11',
        report_time_zone: IST,
        // Unchanged: still the heartbeat counters (older trackers and Reports keep their meaning)
        productive_time: '00:20:34',
        total_work_time: '00:20:34',
        productive_seconds: 1234,
      });
      for (const key of ['idle_time', 'total_tracked_time', 'desktop_work_time', 'activity_percentage', 'idle_seconds_today', 'idle_basis', 'status']) {
        expect(l).toHaveProperty(key);
      }
    });

    it('16. is the same calculation for every employee in the list (no extra queries for Active Time)', async () => {
      closedSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z');
      addEvent('idle_start', '2026-11-11T04:10:00Z', 1);
      addEvent('idle_end', '2026-11-11T04:20:00Z', 1);
      const before = events.findMany.mock.calls.length;
      const list: any[] = (await service.getEmployeeStatus()) as any;
      // Open breaks + the one batched timeline query that already served idle time: Active Time adds none
      expect(events.findMany.mock.calls.length - before).toBe(2);
      expect(list[0].active_seconds_today).toBe((await history()).summary.active_seconds);
    });

    it('17. falls back to the heartbeat counters, labelled and estimated, only when events cannot be read', async () => {
      addSession({ id: 1, user_id: 1, login_time: u('2026-11-11T08:00:00Z'), last_ping: u('2026-11-11T08:59:55Z'), productive_seconds: 3000, idle_seconds: 120 });
      events.findMany.mockImplementation(async () => { throw new Error('events table unavailable'); });
      const l = await live();
      expect(l).toMatchObject({ active_basis: 'heartbeat_counters', active_estimated: true, active_seconds_today: 3000, active_time: '00:50:00' });
    });

    it('18. is read-only', async () => {
      closedSession(1, '2026-11-11T04:00:00Z', '2026-11-11T05:00:00Z');
      await live();
      await history();
      for (const t of [sessions, events, activities]) {
        expect(t.create).not.toHaveBeenCalled();
        expect(t.update).not.toHaveBeenCalled();
      }
    });
  });
});
