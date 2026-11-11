import { Test, TestingModule } from '@nestjs/testing';
import { TrackingService, BROWSER_DEVICE_ID } from './tracking.service';
import { PrismaService } from '../../core/prisma.service';

/**
 * Phase 1 tracking reliability: device-scoped logout, browser/desktop heartbeat separation,
 * live status, gap detection from real timestamps, and honest hourly-chart series names.
 *
 * Uses a small in-memory Prisma stand-in that honours the `where` filters the service sends
 * (equality, in/notIn, gte/lte, OR/NOT), so device scoping is actually exercised.
 */

type Row = Record<string, any>;

const valueOf = (v: any) => (v instanceof Date ? v.getTime() : v);

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    if (key === 'NOT') return !matches(row, cond);
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const value = valueOf(row[key]);
      if ('notIn' in cond && (cond.notIn as any[]).includes(row[key])) return false;
      if ('in' in cond && !(cond.in as any[]).includes(row[key])) return false;
      if ('gte' in cond && !(value !== null && value !== undefined && value >= valueOf(cond.gte))) return false;
      if ('lte' in cond && !(value !== null && value !== undefined && value <= valueOf(cond.lte))) return false;
      return true;
    }
    return valueOf(row[key]) === valueOf(cond);
  });

const sortRows = (rows: Row[], orderBy?: Row) => {
  if (!orderBy) return rows;
  const [field, dir] = Object.entries(orderBy)[0];
  return [...rows].sort((a, b) => {
    const diff = (valueOf(a[field]) ?? 0) - (valueOf(b[field]) ?? 0);
    return dir === 'desc' ? -diff : diff;
  });
};

const makeTable = (defaults: Row) => {
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
  device_id: BROWSER_DEVICE_ID,
  logout_time: null,
  is_active_session: true,
  last_desktop_ping: null,
  is_desktop_idle: false,
  mouse_moves: 0,
  key_presses: 0,
  clicks: 0,
  productive_seconds: 0,
  idle_seconds: 0,
  tracked_seconds: 0,
  activity_percentage: 0,
};

const ACTIVITY_DEFAULTS = {
  window_title: '',
  duration_seconds: 0,
  mouse_moves: 0,
  key_presses: 0,
  clicks: 0,
  productive_seconds: 0,
  productive_duration: 0,
  is_productive: true,
};

const DESKTOP = 'pc-office-01';
const OTHER_DESKTOP = 'pc-home-02';

