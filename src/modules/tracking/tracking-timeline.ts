/**
 * Stage 3: admin historical tracking timeline. Pure functions (no database access): query validation,
 * time-zone day boundaries, duplicate resolution between desktop and server events, interval pairing
 * and summaries. TrackingService.getTrackingTimeline loads the rows and calls buildTrackingTimeline.
 *
 * Rules (also in the Stage 3 report):
 * - Stored rows are never changed; duplicates are only hidden in the response (and listed on the kept event).
 * - A server event (server_inferred / server_heartbeat) duplicates a desktop_client event when they have the
 *   same type, the same session_id (both null counts as the same) and occur within DUPLICATE_WINDOW_MS. Each
 *   desktop event absorbs at most one server event (the nearest). Everything else is shown.
 * - Durations exist only when both boundaries are known. An interval without its closing event is
 *   'ongoing' (its session is still live: elapsed time, not a final duration) or 'incomplete' (no duration).
 * - Summary totals are unions of intervals clipped to the selected range, so overlapping intervals are never
 *   counted twice. Idle is never called a break.
 */
import { CLIENT_EVENT_TYPES, ClientEventType, EVENT_SOURCES } from './tracking-events';

export const TIMELINE_MAX_RANGE_DAYS = 31;
export const TIMELINE_DEFAULT_LIMIT = 20;
export const TIMELINE_MAX_LIMIT = 100;
/** Hard caps on rows read for one request (a request over the cap is answered with truncated: true). */
export const TIMELINE_MAX_SESSIONS = 500;
export const TIMELINE_MAX_EVENTS = 5000;
/** A server event within this time of a desktop event of the same type and session is the same transition. */
export const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
/** A session with an active flag but no heartbeat for longer than this is not live any more (backend timeout). */
export const LIVE_SESSION_WINDOW_MS = 5 * 60 * 1000;

/**
 * A manual break open for longer than this is treated as abandoned: it is shown as an incomplete break (never given
 * an invented end) and no longer makes the employee's live status "On Break".
 */
export const BREAK_STALE_MS = 12 * 60 * 60 * 1000;

export type IntervalKind = 'idle' | 'locked' | 'sleep' | 'offline' | 'break';

/** Periods subtracted from session time for Active Time (with completed manual breaks). Offline is deliberately absent. */
export const ACTIVE_EXCLUDED_KINDS: readonly IntervalKind[] = ['idle', 'locked', 'sleep'];

const INTERVAL_TYPES: Record<IntervalKind, { open: ClientEventType; close: ClientEventType }> = {
  idle: { open: 'idle_start', close: 'idle_end' },
  locked: { open: 'lock', close: 'unlock' },
  sleep: { open: 'sleep', close: 'resume' },
  offline: { open: 'offline_start', close: 'offline_end' },
  break: { open: 'break_start', close: 'break_end' },
};

export const EVENT_LABELS: Record<ClientEventType, string> = {
  session_start: 'Started working',
  session_end: 'Session ended',
  idle_start: 'Became idle',
  idle_end: 'Returned active',
  lock: 'Workstation locked',
  unlock: 'Workstation unlocked',
  sleep: 'Computer went to sleep',
  resume: 'Computer resumed',
  offline_start: 'Went offline',
  offline_end: 'Reconnected',
  break_start: 'Break started',
  break_end: 'Break ended',
};

// ------------------------------------------------------------------------------------------- query

export interface TimelineQuery {
  userId: number;
  from: string; // YYYY-MM-DD (inclusive, in tz)
  to: string; // YYYY-MM-DD (inclusive, in tz)
  tz: string;
  eventTypes: ClientEventType[] | null;
  page: number;
  limit: number;
}

export type TimelineQueryResult = { ok: true; query: TimelineQuery } | { ok: false; message: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written as YYYY-MM-DD. */
export const isCalendarDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && y >= 2000 && y <= 2100;
};

