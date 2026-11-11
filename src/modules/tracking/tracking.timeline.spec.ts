import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { PrismaService } from '../../core/prisma.service';
import {
  DUPLICATE_WINDOW_MS,
  TIMELINE_MAX_EVENTS,
  TIMELINE_MAX_LIMIT,
  TIMELINE_MAX_RANGE_DAYS,
  TIMELINE_MAX_SESSIONS,
  TimelineEventRow,
  TimelineQuery,
  TimelineSessionRow,
  buildTrackingTimeline,
  parseTimelineQuery,
  resolveDuplicates,
  toZonedIso,
  zonedDayStart,
  zonedRange,
} from './tracking-timeline';

/**
 * Stage 3: admin historical timeline. Pure building blocks (query validation, time zones, duplicate
 * resolution, interval pairing, summaries) and the service's bounded queries. Authorization of the route
 * is covered by core/guards/rbac-route-matrix.http.spec.ts (reports/timeline entries).
 */

const IST = 'Asia/Kolkata'; // +05:30, no DST
const NY = 'America/New_York'; // DST
const u = (s: string) => new Date(s);

let nextId = 1;
const ev = (type: string, at: string, source = 'desktop_client', session_id: number | null = 39, extra: Partial<TimelineEventRow> = {}): TimelineEventRow => ({
  id: nextId++, session_id, activity_type: type, occurred_at: u(at), source, reason: null, device_id: 'jisha', ended_at: null, ...extra,
});
const session = (id: number, login: string, extra: Partial<TimelineSessionRow> = {}): TimelineSessionRow => ({
  id, device_id: 'jisha', login_time: u(login), logout_time: null, last_ping: u(login), is_active_session: false, tracked_seconds: 0, ...extra,
});
const query = (extra: Partial<TimelineQuery> = {}): TimelineQuery => ({
  userId: 1, from: '2026-11-07', to: '2026-11-07', tz: IST, eventTypes: null, page: 1, limit: 20, ...extra,
});
const build = (sessions: TimelineSessionRow[], events: TimelineEventRow[], q: Partial<TimelineQuery> = {}, now = u('2026-11-07T18:00:00Z'), truncated = false) =>
  buildTrackingTimeline({ sessions, events, query: query(q), now, employee: { id: 1, name: 'Admin' }, truncated });

/** The real Stage 2 smoke-test day (session 39), including the server-inferred rows stored beside it. */
const smokeDay = () => {
  nextId = 1;
  const s39 = session(39, '2026-11-07T11:43:35.991Z', { logout_time: u('2026-11-07T11:50:23.040Z'), last_ping: u('2026-11-07T11:50:23.040Z'), tracked_seconds: 420 });
  const events = [
    ev('offline_end', '2026-11-07T11:43:35.991Z', 'server_inferred', 39, { reason: 'heartbeat_resumed' }),
    ev('session_start', '2026-11-07T11:43:35.991Z', 'server_inferred', 39, { reason: 'first_heartbeat_after_gap' }),
    ev('session_start', '2026-11-07T11:43:35.966Z', 'desktop_client', 39, { reason: 'tracking_started' }),
    ev('lock', '2026-11-07T11:45:01.282Z'),
    ev('unlock', '2026-11-07T11:45:21.404Z'),
    ev('idle_start', '2026-11-07T11:46:43.542Z'),
    ev('idle_end', '2026-11-07T11:46:54.929Z'),
    ev('offline_start', '2026-11-07T11:47:38.111Z'),
    ev('offline_end', '2026-11-07T11:48:36.138Z'),
    ev('session_end', '2026-11-07T11:50:22.989Z', 'desktop_client', 39, { reason: 'tracking_stopped' }),
    ev('session_end', '2026-11-07T11:50:23.040Z', 'server_inferred', 39, { reason: 'logout_request' }),
  ];
  return { sessions: [s39], events };
};