describe('TrackingService — Phase 1 reliability', () => {
  let service: TrackingService;
  let sessions: ReturnType<typeof makeTable>;
  let activities: ReturnType<typeof makeTable>;
  let users: Row[];

  const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);

  const addSession = (data: Row): Row => {
    const row: Row = { ...SESSION_DEFAULTS, ...data };
    sessions.rows.push(row);
    return row;
  };

  beforeEach(async () => {
    sessions = makeTable(SESSION_DEFAULTS);
    activities = makeTable(ACTIVITY_DEFAULTS);
    users = [
      { id: 1, name: 'User One', username: 'user1', email: 'u1@example.com', tracking_profile: { is_tracking_enabled: true } },
      { id: 2, name: 'User Two', username: 'user2', email: 'u2@example.com', tracking_profile: { is_tracking_enabled: true } },
    ];

    const prisma = {
      user: {
        findMany: jest.fn(async ({ where }: Row = {}) => users.filter((u) => matches(u, where || {}))),
        findUnique: jest.fn(async ({ where }: Row) => users.find((u) => u.id === where.id) ?? null),
      },
      trackingUserProfile: {
        findUnique: jest.fn(async ({ where }: Row) => ({ id: where.user_id, user_id: where.user_id, is_tracking_enabled: true, screenshots_enabled: true })),
      },
      workSession: sessions,
      appActivity: activities,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [TrackingService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(TrackingService);
  });

  // ---------------------------------------------------------------------------------------------
  // Task 1: device-scoped logout
  // ---------------------------------------------------------------------------------------------
  describe('logout is scoped to the calling device', () => {
    let browser: Row;
    let desktop: Row;

    beforeEach(() => {
      browser = addSession({ id: 1, user_id: 1, device_id: BROWSER_DEVICE_ID, login_time: secondsAgo(600), last_ping: secondsAgo(10) });
      desktop = addSession({ id: 2, user_id: 1, device_id: DESKTOP, login_time: secondsAgo(300), last_ping: secondsAgo(5), last_desktop_ping: secondsAgo(5) });
    });

    it('browser logout ends the browser session and leaves the desktop session running', async () => {
      const res = await service.handleLogout(1, { device_id: BROWSER_DEVICE_ID });

      expect(res.success).toBe(true);
      expect(res.ended_session_ids).toEqual([1]);
      expect(browser.is_active_session).toBe(false);
      expect(browser.logout_time).toBeInstanceOf(Date);
      expect(desktop.is_active_session).toBe(true);
      expect(desktop.logout_time).toBeNull();
    });

    it('desktop logout ends the desktop session and leaves the browser session running', async () => {
      const res = await service.handleLogout(1, { device_id: DESKTOP });

      expect(res.ended_session_ids).toEqual([2]);
      expect(desktop.is_active_session).toBe(false);
      expect(browser.is_active_session).toBe(true);
      expect(browser.logout_time).toBeNull();
    });

    it('a device cannot end another device\'s session', async () => {
      const res = await service.handleLogout(1, { device_id: OTHER_DESKTOP });

      expect(res.success).toBe(true);
      expect(res.session_id).toBeNull();
      expect(res.ended_session_ids).toEqual([]);
      expect(browser.is_active_session).toBe(true);
      expect(desktop.is_active_session).toBe(true);
      expect(sessions.update).not.toHaveBeenCalled();
    });

    it('a device cannot end another user\'s session on the same device id', async () => {
      const otherUser = addSession({ id: 3, user_id: 2, device_id: DESKTOP, login_time: secondsAgo(200), last_ping: secondsAgo(5) });

      await service.handleLogout(1, { device_id: DESKTOP });

      expect(desktop.is_active_session).toBe(false);
      expect(otherUser.is_active_session).toBe(true);
    });

    it.each([
      ['an empty body (current desktop tracker)', {}],
      ['no body (older portal builds)', undefined],
      ['a blank device_id', { device_id: '   ' }],
      ['a non-string device_id', { device_id: 42 }],
    ])('ends nothing when the device is ambiguous: %s', async (_label, body) => {
      const res = await service.handleLogout(1, body as any);

      expect(res.success).toBe(false);
      expect(res.session_id).toBeNull();
      expect(browser.is_active_session).toBe(true);
      expect(desktop.is_active_session).toBe(true);
      expect(sessions.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Task 2: browser and desktop heartbeats stay separate
  // ---------------------------------------------------------------------------------------------
  describe('heartbeats only touch sessions of their own device', () => {
    it('a browser heartbeat never refreshes a live desktop session', async () => {
      const desktopPing = secondsAgo(20);
      const desktop = addSession({ id: 10, user_id: 1, device_id: DESKTOP, login_time: secondsAgo(900), last_ping: desktopPing, last_desktop_ping: desktopPing });

      const res = await service.handleHeartbeat(1, {});

      expect(res.session_id).not.toBe(10);
      expect(desktop.last_ping).toBe(desktopPing);
      expect(desktop.last_desktop_ping).toBe(desktopPing);
      expect(desktop.is_active_session).toBe(true);
      const browser = sessions.rows.find((s) => s.id === res.session_id)!;
      expect(browser.device_id).toBe(BROWSER_DEVICE_ID);
      expect(browser.is_active_session).toBe(true);
    });

    it('a browser heartbeat refreshes the existing browser session and leaves a stale desktop session untouched', async () => {
      const staleDesktopPing = secondsAgo(20 * 60);
      const desktop = addSession({ id: 11, user_id: 1, device_id: DESKTOP, login_time: secondsAgo(3600), last_ping: staleDesktopPing, last_desktop_ping: staleDesktopPing });
      const browser = addSession({ id: 12, user_id: 1, device_id: BROWSER_DEVICE_ID, login_time: secondsAgo(1200), last_ping: secondsAgo(30) });

      const res = await service.handleHeartbeat(1, {});

      expect(res.session_id).toBe(12);
      expect(browser.last_ping.getTime()).toBeGreaterThan(Date.now() - 5000);
      expect(desktop.last_ping).toBe(staleDesktopPing);
      expect(desktop.is_active_session).toBe(true); // closed later by its own device's heartbeat, not by the browser
    });

    it('desktop heartbeat updates its own session and does not close the browser session', async () => {
      const browser = addSession({ id: 20, user_id: 1, device_id: BROWSER_DEVICE_ID, login_time: secondsAgo(600), last_ping: secondsAgo(15) });
      const desktop = addSession({ id: 21, user_id: 1, device_id: DESKTOP, login_time: secondsAgo(600), last_ping: secondsAgo(30), last_desktop_ping: secondsAgo(30) });

      const res = await service.handleHeartbeat(1, {
        device_id: DESKTOP,
        app_name: 'Code.exe',
        window_title: 'tracking.service.ts',
        duration_seconds: 30,
        is_idle: false,
        mouse_moves: 12,
        key_presses: 40,
        clicks: 3,
        timestamp: new Date().toISOString(),
      });

      expect(res.session_id).toBe(21);
      expect(res.status).toBe('Active');
      expect(desktop.last_ping.getTime()).toBeGreaterThan(Date.now() - 5000);
      expect(desktop.last_desktop_ping.getTime()).toBeGreaterThan(Date.now() - 5000);
      expect(desktop.is_desktop_idle).toBe(false);
      expect(desktop.productive_seconds).toBe(30);
      expect(browser.is_active_session).toBe(true);
      expect(browser.logout_time).toBeNull();
      expect(activities.rows).toHaveLength(1);
      expect(activities.rows[0]).toMatchObject({ session_id: 21, app_name: 'Code.exe', duration_seconds: 30 });
    });

    it('desktop heartbeat records idle ticks as idle seconds and flags the session idle', async () => {
      const desktop = addSession({ id: 22, user_id: 1, device_id: DESKTOP, login_time: secondsAgo(600), last_ping: secondsAgo(30), last_desktop_ping: secondsAgo(30) });

      const res = await service.handleHeartbeat(1, { device_id: DESKTOP, app_name: 'Code.exe', duration_seconds: 30, is_idle: true });

      expect(res.status).toBe('Idle');
      expect(desktop.is_desktop_idle).toBe(true);
      expect(desktop.idle_seconds).toBe(30);
      expect(desktop.productive_seconds).toBe(0);
    });

    it('desktop heartbeat still closes the user\'s session on another desktop machine', async () => {
      const otherMachine = addSession({ id: 30, user_id: 1, device_id: OTHER_DESKTOP, login_time: secondsAgo(1200), last_ping: secondsAgo(60), last_desktop_ping: secondsAgo(60) });
      const browser = addSession({ id: 31, user_id: 1, device_id: BROWSER_DEVICE_ID, login_time: secondsAgo(1200), last_ping: secondsAgo(10) });

      await service.handleHeartbeat(1, { device_id: DESKTOP, app_name: 'Code.exe', duration_seconds: 30 });

      expect(otherMachine.is_active_session).toBe(false);
      expect(otherMachine.logout_time).toEqual(otherMachine.last_ping);
      expect(browser.is_active_session).toBe(true);
    });

    it('desktop heartbeat after a >5 minute gap closes the old session at its last heartbeat and opens a new one', async () => {
      const lastPing = secondsAgo(10 * 60);
      const old = addSession({ id: 40, user_id: 1, device_id: DESKTOP, login_time: secondsAgo(3600), last_ping: lastPing, last_desktop_ping: lastPing });

      const res = await service.handleHeartbeat(1, { device_id: DESKTOP, app_name: 'Code.exe', duration_seconds: 30 });

      expect(old.is_active_session).toBe(false);
      expect(old.logout_time).toBe(lastPing);
      expect(res.session_id).not.toBe(40);
      const fresh = sessions.rows.find((s) => s.id === res.session_id)!;
      expect(fresh.device_id).toBe(DESKTOP);
      expect(fresh.is_active_session).toBe(true);
    });
  });

  describe('live status is decided by the desktop tracker', () => {
    it('an open portal tab does not keep a disconnected desktop tracker Active', async () => {
      const stale = secondsAgo(10 * 60);
      addSession({ id: 50, user_id: 1, device_id: DESKTOP, login_time: secondsAgo(3600), last_ping: stale, last_desktop_ping: stale });
      addSession({ id: 51, user_id: 1, device_id: BROWSER_DEVICE_ID, login_time: secondsAgo(1800), last_ping: secondsAgo(10) });

      const status: any = await service.getEmployeeStatus(1);

      expect(status.status).toBe('Offline');
      expect(status.status_source).toBeNull();
      expect(status.login_time).toBeNull();
    });

    it('a live desktop tracker sets the status even while a portal tab is open', async () => {
      addSession({ id: 52, user_id: 1, device_id: DESKTOP, login_time: secondsAgo(600), last_ping: secondsAgo(10), last_desktop_ping: secondsAgo(10), is_desktop_idle: true });
      addSession({ id: 53, user_id: 1, device_id: BROWSER_DEVICE_ID, login_time: secondsAgo(300), last_ping: secondsAgo(5) });

      const status: any = await service.getEmployeeStatus(1);

      expect(status.status).toBe('Idle');
      expect(status.status_source).toBe('desktop');
      expect(status.session_id).toBe(52);
    });

    it('portal-only users keep the existing behaviour (Active while the portal pings)', async () => {
      addSession({ id: 54, user_id: 1, device_id: BROWSER_DEVICE_ID, login_time: secondsAgo(600), last_ping: secondsAgo(10) });

      const status: any = await service.getEmployeeStatus(1);

      expect(status.status).toBe('Active');
      expect(status.status_source).toBe('portal');
      expect(status.session_id).toBe(54);
    });

    it('daily report status uses the same rule', async () => {
      const stale = secondsAgo(10 * 60);
      addSession({ id: 55, user_id: 1, device_id: DESKTOP, login_time: secondsAgo(1800), last_ping: stale, last_desktop_ping: stale });
      addSession({ id: 56, user_id: 1, device_id: BROWSER_DEVICE_ID, login_time: secondsAgo(1700), last_ping: secondsAgo(10) });

      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const rows = await service.getDailyReport({ date: todayStr, user_id: 1 });

      // Only meaningful when both sessions started today (skip the assertion just after midnight)
      if (rows.length === 1) expect(rows[0].status).toBe('Offline');
    });
  });

  describe('daily report portal time', () => {
    it('counts only browser time not already covered by a desktop session', async () => {
      const day = new Date(2026, 0, 15);
      const at = (h: number, m = 0) => new Date(2026, 0, 15, h, m);
      // Desktop 09:00-12:00; browser 08:30-12:30 => portal-only time is 08:30-09:00 + 12:00-12:30 = 60 min
      addSession({ id: 60, user_id: 1, device_id: DESKTOP, login_time: at(9), last_ping: at(12), logout_time: at(12), is_active_session: false, productive_seconds: 3 * 3600 });
      addSession({ id: 61, user_id: 1, device_id: BROWSER_DEVICE_ID, login_time: at(8, 30), last_ping: at(12, 30), logout_time: at(12, 30), is_active_session: false });

      const dayStr = `${day.getFullYear()}-01-15`;
      const [row] = await service.getDailyReport({ date: dayStr, user_id: 1 });

      expect(row.portal_active_time).toBe('01:00:00');
      expect(row.productive_time).toBe('03:00:00');
      expect(row.total_engagement_time).toBe('04:00:00');
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Task 3: gap detection from the timestamps that exist
  // ---------------------------------------------------------------------------------------------
  describe('detectBreaksAndGaps', () => {
    const at = (h: number, m = 0, s = 0) => new Date(2026, 0, 15, h, m, s);
    const desktopSession = { id: 70, user_id: 1, device_id: DESKTOP, login_time: at(9), last_ping: at(12), logout_time: at(12) };

    it('treats an activity row\'s timestamp as the END of its merged period', () => {
      // Row A: 09:50-10:00 (600s, last heartbeat 10:00). Row B: 10:25-10:30 (300s, last heartbeat 10:30).
      const result = service.detectBreaksAndGaps([desktopSession], [
        { session_id: 70, timestamp: at(10), duration_seconds: 600 },
        { session_id: 70, timestamp: at(10, 30), duration_seconds: 300 },
      ]);

      expect(result.breaksList).toHaveLength(1);
      expect(result.breaksList[0]).toMatchObject({ type: 'idle', duration: 25 * 60, estimated: true });
      expect(result.breaksList[0].start).toEqual(at(10));
      expect(result.breaksList[0].end).toEqual(at(10, 25));
    });

    it('does not report a gap for contiguous merged rows (the old calculation invented one)', () => {
      // Row A: one heartbeat ending 10:00. Row B: 30 min merged, 10:00-10:30, last heartbeat 10:30.
      // Old code: A "ended" 10:00:30 and B "started" at its last heartbeat 10:30 => a false 29.5 min gap.
      const result = service.detectBreaksAndGaps([desktopSession], [
        { session_id: 70, timestamp: at(10), duration_seconds: 30 },
        { session_id: 70, timestamp: at(10, 30), duration_seconds: 1800 },
      ]);

      expect(result.breaksList).toEqual([]);
      expect(result.totalBreakSeconds).toBe(0);
    });

    it('handles missing or invalid historical timestamps without inventing times', () => {
      const result = service.detectBreaksAndGaps(
        [
          desktopSession,
          { id: 71, user_id: 1, device_id: DESKTOP, login_time: null, last_ping: null, logout_time: null },
          { id: 72, user_id: 1, device_id: DESKTOP, login_time: 'not-a-date', last_ping: at(13) },
          null,
        ],
        [
          { session_id: 70, timestamp: at(10), duration_seconds: 30 },
          { session_id: 70, timestamp: null, duration_seconds: 30 },
          { session_id: 70, timestamp: 'garbage', duration_seconds: 30 },
          // Unknown duration => its start is unknown => no gap reported before it
          { session_id: 70, timestamp: at(11), duration_seconds: null },
          { session_id: 70, timestamp: at(11, 30), duration_seconds: undefined },
          null,
        ],
      );

      expect(result.breaksList).toEqual([]);
      for (const b of result.breaksList) {
        expect(Number.isFinite(b.start.getTime())).toBe(true);
        expect(Number.isFinite(b.end.getTime())).toBe(true);
      }
    });

    it('copes with empty inputs', () => {
      expect(service.detectBreaksAndGaps([], [])).toEqual({ breaksList: [], breakCount: 0, totalBreakSeconds: 0 });
      expect(service.detectBreaksAndGaps(undefined as any, undefined as any).breakCount).toBe(0);
    });

    it('offline gaps come from desktop sessions only; a portal session in between does not hide them', () => {
      const result = service.detectBreaksAndGaps(
        [
          { id: 80, device_id: DESKTOP, login_time: at(9), last_ping: at(10), logout_time: at(10) },
          { id: 81, device_id: BROWSER_DEVICE_ID, login_time: at(10), last_ping: at(11), logout_time: at(11) },
          { id: 82, device_id: DESKTOP, login_time: at(11), last_ping: at(12), logout_time: at(12) },
        ],
        [],
      );

      expect(result.breaksList).toHaveLength(1);
      expect(result.breaksList[0]).toMatchObject({ type: 'offline', duration: 3600, estimated: false });
      expect(result.breaksList[0].start).toEqual(at(10));
      expect(result.breaksList[0].end).toEqual(at(11));
    });

    it('overlapping sessions never produce a gap', () => {
      const result = service.detectBreaksAndGaps(
        [
          { id: 90, device_id: DESKTOP, login_time: at(9), last_ping: at(12), logout_time: at(12) },
          { id: 91, device_id: OTHER_DESKTOP, login_time: at(10), last_ping: at(11), logout_time: at(11) },
          { id: 92, device_id: DESKTOP, login_time: at(11, 30), last_ping: at(13), logout_time: at(13) },
        ],
        [],
      );

      expect(result.breaksList).toEqual([]);
    });

    it('portal-only days still use browser sessions for offline gaps', () => {
      const result = service.detectBreaksAndGaps(
        [
          { id: 93, device_id: BROWSER_DEVICE_ID, login_time: at(9), last_ping: at(10), logout_time: at(10) },
          { id: 94, device_id: BROWSER_DEVICE_ID, login_time: at(10, 30), last_ping: at(11), logout_time: at(11) },
        ],
        [],
      );

      expect(result.breaksList).toHaveLength(1);
      expect(result.breaksList[0]).toMatchObject({ type: 'offline', duration: 1800 });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Task 4: hourly chart series describe app classification, not inactivity
  // ---------------------------------------------------------------------------------------------
  describe('hourly timeline series', () => {
    it('reports productive / non-productive app minutes and no "idle" series', async () => {
      const session = addSession({ id: 100, user_id: 1, device_id: DESKTOP, login_time: secondsAgo(1800), last_ping: secondsAgo(5), last_desktop_ping: secondsAgo(5) });
      const now = new Date();
      activities.rows.push(
        { ...ACTIVITY_DEFAULTS, id: 1, user_id: 1, session_id: session.id, app_name: 'Code.exe', duration_seconds: 600, timestamp: now },
        // Non-productive app with keyboard input: it is not inactivity, and must not be labelled idle
        { ...ACTIVITY_DEFAULTS, id: 2, user_id: 1, session_id: session.id, app_name: 'chrome.exe', window_title: 'YouTube - Google Chrome', duration_seconds: 300, key_presses: 50, timestamp: now },
      );

      const status: any = await service.getEmployeeStatus(1);
      const hour = status.timeline_data[now.getHours()];

      expect(status.timeline_data).toHaveLength(24);
      for (const entry of status.timeline_data) {
        expect(Object.keys(entry).sort()).toEqual(['hour', 'non_productive_apps', 'productive_apps']);
      }
      expect(hour.productive_apps).toBe(10);
      expect(hour.non_productive_apps).toBe(5);
    });
  });
});