export const isValidTimeZone = (tz: unknown): tz is string => {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const defaultTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * The reporting time zone for tracking days (Live Tracking "today" and the History Timeline default). Fixed on purpose:
 * the Node.js server's own zone (often UTC in production) must never decide where an employee's day starts.
 */
export const REPORTING_TIME_ZONE = 'Asia/Kolkata';

/** Today's date (YYYY-MM-DD) in the reporting time zone, and the UTC instant at which it starts. */
export const reportingToday = (now: Date = new Date()): { date: string; start: Date } => {
  const date = zonedParts(now, REPORTING_TIME_ZONE).date;
  return { date, start: zonedDayStart(date, REPORTING_TIME_ZONE) };
};

/** True when two instants fall on the same calendar day in the reporting time zone. */
export const sameReportingDay = (a: number, b: number): boolean =>
  zonedParts(new Date(a), REPORTING_TIME_ZONE).date === zonedParts(new Date(b), REPORTING_TIME_ZONE).date;

/** The reporting-time-zone calendar date (YYYY-MM-DD) of an instant. */
export const reportingDateOf = (instant: Date | string | number): string => zonedParts(new Date(instant), REPORTING_TIME_ZONE).date;

/** Weekday (0 = Sunday) and month (0 = January) of a YYYY-MM-DD calendar date, without any time zone involved. */
export const calendarDateParts = (date: string): { weekday: number; month: number; day: number; year: number } => {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return { weekday: dt.getUTCDay(), month: dt.getUTCMonth(), day: dt.getUTCDate(), year: dt.getUTCFullYear() };
};

/** Calendar arithmetic on YYYY-MM-DD strings (time-zone independent). */
export const addDays = (date: string, days: number): string => {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
};

const daysBetween = (from: string, to: string): number => {
  const [a, b] = [from, to].map((s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  });
  return Math.round((b - a) / 86400000);
};

const parsePositiveInt = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d{1,9}$/.test(s)) return NaN as any;
  const n = Number(s);
  return n > 0 ? n : (NaN as any);
};

/**
 * Validates GET /tracking/reports/timeline query parameters. `user_id` is required; the period is `date`
 * (one day) or `from`..`to` (inclusive, at most TIMELINE_MAX_RANGE_DAYS days), defaulting to today in `tz`.
 * `tz` defaults to REPORTING_TIME_ZONE.
 */
export const parseTimelineQuery = (raw: any, now: Date = new Date()): TimelineQueryResult => {
  const q = raw && typeof raw === 'object' ? raw : {};
  const fail = (message: string): TimelineQueryResult => ({ ok: false, message });

  const userId = parsePositiveInt(q.user_id);
  if (userId === null) return fail('user_id is required');
  if (!Number.isSafeInteger(userId)) return fail('user_id must be a positive integer');

  // No tz given: the reporting zone (never the server's local zone, which decides nothing about an employee's day)
  const tz = q.tz === undefined || q.tz === '' ? REPORTING_TIME_ZONE : q.tz;
  if (!isValidTimeZone(tz)) return fail('tz must be an IANA time zone such as Asia/Kolkata');

  let from: string;
  let to: string;
  if (q.date !== undefined && q.date !== '') {
    if (q.from !== undefined || q.to !== undefined) return fail('Use either date or from/to, not both');
    if (!isCalendarDate(q.date)) return fail('date must be a valid date in YYYY-MM-DD format');
    from = to = q.date;
  } else if (q.from !== undefined || q.to !== undefined) {
    if (!isCalendarDate(q.from) || !isCalendarDate(q.to)) return fail('from and to must both be valid dates in YYYY-MM-DD format');
    from = q.from;
    to = q.to;
    if (daysBetween(from, to) < 0) return fail('from must not be after to');
    if (daysBetween(from, to) + 1 > TIMELINE_MAX_RANGE_DAYS) return fail(`The date range may cover at most ${TIMELINE_MAX_RANGE_DAYS} days`);
  } else {
    from = to = zonedParts(now, tz).date;
  }

  let eventTypes: ClientEventType[] | null = null;
  if (q.event_type !== undefined && q.event_type !== '') {
    const list = (Array.isArray(q.event_type) ? q.event_type : String(q.event_type).split(','))
      .map((s: any) => String(s).trim())
      .filter(Boolean);
    const unknown = list.filter((t: string) => !(CLIENT_EVENT_TYPES as readonly string[]).includes(t));
    if (unknown.length > 0 || list.length === 0) return fail(`event_type must be one or more of: ${CLIENT_EVENT_TYPES.join(', ')}`);
    eventTypes = Array.from(new Set(list)) as ClientEventType[];
  }

  const page = parsePositiveInt(q.page);
  if (page !== null && !Number.isSafeInteger(page)) return fail('page must be a positive integer');
  const limit = parsePositiveInt(q.limit);
  if (limit !== null && (!Number.isSafeInteger(limit) || limit > TIMELINE_MAX_LIMIT)) return fail(`limit must be an integer from 1 to ${TIMELINE_MAX_LIMIT}`);

  return { ok: true, query: { userId, from, to, tz, eventTypes, page: page ?? 1, limit: limit ?? TIMELINE_DEFAULT_LIMIT } };
};

// ------------------------------------------------------------------------------------------- time zones

const partsFormatter = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (tz: string) => {
  let f = partsFormatter.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsFormatter.set(tz, f);
  }
  return f;
};

/** Wall-clock parts of an instant in `tz`, and that zone's UTC offset (minutes) at the instant. */
export const zonedParts = (instant: Date, tz: string) => {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(instant)) parts[p.type] = p.value;
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offsetMinutes = Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    offsetMinutes,
  };
};