describe('tracking timeline — query validation', () => {
  const NOW = u('2026-11-07T20:00:00Z'); // 8 Nov 01:30 in IST
  const err = (q: any) => {
    const r = parseTimelineQuery(q, NOW);
    return 'message' in r ? r.message : null;
  };
  const ok = (q: any) => {
    const r = parseTimelineQuery(q, NOW);
    if ('message' in r) throw new Error(r.message);
    return r.query;
  };

  it('requires a positive integer user_id', () => {
    expect(err({})).toMatch(/user_id is required/);
    for (const bad of ['0', '-1', 'abc', '1.5', '1;DROP']) expect(err({ user_id: bad })).toMatch(/user_id/);
  });

  it('rejects invalid dates and impossible calendar days', () => {
    for (const bad of ['2026-13-01', '2026-02-30', '07-11-2026', '2026-11-7', 'today', '2026-11-07T00:00:00Z']) {
      expect(err({ user_id: '1', date: bad, tz: IST })).toMatch(/date must be a valid date/);
    }
    expect(err({ user_id: '1', from: '2026-11-07', tz: IST })).toMatch(/from and to/);
    expect(err({ user_id: '1', from: '2026-11-08', to: '2026-11-07', tz: IST })).toMatch(/after/);
    expect(err({ user_id: '1', date: '2026-11-07', from: '2026-11-07', to: '2026-11-07' })).toMatch(/either date or from\/to/);
  });

  it(`enforces the ${TIMELINE_MAX_RANGE_DAYS}-day range limit`, () => {
    expect(ok({ user_id: '1', from: '2026-10-08', to: '2026-11-07', tz: IST }).from).toBe('2026-10-08');
    expect(err({ user_id: '1', from: '2026-10-07', to: '2026-11-07', tz: IST })).toMatch(/at most 31 days/);
  });

  it('validates tz, event_type, page and limit', () => {
    expect(err({ user_id: '1', tz: 'Mars/Olympus' })).toMatch(/tz must be/);
    expect(err({ user_id: '1', tz: IST, event_type: 'break_pause' })).toMatch(/event_type/);
    expect(ok({ user_id: '1', tz: IST, event_type: 'lock,unlock,lock' }).eventTypes).toEqual(['lock', 'unlock']);
    expect(err({ user_id: '1', tz: IST, page: '0' })).toMatch(/page/);
    expect(err({ user_id: '1', tz: IST, limit: String(TIMELINE_MAX_LIMIT + 1) })).toMatch(/limit/);
    expect(ok({ user_id: '1', tz: IST, limit: '5', page: '2' })).toMatchObject({ limit: 5, page: 2 });
  });

  it('defaults to today in the requested time zone', () => {
    expect(ok({ user_id: '1', tz: IST })).toMatchObject({ from: '2026-11-08', to: '2026-11-08' });
    expect(ok({ user_id: '1', tz: 'UTC' })).toMatchObject({ from: '2026-11-07', to: '2026-11-07' });
  });
});

