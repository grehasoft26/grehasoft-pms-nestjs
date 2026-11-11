import { Test, TestingModule } from '@nestjs/testing';
import { TrackingService } from './tracking.service';
import { PrismaService } from '../../core/prisma.service';
import { CLIENT_EVENT_TYPES, PERIOD_OPENING_TYPES, validateClientEvent } from './tracking-events';
import {
  BREAK_STALE_MS,
  TimelineEventRow,
  TimelineQuery,
  TimelineSessionRow,
  buildTrackingTimeline,
  resolveOpenBreaks,
} from './tracking-timeline';

/**
 * Stage 4: manual breaks (Stop Tracking = Start Break, Start Tracking = End Break). Event validation, pairing of
 * break_start / break_end across the two sessions, Break Time (completed breaks only), incomplete and ongoing
 * breaks, and the live "On Break" status. Pure logic plus the service's status query.
 */

const IST = 'Asia/Kolkata';
const u = (s: string) => new Date(s);
let nextId = 1;
const ev = (type: string, at: string, session_id: number | null, source = 'desktop_client', extra: Partial<TimelineEventRow> = {}): TimelineEventRow => ({
  id: nextId++, session_id, activity_type: type, occurred_at: u(at), source, reason: null, device_id: 'jisha', ended_at: null, ...extra,
});
const session = (id: number, login: string, logout: string | null, extra: Partial<TimelineSessionRow> = {}): TimelineSessionRow => ({
  id, device_id: 'jisha', login_time: u(login), logout_time: logout ? u(logout) : null, last_ping: u(logout ?? login),
  is_active_session: logout === null, tracked_seconds: 0, ...extra,
});
const query = (extra: Partial<TimelineQuery> = {}): TimelineQuery => ({ userId: 1, from: '2026-11-07', to: '2026-11-07', tz: IST, eventTypes: null, page: 1, limit: 20, ...extra });
const build = (sessions: TimelineSessionRow[], events: TimelineEventRow[], q: Partial<TimelineQuery> = {}, now = u('2026-11-07T18:00:00Z')) =>
  buildTrackingTimeline({ sessions, events, query: query(q), now, employee: { id: 1 } });

/** Work 09:00-10:00 UTC (session 1), break 10:00:00 -> 10:05:30, work 10:05:30-11:00 (session 2). */
const oneBreakDay = () => {
  nextId = 1;
  const s1 = session(1, '2026-11-07T09:00:00Z', '2026-11-07T10:00:00.040Z');
  const s2 = session(2, '2026-11-07T10:05:30.100Z', '2026-11-07T11:00:00Z');
  const events = [
    ev('session_start', '2026-11-07T09:00:00Z', 1),
    // Stop Tracking: break_start is queued before session_end, so it carries the closing session's id
    ev('break_start', '2026-11-07T10:00:00.000Z', 1, 'desktop_client', { reason: 'manual_break' }),
    ev('session_end', '2026-11-07T10:00:00.020Z', 1),
    // Start Tracking: break_end first, then the new run's session_start (session 2)
    ev('break_end', '2026-11-07T10:05:30.000Z', 2, 'desktop_client', { reason: 'manual_break_end' }),
    ev('session_start', '2026-11-07T10:05:30.050Z', 2),
    ev('session_end', '2026-11-07T11:00:00Z', 2),
  ];
  return { sessions: [s1, s2], events };
};

describe('break events: validation', () => {
  const NOW = u('2026-11-07T12:00:00Z').getTime();
  const base = (type: string, extra: any = {}) => ({ client_event_id: 'brk-00000001', type, occurred_at: '2026-11-07T10:00:00.000Z', ...extra });
  const result = (raw: any) => validateClientEvent(raw, 'jisha', NOW);

  it('accepts break_start and break_end as desktop event types', () => {
    expect(CLIENT_EVENT_TYPES).toEqual(expect.arrayContaining(['break_start', 'break_end']));
    for (const t of ['break_start', 'break_end']) expect('error' in result(base(t))).toBe(false);
  });

  it('break_start opens a period (may carry ended_at / duration); break_end may not', () => {
    expect(PERIOD_OPENING_TYPES.has('break_start')).toBe(true);
    expect(PERIOD_OPENING_TYPES.has('break_end')).toBe(false);
    expect('error' in result(base('break_start', { duration_seconds: 330 }))).toBe(false);
    const r = result(base('break_end', { duration_seconds: 330 }));
    expect('error' in r && r.error).toBe('ended_at_not_allowed');
  });

  it('keeps rejecting unknown break-like types, future times and a different device', () => {
    expect('error' in result(base('break_pause'))).toBe(true);
    expect('error' in result(base('break_start', { occurred_at: '2026-11-07T13:00:00.000Z' }))).toBe(true);
    const r = result(base('break_start', { device_id: 'other-pc' }));
    expect('error' in r && r.error).toBe('device_mismatch');
  });
});