const formatOffset = (minutes: number) => {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
};

/** ISO-8601 local time with the zone offset, e.g. 2026-11-07T17:13:35.966+05:30. */
export const toZonedIso = (instant: Date, tz: string): string => {
  const p = zonedParts(instant, tz);
  const ms = String(instant.getUTCMilliseconds()).padStart(3, '0');
  return `${p.date}T${p.time}.${ms}${formatOffset(p.offsetMinutes)}`;
};

/** The UTC instant at which calendar day `date` (YYYY-MM-DD) starts in `tz` (handles DST changes). */
export const zonedDayStart = (date: string, tz: string): Date => {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  let guess = wall - zonedParts(new Date(wall), tz).offsetMinutes * 60000;
  guess = wall - zonedParts(new Date(guess), tz).offsetMinutes * 60000;
  return new Date(guess);
};

/** [start, end) of the inclusive local date range in `tz`, as UTC instants. */
export const zonedRange = (from: string, to: string, tz: string) => ({
  start: zonedDayStart(from, tz),
  end: zonedDayStart(addDays(to, 1), tz),
});

// ------------------------------------------------------------------------------------------- building

export interface TimelineSessionRow {
  id: number;
  device_id: string | null;
  login_time: Date;
  logout_time: Date | null;
  last_ping: Date | null;
  is_active_session: boolean;
  tracked_seconds: number | null;
}

export interface TimelineEventRow {
  id: number;
  session_id: number | null;
  activity_type: string;
  occurred_at: Date;
  source: string;
  reason: string | null;
  device_id: string | null;
  ended_at: Date | null;
}

type Interval = { start: number; end: number };

const mergeIntervals = (intervals: Interval[]): Interval[] => {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
};

const totalSeconds = (intervals: Interval[]) => Math.floor(mergeIntervals(intervals).reduce((s, i) => s + (i.end - i.start), 0) / 1000);

/** Sum of each (merged) period's own whole seconds, so a total always equals the sum of the durations shown on its events. */
const totalWholeSeconds = (intervals: Interval[]) => mergeIntervals(intervals).reduce((s, i) => s + Math.floor((i.end - i.start) / 1000), 0);

const clip = (iv: Interval, range: Interval): Interval | null => {
  const start = Math.max(iv.start, range.start);
  const end = Math.min(iv.end, range.end);
  return end > start ? { start, end } : null;
};

/** Length of `base` (merged) not covered by `cover` (merged). */
const subtractSeconds = (base: Interval[], cover: Interval[]): number => {
  const b = mergeIntervals(base);
  const c = mergeIntervals(cover);
  let total = 0;
  for (const iv of b) {
    let covered = 0;
    for (const x of c) {
      const overlap = Math.min(iv.end, x.end) - Math.max(iv.start, x.start);
      if (overlap > 0) covered += overlap;
    }
    total += iv.end - iv.start - covered;
  }
  return Math.max(0, Math.floor(total / 1000));
};

const isServerSource = (source: string) => source === EVENT_SOURCES.serverInferred || source === EVENT_SOURCES.serverHeartbeat;

export interface SuppressedDuplicate {
  id: number;
  source: string;
  reason: string | null;
  occurred_at: string;
}

interface WorkingEvent {
  row: TimelineEventRow;
  t: number;
  suppressed: SuppressedDuplicate[];
  intervalRef?: TimelineInterval;
}

/**
 * Hides server events that duplicate a desktop event (same type, same session, within DUPLICATE_WINDOW_MS);
 * each desktop event absorbs at most the one nearest server event. Returns the kept events in time order.
 */