describe('tracking timeline — time zones', () => {
  it('converts a local day to UTC boundaries (midnight in the employee zone)', () => {
    expect(zonedDayStart('2026-11-07', IST).toISOString()).toBe('2026-11-06T18:30:00.000Z');
    const r = zonedRange('2026-11-07', '2026-11-07', IST);
    expect([r.start.toISOString(), r.end.toISOString()]).toEqual(['2026-11-06T18:30:00.000Z', '2026-11-07T18:30:00.000Z']);
  });

  it('handles daylight-saving days (23 and 25 hour days)', () => {
    const spring = zonedRange('2026-03-08', '2026-03-08', NY);
    expect((spring.end.getTime() - spring.start.getTime()) / 3600000).toBe(23);
    const fall = zonedRange('2026-11-01', '2026-11-01', NY);
    expect((fall.end.getTime() - fall.start.getTime()) / 3600000).toBe(25);
    expect(zonedDayStart('2026-11-01', NY).toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });

  it('formats UTC instants as local ISO-8601 with the zone offset', () => {
    expect(toZonedIso(u('2026-11-07T11:43:35.966Z'), IST)).toBe('2026-11-07T17:13:35.966+05:30');
    expect(toZonedIso(u('2026-11-07T23:59:59.999Z'), 'UTC')).toBe('2026-11-07T23:59:59.999+00:00');
    expect(toZonedIso(u('2026-07-01T12:00:00Z'), NY)).toBe('2026-07-01T08:00:00.000-04:00');
  });
});

describe('tracking timeline — duplicate resolution', () => {
  beforeEach(() => (nextId = 1));

  it('prefers the desktop event and hides the matching server event (same type, session, within the window)', () => {
    const d = ev('session_start', '2026-11-07T11:43:35.966Z');
    const s = ev('session_start', '2026-11-07T11:43:35.991Z', 'server_inferred');
    const { kept, suppressedCount } = resolveDuplicates([s, d]);
    expect(kept.map((k) => k.row.id)).toEqual([d.id]);
    expect(suppressedCount).toBe(1);
    expect(kept[0].suppressed).toEqual([{ id: s.id, source: 'server_inferred', reason: null, occurred_at: '2026-11-07T11:43:35.991Z' }]);
  });

  it('keeps server events with no desktop counterpart (fallback)', () => {
    const s = ev('session_end', '2026-11-07T11:08:33.982Z', 'server_inferred', 36, { reason: 'heartbeat_timeout' });
    expect(resolveDuplicates([s]).kept).toHaveLength(1);
  });

  it('does not treat same-type events as duplicates across sessions, outside the window, or between two desktop events', () => {
    const d = ev('session_end', '2026-11-07T11:50:22.989Z', 'desktop_client', 39);
    const otherSession = ev('session_end', '2026-11-07T11:50:23.040Z', 'server_inferred', 40);
    const late = ev('session_end', new Date(u('2026-11-07T11:50:22.989Z').getTime() + DUPLICATE_WINDOW_MS + 1).toISOString(), 'server_inferred', 39);
    const d2 = ev('session_end', '2026-11-07T11:50:22.900Z', 'desktop_client', 39); // earlier, so `late` is outside its window too
    expect(resolveDuplicates([d, otherSession, late, d2]).kept).toHaveLength(4);
  });

  it('matches one-to-one, nearest first', () => {
    const d1 = ev('idle_start', '2026-11-07T10:00:00Z');
    const d2 = ev('idle_start', '2026-11-07T10:01:00Z');
    const s = ev('idle_start', '2026-11-07T10:00:50Z', 'server_heartbeat');
    const { kept } = resolveDuplicates([d1, d2, s]);
    expect(kept.map((k) => k.row.id)).toEqual([d1.id, d2.id]);
    expect(kept.find((k) => k.row.id === d2.id)!.suppressed.map((x) => x.id)).toEqual([s.id]);
  });

  it('shows the smoke-test session start and end once each, from the desktop', () => {
    const { sessions, events } = smokeDay();
    const t = build(sessions, events);
    const types = t.sessions[0].events.map((e) => e.type);
    expect(types.filter((x) => x === 'session_start')).toHaveLength(1);
    expect(types.filter((x) => x === 'session_end')).toHaveLength(1);
    expect(t.sessions[0].start).toMatchObject({ at: '2026-11-07T11:43:35.966Z', source: 'desktop_client' });
    expect(t.sessions[0].end).toMatchObject({ at: '2026-11-07T11:50:22.989Z', source: 'desktop_client' });
    expect(t.summary.duplicates_hidden).toBe(2);
    // The stored rows are untouched
    expect(events).toHaveLength(11);
  });
});

describe('tracking timeline — building', () => {
  beforeEach(() => (nextId = 1));

  it('orders events chronologically and groups them by session', () => {
    const { sessions, events } = smokeDay();
    const t = build(sessions, [...events].reverse());
    const at = t.sessions[0].events.map((e) => e.occurred_at);
    expect(at).toEqual([...at].sort());
    expect(t.sessions).toHaveLength(1);
    expect(t.sessions[0].events.every((e) => e.session_id === 39)).toBe(true);
    expect(t.sessions[0].events.map((e) => e.type)).toEqual([
      'session_start', 'offline_end', 'lock', 'unlock', 'idle_start', 'idle_end', 'offline_start', 'offline_end', 'session_end',
    ]);
  });

  it('calculates idle, lock and offline durations from the stored timestamps', () => {
    const { sessions, events } = smokeDay();
    const t = build(sessions, events);
    const s = t.sessions[0];
    const dur = (type: string) => s.events.find((e) => e.type === type)!.duration_seconds;
    expect(dur('lock')).toBe(20); // 11:45:01.282 -> 11:45:21.404
    expect(dur('idle_start')).toBe(11); // 11:46:43.542 -> 11:46:54.929
    expect(dur('offline_start')).toBe(58); // 11:47:38.111 -> 11:48:36.138
    expect(s.duration_seconds).toBe(407); // 11:43:35.966 -> 11:50:22.989
    expect(s).toMatchObject({ idle_seconds: 11, locked_seconds: 20, offline_seconds: 58, status: 'ended', heartbeat_tracked_seconds: 420 });
    expect(t.summary).toMatchObject({ session_count: 1, tracked_seconds: 407, idle_seconds: 11, locked_seconds: 20, offline_seconds: 58 });
    // Not derivable here: the server's offline_end before the session has no known start (see next test)
    expect(t.summary.active_seconds).toBeNull();
  });

  it('marks an unmatched closing event and an unclosed opening of an ended session as incomplete (no duration)', () => {
    const { sessions, events } = smokeDay();
    // The server's offline_end for the gap before session 39 has no opening in this range
    const t = build(sessions, events);
    const unmatched = t.sessions[0].intervals.find((iv) => iv.kind === 'offline' && iv.start === null)!;
    expect(unmatched).toMatchObject({ status: 'incomplete', duration_seconds: null, end: '2026-11-07T11:43:35.991Z' });
    expect(t.summary.incomplete_interval_count).toBe(1);
    expect(t.summary.active_seconds).toBeNull();
    expect(t.summary.active_reliable).toBe(false);

    nextId = 1;
    const s = session(50, '2026-11-07T04:00:00Z', { logout_time: u('2026-11-07T05:00:00Z'), last_ping: u('2026-11-07T05:00:00Z') });
    const t2 = build([s], [ev('session_start', '2026-11-07T04:00:00Z', 'desktop_client', 50), ev('lock', '2026-11-07T04:30:00Z', 'desktop_client', 50)]);
    const lock = t2.sessions[0].events.find((e) => e.type === 'lock')!;
    expect(lock).toMatchObject({ duration_seconds: null, elapsed_seconds: null, interval_status: 'incomplete' });
    expect(t2.summary.locked_seconds).toBe(0);
  });

  it('never pairs an idle opened in one session with an idle_end of a later session', () => {
    const a = session(60, '2026-11-07T03:00:00Z', { logout_time: u('2026-11-07T04:00:00Z') });
    const b = session(61, '2026-11-07T06:00:00Z', { logout_time: u('2026-11-07T07:00:00Z') });
    const t = build([a, b], [ev('idle_start', '2026-11-07T03:30:00Z', 'desktop_client', 60), ev('idle_end', '2026-11-07T06:10:00Z', 'desktop_client', 61)]);
    expect(t.summary.idle_seconds).toBe(0);
    expect(t.sessions.flatMap((s) => s.intervals).map((iv) => iv.status)).toEqual(['incomplete', 'incomplete']);
  });

  it('reports an ongoing session and open interval as elapsed time, not a final duration', () => {
    const now = u('2026-11-07T12:10:00Z');
    const live = session(70, '2026-11-07T12:00:00Z', { is_active_session: true, last_ping: u('2026-11-07T12:09:40Z') });
    const t = build([live], [ev('session_start', '2026-11-07T12:00:00Z', 'desktop_client', 70), ev('idle_start', '2026-11-07T12:05:00Z', 'desktop_client', 70)], {}, now);
    const s = t.sessions[0];
    expect(s).toMatchObject({ status: 'ongoing', duration_seconds: null, elapsed_seconds: 600, end: null });
    expect(s.events.find((e) => e.type === 'idle_start')).toMatchObject({ duration_seconds: null, elapsed_seconds: 300, interval_status: 'ongoing' });
    expect(t.summary).toMatchObject({ includes_ongoing: true, tracked_seconds: 600, idle_seconds: 300 });
  });

  it('treats an active-flagged session without recent heartbeats as incomplete, estimated to its last heartbeat', () => {
    const stale = session(80, '2026-11-07T08:00:00Z', { is_active_session: true, last_ping: u('2026-11-07T09:00:00Z') });
    const t = build([stale], [], {}, u('2026-11-07T12:00:00Z'));
    expect(t.sessions[0]).toMatchObject({ status: 'incomplete', duration_seconds: null, has_events: false, start: { source: 'session_record' } });
    expect(t.summary).toMatchObject({ tracked_seconds: 3600, includes_estimates: true, active_seconds: null });
  });

  it('splits periods at local midnight and shows each day only its own part', () => {
    // 23:30 -> 00:30 IST across 7/8 Nov; idle 23:50 -> 00:10
    const s = session(90, '2026-11-07T18:00:00Z', { logout_time: u('2026-11-07T19:00:00Z'), last_ping: u('2026-11-07T19:00:00Z') });
    const events = [
      ev('session_start', '2026-11-07T18:00:00Z', 'desktop_client', 90),
      ev('idle_start', '2026-11-07T18:20:00Z', 'desktop_client', 90),
      ev('idle_end', '2026-11-07T18:40:00Z', 'desktop_client', 90),
      ev('session_end', '2026-11-07T19:00:00Z', 'desktop_client', 90),
    ];
    const day1 = build([s], events, { from: '2026-11-07', to: '2026-11-07' }, u('2026-11-09T00:00:00Z'));
    const day2 = build([s], events, { from: '2026-11-08', to: '2026-11-08' }, u('2026-11-09T00:00:00Z'));
    expect(day1.summary).toMatchObject({ tracked_seconds: 1800, idle_seconds: 600 });
    expect(day2.summary).toMatchObject({ tracked_seconds: 1800, idle_seconds: 600 });
    expect(day1.sessions[0].events.map((e) => e.type)).toEqual(['session_start', 'idle_start']);
    expect(day2.sessions[0].events.map((e) => e.type)).toEqual(['idle_end', 'session_end']);
    // The full idle period is still 20 minutes on the event that opens it
    expect(day1.sessions[0].events[1].duration_seconds).toBe(1200);
    expect(day1.sessions[0].events[1].local_date).toBe('2026-11-07');
    expect(day2.sessions[0].events[0].local_time).toBe('2026-11-08T00:10:00.000+05:30');
  });

  it('gives each event UTC and local times that describe the same instant', () => {
    const { sessions, events } = smokeDay();
    for (const e of build(sessions, events).sessions[0].events) {
      expect(e.occurred_at.endsWith('Z')).toBe(true);
      expect(new Date(e.local_time).getTime()).toBe(new Date(e.occurred_at).getTime());
      expect(e.local_time).toMatch(/\+05:30$/);
    }
  });

  it('never counts overlapping intervals twice in the totals', () => {
    const s = session(95, '2026-11-07T04:00:00Z', { logout_time: u('2026-11-07T05:00:00Z'), last_ping: u('2026-11-07T05:00:00Z') });
    const events = [
      ev('session_start', '2026-11-07T04:00:00Z', 'desktop_client', 95),
      ev('idle_start', '2026-11-07T04:10:00Z', 'desktop_client', 95),
      ev('lock', '2026-11-07T04:15:00Z', 'desktop_client', 95),
      ev('unlock', '2026-11-07T04:25:00Z', 'desktop_client', 95),
      ev('idle_end', '2026-11-07T04:25:00Z', 'desktop_client', 95),
      ev('session_end', '2026-11-07T05:00:00Z', 'desktop_client', 95),
    ];
    const t = build([s], events);
    expect(t.summary).toMatchObject({ tracked_seconds: 3600, idle_seconds: 900, locked_seconds: 600 });
    // Idle 04:10-04:25 contains the lock: active = 60 min - 15 min, not 60 - 15 - 10
    expect(t.summary.active_seconds).toBe(2700);
  });

  it('flags offline time that is a server-detected heartbeat gap (cause unknown)', () => {
    const { sessions, events } = smokeDay();
    expect(build(sessions, events).summary.offline_includes_server_gaps).toBe(true); // the server's unmatched offline_end
    const desktopOnly = events.filter((e) => e.source === 'desktop_client');
    const t = build(sessions, desktopOnly);
    expect(t.summary.offline_includes_server_gaps).toBe(false);
    expect(t.sessions[0].intervals.find((iv) => iv.kind === 'offline')).toMatchObject({ source: 'desktop_client', status: 'closed' });
  });

  it('uses ended_at of a server period when no closing event exists', () => {
    const s = session(96, '2026-11-07T04:00:00Z', { logout_time: u('2026-11-07T05:00:00Z') });
    const t = build([s], [ev('offline_start', '2026-11-07T04:10:00Z', 'server_inferred', 96, { ended_at: u('2026-11-07T04:20:00Z') })]);
    expect(t.sessions[0].intervals[0]).toMatchObject({ status: 'closed', duration_seconds: 600, end_source: 'ended_at' });
  });

  it('filters shown events by type but keeps durations computed from every event', () => {
    const { sessions, events } = smokeDay();
    const t = build(sessions, events, { eventTypes: ['idle_start'] });
    expect(t.sessions[0].events.map((e) => e.type)).toEqual(['idle_start']);
    expect(t.sessions[0].events[0].duration_seconds).toBe(11);
    expect(t.summary.locked_seconds).toBe(20);
  });

  it('paginates sessions while the summary covers the whole range', () => {
    const sessions = [1, 2, 3, 4, 5].map((i) => session(100 + i, `2026-11-07T0${i}:00:00Z`, { logout_time: u(`2026-11-07T0${i}:30:00Z`) }));
    const t = build(sessions, [], { page: 2, limit: 2 });
    expect(t.pagination).toEqual({ page: 2, limit: 2, total_sessions: 5, total_pages: 3 });
    expect(t.sessions.map((s) => s.id)).toEqual([103, 104]);
    expect(t.summary).toMatchObject({ session_count: 5, tracked_seconds: 5 * 1800 });
  });

  it('returns an empty, well-formed timeline when there is no data', () => {
    const t = build([], []);
    expect(t.sessions).toEqual([]);
    expect(t.unassigned_events).toEqual([]);
    expect(t.summary).toMatchObject({ session_count: 0, tracked_seconds: 0, idle_seconds: 0, active_seconds: 0, incomplete_interval_count: 0 });
    expect(t.pagination).toMatchObject({ total_sessions: 0, total_pages: 1 });
  });

  it('never labels idle as a break and ignores legacy event types', () => {
    const { sessions, events } = smokeDay();
    const t = build(sessions, [...events, ev('idle', '2026-11-07T11:46:00Z', 'legacy')]);
    const labels = t.sessions[0].events.map((e) => e.label.toLowerCase());
    expect(labels.some((l) => l.includes('break'))).toBe(false);
    expect(t.sessions[0].events.some((e) => (e.type as string) === 'idle')).toBe(false);
  });
});

describe('TrackingService.getTrackingTimeline', () => {
  let service: TrackingService;
  let prisma: any;

  beforeEach(async () => {
    nextId = 1;
    const { sessions, events } = smokeDay();
    prisma = {
      user: { findUnique: jest.fn(async ({ where }: any) => (where.id === 1 ? { id: 1, name: 'Admin', username: 'admin', email: 'a@x', position: null, department: null } : null)) },
      workSession: { findMany: jest.fn(async () => sessions) },
      trackingActivityLog: { findMany: jest.fn(async () => events) },
      trackingUserProfile: { findUnique: jest.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [TrackingService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(TrackingService);
  });

  it('returns the normalized timeline for an employee and day', async () => {
    const t = await service.getTrackingTimeline({ user_id: '1', date: '2026-11-07', tz: IST });
    expect(t.employee).toMatchObject({ id: 1, username: 'admin' });
    expect(t.range).toEqual({ from: '2026-11-07', to: '2026-11-07', tz: IST, start: '2026-11-06T18:30:00.000Z', end: '2026-11-07T18:30:00.000Z' });
    expect(t.sessions[0].id).toBe(39);
  });

  it('uses bounded, indexed queries: desktop sessions overlapping the range, their events, no metadata', async () => {
    await service.getTrackingTimeline({ user_id: '1', date: '2026-11-07', tz: IST });
    const sArgs = prisma.workSession.findMany.mock.calls[0][0];
    expect(sArgs.where).toMatchObject({ user_id: 1, device_id: { not: 'default' }, login_time: { lt: u('2026-11-07T18:30:00.000Z') } });
    expect(sArgs.take).toBe(TIMELINE_MAX_SESSIONS + 1);
    const eArgs = prisma.trackingActivityLog.findMany.mock.calls[0][0];
    expect(eArgs.where.user_id).toBe(1);
    expect(eArgs.where.OR).toEqual([
      { session_id: { in: [39] } },
      { session_id: null, occurred_at: { gte: u('2026-11-06T18:30:00.000Z'), lt: u('2026-11-07T18:30:00.000Z') } },
      // Stage 4: manual breaks may start in a session outside the range (look back 12 h)
      { activity_type: { in: ['break_start', 'break_end'] }, occurred_at: { gte: u('2026-11-06T06:30:00.000Z'), lt: u('2026-11-07T18:30:00.000Z') } },
    ]);
    expect(eArgs.take).toBe(TIMELINE_MAX_EVENTS + 1);
    expect(eArgs.select.metadata).toBeUndefined();
    expect(prisma.workSession.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.trackingActivityLog.findMany).toHaveBeenCalledTimes(1);
  });

  it('flags a truncated result instead of loading unlimited rows', async () => {
    prisma.trackingActivityLog.findMany.mockResolvedValueOnce(
      Array.from({ length: TIMELINE_MAX_EVENTS + 1 }, (_, i) => ev('lock', new Date(u('2026-11-07T05:00:00Z').getTime() + i * 1000).toISOString())),
    );
    const t = await service.getTrackingTimeline({ user_id: '1', date: '2026-11-07', tz: IST });
    expect(t.truncated).toBe(true);
    expect(t.summary.active_reliable).toBe(false);
  });

  it('rejects invalid filters with 400 and an unknown employee with 404, before loading tracking data', async () => {
    await expect(service.getTrackingTimeline({ user_id: '1', date: '2026-02-30' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getTrackingTimeline({ user_id: '1', from: '2026-01-01', to: '2026-03-01' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getTrackingTimeline({ user_id: '999', date: '2026-11-07' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.workSession.findMany).not.toHaveBeenCalled();
  });

  it('is read-only', async () => {
    await service.getTrackingTimeline({ user_id: '1', date: '2026-11-07', tz: IST });
    for (const table of [prisma.workSession, prisma.trackingActivityLog]) {
      expect(Object.keys(table)).toEqual(['findMany']);
    }
  });
});