describe('break timeline: pairing across sessions', () => {
  beforeEach(() => (nextId = 1));

  it('pairs break_start (closing session) with break_end (new session) and calculates the exact duration', () => {
    const { sessions, events } = oneBreakDay();
    const t = build(sessions, events);
    const startEv = t.sessions[0].events.find((e) => e.type === 'break_start')!;
    expect(startEv).toMatchObject({ label: 'Break started', duration_seconds: 330, interval_status: 'closed', session_id: 1 });
    const endEv = t.sessions[1].events.find((e) => e.type === 'break_end')!;
    expect(endEv).toMatchObject({ label: 'Break ended', session_id: 2 });
    expect(t.summary).toMatchObject({ break_seconds: 330, break_count: 1, incomplete_break_count: 0, break_ongoing: false });
    const iv = t.sessions[0].intervals.find((i) => i.kind === 'break')!;
    expect(iv).toMatchObject({ status: 'closed', start: '2026-11-07T10:00:00.000Z', end: '2026-11-07T10:05:30.000Z', duration_seconds: 330 });
  });

  it('break time is its own category: not idle, not offline, not active', () => {
    const { sessions, events } = oneBreakDay();
    const t = build(sessions, events);
    expect(t.summary.idle_seconds).toBe(0);
    expect(t.summary.offline_seconds).toBe(0);
    expect(t.summary.locked_seconds).toBe(0);
    // Sessions: 09:00-10:00:00.040 and 10:05:30.100-11:00 = 3600.04 + 3269.9 s; the 20 ms overlap with the break is not counted twice
    expect(t.summary.session_count).toBe(2);
    expect(t.summary.tracked_seconds).toBe(Math.floor((3600.04 + 3269.9)));
    expect(t.summary.active_reliable).toBe(true);
    expect(t.summary.active_seconds).toBe(t.summary.tracked_seconds - 0); // no break time inside the sessions (<1 s overlap)
  });

  it('handles several breaks in one day, each paired once', () => {
    nextId = 1;
    const sess = [session(1, '2026-11-07T04:00:00Z', '2026-11-07T05:00:00Z'), session(2, '2026-11-07T05:10:00Z', '2026-11-07T06:00:00Z'), session(3, '2026-11-07T06:20:00Z', '2026-11-07T07:00:00Z')];
    const events = [
      ev('break_start', '2026-11-07T05:00:00Z', 1), ev('break_end', '2026-11-07T05:10:00Z', 2),
      ev('break_start', '2026-11-07T06:00:00Z', 2), ev('break_end', '2026-11-07T06:20:00Z', 3),
    ];
    const t = build(sess, events);
    expect(t.summary).toMatchObject({ break_seconds: 600 + 1200, break_count: 2, incomplete_break_count: 0 });
  });

  it('a second break_start while one is open is ignored for pairing (one interval, never counted twice)', () => {
    nextId = 1;
    const sess = [session(1, '2026-11-07T04:00:00Z', '2026-11-07T05:00:00Z'), session(2, '2026-11-07T05:10:00Z', '2026-11-07T06:00:00Z')];
    const events = [ev('break_start', '2026-11-07T05:00:00Z', 1), ev('break_start', '2026-11-07T05:02:00Z', 1), ev('break_end', '2026-11-07T05:10:00Z', 2)];
    const t = build(sess, events);
    expect(t.summary).toMatchObject({ break_seconds: 600, break_count: 1 });
  });

  it('duplicate break_end without an open break is an incomplete break with no duration and no time', () => {
    const { sessions, events } = oneBreakDay();
    const dup = ev('break_end', '2026-11-07T10:06:00Z', 2);
    const t = build(sessions, [...events, dup]);
    expect(t.summary).toMatchObject({ break_seconds: 330, break_count: 1, incomplete_break_count: 1 });
    expect(t.sessions[1].events.find((e) => e.id === dup.id)).toMatchObject({ duration_seconds: null, interval_status: 'incomplete' });
  });

  it('a break without an end: ongoing while recent, incomplete when a session started since, abandoned after 12 h; never in Break Time', () => {
    nextId = 1;
    const s1 = session(1, '2026-11-07T09:00:00Z', '2026-11-07T10:00:00Z');
    // Recent: 10:00 break, "now" = 10:30
    let t = build([s1], [ev('break_start', '2026-11-07T10:00:00Z', 1)], {}, u('2026-11-07T10:30:00Z'));
    expect(t.summary).toMatchObject({ break_seconds: 0, break_count: 0, break_ongoing: true, incomplete_break_count: 0 });
    expect(t.sessions[0].events.find((e) => e.type === 'break_start')).toMatchObject({ interval_status: 'ongoing', elapsed_seconds: 1800, duration_seconds: null });

    // Work resumed (a session started) but no break_end was ever recorded
    const s2 = session(2, '2026-11-07T10:20:00Z', '2026-11-07T11:00:00Z');
    t = build([s1, s2], [ev('break_start', '2026-11-07T10:00:00Z', 1), ev('session_start', '2026-11-07T10:20:00Z', 2)], {}, u('2026-11-07T11:30:00Z'));
    expect(t.summary).toMatchObject({ break_seconds: 0, break_ongoing: false, incomplete_break_count: 1 });
    expect(t.sessions[0].events.find((e) => e.type === 'break_start')).toMatchObject({ interval_status: 'incomplete', duration_seconds: null, elapsed_seconds: null });

    // Abandoned: open for more than 12 h
    t = build([s1], [ev('break_start', '2026-11-07T10:00:00Z', 1)], {}, new Date(u('2026-11-07T10:00:00Z').getTime() + BREAK_STALE_MS + 60000));
    expect(t.summary).toMatchObject({ break_ongoing: false });
  });

  it('an unfinished break does not make session time unreliable', () => {
    nextId = 1;
    const s1 = session(1, '2026-11-07T09:00:00Z', '2026-11-07T10:00:00Z');
    const t = build([s1], [ev('session_start', '2026-11-07T09:00:00Z', 1), ev('break_start', '2026-11-07T10:00:00Z', 1), ev('session_end', '2026-11-07T10:00:00.010Z', 1)], {}, u('2026-11-07T10:10:00Z'));
    expect(t.summary.active_reliable).toBe(true);
    expect(t.summary.incomplete_interval_count).toBe(0);
    expect(t.summary.tracked_seconds).toBe(3600);
  });

  it('splits a break at local midnight: each day gets its own part, the event shows the full duration', () => {
    nextId = 1;
    // IST 23:50 -> 00:20 (UTC 18:20 -> 18:50), sessions around it
    const s1 = session(1, '2026-11-07T14:00:00Z', '2026-11-07T18:20:00Z');
    const s2 = session(2, '2026-11-07T18:50:00Z', '2026-11-07T20:00:00Z');
    const events = [ev('break_start', '2026-11-07T18:20:00Z', 1), ev('break_end', '2026-11-07T18:50:00Z', 2)];
    const now = u('2026-11-09T00:00:00Z');
    const day1 = build([s1, s2], events, { from: '2026-11-07', to: '2026-11-07' }, now);
    const day2 = build([s1, s2], events, { from: '2026-11-08', to: '2026-11-08' }, now);
    expect(day1.summary.break_seconds).toBe(10 * 60);
    expect(day2.summary.break_seconds).toBe(20 * 60);
    expect(day1.sessions[0].events.find((e) => e.type === 'break_start')!.duration_seconds).toBe(1800);
    expect(day2.sessions[0].events.find((e) => e.type === 'break_end')!.local_time).toBe('2026-11-08T00:20:00.000+05:30');
    // Both days count the break once (no double counting inside a single view)
    const range = build([s1, s2], events, { from: '2026-11-07', to: '2026-11-08' }, now);
    expect(range.summary.break_seconds).toBe(1800);
    expect(range.summary.break_count).toBe(1);
  });

  it('a break whose start is in a session outside the requested range still pairs (events from the look-back window)', () => {
    nextId = 1;
    // Only session 2 overlaps the day; the break began in session 1 the previous evening
    const s2 = session(2, '2026-11-07T18:50:00Z', '2026-11-07T20:00:00Z');
    const events = [ev('break_start', '2026-11-07T18:20:00Z', 1), ev('break_end', '2026-11-07T18:50:00Z', 2)];
    const t = build([s2], events, { from: '2026-11-08', to: '2026-11-08' }, u('2026-11-09T00:00:00Z'));
    expect(t.summary).toMatchObject({ break_seconds: 20 * 60, incomplete_break_count: 0 });
  });

  it('overlapping intervals are never double counted: a break overlapping a lock counts once in each total and once in active time', () => {
    nextId = 1;
    const s1 = session(1, '2026-11-07T09:00:00Z', '2026-11-07T10:10:00Z');
    const events = [
      ev('session_start', '2026-11-07T09:00:00Z', 1),
      ev('lock', '2026-11-07T10:00:00Z', 1), ev('break_start', '2026-11-07T10:00:00Z', 1),
      ev('unlock', '2026-11-07T10:10:00Z', 1), ev('break_end', '2026-11-07T10:10:00Z', 1),
      ev('session_end', '2026-11-07T10:10:00Z', 1),
    ];
    const t = build([s1], events);
    expect(t.summary).toMatchObject({ tracked_seconds: 4200, locked_seconds: 600, break_seconds: 600 });
    expect(t.summary.active_seconds).toBe(3600); // 70 min minus the single 10 min overlap
  });

  it('offline time that overlaps a completed break is not counted as offline (the break was the employee\'s choice)', () => {
    nextId = 1;
    // Logout failed while offline: the server inferred a gap 10:00-10:20 (offline_start with ended_at); the break was 10:00-10:10
    const s1 = session(1, '2026-11-07T09:00:00Z', '2026-11-07T10:00:00Z');
    const s2 = session(2, '2026-11-07T10:20:00Z', '2026-11-07T11:00:00Z');
    const events = [
      ev('offline_start', '2026-11-07T10:00:00Z', 1, 'server_inferred', { ended_at: u('2026-11-07T10:20:00Z') }),
      ev('break_start', '2026-11-07T10:00:00Z', 1), ev('break_end', '2026-11-07T10:10:00Z', 2),
    ];
    const t = build([s1, s2], events);
    expect(t.summary.break_seconds).toBe(600);
    expect(t.summary.offline_seconds).toBe(600); // only the 10:10-10:20 remainder
    expect(t.summary.idle_seconds).toBe(0);
  });
  it('a break with fractional seconds shows the same whole-second duration on the event and in Break time (never 1 s apart)', () => {
    nextId = 1;
    const s1 = session(1, '2026-11-07T09:00:00Z', '2026-11-07T10:00:00.020Z');
    const s2 = session(2, '2026-11-07T10:01:52.700Z', '2026-11-07T11:00:00Z');
    const t = build([s1, s2], [ev('break_start', '2026-11-07T10:00:00.000Z', 1), ev('break_end', '2026-11-07T10:01:52.649Z', 2)]);
    expect(t.sessions[0].events.find((e) => e.type === 'break_start')!.duration_seconds).toBe(112);
    expect(t.summary.break_seconds).toBe(112);
  });
  it('keeps the existing calculations unchanged when there are no breaks', () => {
    nextId = 1;
    const s1 = session(1, '2026-11-07T09:00:00Z', '2026-11-07T10:00:00Z');
    const t = build([s1], [ev('session_start', '2026-11-07T09:00:00Z', 1), ev('idle_start', '2026-11-07T09:10:00Z', 1), ev('idle_end', '2026-11-07T09:20:00Z', 1), ev('session_end', '2026-11-07T10:00:00Z', 1)]);
    expect(t.summary).toMatchObject({ tracked_seconds: 3600, idle_seconds: 600, break_seconds: 0, break_count: 0, incomplete_break_count: 0, break_ongoing: false });
    expect(t.summary.active_seconds).toBe(3000);
  });

  it('event-type filter can show only break events; the totals still use every event', () => {
    const { sessions, events } = oneBreakDay();
    const t = build(sessions, events, { eventTypes: ['break_start', 'break_end'] });
    expect(t.sessions.flatMap((s) => s.events.map((e) => e.type))).toEqual(['break_start', 'break_end']);
    expect(t.summary.break_seconds).toBe(330);
  });
});

