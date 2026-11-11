import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TrackingService, BROWSER_DEVICE_ID, serverEventId } from './tracking.service';
import { PrismaService } from '../../core/prisma.service';
import {
  CLIENT_EVENT_TYPES,
  MAX_EVENTS_PER_BATCH,
  MAX_METADATA_BYTES,
  parseZonedTimestamp,
  validateClientEvent,
} from './tracking-events';

/**
 * Phase 2: tracking event storage. POST /tracking/events, the heartbeat idle fallback, server-inferred
 * session/offline events and late offline batches.
 *
 * In-memory Prisma stand-in that honours the service's `where` filters and enforces the real
 * per-user unique key on client_event_id (throws P2002 like Prisma). The clock is fixed so
 * "same local day" rules are deterministic.
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
    return (valueOf(row[key]) ?? null) === (valueOf(cond) ?? null);
  });

const sortRows = (rows: Row[], orderBy?: Row) => {
  if (!orderBy) return rows;
  const [field, dir] = Object.entries(orderBy)[0];
  return [...rows].sort((a, b) => {
    const diff = (valueOf(a[field]) ?? 0) - (valueOf(b[field]) ?? 0);
    return dir === 'desc' ? -diff : diff;
  });
};

const uniqueViolation = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

const makeTable = (defaults: () => Row, uniqueKey?: (data: Row, rows: Row[]) => boolean) => {
  const rows: Row[] = [];
  let nextId = 1;
  return {
    rows,
    findFirst: jest.fn(async ({ where, orderBy }: Row = {}) => sortRows(rows.filter((r) => matches(r, where)), orderBy)[0] ?? null),
    findMany: jest.fn(async ({ where, orderBy, take }: Row = {}) => {
      const found = sortRows(rows.filter((r) => matches(r, where)), orderBy);
      return take ? found.slice(0, take) : found;
    }),
    findUnique: jest.fn(async ({ where }: Row) => rows.find((r) => matches(r, where)) ?? null),
    create: jest.fn(async ({ data }: Row) => {
      if (uniqueKey && uniqueKey(data, rows)) throw uniqueViolation();
      const row: Row = { id: nextId++, ...defaults(), ...data };
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

// Fixed "now": 7 Nov 2026, 14:00 local time
const NOW = new Date(2026, 10, 7, 14, 0, 0);
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60 * 1000);
const iso = (d: Date) => d.toISOString();

const DESKTOP = 'pc-office-01';
const OTHER_DESKTOP = 'pc-home-02';

describe('TrackingService — Phase 2 event storage', () => {
  let service: TrackingService;
  let sessions: ReturnType<typeof makeTable>;
  let activities: ReturnType<typeof makeTable>;
  let events: ReturnType<typeof makeTable>;
  let trackingEnabled: boolean;
  let idSeq: number;

  const newId = () => `evt-${String(++idSeq).padStart(6, '0')}`;
  const addSession = (data: Row): Row => {
    const row: Row = {
      device_id: BROWSER_DEVICE_ID, logout_time: null, is_active_session: true, last_desktop_ping: null, is_desktop_idle: false,
      mouse_moves: 0, key_presses: 0, clicks: 0, productive_seconds: 0, idle_seconds: 0, tracked_seconds: 0, activity_percentage: 0,
      ...data,
    };
    sessions.rows.push(row);
    return row;
  };
  const eventsOf = (filter: Row = {}) => events.rows.filter((r) => matches(r, filter));

  beforeEach(async () => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
    });
    idSeq = 0;
    trackingEnabled = true;
    sessions = makeTable(() => ({
      logout_time: null, last_desktop_ping: null, is_desktop_idle: false, mouse_moves: 0, key_presses: 0, clicks: 0,
      productive_seconds: 0, idle_seconds: 0, tracked_seconds: 0, activity_percentage: 0,
    }));
    // Session ids in tests are set explicitly (100+); created sessions start at 1
    activities = makeTable(() => ({ window_title: '', duration_seconds: 0, mouse_moves: 0, key_presses: 0, clicks: 0, productive_seconds: 0, productive_duration: 0, is_productive: true }));
    events = makeTable(
      () => ({ timestamp: new Date(), source: 'legacy', session_id: null, reason: null, device_id: null, ended_at: null, duration_seconds: null, metadata: null }),
      (data, rows) => data.client_event_id != null && rows.some((r) => r.user_id === data.user_id && r.client_event_id === data.client_event_id),
    );

    const prisma = {
      user: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
      trackingUserProfile: {
        findUnique: jest.fn(async ({ where }: Row) => ({ id: where.user_id, user_id: where.user_id, is_tracking_enabled: trackingEnabled, screenshots_enabled: true })),
      },
      workSession: sessions,
      appActivity: activities,
      trackingActivityLog: events,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [TrackingService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(TrackingService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const send = (evs: Row[], extra: Row = {}, userId = 1) => service.handleTrackingEvents(userId, { device_id: DESKTOP, events: evs, ...extra });
  const ev = (type: string, occurredAt: Date, extra: Row = {}): Row => ({ client_event_id: newId(), type, occurred_at: iso(occurredAt), ...extra });

  // ---------------------------------------------------------------------------------------------
  // Validation (pure)
  // ---------------------------------------------------------------------------------------------
  describe('validateClientEvent', () => {
    const validate = (raw: Row) => validateClientEvent(raw, DESKTOP, NOW.getTime());
    const base = () => ({ client_event_id: 'abcdef12-0000', type: 'idle_start', occurred_at: iso(minutesAgo(5)) });
    const errorOf = (raw: Row) => {
      const r = validate(raw);
      return 'error' in r ? r.error : null;
    };

    it('accepts a minimal valid event', () => {
      expect(errorOf(base())).toBeNull();
    });

    it.each([
      ['legacy enum value', 'idle'],
      ['legacy enum value', 'active'],
      ['unknown type', 'break_pause'],
      ['missing type', undefined],
      ['non-string type', 5],
    ])('rejects %s (%p)', (_l, type) => {
      expect(errorOf({ ...base(), type })).toBe('invalid_type');
    });

    it.each([
      ['too short', 'abc'],
      ['spaces', 'has space 1234'],
      ['too long', 'x'.repeat(101)],
      ['missing', undefined],
      ['non-string', 12345678],
    ])('rejects client_event_id that is %s', (_l, id) => {
      expect(errorOf({ ...base(), client_event_id: id })).toBe('invalid_client_event_id');
    });

    it('reserves the srv: prefix for server-generated events', () => {
      expect(errorOf({ ...base(), client_event_id: 'srv:session_end:1' })).toBe('reserved_client_event_id');
      expect(errorOf({ ...base(), client_event_id: 'SRV:session_end:1' })).toBe('reserved_client_event_id');
    });

    it.each([
      ['no zone (ambiguous local time)', '2026-11-07T10:00:00'],
      ['date only', '2026-11-07'],
      ['garbage', 'yesterday'],
      ['epoch number', 1762500000000],
      ['impossible date', '2026-13-45T10:00:00Z'],
    ])('rejects occurred_at with %s', (_l, occurred_at) => {
      expect(errorOf({ ...base(), occurred_at })).toBe('invalid_occurred_at');
    });

    it('rejects timestamps beyond the clock-skew window and older than 30 days', () => {
      expect(errorOf({ ...base(), occurred_at: iso(new Date(NOW.getTime() + 3 * 60 * 1000)) })).toBe('occurred_at_in_future');
      expect(errorOf({ ...base(), occurred_at: iso(new Date(NOW.getTime() + 60 * 1000)) })).toBeNull();
      expect(errorOf({ ...base(), occurred_at: iso(minutesAgo(31 * 24 * 60)) })).toBe('occurred_at_too_old');
      expect(errorOf({ ...base(), occurred_at: iso(minutesAgo(29 * 24 * 60)) })).toBeNull();
    });

    it('parses .NET round-trip timestamps (7 fractional digits) and offsets to the exact UTC instant', () => {
      expect(parseZonedTimestamp('2026-11-07T04:30:15.1234567Z')!.toISOString()).toBe('2026-11-07T04:30:15.123Z');
      expect(parseZonedTimestamp('2026-11-07T10:00:00+05:30')!.toISOString()).toBe('2026-11-07T04:30:00.000Z');
      expect(parseZonedTimestamp('2026-11-07T10:00:00.5-0100')!.toISOString()).toBe('2026-11-07T11:00:00.500Z');
      expect(parseZonedTimestamp('2026-11-07T10:00Z')!.toISOString()).toBe('2026-11-07T10:00:00.000Z');
    });

    it('rejects an event naming a different device than its batch', () => {
      expect(errorOf({ ...base(), device_id: OTHER_DESKTOP })).toBe('device_mismatch');
      expect(errorOf({ ...base(), device_id: DESKTOP })).toBeNull();
    });

    it.each([['string', '12'], ['negative', -1], ['zero', 0], ['fraction', 1.5]])('rejects a %s session_id', (_l, session_id) => {
      expect(errorOf({ ...base(), session_id })).toBe('invalid_session_id');
    });

    it('ended_at / duration only on period-opening events, and they must agree', () => {
      const start = minutesAgo(30);
      const opening = { ...base(), occurred_at: iso(start) };
      expect(errorOf({ ...base(), type: 'idle_end', duration_seconds: 60 })).toBe('ended_at_not_allowed');
      expect(errorOf({ ...opening, ended_at: iso(minutesAgo(31)) })).toBe('ended_before_occurred');
      expect(errorOf({ ...opening, ended_at: 'soon' })).toBe('invalid_ended_at');
      expect(errorOf({ ...opening, ended_at: iso(minutesAgo(20)), duration_seconds: 60 })).toBe('duration_mismatch');
      expect(errorOf({ ...opening, ended_at: iso(minutesAgo(20)), duration_seconds: 600 })).toBeNull();
      expect(errorOf({ ...opening, duration_seconds: -5 })).toBe('invalid_duration');
      expect(errorOf({ ...opening, duration_seconds: 2.5 })).toBe('invalid_duration');
      expect(errorOf({ ...opening, duration_seconds: 3600 })).toBe('invalid_duration'); // ends in the future

      const fromEnded = validate({ ...opening, ended_at: iso(minutesAgo(20)) });
      expect('event' in fromEnded && fromEnded.event.duration_seconds).toBe(600);
      const fromDuration = validate({ ...opening, duration_seconds: 300 });
      expect('event' in fromDuration && fromDuration.event.ended_at!.toISOString()).toBe(iso(minutesAgo(25)));
    });

    it('validates reason and metadata', () => {
      expect(errorOf({ ...base(), reason: 'threshold_reached' })).toBeNull();
      expect(errorOf({ ...base(), reason: 'has spaces' })).toBe('invalid_reason');
      expect(errorOf({ ...base(), reason: 'x'.repeat(65) })).toBe('invalid_reason');
      expect(errorOf({ ...base(), metadata: { last_input_at: iso(minutesAgo(10)) } })).toBeNull();
      expect(errorOf({ ...base(), metadata: ['a'] })).toBe('invalid_metadata');
      expect(errorOf({ ...base(), metadata: 'text' })).toBe('invalid_metadata');
      expect(errorOf({ ...base(), metadata: { blob: 'x'.repeat(MAX_METADATA_BYTES) } })).toBe('metadata_too_large');
    });

    it('rejects non-object events', () => {
      expect(errorOf(null as any)).toBe('invalid_event');
      expect(errorOf([] as any)).toBe('invalid_event');
      expect(errorOf('idle_start' as any)).toBe('invalid_event');
    });
  });

  // ---------------------------------------------------------------------------------------------
  // POST /tracking/events
  // ---------------------------------------------------------------------------------------------
  describe('handleTrackingEvents', () => {
    it.each(CLIENT_EVENT_TYPES.map((t) => [t]))('stores a %s event from the desktop tracker', async (type) => {
      const res = await send([ev(type, minutesAgo(10))]);

      expect(res).toMatchObject({ success: true, received: 1, accepted: 1, duplicates: 0, rejected: 0 });
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]).toMatchObject({ user_id: 1, activity_type: type, source: 'desktop_client', device_id: DESKTOP });
    });

    it('rejects whole requests without a usable desktop device or event list', async () => {
      await expect(service.handleTrackingEvents(1, { events: [] })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.handleTrackingEvents(1, { device_id: '  ', events: [] })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.handleTrackingEvents(1, { device_id: BROWSER_DEVICE_ID, events: [] })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.handleTrackingEvents(1, { device_id: 'x'.repeat(256), events: [] })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.handleTrackingEvents(1, { device_id: DESKTOP, events: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
      const tooMany = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => ev('idle_start', minutesAgo(5)));
      await expect(send(tooMany)).rejects.toBeInstanceOf(BadRequestException);
      expect(events.rows).toHaveLength(0);
    });

    it('returns 403 when tracking is disabled for the employee', async () => {
      trackingEnabled = false;
      await expect(send([ev('idle_start', minutesAgo(5))])).rejects.toBeInstanceOf(ForbiddenException);
      expect(events.rows).toHaveLength(0);
    });

    it('accepts an empty batch', async () => {
      expect(await send([])).toMatchObject({ received: 0, accepted: 0, duplicates: 0, rejected: 0, results: [] });
    });

    describe('authentication and ownership', () => {
      beforeEach(() => {
        addSession({ id: 100, user_id: 1, device_id: DESKTOP, login_time: minutesAgo(120), last_ping: minutesAgo(1) });
        addSession({ id: 101, user_id: 2, device_id: DESKTOP, login_time: minutesAgo(120), last_ping: minutesAgo(1) });
        addSession({ id: 102, user_id: 1, device_id: BROWSER_DEVICE_ID, login_time: minutesAgo(120), last_ping: minutesAgo(1) });
        addSession({ id: 103, user_id: 1, device_id: OTHER_DESKTOP, login_time: minutesAgo(120), last_ping: minutesAgo(1), is_active_session: false, logout_time: minutesAgo(60) });
      });

      it('always stores events for the authenticated employee, ignoring any user_id in the body', async () => {
        await service.handleTrackingEvents(1, { device_id: DESKTOP, user_id: 2, events: [ev('idle_start', minutesAgo(5), { user_id: 2 })] });
        expect(events.rows[0].user_id).toBe(1);
      });

      it('accepts a session_id of the employee\'s own session on this device', async () => {
        const res = await send([ev('lock', minutesAgo(5), { session_id: 100 })]);
        expect(res.results[0]).toMatchObject({ status: 'accepted', session_id: 100 });
      });

      it.each([
        ['another employee\'s session', 101],
        ['the employee\'s browser session', 102],
        ['the employee\'s session on another device', 103],
        ['a session that does not exist', 999],
      ])('rejects %s', async (_l, session_id) => {
        const res = await send([ev('lock', minutesAgo(5), { session_id })]);
        expect(res.results[0]).toMatchObject({ status: 'rejected', error: 'session_not_permitted' });
        expect(events.rows).toHaveLength(0);
      });

      it('without session_id, attaches the session of this device that covers occurred_at, or none', async () => {
        const res = await send([ev('idle_start', minutesAgo(30)), ev('idle_start', minutesAgo(3 * 60))]);
        expect(res.results.map((r: Row) => r.session_id)).toEqual([100, null]);
      });
    });

    describe('idempotency', () => {
      it('a resent batch stores nothing twice', async () => {
        const batch = [ev('idle_start', minutesAgo(20)), ev('idle_end', minutesAgo(10))];
        const first = await send(batch);
        const second = await send(batch);

        expect(first).toMatchObject({ accepted: 2, duplicates: 0 });
        expect(second).toMatchObject({ accepted: 0, duplicates: 2, rejected: 0 });
        expect(second.results.map((r: Row) => r.id)).toEqual(first.results.map((r: Row) => r.id));
        expect(events.rows).toHaveLength(2);
      });

      it('an id repeated inside one batch is stored once', async () => {
        const a = ev('idle_start', minutesAgo(20));
        const res = await send([a, { ...a }]);
        expect(res.results.map((r: Row) => r.status)).toEqual(['accepted', 'duplicate']);
        expect(events.rows).toHaveLength(1);
      });

      it('flags a conflicting repeat (same id, different content) and keeps the stored event', async () => {
        const a = ev('idle_start', minutesAgo(20));
        await send([a]);
        const res = await send([{ ...a, type: 'lock' }]);

        expect(res.results[0]).toMatchObject({ status: 'duplicate', conflict: true });
        expect(events.rows).toHaveLength(1);
        expect(events.rows[0].activity_type).toBe('idle_start');
      });

      it('treats a unique-key race (P2002 on insert) as a duplicate', async () => {
        events.create.mockImplementationOnce(async () => { throw uniqueViolation(); });
        const res = await send([ev('idle_start', minutesAgo(5))]);
        expect(res.results[0]).toMatchObject({ status: 'duplicate' });
      });

      it('event ids are unique per employee, so another employee cannot pre-claim or collide with them', async () => {
        const shared = 'shared-id-0001';
        const r1 = await send([{ client_event_id: shared, type: 'lock', occurred_at: iso(minutesAgo(5)) }], {}, 1);
        const r2 = await send([{ client_event_id: shared, type: 'lock', occurred_at: iso(minutesAgo(5)) }], {}, 2);
        expect(r1.accepted).toBe(1);
        expect(r2.accepted).toBe(1);
        expect(eventsOf({ client_event_id: shared }).map((r) => r.user_id).sort()).toEqual([1, 2]);
      });
    });

    it('reports partial failures per event and stores the valid ones', async () => {
      const dup = ev('idle_start', minutesAgo(40));
      await send([dup]);

      const res = await send([
        ev('lock', minutesAgo(30)),
        { ...ev('lock', minutesAgo(30)), type: 'nap' },
        dup,
        ev('unlock', minutesAgo(25)),
        { ...ev('unlock', minutesAgo(25)), occurred_at: 'later' },
      ]);

      expect(res).toMatchObject({ received: 5, accepted: 2, duplicates: 1, rejected: 2 });
      expect(res.results.map((r: Row) => [r.index, r.status, r.error ?? null])).toEqual([
        [0, 'accepted', null],
        [1, 'rejected', 'invalid_type'],
        [2, 'duplicate', null],
        [3, 'accepted', null],
        [4, 'rejected', 'invalid_occurred_at'],
      ]);
      expect(events.rows).toHaveLength(3);
    });

    it('a storage error rejects only that event (retryable) and the batch continues', async () => {
      events.create.mockImplementationOnce(async () => { throw new Error('connection lost'); });
      const res = await send([ev('lock', minutesAgo(10)), ev('unlock', minutesAgo(5))]);
      expect(res.results.map((r: Row) => r.status)).toEqual(['rejected', 'accepted']);
      expect(res.results[0].error).toBe('storage_error');
    });

    it('stores out-of-order events with their own times (ordering is by occurred_at, not arrival)', async () => {
      const times = [minutesAgo(10), minutesAgo(50), minutesAgo(30)];
      await send([ev('idle_end', times[0]), ev('idle_start', times[1]), ev('lock', times[2])]);

      const ordered = [...events.rows].sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
      expect(ordered.map((r) => r.activity_type)).toEqual(['idle_start', 'lock', 'idle_end']);
      expect(ordered.map((r) => r.occurred_at.toISOString())).toEqual([iso(times[1]), iso(times[2]), iso(times[0])]);
    });

    it('preserves the UTC instant exactly and keeps the receive time separately', async () => {
      await send([
        { client_event_id: newId(), type: 'idle_start', occurred_at: '2026-11-07T13:20:05.1234567+05:30', ended_at: '2026-11-07T08:00:05.123Z', reason: 'threshold_reached', metadata: { last_input_at: '2026-11-07T07:45:05Z' } },
      ]);
      const row = events.rows[0];
      expect(row.occurred_at.toISOString()).toBe('2026-11-07T07:50:05.123Z');
      expect(row.ended_at.toISOString()).toBe('2026-11-07T08:00:05.123Z');
      expect(row.duration_seconds).toBe(600);
      expect(row.timestamp.getTime()).toBe(NOW.getTime());
      expect(row).toMatchObject({ reason: 'threshold_reached', metadata: { last_input_at: '2026-11-07T07:45:05Z' } });
    });

    it('accepts late events queued offline days ago and files them under the session that covered them', async () => {
      const twoDaysAgo = minutesAgo(2 * 24 * 60);
      addSession({ id: 110, user_id: 1, device_id: DESKTOP, login_time: new Date(twoDaysAgo.getTime() - 3600_000), last_ping: twoDaysAgo, logout_time: new Date(twoDaysAgo.getTime() + 3600_000), is_active_session: false });

      const res = await send([
        ev('offline_start', new Date(twoDaysAgo.getTime() - 600_000), { ended_at: iso(twoDaysAgo) }),
        ev('offline_end', twoDaysAgo),
      ]);
      expect(res.accepted).toBe(2);
      expect(events.rows.map((r) => r.session_id)).toEqual([110, 110]);
      expect(events.rows[0].duration_seconds).toBe(600);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Heartbeat fallback (older trackers that do not send events)
  // ---------------------------------------------------------------------------------------------
  describe('heartbeat idle fallback', () => {
    const desktopBeat = (is_idle: boolean, at: Date, extra: Row = {}) =>
      service.handleHeartbeat(1, { device_id: DESKTOP, app_name: 'Code.exe', duration_seconds: 30, is_idle, timestamp: iso(at), ...extra });

    let session: Row;
    beforeEach(() => {
      session = addSession({ id: 200, user_id: 1, device_id: DESKTOP, login_time: minutesAgo(60), last_ping: minutesAgo(0.5), last_desktop_ping: minutesAgo(0.5) });
    });

    it('records idle_start at the heartbeat that first reports idle, marked as a heartbeat-precision detection', async () => {
      await desktopBeat(true, NOW);

      const [e] = eventsOf({ activity_type: 'idle_start' });
      expect(e).toMatchObject({ source: 'server_heartbeat', reason: 'heartbeat_state_change', session_id: 200, device_id: DESKTOP });
      expect(e.occurred_at.toISOString()).toBe(iso(NOW));
      expect(e.metadata).toMatchObject({ precision: 'heartbeat', changed_after: iso(minutesAgo(0.5)), changed_by: iso(NOW) });
      expect(e.metadata.note).toMatch(/last keyboard\/mouse input was earlier and is not known/);
      expect(e.client_event_id).toBe(serverEventId.heartbeatIdle(200, 'idle_start', NOW));
    });

    it('records idle_end when the desktop reports active again', async () => {
      session.is_desktop_idle = true;
      await desktopBeat(false, NOW);
      expect(eventsOf({ activity_type: 'idle_end' })).toHaveLength(1);
      expect(eventsOf({ activity_type: 'idle_start' })).toHaveLength(0);
    });

    it('records nothing while the state does not change', async () => {
      await desktopBeat(false, NOW);
      session.is_desktop_idle = true;
      await desktopBeat(true, NOW);
      expect(eventsOf({ source: 'server_heartbeat' })).toHaveLength(0);
    });

    it('a retried heartbeat (same timestamp) cannot store the transition twice', async () => {
      await desktopBeat(true, NOW);
      session.is_desktop_idle = false; // as if the retry raced the first write
      await desktopBeat(true, NOW);
      expect(eventsOf({ activity_type: 'idle_start' })).toHaveLength(1);
    });

    it('is skipped for trackers that send their own events (events_supported: true)', async () => {
      await desktopBeat(true, NOW, { events_supported: true });
      expect(eventsOf({ source: 'server_heartbeat' })).toHaveLength(0);
      expect(session.is_desktop_idle).toBe(true);
    });

    it('a new session that starts idle records idle_start with its own reason', async () => {
      sessions.rows.length = 0;
      await desktopBeat(true, NOW);
      expect(eventsOf({ activity_type: 'idle_start' })[0]).toMatchObject({ reason: 'idle_at_session_start' });
    });

    it('browser heartbeats never create desktop idle events, even with idle or app fields', async () => {
      addSession({ id: 201, user_id: 1, device_id: BROWSER_DEVICE_ID, login_time: minutesAgo(30), last_ping: minutesAgo(0.5) });
      await service.handleHeartbeat(1, {});
      await service.handleHeartbeat(1, { is_idle: true, app_name: 'chrome.exe', timestamp: iso(NOW) });

      expect(events.rows).toHaveLength(0);
      expect(session.is_desktop_idle).toBe(false);
    });

    it('a failing event store never breaks the heartbeat (e.g. migration not yet applied)', async () => {
      events.create.mockImplementation(async () => { throw new Error("Unknown column 'occurred_at'"); });
      const res = await desktopBeat(true, NOW);
      expect(res).toMatchObject({ success: true, session_id: 200, status: 'Idle' });
      expect(session.is_desktop_idle).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Session and offline events inferred by the server
  // ---------------------------------------------------------------------------------------------
  describe('session and offline events', () => {
    const beat = (deviceId: string, at: Date = NOW) => service.handleHeartbeat(1, { device_id: deviceId, app_name: 'Code.exe', duration_seconds: 30, timestamp: iso(at) });

    it('the first desktop heartbeat records session_start (server-inferred)', async () => {
      const res = await beat(DESKTOP);
      const [e] = eventsOf({ activity_type: 'session_start' });
      expect(e).toMatchObject({ session_id: res.session_id, source: 'server_inferred', reason: 'first_heartbeat', client_event_id: serverEventId.sessionStart(res.session_id) });
      expect(e.occurred_at.toISOString()).toBe(iso(NOW));
    });

    it('browser sessions get no timeline events', async () => {
      await service.handleHeartbeat(1, {});
      await service.handleLogout(1, { device_id: BROWSER_DEVICE_ID });
      expect(events.rows).toHaveLength(0);
    });

    it('a heartbeat gap records session_end, offline_start/offline_end and a new session_start', async () => {
      const lastPing = minutesAgo(40);
      addSession({ id: 300, user_id: 1, device_id: DESKTOP, login_time: minutesAgo(120), last_ping: lastPing, last_desktop_ping: lastPing });

      const res = await beat(DESKTOP);

      const byType = (t: string) => eventsOf({ activity_type: t })[0];
      expect(byType('session_end')).toMatchObject({ session_id: 300, reason: 'heartbeat_timeout', source: 'server_inferred' });
      expect(byType('session_end').occurred_at).toEqual(lastPing);
      expect(byType('offline_start')).toMatchObject({ session_id: 300, reason: 'heartbeat_gap', duration_seconds: 40 * 60 });
      expect(byType('offline_start').occurred_at).toEqual(lastPing);
      expect(byType('offline_start').ended_at.toISOString()).toBe(iso(NOW));
      expect(byType('offline_end')).toMatchObject({ session_id: res.session_id, reason: 'heartbeat_resumed' });
      expect(byType('offline_end').occurred_at.toISOString()).toBe(iso(NOW));
      expect(byType('session_start')).toMatchObject({ session_id: res.session_id, reason: 'first_heartbeat_after_gap' });
      expect(byType('offline_start').metadata.note).toMatch(/cause .* is unknown/);
    });

    it('a heartbeat within the timeout records no session or offline events', async () => {
      addSession({ id: 301, user_id: 1, device_id: DESKTOP, login_time: minutesAgo(60), last_ping: minutesAgo(1), last_desktop_ping: minutesAgo(1) });
      await beat(DESKTOP);
      expect(events.rows).toHaveLength(0);
    });

    it('a heartbeat from another desktop machine ends the old machine\'s session with session_end', async () => {
      addSession({ id: 302, user_id: 1, device_id: OTHER_DESKTOP, login_time: minutesAgo(60), last_ping: minutesAgo(2), last_desktop_ping: minutesAgo(2) });
      await beat(DESKTOP);
      expect(eventsOf({ activity_type: 'session_end', session_id: 302 })[0]).toMatchObject({ reason: 'superseded_by_other_device', device_id: OTHER_DESKTOP });
    });

    it('desktop logout records session_end once; a repeated logout adds nothing', async () => {
      addSession({ id: 303, user_id: 1, device_id: DESKTOP, login_time: minutesAgo(60), last_ping: minutesAgo(1) });
      await service.handleLogout(1, { device_id: DESKTOP });
      await service.handleLogout(1, { device_id: DESKTOP });
      const ends = eventsOf({ activity_type: 'session_end' });
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({ session_id: 303, reason: 'logout_request' });
    });

    it('an ambiguous logout (no device_id) records nothing', async () => {
      addSession({ id: 304, user_id: 1, device_id: DESKTOP, login_time: minutesAgo(60), last_ping: minutesAgo(1) });
      await service.handleLogout(1, {});
      expect(events.rows).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Late offline activity batches (POST /tracking/activity-batch-sync)
  // ---------------------------------------------------------------------------------------------
  describe('late offline activity batches', () => {
    const activity = (at: Date, extra: Row = {}) => ({
      app_name: 'Code.exe', window_title: 'main.ts', duration_seconds: 30, is_idle: false, mouse_moves: 3, key_presses: 9, clicks: 1, timestamp: iso(at), ...extra,
    });
    const sync = (acts: Row[]) => service.handleActivityBatchSync(1, { device_id: DESKTOP, activities: acts });
    const queued = (fromMin: number, toMin: number) => {
      const out: Row[] = [];
      for (let m = fromMin; m >= toMin; m -= 0.5) out.push(activity(minutesAgo(m), { window_title: `file-${m}` }));
      return out;
    };

    it('files activity queued during a network outage into the session that was running, extending it — no new session', async () => {
      // Session A worked until 13:20, then the network dropped. At 13:40 a heartbeat got through:
      // the server closed A at its last heartbeat and opened B. Now the queue (13:20:30-13:39:30) arrives.
      const a = addSession({ id: 400, user_id: 1, device_id: DESKTOP, login_time: minutesAgo(120), last_ping: minutesAgo(40), logout_time: minutesAgo(40), is_active_session: false, productive_seconds: 4800 });
      const b = addSession({ id: 401, user_id: 1, device_id: DESKTOP, login_time: minutesAgo(20), last_ping: minutesAgo(0.5), is_active_session: true });
      events.rows.push({ id: 900, user_id: 1, session_id: 400, activity_type: 'session_end', client_event_id: serverEventId.sessionEnd(400), source: 'server_inferred', reason: 'heartbeat_timeout', occurred_at: minutesAgo(40), metadata: { inferred_from: 'heartbeat gap' } });

      const res = await sync(queued(39.5, 20.5));

      expect(res.synced_count).toBe(39);
      expect(sessions.rows).toHaveLength(2); // no made-up session
      expect(a.logout_time.toISOString()).toBe(iso(minutesAgo(20.5)));
      expect(a.productive_seconds).toBe(4800 + 39 * 30);
      expect(b.login_time.toISOString()).toBe(iso(minutesAgo(20))); // untouched
      expect(activities.rows.every((r) => r.session_id === 400)).toBe(true);

      const end = events.rows.find((r) => r.id === 900)!;
      expect(end.occurred_at.toISOString()).toBe(iso(minutesAgo(20.5)));
      expect(end.metadata).toMatchObject({ revised_by: 'late_offline_batch', originally_inferred_at: iso(minutesAgo(40)) });
    });

    it('activity from before a session\'s first heartbeat (same day) moves that session\'s start back', async () => {
      const b = addSession({ id: 410, user_id: 1, device_id: DESKTOP, login_time: minutesAgo(20), last_ping: minutesAgo(0.5), is_active_session: true });
      events.rows.push({ id: 910, user_id: 1, session_id: 410, activity_type: 'session_start', client_event_id: serverEventId.sessionStart(410), source: 'server_inferred', reason: 'first_heartbeat', occurred_at: minutesAgo(20) });

      await sync(queued(30, 25));

      expect(sessions.rows).toHaveLength(1);
      expect(b.login_time.toISOString()).toBe(iso(minutesAgo(30)));
      expect(events.rows.find((r) => r.id === 910)!.occurred_at.toISOString()).toBe(iso(minutesAgo(30)));
    });

    it('activity with no session of this device nearby creates one closed session with inferred start/end', async () => {
      const yesterday = minutesAgo(24 * 60);
      const res = await sync([activity(yesterday), activity(new Date(yesterday.getTime() + 30_000))]);

      expect(sessions.rows).toHaveLength(1);
      const created = sessions.rows[0];
      expect(created).toMatchObject({ is_active_session: false, device_id: DESKTOP });
      expect(created.login_time.toISOString()).toBe(iso(yesterday));
      expect(created.logout_time.toISOString()).toBe(iso(new Date(yesterday.getTime() + 30_000)));
      expect(res.session_id).toBe(created.id);
      expect(eventsOf({ session_id: created.id }).map((r) => [r.activity_type, r.reason])).toEqual([
        ['session_start', 'late_offline_batch'],
        ['session_end', 'late_offline_batch'],
      ]);
    });

    it('does not attach activity to a browser session or another device\'s session', async () => {
      addSession({ id: 420, user_id: 1, device_id: BROWSER_DEVICE_ID, login_time: minutesAgo(60), last_ping: minutesAgo(1) });
      addSession({ id: 421, user_id: 1, device_id: OTHER_DESKTOP, login_time: minutesAgo(60), last_ping: minutesAgo(1) });

      await sync([activity(minutesAgo(10))]);

      const created = sessions.rows.find((s) => s.id !== 420 && s.id !== 421)!;
      expect(created.device_id).toBe(DESKTOP);
      expect(activities.rows[0].session_id).toBe(created.id);
    });

    it('recent activity goes to the running session and refreshes its last_ping (existing behaviour)', async () => {
      const live = addSession({ id: 430, user_id: 1, device_id: DESKTOP, login_time: minutesAgo(60), last_ping: minutesAgo(2) });
      await sync([activity(minutesAgo(1.5)), activity(minutesAgo(1))]);

      expect(sessions.rows).toHaveLength(1);
      expect(live.last_ping.getTime()).toBe(NOW.getTime());
      expect(live.productive_seconds).toBe(60);
      expect(events.rows).toHaveLength(0);
    });

    it('a resynced batch is skipped and creates nothing', async () => {
      const acts = [activity(minutesAgo(24 * 60))];
      await sync(acts);
      const sessionsAfterFirst = sessions.rows.length;
      const eventsAfterFirst = events.rows.length;

      const res = await sync(acts);

      expect(res).toMatchObject({ synced_count: 0, skipped_count: 1, session_id: null });
      expect(sessions.rows).toHaveLength(sessionsAfterFirst);
      expect(events.rows).toHaveLength(eventsAfterFirst);
    });

    it('an older activity never merges into (and rewinds) a later row of the same app', async () => {
      addSession({ id: 440, user_id: 1, device_id: DESKTOP, login_time: minutesAgo(60), last_ping: minutesAgo(1) });
      activities.rows.push({ id: 50, user_id: 1, session_id: 440, app_name: 'Code.exe', window_title: 'main.ts', duration_seconds: 300, timestamp: minutesAgo(5), mouse_moves: 0, key_presses: 0, clicks: 0, productive_seconds: 300, productive_duration: 300 });

      await sync([activity(minutesAgo(30))]);

      const original = activities.rows.find((r) => r.id === 50)!;
      expect(original.timestamp.toISOString()).toBe(iso(minutesAgo(5)));
      expect(original.duration_seconds).toBe(300);
      expect(activities.rows).toHaveLength(2);
    });
  });
});