export const resolveDuplicates = (rows: TimelineEventRow[]): { kept: WorkingEvent[]; suppressedCount: number } => {
  const events: WorkingEvent[] = rows
    .map((row) => ({ row, t: new Date(row.occurred_at).getTime(), suppressed: [] as SuppressedDuplicate[] }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t || a.row.id - b.row.id);

  const desktop = events.filter((e) => e.row.source === EVENT_SOURCES.desktopClient);
  const server = events.filter((e) => isServerSource(e.row.source));
  const removed = new Set<WorkingEvent>();

  // Closest pairs first, so one desktop event never takes a server event that is nearer to another
  const candidates: Array<{ d: WorkingEvent; s: WorkingEvent; gap: number }> = [];
  for (const d of desktop) {
    for (const s of server) {
      if (s.row.activity_type !== d.row.activity_type) continue;
      if ((s.row.session_id ?? null) !== (d.row.session_id ?? null)) continue;
      const gap = Math.abs(s.t - d.t);
      if (gap <= DUPLICATE_WINDOW_MS) candidates.push({ d, s, gap });
    }
  }
  candidates.sort((a, b) => a.gap - b.gap);
  const used = new Set<WorkingEvent>();
  for (const c of candidates) {
    if (used.has(c.d) || removed.has(c.s)) continue;
    used.add(c.d);
    removed.add(c.s);
    c.d.suppressed.push({ id: c.s.row.id, source: c.s.row.source, reason: c.s.row.reason, occurred_at: new Date(c.s.t).toISOString() });
  }
  return { kept: events.filter((e) => !removed.has(e)), suppressedCount: removed.size };
};

export interface TimelineInterval {
  kind: IntervalKind;
  /** closed: both ends known; ongoing: still open in a live session (elapsed only); incomplete: an end is unknown */
  status: 'closed' | 'ongoing' | 'incomplete';
  start: string | null;
  end: string | null;
  duration_seconds: number | null;
  elapsed_seconds: number | null;
  session_id: number | null;
  start_event_id: number | null;
  end_event_id: number | null;
  /** 'event' when closed by its closing event, 'ended_at' when the opening event carried the end */
  end_source: 'event' | 'ended_at' | null;
  /** Producer of the event that opened the period (or closed it, when its start is unknown) */
  source: string;
}

/**
 * Pairs opening and closing events per kind across the whole (deduplicated) stream, so a period may span
 * sessions (an outage) or midnight. A second opening while one is open is ignored for pairing (the event
 * itself is still shown); a closing event with nothing open is an interval with an unknown start.
 */
const pairIntervals = (events: WorkingEvent[], liveSessionIds: Set<number>, nowMs: number, anyLive: boolean): TimelineInterval[] => {
  const out: TimelineInterval[] = [];
  // An unclosed period is 'ongoing' (elapsed time only) while it can still be closed, else 'incomplete'.
  // idle/lock/sleep/offline: while their session is live. A manual break has no live session (Stop Tracking closed it):
  // it is ongoing while it is recent and no session has started since (a later session_start without a break_end
  // means work resumed and the end was never recorded: incomplete, never given an invented end).
  // A session_start on the same device after a break_start is evidence that work resumed (the break was never ended). A
  // session_start from another device (or a missing device id on either side) is only treated as the same timeline when
  // the device ids match, so one machine's new session never settles another machine's break.
  const resumedAfter = (breakStart: WorkingEvent, e: WorkingEvent): boolean =>
    e.row.activity_type === 'session_start' && e.t > breakStart.t
    && ((e.row.device_id ?? null) === (breakStart.row.device_id ?? null) || e.row.device_id == null || breakStart.row.device_id == null);
  const isOpenLive = (kind: IntervalKind, ev: WorkingEvent, nullSessionLive: boolean): boolean => {
    if (kind === 'break') {
      return nowMs - ev.t <= BREAK_STALE_MS && !events.some((x) => resumedAfter(ev, x));
    }
    return ev.row.session_id !== null ? liveSessionIds.has(ev.row.session_id) : nullSessionLive;
  };
  for (const kind of Object.keys(INTERVAL_TYPES) as IntervalKind[]) {
    const { open, close } = INTERVAL_TYPES[kind];
    let current: { ev: WorkingEvent } | null = null;
    const closeOpenAsUnknown = () => {
      if (!current) return;
      const ev = current.ev;
      const live = isOpenLive(kind, ev, false);
      const iv: TimelineInterval = {
        kind, status: live ? 'ongoing' : 'incomplete', start: new Date(ev.t).toISOString(), end: null, duration_seconds: null,
        elapsed_seconds: live ? Math.max(0, Math.round((nowMs - ev.t) / 1000)) : null, session_id: ev.row.session_id,
        start_event_id: ev.row.id, end_event_id: null, end_source: null, source: ev.row.source,
      };
      ev.intervalRef = iv;
      out.push(iv);
      current = null;
    };
    for (const e of events) {
      // Idle, lock and sleep belong to one session: an opening left in an earlier session never pairs with a
      // closing event of a later session (that would invent a period across the gap). Outages and manual breaks may span
      // sessions: a break starts in the session that Stop Tracking closed and ends in the session Start Tracking opens.
      // But a break that is still open when a new session starts on its device was abandoned (logout, exit, crash): it is
      // closed here as incomplete (no end, no duration, no synthetic event) so that a later break_start opens its own break
      // and the next break_end pairs with that one, never with the abandoned one.
      if (kind === 'break' && current && resumedAfter(current.ev, e)) {
        closeOpenAsUnknown();
      }
      if (current && kind !== 'offline' && kind !== 'break' && (e.row.activity_type === open || e.row.activity_type === close)
        && (e.row.session_id ?? null) !== (current.ev.row.session_id ?? null)) {
        closeOpenAsUnknown();
      }
      if (e.row.activity_type === open) {
        if (current) continue;
        current = { ev: e };
      } else if (e.row.activity_type === close) {
        if (current) {
          const iv: TimelineInterval = {
            kind, status: 'closed', start: new Date(current.ev.t).toISOString(), end: new Date(e.t).toISOString(),
            duration_seconds: Math.max(0, Math.floor((e.t - current.ev.t) / 1000)), elapsed_seconds: null,
            session_id: current.ev.row.session_id, start_event_id: current.ev.row.id, end_event_id: e.row.id, end_source: 'event', source: current.ev.row.source,
          };
          current.ev.intervalRef = iv;
          out.push(iv);
          current = null;
        } else {
          const unmatched: TimelineInterval = {
            kind, status: 'incomplete', start: null, end: new Date(e.t).toISOString(), duration_seconds: null, elapsed_seconds: null,
            session_id: e.row.session_id, start_event_id: null, end_event_id: e.row.id, end_source: 'event', source: e.row.source,
          };
          // The closing event carries the indicator: its start was never recorded
          e.intervalRef = unmatched;
          out.push(unmatched);
        }
      }
    }
    if (current) {
      const ev = current.ev;
      const endedAt = ev.row.ended_at ? new Date(ev.row.ended_at).getTime() : null;
      let iv: TimelineInterval;
      if (endedAt !== null && Number.isFinite(endedAt) && endedAt >= ev.t) {
        iv = {
          kind, status: 'closed', start: new Date(ev.t).toISOString(), end: new Date(endedAt).toISOString(),
          duration_seconds: Math.floor((endedAt - ev.t) / 1000), elapsed_seconds: null, session_id: ev.row.session_id,
          start_event_id: ev.row.id, end_event_id: null, end_source: 'ended_at', source: ev.row.source,
        };
      } else {
        const live = isOpenLive(kind, ev, anyLive);
        iv = {
          kind, status: live ? 'ongoing' : 'incomplete', start: new Date(ev.t).toISOString(), end: null, duration_seconds: null,
          elapsed_seconds: live ? Math.max(0, Math.round((nowMs - ev.t) / 1000)) : null, session_id: ev.row.session_id,
          start_event_id: ev.row.id, end_event_id: null, end_source: null, source: ev.row.source,
        };
      }
      ev.intervalRef = iv;
      out.push(iv);
    }
  }
  return out.sort((a, b) => (a.start ?? a.end ?? '').localeCompare(b.start ?? b.end ?? ''));
};

export interface BuildTimelineInput {
  sessions: TimelineSessionRow[];
  events: TimelineEventRow[];
  query: TimelineQuery;
  now: Date;
  employee: any;
  truncated?: boolean;
}

export const buildTrackingTimeline = ({ sessions, events, query, now, employee, truncated = false }: BuildTimelineInput) => {
  const { tz } = query;
  const range = zonedRange(query.from, query.to, tz);
  const rangeIv: Interval = { start: range.start.getTime(), end: range.end.getTime() };
  const nowMs = now.getTime();
  const sessionIds = new Set(sessions.map((s) => s.id));

  const { kept, suppressedCount } = resolveDuplicates(
    events.filter((e) => (CLIENT_EVENT_TYPES as readonly string[]).includes(e.activity_type)),
  );

  // ---- sessions: boundaries (desktop event, else server event, else the session record) and status
  const byType = (sid: number, type: string) => kept.filter((e) => e.row.session_id === sid && e.row.activity_type === type);
  const liveSessionIds = new Set<number>();
  const sessionViews = sessions
    .slice()
    .sort((a, b) => new Date(a.login_time).getTime() - new Date(b.login_time).getTime() || a.id - b.id)
    .map((s) => {
      const starts = byType(s.id, 'session_start');
      const ends = byType(s.id, 'session_end');
      const pick = (list: WorkingEvent[], last: boolean) => {
        const desk = list.filter((e) => e.row.source === EVENT_SOURCES.desktopClient);
        const pool = desk.length ? desk : list;
        return pool.length ? (last ? pool[pool.length - 1] : pool[0]) : null;
      };
      const startEv = pick(starts, false);
      const endEv = pick(ends, true);
      const startMs = startEv ? startEv.t : new Date(s.login_time).getTime();
      const lastPingMs = s.last_ping ? new Date(s.last_ping).getTime() : null;

      let status: 'ended' | 'ongoing' | 'incomplete';
      let endMs: number | null = null;
      let endSource: string | null = null;
      if (endEv) {
        status = 'ended';
        endMs = endEv.t;
        endSource = endEv.row.source;
      } else if (!s.is_active_session && s.logout_time) {
        status = 'ended';
        endMs = new Date(s.logout_time).getTime();
        endSource = 'session_record';
      } else if (s.is_active_session && lastPingMs !== null && nowMs - lastPingMs <= LIVE_SESSION_WINDOW_MS) {
        status = 'ongoing';
      } else {
        status = 'incomplete';
      }
      if (status === 'ongoing') liveSessionIds.add(s.id);

      return {
        row: s,
        startMs,
        endMs,
        lastPingMs,
        status,
        start: { at: new Date(startMs).toISOString(), local: toZonedIso(new Date(startMs), tz), source: startEv ? startEv.row.source : 'session_record', event_id: startEv?.row.id ?? null },
        end: endMs !== null
          ? { at: new Date(endMs).toISOString(), local: toZonedIso(new Date(endMs), tz), source: endSource, event_id: endEv?.row.id ?? null }
          : null,
      };
    });

  const intervals = pairIntervals(kept, liveSessionIds, nowMs, liveSessionIds.size > 0);

  // Known spans: ended = start..end; ongoing = start..now (elapsed); incomplete = start..last heartbeat (a lower bound)
  const spanOf = (v: (typeof sessionViews)[number]): Interval | null => {
    const end = v.status === 'ended' ? v.endMs : v.status === 'ongoing' ? nowMs : v.lastPingMs;
    return end !== null && end > v.startMs ? { start: v.startMs, end } : null;
  };

  const knownIntervals = (kind: IntervalKind, sid?: number) =>
    intervals
      .filter((iv) => iv.kind === kind && (sid === undefined || iv.session_id === sid))
      .map((iv) => {
        if (!iv.start) return null;
        const end = iv.end ? new Date(iv.end).getTime() : iv.status === 'ongoing' ? nowMs : null;
        return end === null ? null : { start: new Date(iv.start).getTime(), end };
      })
      .filter((x): x is Interval => x !== null)
      .map((iv) => clip(iv, rangeIv))
      .filter((x): x is Interval => x !== null);

  const kinds: IntervalKind[] = ['idle', 'locked', 'sleep', 'offline'];
  const secondsByKind = (sid?: number) => {
    const out: Record<IntervalKind, number> = { idle: 0, locked: 0, sleep: 0, offline: 0, break: 0 };
    for (const k of kinds) out[k] = totalSeconds(knownIntervals(k, sid));
    return out;
  };

  // Manual breaks: only COMPLETED intervals (both events known) count; ongoing and incomplete ones are excluded
  const completedBreaks = (): Interval[] =>
    intervals
      .filter((iv) => iv.kind === 'break' && iv.status === 'closed' && iv.start && iv.end)
      .map((iv) => clip({ start: new Date(iv.start as string).getTime(), end: new Date(iv.end as string).getTime() }, rangeIv))
      .filter((x): x is Interval => x !== null);

  // ---- events shown: in range, optionally filtered by type (intervals and totals always use every event)
  const toEventView = (e: WorkingEvent) => {
    const type = e.row.activity_type as ClientEventType;
    const iv = e.intervalRef;
    return {
      id: e.row.id,
      type,
      label: EVENT_LABELS[type],
      occurred_at: new Date(e.t).toISOString(),
      local_time: toZonedIso(new Date(e.t), tz),
      local_date: zonedParts(new Date(e.t), tz).date,
      source: e.row.source,
      reason: e.row.reason,
      session_id: e.row.session_id,
      device_id: e.row.device_id,
      duration_seconds: iv && iv.status === 'closed' ? iv.duration_seconds : null,
      elapsed_seconds: iv && iv.status === 'ongoing' ? iv.elapsed_seconds : null,
      interval_status: iv ? iv.status : null,
      suppressed_duplicates: e.suppressed,
    };
  };
  const shown = kept.filter((e) => e.t >= rangeIv.start && e.t < rangeIv.end && (!query.eventTypes || query.eventTypes.includes(e.row.activity_type as ClientEventType)));

  // ---- summary (whole range, all sessions; unions so nothing counts twice)
  const spans = sessionViews.map(spanOf).filter((x): x is Interval => x !== null).map((iv) => clip(iv, rangeIv)).filter((x): x is Interval => x !== null);
  const totals = secondsByKind();
  const breakIntervals = completedBreaks();
  const inRange = (iv: TimelineInterval) => {
    const s = iv.start ? new Date(iv.start).getTime() : null;
    const e = iv.end ? new Date(iv.end).getTime() : null;
    return (s ?? e ?? 0) < rangeIv.end && (e ?? nowMs) >= rangeIv.start;
  };
  // A manual break lies between sessions, so an unfinished one never makes session time unreliable: it is counted apart
  const incompleteCount = intervals.filter((iv) => iv.kind !== 'break' && iv.status === 'incomplete' && inRange(iv)).length;
  const incompleteBreaks = intervals.filter((iv) => iv.kind === 'break' && iv.status === 'incomplete' && inRange(iv)).length;
  const ongoingBreak = intervals.some((iv) => iv.kind === 'break' && iv.status === 'ongoing' && inRange(iv));
  const sessionsInRange = sessionViews.filter((v) => {
    const sp = spanOf(v);
    return sp ? clip(sp, rangeIv) !== null : v.startMs >= rangeIv.start && v.startMs < rangeIv.end;
  });
  const anyIncompleteSession = sessionsInRange.some((v) => v.status === 'incomplete');

  // ---- Active Time (the single definition shared by History, Live Tracking and the desktop tracker's Today's Work)
  // Session time (spans above: ended = start..end, ongoing = start..now, incomplete = start..last heartbeat) minus the
  // merged idle, locked and sleep periods and completed manual breaks. Offline periods are NOT subtracted: while the
  // tracker runs offline it keeps measuring, and its queued idle/lock/sleep events still mark inactivity once synced;
  // time without a running tracker session is outside every span anyway. Unfinished periods are closed conservatively
  // (never adding activity beyond a known boundary) and make the result an estimate.
  const unclippedSpanBySession = new Map<number, Interval>();
  for (const v of sessionViews) {
    const sp = spanOf(v);
    if (sp) unclippedSpanBySession.set(v.row.id, sp);
  }
  const mergedUnclippedSpans = mergeIntervals(Array.from(unclippedSpanBySession.values()));
  const spanFor = (t: number, sid: number | null): Interval | null =>
    (sid !== null ? unclippedSpanBySession.get(sid) : undefined) ?? mergedUnclippedSpans.find((iv) => t >= iv.start && t <= iv.end) ?? null;
  const inactiveIntervals: Interval[] = intervals
    .filter((iv) => ACTIVE_EXCLUDED_KINDS.includes(iv.kind))
    .map((iv): Interval | null => {
      const s = iv.start ? new Date(iv.start).getTime() : null;
      const e = iv.end ? new Date(iv.end).getTime() : null;
      if (s !== null && e !== null) return { start: s, end: e };
      if (iv.status === 'ongoing' && s !== null) return { start: s, end: nowMs };
      if (s !== null) {
        // End unknown: inactive until its session's last known boundary (never counted as activity)
        const sp = spanFor(s, iv.session_id);
        return sp && sp.end > s ? { start: s, end: sp.end } : null;
      }
      if (e !== null) {
        // Start unknown: inactive since the previous recorded event of its session, else since the session started
        const sid = iv.session_id ?? null;
        let prev: number | null = null;
        for (const k of kept) {
          if ((k.row.session_id ?? null) === sid && k.t < e && k.row.id !== iv.end_event_id && (prev === null || k.t > prev)) prev = k.t;
        }
        const sp = spanFor(e, sid);
        const start = Math.max(sp ? sp.start : Number.NEGATIVE_INFINITY, prev ?? Number.NEGATIVE_INFINITY);
        return Number.isFinite(start) && start < e ? { start, end: e } : null;
      }
      return null;
    })
    .filter((x): x is Interval => x !== null)
    .map((iv) => clip(iv, rangeIv))
    .filter((x): x is Interval => x !== null);
  const incompleteInactive = intervals.filter((iv) => ACTIVE_EXCLUDED_KINDS.includes(iv.kind) && iv.status === 'incomplete' && inRange(iv)).length;
  const activeEstimated = truncated || anyIncompleteSession || incompleteInactive > 0;
  const activeSeconds = subtractSeconds(spans, [...inactiveIntervals, ...breakIntervals]);

  const clipTo = (iv: TimelineInterval) => (iv.start && iv.end ? clip({ start: new Date(iv.start).getTime(), end: new Date(iv.end).getTime() }, rangeIv) : null);
  const summary = {
    session_count: sessionsInRange.length,
    tracked_seconds: totalSeconds(spans),
    idle_seconds: totals.idle,
    locked_seconds: totals.locked,
    sleep_seconds: totals.sleep,
    /** Offline time not covered by a completed manual break (a break is the employee's choice, not a lost connection) */
    offline_seconds: subtractSeconds(knownIntervals('offline'), breakIntervals),
    /** Sum of COMPLETED manual breaks (clipped to the range); incomplete and ongoing breaks are not included */
    break_seconds: totalWholeSeconds(breakIntervals),
    break_count: intervals.filter((iv) => iv.kind === 'break' && iv.status === 'closed' && clipTo(iv) !== null).length,
    /** Breaks with a start but no end (abandoned or end never recorded) */
    incomplete_break_count: incompleteBreaks,
    /** A break is open right now (shown as "ongoing"; its time is not part of break_seconds yet) */
    break_ongoing: ongoingBreak,
    /**
     * Active Time: session time not covered by idle, locked or sleep periods or completed manual breaks (offline time while
     * the tracker ran counts by its own events). Always a number; see active_estimated.
     */
    active_seconds: activeSeconds,
    /** True when an end or start was unknown (closed conservatively at the last known boundary) or the data was truncated */
    active_estimated: activeEstimated,
    /** Kept for older clients: the opposite of active_estimated */
    active_reliable: !activeEstimated,
    incomplete_interval_count: incompleteCount,
    includes_ongoing: sessionsInRange.some((v) => v.status === 'ongoing') || intervals.some((iv) => iv.kind !== 'break' && iv.status === 'ongoing' && inRange(iv)),
    /** tracked_seconds uses the last heartbeat as the end of sessions whose end was never recorded */
    includes_estimates: anyIncompleteSession,
    duplicates_hidden: suppressedCount,
    /** Some offline time is a server-detected heartbeat gap: the tracker sent nothing, cause unknown (stopped, asleep, shut down or no network) */
    offline_includes_server_gaps: intervals.some((iv) => iv.kind === 'offline' && isServerSource(iv.source) && inRange(iv)),
  };

  // ---- pagination over sessions in range
  const total = sessionsInRange.length;
  const totalPages = Math.max(1, Math.ceil(total / query.limit));
  const pageViews = sessionsInRange.slice((query.page - 1) * query.limit, query.page * query.limit);

  const sessionsOut = pageViews.map((v) => {
    const per = secondsByKind(v.row.id);
    return {
      id: v.row.id,
      device_id: v.row.device_id,
      status: v.status,
      start: v.start,
      end: v.end,
      last_heartbeat_at: v.lastPingMs !== null ? new Date(v.lastPingMs).toISOString() : null,
      duration_seconds: v.status === 'ended' && v.endMs !== null ? Math.max(0, Math.round((v.endMs - v.startMs) / 1000)) : null,
      elapsed_seconds: v.status === 'ongoing' ? Math.max(0, Math.round((nowMs - v.startMs) / 1000)) : null,
      heartbeat_tracked_seconds: v.row.tracked_seconds ?? 0,
      idle_seconds: per.idle,
      locked_seconds: per.locked,
      sleep_seconds: per.sleep,
      offline_seconds: per.offline,
      intervals: intervals.filter((iv) => iv.session_id === v.row.id),
      events: shown.filter((e) => e.row.session_id === v.row.id).map(toEventView),
      has_events: kept.some((e) => e.row.session_id === v.row.id),
    };
  });

  return {
    employee,
    range: { from: query.from, to: query.to, tz, start: range.start.toISOString(), end: range.end.toISOString() },
    generated_at: now.toISOString(),
    filters: { event_types: query.eventTypes },
    summary,
    pagination: { page: query.page, limit: query.limit, total_sessions: total, total_pages: totalPages },
    sessions: sessionsOut,
    /** Events not attached to any session in the range (e.g. late offline events with no covering session) */
    unassigned_events: shown.filter((e) => e.row.session_id === null || !sessionIds.has(e.row.session_id)).map(toEventView),
    unassigned_intervals: intervals.filter((iv) => iv.session_id === null || !sessionIds.has(iv.session_id)).filter(inRange),
    truncated,
  };
};

// ------------------------------------------------------------------------------------------- open break (live status)

export interface BreakEventRow {
  user_id: number;
  activity_type: string;
  occurred_at: Date | string;
}

export interface OpenBreak {
  started_at: Date;
}

/**
 * The break a user is on right now, from their break events (any order): the latest break event decides, and only a
 * reak_start that is newer than BREAK_STALE_MS-old leaves the user "on break". An older open break is abandoned
 * (reported as an incomplete break in the timeline) and never turned into an Offline/On Break guess.
 */
export const resolveOpenBreaks = (rows: BreakEventRow[], now: Date): Map<number, OpenBreak> => {
  const latest = new Map<number, { type: string; at: number }>();
  for (const r of rows) {
    if (r.activity_type !== 'break_start' && r.activity_type !== 'break_end') continue;
    const at = new Date(r.occurred_at).getTime();
    if (!Number.isFinite(at)) continue;
    const prev = latest.get(r.user_id);
    // On equal times a break_end wins (the break was over at that instant)
    if (!prev || at > prev.at || (at === prev.at && r.activity_type === 'break_end')) latest.set(r.user_id, { type: r.activity_type, at });
  }
  const open = new Map<number, OpenBreak>();
  for (const [userId, e] of latest) {
    if (e.type === 'break_start' && now.getTime() - e.at <= BREAK_STALE_MS && e.at <= now.getTime() + 2 * 60 * 1000) {
      open.set(userId, { started_at: new Date(e.at) });
    }
  }
  return open;
};