describe('open breaks and live status', () => {
  const NOW = u('2026-11-07T12:00:00Z');
  const row = (user_id: number, type: string, at: string) => ({ user_id, activity_type: type, occurred_at: u(at) });

  it('the latest break event decides; order of rows does not matter; users are independent', () => {
    const rows = [
      row(1, 'break_end', '2026-11-07T10:30:00Z'), row(1, 'break_start', '2026-11-07T10:00:00Z'), // closed
      row(2, 'break_start', '2026-11-07T11:30:00Z'), // open
      row(3, 'break_start', '2026-11-07T11:00:00Z'), row(3, 'break_end', '2026-11-07T11:10:00Z'), row(3, 'break_start', '2026-11-07T11:40:00Z'), // second break open
    ];
    const open = resolveOpenBreaks(rows, NOW);
    expect([...open.keys()].sort()).toEqual([2, 3]);
    expect(open.get(2)!.started_at.toISOString()).toBe('2026-11-07T11:30:00.000Z');
    expect(open.get(3)!.started_at.toISOString()).toBe('2026-11-07T11:40:00.000Z');
  });

  it('a break_end at the same instant as a break_start wins; abandoned and future-dated breaks are not open', () => {
    expect(resolveOpenBreaks([row(1, 'break_start', '2026-11-07T11:00:00Z'), row(1, 'break_end', '2026-11-07T11:00:00Z')], NOW).size).toBe(0);
    expect(resolveOpenBreaks([row(1, 'break_start', new Date(NOW.getTime() - BREAK_STALE_MS - 1000).toISOString())], NOW).size).toBe(0);
    expect(resolveOpenBreaks([row(1, 'break_start', '2026-11-07T13:00:00Z')], NOW).size).toBe(0);
  });

  describe('TrackingService.resolveLiveStatus', () => {
    let service: TrackingService;
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({ providers: [TrackingService, { provide: PrismaService, useValue: {} }] }).compile();
      service = module.get(TrackingService);
    });
    const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000);
    const desktop = (extra: any = {}) => ({ id: 10, user_id: 1, device_id: 'jisha', login_time: secondsAgo(3600), last_ping: secondsAgo(30), last_desktop_ping: secondsAgo(30), is_active_session: true, is_desktop_idle: false, ...extra });
    const onBreak = { started_at: secondsAgo(600) };

    it('shows On Break for an open break, not Offline, even though no heartbeat is running (session closed by Stop)', () => {
      const closed = desktop({ is_active_session: false, logout_time: secondsAgo(600), last_ping: secondsAgo(600) });
      const live = service.resolveLiveStatus([closed], NOW, { openBreak: onBreak });
      expect(live).toMatchObject({ status: 'On Break', source: 'desktop', session: null });
      expect(live.break_started_at).toEqual(onBreak.started_at);
    });

    it('On Break also holds when the session was not closed (logout failed) but its last heartbeat predates the break', () => {
      const open = desktop({ last_ping: secondsAgo(700), last_desktop_ping: secondsAgo(700) });
      expect(service.resolveLiveStatus([open], NOW, { openBreak: onBreak }).status).toBe('On Break');
    });

    it('work after the break started wins: a heartbeat newer than break_start means the employee is working again', () => {
      const working = desktop({ last_ping: secondsAgo(20), last_desktop_ping: secondsAgo(20) });
      expect(service.resolveLiveStatus([working], NOW, { openBreak: onBreak }).status).toBe('Active');
      expect(service.resolveLiveStatus([desktop({ is_desktop_idle: true, last_desktop_ping: secondsAgo(20) })], NOW, { openBreak: onBreak }).status).toBe('Idle');
    });

    it('an unrelated disconnection is never interpreted as a break', () => {
      const silent = desktop({ last_ping: secondsAgo(900), last_desktop_ping: secondsAgo(900) }); // open but silent
      expect(service.resolveLiveStatus([silent], NOW, { distinguishStopped: true }).status).toBe('Offline');
      expect(service.resolveLiveStatus([silent], NOW).status).toBe('Offline');
    });

    it('Stopped is reported only on request: latest desktop session closed, none open', () => {
      const closed = desktop({ is_active_session: false, logout_time: secondsAgo(600), last_ping: secondsAgo(600) });
      expect(service.resolveLiveStatus([closed], NOW, { distinguishStopped: true }).status).toBe('Stopped');
      expect(service.resolveLiveStatus([closed], NOW).status).toBe('Offline'); // reports keep the existing rule
      expect(service.resolveLiveStatus([], NOW, { distinguishStopped: true }).status).toBe('Offline');
    });
  });
});

describe('TrackingService.getEmployeeStatus: On Break', () => {
  const NOW = new Date();
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000);
  const build2 = async (sessions: any[], breakRows: any[], failBreakQuery = false) => {
    const prisma: any = {
      user: { findMany: jest.fn(async () => [{ id: 1, name: 'Admin User', username: 'admin', email: 'a@x', tracking_profile: { is_tracking_enabled: true, screenshots_enabled: true } }]) },
      workSession: { findMany: jest.fn(async () => sessions), findFirst: jest.fn(async () => sessions[0] ?? null) },
      appActivity: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      trackingActivityLog: { findMany: jest.fn(async () => { if (failBreakQuery) throw new Error('enum value not supported'); return breakRows; }) },
    };
    const module: TestingModule = await Test.createTestingModule({ providers: [TrackingService, { provide: PrismaService, useValue: prisma }] }).compile();
    return { service: module.get(TrackingService), prisma };
  };
  const closedSession = () => ({ id: 5, user_id: 1, device_id: 'jisha', login_time: minutesAgo(90), last_ping: minutesAgo(10), logout_time: minutesAgo(10), is_active_session: false, productive_seconds: 1800, idle_seconds: 600, mouse_moves: 0, key_presses: 0, clicks: 0, last_desktop_ping: minutesAgo(10), is_desktop_idle: false });

  it('reports On Break with the break start, and totals still come from sessions only (no break time added)', async () => {
    const { service, prisma } = await build2([closedSession()], [{ user_id: 1, activity_type: 'break_start', occurred_at: minutesAgo(10) }]);
    const s: any = await service.getEmployeeStatus(1);
    expect(s.status).toBe('On Break');
    expect(s.break_started_at).toBe(minutesAgo(10).toISOString());
    // 1800 s active (heartbeat counter) + 0 s idle: idle comes from idle_start/idle_end events (none here), not from the
    // session's 600 s idle counter; break time is not counted either
    expect(s.total_tracked_time).toBe('00:30:00');
    expect(s.idle_time).toBe('00:00:00');
    expect(s.idle_basis).toBe('threshold_events');
    const args = prisma.trackingActivityLog.findMany.mock.calls[0][0];
    expect(args.where.activity_type).toEqual({ in: ['break_start', 'break_end'] });
    // One query for open breaks (all users) + one for the employee's events of today (shared with the History Timeline)
    expect(prisma.trackingActivityLog.findMany).toHaveBeenCalledTimes(2);
  });

  it('after the break ended the employee is Stopped (no session open), not On Break', async () => {
    const { service } = await build2([closedSession()], [
      { user_id: 1, activity_type: 'break_start', occurred_at: minutesAgo(10) }, { user_id: 1, activity_type: 'break_end', occurred_at: minutesAgo(5) },
    ]);
    const s: any = await service.getEmployeeStatus(1);
    expect(s.status).toBe('Stopped');
    expect(s.break_started_at).toBeNull();
  });

  it('a failing break query never breaks the status (e.g. a database without break support)', async () => {
    const { service } = await build2([closedSession()], [], true);
    const s: any = await service.getEmployeeStatus(1);
    expect(s.status).toBe('Stopped');
  });
});

describe('abandoned breaks (pairing): a later session_start closes an unfinished break as incomplete', () => {
  beforeEach(() => (nextId = 1));
  const DAY = { from: '2026-11-11', to: '2026-11-11' };
  const NOW = u('2026-11-11T05:20:00Z');
  const breaksOf = (t: ReturnType<typeof build>) =>
    t.sessions.flatMap((s) => s.intervals).filter((iv) => iv.kind === 'break').sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));

  /** The real sequence reported by the final verification (local data, UTC). */
  const reported = () => {
    nextId = 1;
    const sessions = [
      session(50, '2026-11-11T04:22:10.160Z', '2026-11-11T04:23:04.071Z'),
      session(52, '2026-11-11T04:24:56.701Z', '2026-11-11T04:32:19.783Z'),
      session(53, '2026-11-11T04:56:49.448Z', '2026-11-11T04:58:03.920Z'),
      session(54, '2026-11-11T05:03:20.401Z', '2026-11-11T05:05:30.000Z'),
      session(55, '2026-11-11T05:06:59.045Z', '2026-11-11T05:08:22.590Z'),
      session(58, '2026-11-11T05:14:33.387Z', null, { last_ping: u('2026-11-11T05:19:50Z') }),
    ];
    const events = [
      ev('session_start', '2026-11-11T04:22:10.129Z', 50),
      ev('break_start', '2026-11-11T04:23:03.994Z', 50), // break completed below (~112 s)
      ev('session_start', '2026-11-11T04:24:56.677Z', 52),
      ev('break_end', '2026-11-11T04:24:56.643Z', 52),
      ev('break_start', '2026-11-11T04:32:19.682Z', 52), // break A: the app exited, never ended
      ev('session_start', '2026-11-11T04:56:49.419Z', 53), // a new session: work resumed
      ev('break_start', '2026-11-11T04:58:03.838Z', 53), // break B
      ev('break_end', '2026-11-11T05:03:20.335Z', 54),
      ev('session_start', '2026-11-11T05:03:20.375Z', 54),
      ev('session_start', '2026-11-11T05:06:59.018Z', 55),
      ev('break_start', '2026-11-11T05:08:22.512Z', 55), // break C: logout during the break, never ended
      ev('session_start', '2026-11-11T05:14:33.356Z', 58),
    ];
    return { sessions, events };
  };

  it('reported sequence: break B pairs with its own end; A and the logout break are incomplete without a duration', () => {
    const { sessions, events } = reported();
    const before = JSON.stringify(events);
    const t = build(sessions, events, DAY, NOW);
    const breaks = breaksOf(t);
    expect(breaks.map((b) => [b.start, b.status, b.duration_seconds])).toEqual([
      ['2026-11-11T04:23:03.994Z', 'closed', 112],
      ['2026-11-11T04:32:19.682Z', 'incomplete', null], // break A
      ['2026-11-11T04:58:03.838Z', 'closed', 316], // break B, with ITS end (05:03:20.335)
      ['2026-11-11T05:08:22.512Z', 'incomplete', null], // logout during a break
    ]);
    expect(t.summary).toMatchObject({ break_count: 2, break_seconds: 428, incomplete_break_count: 2, break_ongoing: false });
    expect(breaks[2].end).toBe('2026-11-11T05:03:20.335Z');
    expect(breaks[1].end).toBeNull();
    // The event rows show the same: no duration on the abandoned starts
    const shownStarts = t.sessions.flatMap((s) => s.events).filter((e) => e.type === 'break_start');
    expect(shownStarts.map((e) => [e.interval_status, e.duration_seconds])).toEqual([['closed', 112], ['incomplete', null], ['closed', 316], ['incomplete', null]]);
    // Nothing is invented or changed: no event beyond the stored ones, stored rows untouched
    const allShown = [...t.sessions.flatMap((s) => s.events), ...t.unassigned_events];
    expect(allShown.length).toBeLessThanOrEqual(events.length);
    expect(allShown.every((e) => events.some((r) => r.id === e.id))).toBe(true);
    expect(allShown.filter((e) => e.type === 'break_end')).toHaveLength(2);
    expect(JSON.stringify(events)).toBe(before);
  });

  it('a new session after an abandoned break: the break is incomplete, never completed by the session', () => {
    nextId = 1;
    const s1 = session(1, '2026-11-11T04:00:00Z', '2026-11-11T04:30:00Z');
    const s2 = session(2, '2026-11-11T05:00:00Z', null, { last_ping: u('2026-11-11T05:19:00Z') });
    const t = build([s1, s2], [ev('break_start', '2026-11-11T04:30:00Z', 1), ev('session_start', '2026-11-11T05:00:00Z', 2)], DAY, NOW);
    expect(breaksOf(t)).toHaveLength(1);
    expect(breaksOf(t)[0]).toMatchObject({ status: 'incomplete', duration_seconds: null, end: null });
    expect(t.summary).toMatchObject({ break_count: 0, break_seconds: 0, incomplete_break_count: 1, break_ongoing: false });
  });

  it('several abandoned breaks separated by new sessions: each stays incomplete, a later break pairs only with its own end', () => {
    nextId = 1;
    const sess = [1, 2, 3, 4].map((i) => session(i, `2026-11-11T0${i}:00:00Z`, `2026-11-11T0${i}:30:00Z`));
    const events = [
      ev('session_start', '2026-11-11T01:00:00Z', 1), ev('break_start', '2026-11-11T01:30:00Z', 1), // abandoned
      ev('session_start', '2026-11-11T02:00:00Z', 2), ev('break_start', '2026-11-11T02:30:00Z', 2), // abandoned
      ev('session_start', '2026-11-11T03:00:00Z', 3), ev('break_start', '2026-11-11T03:30:00Z', 3), // paired below
      ev('break_end', '2026-11-11T03:45:00Z', 4), ev('session_start', '2026-11-11T03:45:00.050Z', 4),
    ];
    const t = build(sess, events, DAY, NOW);
    expect(breaksOf(t).map((b) => [b.status, b.duration_seconds])).toEqual([['incomplete', null], ['incomplete', null], ['closed', 900]]);
    expect(t.summary).toMatchObject({ break_count: 1, break_seconds: 900, incomplete_break_count: 2 });
  });

  it('duplicate session_start events (desktop and server for the same start) close the break once', () => {
    nextId = 1;
    const s1 = session(1, '2026-11-11T04:00:00Z', '2026-11-11T04:30:00Z');
    const s2 = session(2, '2026-11-11T05:00:00Z', null, { last_ping: u('2026-11-11T05:19:00Z') });
    const events = [
      ev('break_start', '2026-11-11T04:30:00Z', 1),
      ev('session_start', '2026-11-11T05:00:00.000Z', 2, 'desktop_client'),
      ev('session_start', '2026-11-11T05:00:00.030Z', 2, 'server_inferred'),
      ev('session_start', '2026-11-11T05:00:00.030Z', 2, 'desktop_client'),
    ];
    const t = build([s1, s2], events, DAY, NOW);
    expect(breaksOf(t)).toHaveLength(1);
    expect(t.summary).toMatchObject({ break_count: 0, incomplete_break_count: 1, break_seconds: 0 });
  });

  it('an incomplete break with no later session: ongoing while recent, incomplete once it is past the abandon limit', () => {
    nextId = 1;
    const s1 = session(1, '2026-11-11T04:00:00Z', '2026-11-11T04:30:00Z');
    const recent = build([s1], [ev('break_start', '2026-11-11T04:30:00Z', 1)], DAY, u('2026-11-11T04:50:00Z'));
    expect(recent.summary).toMatchObject({ break_ongoing: true, incomplete_break_count: 0, break_seconds: 0 });
    const old = build([s1], [ev('break_start', '2026-11-11T04:30:00Z', 1)], { from: '2026-11-11', to: '2026-11-12' }, new Date(u('2026-11-11T04:30:00Z').getTime() + BREAK_STALE_MS + 60000));
    expect(old.summary).toMatchObject({ break_ongoing: false, incomplete_break_count: 1, break_seconds: 0 });
  });

  it('a session_start on ANOTHER device does not settle this device\'s break; one on the same device does', () => {
    nextId = 1;
    const pcA = session(1, '2026-11-11T04:00:00Z', '2026-11-11T04:30:00Z', { device_id: 'pc-a' });
    const pcB = session(2, '2026-11-11T04:40:00Z', null, { device_id: 'pc-b', last_ping: u('2026-11-11T04:45:00Z') });
    const start = ev('break_start', '2026-11-11T04:30:00Z', 1, 'desktop_client', { device_id: 'pc-a' });
    const otherDevice = ev('session_start', '2026-11-11T04:40:00Z', 2, 'desktop_client', { device_id: 'pc-b' });
    const end = ev('break_end', '2026-11-11T04:50:00Z', 1, 'desktop_client', { device_id: 'pc-a' });
    let t = build([pcA, pcB], [start, otherDevice, end], DAY, NOW);
    expect(breaksOf(t)[0]).toMatchObject({ status: 'closed', duration_seconds: 1200 }); // pc-b starting work did not abandon pc-a's break
    expect(t.summary).toMatchObject({ break_count: 1, break_seconds: 1200, incomplete_break_count: 0 });

    const sameDevice = ev('session_start', '2026-11-11T04:40:00Z', 2, 'desktop_client', { device_id: 'pc-a' });
    t = build([pcA, session(2, '2026-11-11T04:40:00Z', null, { device_id: 'pc-a', last_ping: u('2026-11-11T04:45:00Z') })], [start, sameDevice], DAY, NOW);
    expect(t.summary).toMatchObject({ break_count: 0, incomplete_break_count: 1 });
  });

  it('valid pairing is unchanged (break_end first, then the new session_start) and a break spanning midnight still pairs', () => {
    const { sessions, events } = oneBreakDay();
    const t = build(sessions, events);
    expect(t.summary).toMatchObject({ break_seconds: 330, break_count: 1, incomplete_break_count: 0 });
    nextId = 1;
    const s1 = session(1, '2026-11-07T14:00:00Z', '2026-11-07T18:20:00Z');
    const s2 = session(2, '2026-11-07T18:50:00Z', '2026-11-07T20:00:00Z');
    const mid = [ev('break_start', '2026-11-07T18:20:00Z', 1), ev('break_end', '2026-11-07T18:50:00Z', 2), ev('session_start', '2026-11-07T18:50:00.040Z', 2)];
    const r = build([s1, s2], mid, { from: '2026-11-07', to: '2026-11-08' }, u('2026-11-09T00:00:00Z'));
    expect(r.summary).toMatchObject({ break_seconds: 1800, break_count: 1, incomplete_break_count: 0 });
  });
});