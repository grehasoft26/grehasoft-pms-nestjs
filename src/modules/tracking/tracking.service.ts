import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../../core/prisma.service';
import {
  ClientEventType,
  EVENT_SOURCES,
  EventRejection,
  MAX_DEVICE_ID_LENGTH,
  MAX_EVENTS_PER_BATCH,
  SERVER_EVENT_ID_PREFIX,
  validateClientEvent,
} from './tracking-events';
import { CLIENT_EVENT_TYPES } from './tracking-events';
import {
  BREAK_STALE_MS,
  OpenBreak,
  TIMELINE_MAX_EVENTS,
  TIMELINE_MAX_SESSIONS,
  REPORTING_TIME_ZONE,
  addDays,
  buildTrackingTimeline,
  calendarDateParts,
  isCalendarDate,
  parseTimelineQuery,
  reportingDateOf,
  reportingToday,
  resolveOpenBreaks,
  sameReportingDay,
  zonedParts,
  zonedRange,
} from './tracking-timeline';
import {
  IDLE_DERIVED_ROW_KEYS,
  IDLE_UNAVAILABLE_LABEL,
  NullableTotal,
  exportValue,
  idleBasesOf,
  CSV_UTF8_BOM,
  readIdleEffectiveDate,
  reportIdleBasis,
  rowIdleBasis,
  sumNullable,
} from './tracking-report-idle';

/**
 * device_id of web-portal (browser) sessions: the portal heartbeat sends no device_id, so it falls back to
 * this value. Every other device_id is a desktop tracker (the tracker always sends its machine name).
 */
export const BROWSER_DEVICE_ID = 'default';

/** A session with no heartbeat for this long is treated as ended. */
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
/** A desktop tracker that has not pinged for this long is shown as Offline. */
const LIVE_WINDOW_SECONDS = 300;
/** A desktop tracker that has not pinged for this long (but is still within the live window) is shown as Idle. */
const STALE_PING_IDLE_SECONDS = 120;

export const isBrowserSession = (session: { device_id?: string | null } | null | undefined): boolean =>
  (session?.device_id ?? BROWSER_DEVICE_ID) === BROWSER_DEVICE_ID;

/** Milliseconds for a Date/string, or null when it is missing or not a valid date. */
const toMs = (value: Date | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/**
 * How one desktop heartbeat tick (normal heartbeat or offline batch entry) is counted in the session's
 * productive_seconds / idle_seconds. Threshold-based: the tick is idle only when the tracker reports is_idle
 * (no keyboard/mouse input for its idle threshold, 5 minutes by default), otherwise it is active time.
 *
 * Before this rule a tick counted as idle whenever it had no input in its own ~10 s, which made a few seconds of
 * reading or thinking "idle" and disagreed with the event-based idle of the History Timeline. Every tracker version
 * (with or without event support) sends the same threshold-based is_idle flag, so the rule applies to all of them.
 * Each tick's duration lands in exactly one bucket, so nothing is counted twice.
 */
export const heartbeatTickSeconds = (isIdle: boolean, durationSeconds: number): { activeSeconds: number; idleSeconds: number } => {
  const seconds = Math.max(0, Number(durationSeconds) || 0);
  return isIdle ? { activeSeconds: 0, idleSeconds: seconds } : { activeSeconds: seconds, idleSeconds: 0 };
};

/**
 * What Live Tracking's idle_time is based on:
 * - 'threshold_events': idle_start/idle_end periods for today (reporting time zone), computed by the same
 *   buildTrackingTimeline as the History Timeline (identical definition and rounding);
 * - 'heartbeat_counters': fallback when tracking events cannot be read; the sum of today's work_session.idle_seconds,
 *   which for sessions that started before the threshold rule may still contain old no-input-tick seconds.
 */
export type LiveIdleBasis = 'threshold_events' | 'heartbeat_counters';

export type LiveIdleResult = {
  seconds: number;
  basis: LiveIdleBasis;
  ongoing: boolean;
  incompleteIntervals: number;
  /** Today's Active Time: the History Timeline's summary.active_seconds for the same employee and day */
  activeSeconds: number;
  activeEstimated: boolean;
};

/**
 * What Live Tracking's (and the desktop tracker's) Active Time is based on:
 * - 'timeline': the History Timeline's active_seconds for today (buildTrackingTimeline; the single definition);
 * - 'heartbeat_counters': fallback when tracking events cannot be read; the sum of today's productive_seconds counters.
 */
export type ActiveTimeBasis = 'timeline' | 'heartbeat_counters';

/** Timeline rows of one employee, capped exactly like the single-employee History Timeline query. */
export type TimelineRowsForUser = { sessionRows: any[]; events: any[]; truncated: boolean };

/**
 * A business reporting date parameter as YYYY-MM-DD in the reporting time zone. A calendar date is taken as is; any
 * other parseable value (e.g. an ISO timestamp) is converted to its Asia/Kolkata date; empty = null.
 */
const reportDateParam = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (isCalendarDate(s)) return s;
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return reportingDateOf(parsed);
  throw new BadRequestException(`${name} must be a date in YYYY-MM-DD format`);
};

/** PDF cell marker for an unavailable (mixed-day) value; the legend under the table spells out IDLE_UNAVAILABLE_LABEL */
const PDF_UNAVAILABLE_MARK = 'Unavailable †';

/** Export columns (daily/employee rows, weekly trend, monthly ranking) whose value depends on idle time */
const IDLE_DERIVED_EXPORT_KEYS = new Set<string>([...IDLE_DERIVED_ROW_KEYS, 'Idle Hours', 'Total Tracked', 'tracked_hours']);

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type Interval = { start: number; end: number };

/** Sorted, non-overlapping union of the given intervals. */
const mergeIntervals = (intervals: Interval[]): Interval[] => {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ ...iv });
  }
  return merged;
};

/** Total seconds of `intervals` (merged) that are not covered by `cover` (merged). */
const uncoveredSeconds = (intervals: Interval[], cover: Interval[]): number => {
  const base = mergeIntervals(intervals);
  const covering = mergeIntervals(cover);
  let total = 0;
  for (const iv of base) {
    let covered = 0;
    for (const c of covering) {
      const overlap = Math.min(iv.end, c.end) - Math.max(iv.start, c.start);
      if (overlap > 0) covered += overlap;
    }
    total += iv.end - iv.start - covered;
  }
  return Math.max(0, Math.floor(total / 1000));
};

/**
 * Idempotency keys of server-generated events. Deterministic, so a retried heartbeat or a repeated
 * inference cannot store the same event twice (unique per user + client_event_id).
 */
export const serverEventId = {
  sessionStart: (sessionId: number) => `${SERVER_EVENT_ID_PREFIX}session_start:${sessionId}`,
  sessionEnd: (sessionId: number) => `${SERVER_EVENT_ID_PREFIX}session_end:${sessionId}`,
  /** Offline gap that followed `sessionId` (keyed by the session before the gap) */
  offlineStart: (sessionId: number) => `${SERVER_EVENT_ID_PREFIX}offline_start:${sessionId}`,
  offlineEnd: (sessionId: number) => `${SERVER_EVENT_ID_PREFIX}offline_end:${sessionId}`,
  heartbeatIdle: (sessionId: number, type: 'idle_start' | 'idle_end', detectedAt: Date) =>
    `${SERVER_EVENT_ID_PREFIX}hb:${sessionId}:${type}:${detectedAt.getTime()}`,
};

type ServerEventInput = {
  userId: number;
  sessionId: number | null;
  deviceId: string;
  type: ClientEventType;
  occurredAt: Date;
  source: typeof EVENT_SOURCES.serverHeartbeat | typeof EVENT_SOURCES.serverInferred;
  reason: string;
  clientEventId: string;
  endedAt?: Date | null;
  metadata?: Record<string, unknown> | null;
};

const isUniqueViolation = (err: any) => err?.code === 'P2002';

/** A late offline batch may extend a session (or pull its start back) by at most this much, same local day only. */
const MAX_LATE_ATTACH_MS = 12 * 3600 * 1000;

export type LiveStatus = {
  /** 'On Break' / 'Stopped' are only produced when the caller asks for them (see resolveLiveStatus options) */
  status: 'Active' | 'Idle' | 'Offline' | 'On Break' | 'Stopped';
  source: 'desktop' | 'portal' | null;
  session: any | null;
  /** When the manual break that makes the status 'On Break' started */
  break_started_at?: Date | null;
};

export type LiveStatusOptions = {
  /** The employee's open manual break (see resolveOpenBreaks); makes the status 'On Break' unless work has resumed */
  openBreak?: OpenBreak | null;
  /** Report a desktop tracker that was stopped on purpose (latest session closed, none open) as 'Stopped', not 'Offline' */
  distinguishStopped?: boolean;
};

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores one server-generated tracking event. Never throws: event storage must not break heartbeats,
   * logout or activity sync (for example on a database the Phase 2 migration has not reached yet).
   */
  private async recordServerEvent(e: ServerEventInput): Promise<'created' | 'duplicate' | 'failed'> {
    const endedAt = e.endedAt ?? null;
    try {
      await this.prisma.trackingActivityLog.create({
        data: {
          user_id: e.userId,
          session_id: e.sessionId,
          activity_type: e.type,
          occurred_at: e.occurredAt,
          client_event_id: e.clientEventId,
          source: e.source,
          reason: e.reason,
          device_id: e.deviceId,
          ended_at: endedAt,
          duration_seconds: endedAt ? Math.max(0, Math.round((endedAt.getTime() - e.occurredAt.getTime()) / 1000)) : null,
          metadata: (e.metadata ?? undefined) as any,
        },
      });
      return 'created';
    } catch (err) {
      if (isUniqueViolation(err)) return 'duplicate';
      this.logger.warn(`Could not store tracking event ${e.clientEventId}: ${(err as Error)?.message ?? err}`);
      return 'failed';
    }
  }

  /**
   * Moves a server-inferred event to a corrected time (used when a late offline batch shows a session
   * lasted longer, or started earlier, than the server first inferred). Never throws.
   */
  private async reviseServerEvent(userId: number, clientEventId: string, occurredAt: Date, revisedBy: string): Promise<void> {
    try {
      const existing = await this.prisma.trackingActivityLog.findFirst({
        where: { user_id: userId, client_event_id: clientEventId, source: EVENT_SOURCES.serverInferred },
      });
      if (!existing || new Date(existing.occurred_at).getTime() === occurredAt.getTime()) return;
      const previous = (existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}) as Record<string, unknown>;
      await this.prisma.trackingActivityLog.update({
        where: { id: existing.id },
        data: {
          occurred_at: occurredAt,
          metadata: { ...previous, revised_by: revisedBy, originally_inferred_at: new Date(existing.occurred_at).toISOString() } as any,
        },
      });
    } catch (err) {
      this.logger.warn(`Could not revise tracking event ${clientEventId}: ${(err as Error)?.message ?? err}`);
    }
  }

  /**
   * Heartbeat fallback for trackers that do not send events: records idle_start / idle_end when the
   * desktop's is_idle flag differs from the session's stored state.
   *
   * occurred_at is the DETECTION time (this heartbeat's timestamp), not the moment of the change. The
   * tracker reports idle only after its inactivity threshold (5 minutes by default), so the employee's
   * last input was roughly that long before idle_start, and the change itself happened somewhere between
   * the previous heartbeat and this one. Neither moment is known to the server; metadata says so.
   */
  private async recordHeartbeatIdleTransition(
    userId: number,
    sessionId: number,
    deviceId: string,
    previousIdle: boolean | null,
    isIdle: boolean,
    detectedAt: Date,
    previousHeartbeatAt: Date | null,
  ): Promise<void> {
    let type: 'idle_start' | 'idle_end' | null = null;
    let reason = 'heartbeat_state_change';
    if (previousIdle === null) {
      if (isIdle) {
        type = 'idle_start';
        reason = 'idle_at_session_start';
      }
    } else if (previousIdle !== isIdle) {
      type = isIdle ? 'idle_start' : 'idle_end';
    }
    if (!type) return;

    await this.recordServerEvent({
      userId,
      sessionId,
      deviceId,
      type,
      occurredAt: detectedAt,
      source: EVENT_SOURCES.serverHeartbeat,
      reason,
      clientEventId: serverEventId.heartbeatIdle(sessionId, type, detectedAt),
      metadata: {
        precision: 'heartbeat',
        occurred_at_is: 'detection time (heartbeat timestamp), not the exact moment of the change',
        changed_after: previousHeartbeatAt ? previousHeartbeatAt.toISOString() : null,
        changed_by: detectedAt.toISOString(),
        ...(type === 'idle_start'
          ? { note: 'The tracker reports idle only after its inactivity threshold; the last keyboard/mouse input was earlier and is not known' }
          : {}),
      },
    });
  }

  // -------------------------------------------------------------
  // TRACKING EVENTS (POST /tracking/events)
  // -------------------------------------------------------------
  /**
   * Stores a batch of state-transition events from the authenticated employee's desktop tracker.
   *
   * - The user is always the authenticated employee (never taken from the body).
   * - device_id is required and must be a desktop device (not the portal's BROWSER_DEVICE_ID).
   * - An event may name a session_id only if that session belongs to this employee AND this device;
   *   otherwise the event is rejected. Without session_id the session covering occurred_at on this
   *   device is used (or none).
   * - occurred_at is stored exactly as sent (UTC); the receive time goes to `timestamp`.
   * - Idempotent: (user, client_event_id) is unique. A repeat is reported as duplicate, never stored twice.
   * - Partial success: each event gets its own accepted / duplicate / rejected result.
   */
  async handleTrackingEvents(userId: number, body: any = {}) {
    const profile = await this.getOrCreateProfile(userId);
    if (!profile.is_tracking_enabled) {
      throw new ForbiddenException('Tracking is disabled for user');
    }

    const deviceId = typeof body?.device_id === 'string' ? body.device_id.trim() : '';
    if (!deviceId) throw new BadRequestException('device_id is required');
    if (deviceId.length > MAX_DEVICE_ID_LENGTH) throw new BadRequestException('device_id is too long');
    if (deviceId === BROWSER_DEVICE_ID) {
      throw new BadRequestException('Tracking events are only accepted from a desktop tracker device');
    }
    if (!Array.isArray(body?.events)) throw new BadRequestException('events must be an array');
    if (body.events.length > MAX_EVENTS_PER_BATCH) {
      throw new BadRequestException(`At most ${MAX_EVENTS_PER_BATCH} events per request`);
    }

    const now = new Date();
    type EventResult = {
      index: number;
      client_event_id: string | null;
      status: 'accepted' | 'duplicate' | 'rejected';
      id?: number;
      session_id?: number | null;
      error?: EventRejection;
      message?: string;
      conflict?: boolean;
    };
    const results: EventResult[] = [];
    const seenInBatch = new Set<string>();
    const sessionCache = new Map<number, any>();

    for (let index = 0; index < body.events.length; index++) {
      const validation = validateClientEvent(body.events[index], deviceId, now.getTime());
      // (`in` narrows the union without strictNullChecks, which this project does not enable)
      if ('error' in validation) {
        results.push({ index, client_event_id: validation.client_event_id, status: 'rejected', error: validation.error, message: validation.message });
        continue;
      }
      const ev = validation.event;

      if (seenInBatch.has(ev.client_event_id)) {
        results.push({ index, client_event_id: ev.client_event_id, status: 'duplicate', message: 'Repeated in this batch' });
        continue;
      }
      seenInBatch.add(ev.client_event_id);

      // Session ownership: the same answer for "does not exist" and "not yours", so ids cannot be probed
      let sessionId: number | null = null;
      if (ev.session_id !== null) {
        if (!sessionCache.has(ev.session_id)) {
          sessionCache.set(ev.session_id, await this.prisma.workSession.findFirst({ where: { id: ev.session_id, user_id: userId } }));
        }
        const session = sessionCache.get(ev.session_id);
        if (!session || session.user_id !== userId || session.device_id !== deviceId) {
          results.push({
            index, client_event_id: ev.client_event_id, status: 'rejected', error: 'session_not_permitted',
            message: 'session_id is not a session of this employee on this device',
          });
          continue;
        }
        sessionId = session.id;
      } else {
        const covering = await this.prisma.workSession.findFirst({
          where: {
            user_id: userId,
            device_id: deviceId,
            login_time: { lte: ev.occurred_at },
            OR: [{ logout_time: null }, { logout_time: { gte: ev.occurred_at } }],
          },
          orderBy: { login_time: 'desc' },
        });
        sessionId = covering?.id ?? null;
      }

      const existing = await this.prisma.trackingActivityLog.findFirst({
        where: { user_id: userId, client_event_id: ev.client_event_id },
      });
      if (existing) {
        const conflict = existing.activity_type !== ev.type || new Date(existing.occurred_at).getTime() !== ev.occurred_at.getTime();
        results.push({
          index, client_event_id: ev.client_event_id, status: 'duplicate', id: existing.id, session_id: existing.session_id,
          ...(conflict ? { conflict: true, message: 'Already stored with a different type or time; the stored event is kept' } : {}),
        });
        continue;
      }

      try {
        const created = await this.prisma.trackingActivityLog.create({
          data: {
            user_id: userId,
            session_id: sessionId,
            activity_type: ev.type,
            occurred_at: ev.occurred_at,
            client_event_id: ev.client_event_id,
            source: EVENT_SOURCES.desktopClient,
            reason: ev.reason,
            device_id: deviceId,
            ended_at: ev.ended_at,
            duration_seconds: ev.duration_seconds,
            metadata: (ev.metadata ?? undefined) as any,
          },
        });
        results.push({ index, client_event_id: ev.client_event_id, status: 'accepted', id: created.id, session_id: sessionId });
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Stored concurrently by another request with the same id
          results.push({ index, client_event_id: ev.client_event_id, status: 'duplicate' });
        } else {
          this.logger.warn(`Could not store tracking event ${ev.client_event_id}: ${(err as Error)?.message ?? err}`);
          results.push({ index, client_event_id: ev.client_event_id, status: 'rejected', error: 'storage_error', message: 'The event could not be stored; retry later' });
        }
      }
    }

    const count = (status: EventResult['status']) => results.filter((r) => r.status === status).length;
    return {
      success: true,
      device_id: deviceId,
      received: body.events.length,
      accepted: count('accepted'),
      duplicates: count('duplicate'),
      rejected: count('rejected'),
      results,
    };
  }

  // -------------------------------------------------------------
  // 1. GET OR CREATE USER TRACKING PROFILE
  // -------------------------------------------------------------
  async getOrCreateProfile(userId: number) {
    let profile = await this.prisma.trackingUserProfile.findUnique({
      where: { user_id: userId },
    });

    if (!profile) {
      profile = await this.prisma.trackingUserProfile.create({
        data: {
          user_id: userId,
          is_tracking_enabled: true,
          screenshots_enabled: true,
        },
      });
    }

    return profile;
  }

  async setTrackingEnabled(userId: number, enabled: boolean) {
    const profile = await this.getOrCreateProfile(userId);

    const updated = await this.prisma.trackingUserProfile.update({
      where: { id: profile.id },
      data: { is_tracking_enabled: enabled },
    });

    return {
      success: true,
      message: `Tracking ${enabled ? 'enabled' : 'disabled'} successfully`,
      data: updated,
    };
  }

  async toggleTrackingForUser(adminUser: any, targetUserId: number, enabled?: boolean) {
    const profile = await this.getOrCreateProfile(targetUserId);
    const newStatus = enabled !== undefined ? enabled : !profile.is_tracking_enabled;

    const updated = await this.prisma.trackingUserProfile.update({
      where: { id: profile.id },
      data: { is_tracking_enabled: newStatus },
    });

    return {
      success: true,
      message: `Tracking ${newStatus ? 'enabled' : 'disabled'} for user ID ${targetUserId}`,
      data: updated,
    };
  }

  classifyAppActivity(appName: string = '', windowTitle: string = ''): 'productive' | 'non_productive' {
    const appLower = (appName || '').toLowerCase().trim();
    const titleLower = (windowTitle || '').toLowerCase();

    if (!appLower || appLower === 'idle' || appLower === 'none') {
      return 'non_productive';
    }

    const nonProductiveApps = [
      'youtube', 'facebook', 'twitter', 'instagram', 'netflix', 'spotify',
      'reddit', 'pinterest', 'tumblr', 'tiktok', 'vimeo', 'solitaire',
      'freecell', 'minesweeper', 'steam', 'epic games', 'origin', 'uplay',
      'discord', 'twitch', 'hulu', 'disney+', 'games', 'game'
    ];

    for (const np of nonProductiveApps) {
      if (appLower.includes(np)) return 'non_productive';
    }

    if (['chrome', 'firefox', 'safari', 'edge', 'opera', 'browser'].some((b) => appLower.includes(b))) {
      const nonProductiveSites = ['youtube.com', 'facebook.com', 'twitter.com', 'instagram.com', 'netflix.com', 'reddit.com', 'pinterest.com', 'amazon.in', 'amazon.com', 'flipkart.com', 'ebay.com'];
      for (const site of nonProductiveSites) {
        if (titleLower.includes(site) || titleLower.includes(site.split('.')[0])) {
          return 'non_productive';
        }
      }
    }

    return 'productive';
  }

  // -------------------------------------------------------------
  // 2. HEARTBEAT & SESSION MANAGEMENT
  // -------------------------------------------------------------
  async handleHeartbeat(userId: number, body: any = {}) {
    const profile = await this.getOrCreateProfile(userId);
    if (!profile.is_tracking_enabled) {
      throw new ForbiddenException('Tracking is disabled for user');
    }

    const now = new Date();
    const deviceId = body?.device_id || 'default';
    const installationUuid = body?.installation_uuid || null;
    const trackerId = body?.tracker_id || null;
    const machineFingerprint = body?.machine_fingerprint || null;

    let eventTime = now;
    if (body?.timestamp) {
      const parsed = new Date(body.timestamp);
      if (!isNaN(parsed.getTime()) && parsed.getTime() <= now.getTime() + 60 * 1000) {
        eventTime = parsed;
      }
    }

    // A heartbeat only ever reads, refreshes or closes sessions of its own kind: browser heartbeats touch
    // browser sessions, desktop heartbeats touch desktop sessions. (Previously a browser heartbeat attached
    // itself to a live desktop session and refreshed its last_ping, so an open portal tab kept a disconnected
    // tracker looking connected; and a desktop heartbeat closed the user's browser session.)
    if (deviceId !== BROWSER_DEVICE_ID) {
      // One desktop tracker per user at a time: a heartbeat from this machine closes the user's sessions on
      // other desktop machines. Browser sessions are left alone.
      const otherDesktopSessions = await this.prisma.workSession.findMany({
        where: {
          user_id: userId,
          is_active_session: true,
          device_id: { notIn: [deviceId, BROWSER_DEVICE_ID] },
        },
      });

      for (const oldSess of otherDesktopSessions) {
        if (oldSess.device_id === deviceId || isBrowserSession(oldSess)) continue;
        const endedAt = oldSess.last_ping || oldSess.login_time || now;
        await this.prisma.workSession.update({
          where: { id: oldSess.id },
          data: {
            is_active_session: false,
            logout_time: endedAt,
          },
        });
        await this.recordServerEvent({
          userId,
          sessionId: oldSess.id,
          deviceId: oldSess.device_id,
          type: 'session_end',
          occurredAt: new Date(endedAt),
          source: EVENT_SOURCES.serverInferred,
          reason: 'superseded_by_other_device',
          clientEventId: serverEventId.sessionEnd(oldSess.id),
          metadata: { superseded_by_device_id: deviceId, inferred_from: 'last heartbeat of the replaced device' },
        });
      }
    }

    // Timeline events are recorded for desktop tracker sessions only; browser sessions have none
    const isDesktopDevice = deviceId !== BROWSER_DEVICE_ID;

    let activeSession: any = await this.prisma.workSession.findFirst({
      where: {
        user_id: userId,
        device_id: deviceId,
        is_active_session: true,
      },
      orderBy: { login_time: 'desc' },
    });

    // Desktop idle state before this heartbeat (null = new session, no previous state)
    let previousDesktopIdle: boolean | null = activeSession ? Boolean(activeSession.is_desktop_idle) : null;
    let previousDesktopPing: Date | null = activeSession?.last_desktop_ping ? new Date(activeSession.last_desktop_ping) : null;

    if (activeSession) {
      const timeSincePingMs = now.getTime() - new Date(activeSession.last_ping).getTime();
      if (timeSincePingMs > SESSION_TIMEOUT_MS) {
        const timedOut = activeSession;
        const lastHeartbeatAt = new Date(timedOut.last_ping);
        await this.prisma.workSession.update({
          where: { id: timedOut.id },
          data: {
            is_active_session: false,
            logout_time: timedOut.last_ping,
          },
        });

        activeSession = await this.prisma.workSession.create({
          data: {
            user_id: userId,
            login_time: eventTime < now ? eventTime : now,
            last_ping: now,
            is_active_session: true,
            device_id: deviceId,
            installation_uuid: installationUuid,
            tracker_id: trackerId,
            machine_fingerprint: machineFingerprint,
          },
        });
        previousDesktopIdle = null;
        previousDesktopPing = null;

        if (isDesktopDevice) {
          // No heartbeat for more than SESSION_TIMEOUT_MS: the tracker was not communicating between its last
          // heartbeat and this one. Why (stopped, asleep, shut down, no network) is not known to the server.
          const reconnectedAt = new Date(activeSession.login_time);
          const gapMetadata = {
            inferred_from: 'heartbeat gap',
            last_heartbeat_at: lastHeartbeatAt.toISOString(),
            next_heartbeat_at: reconnectedAt.toISOString(),
            note: 'The tracker sent no heartbeat in this period; the cause (stopped, asleep, shut down or no network) is unknown',
          };
          await this.recordServerEvent({
            userId, sessionId: timedOut.id, deviceId, type: 'session_end', occurredAt: lastHeartbeatAt,
            source: EVENT_SOURCES.serverInferred, reason: 'heartbeat_timeout',
            clientEventId: serverEventId.sessionEnd(timedOut.id), metadata: gapMetadata,
          });
          await this.recordServerEvent({
            userId, sessionId: timedOut.id, deviceId, type: 'offline_start', occurredAt: lastHeartbeatAt,
            source: EVENT_SOURCES.serverInferred, reason: 'heartbeat_gap', endedAt: reconnectedAt,
            clientEventId: serverEventId.offlineStart(timedOut.id), metadata: gapMetadata,
          });
          await this.recordServerEvent({
            userId, sessionId: activeSession.id, deviceId, type: 'offline_end', occurredAt: reconnectedAt,
            source: EVENT_SOURCES.serverInferred, reason: 'heartbeat_resumed',
            clientEventId: serverEventId.offlineEnd(timedOut.id), metadata: gapMetadata,
          });
          await this.recordServerEvent({
            userId, sessionId: activeSession.id, deviceId, type: 'session_start', occurredAt: reconnectedAt,
            source: EVENT_SOURCES.serverInferred, reason: 'first_heartbeat_after_gap',
            clientEventId: serverEventId.sessionStart(activeSession.id),
            metadata: { inferred_from: 'first heartbeat of the session; the tracker may have started earlier' },
          });
        }
      } else {
        activeSession = await this.prisma.workSession.update({
          where: { id: activeSession.id },
          data: {
            last_ping: now,
            installation_uuid: installationUuid || activeSession.installation_uuid,
            tracker_id: trackerId || activeSession.tracker_id,
            machine_fingerprint: machineFingerprint || activeSession.machine_fingerprint,
          },
        });
      }
    } else {
      activeSession = await this.prisma.workSession.create({
        data: {
          user_id: userId,
          login_time: eventTime < now ? eventTime : now,
          last_ping: now,
          is_active_session: true,
          device_id: deviceId,
          installation_uuid: installationUuid,
          tracker_id: trackerId,
          machine_fingerprint: machineFingerprint,
        },
      });
      if (isDesktopDevice) {
        await this.recordServerEvent({
          userId, sessionId: activeSession.id, deviceId, type: 'session_start', occurredAt: new Date(activeSession.login_time),
          source: EVENT_SOURCES.serverInferred, reason: 'first_heartbeat',
          clientEventId: serverEventId.sessionStart(activeSession.id),
          metadata: { inferred_from: 'first heartbeat of the session; the tracker may have started earlier' },
        });
      }
    }

    const appName = body?.app_name || body?.current_app || null;
    const windowTitle = body?.window_title || body?.current_window || '';
    const durationSeconds = Number(body?.duration_seconds || 10);
    const isIdle = Boolean(body?.is_idle || false);
    const mouseMoves = Number(body?.mouse_moves || 0);
    const keyPresses = Number(body?.key_presses || 0);
    const clicks = Number(body?.clicks || 0);

    const isDesktopTelemetry = (deviceId !== 'default') || (appName !== null) || (mouseMoves > 0 || keyPresses > 0 || clicks > 0);

    if (isDesktopTelemetry) {
      // Always update live idle status & last desktop ping on active session
      activeSession = await this.prisma.workSession.update({
        where: { id: activeSession.id },
        data: {
          last_desktop_ping: now,
          is_desktop_idle: isIdle,
        },
      });

      // Fallback for trackers that do not send events yet (they send events_supported: true once they do)
      if (isDesktopDevice && body?.events_supported !== true) {
        await this.recordHeartbeatIdleTransition(userId, activeSession.id, deviceId, previousDesktopIdle, isIdle, eventTime, previousDesktopPing);
      }

      // Application-level deduplication: check if exact identical app activity was recorded in last 3 seconds
      const recentDup = await this.prisma.appActivity.findFirst({
        where: {
          session_id: activeSession.id,
          app_name: appName || 'Active Workspace',
          window_title: windowTitle,
          timestamp: { gte: new Date(eventTime.getTime() - 2000), lte: new Date(eventTime.getTime() + 2000) },
        },
      });

      if (!recentDup) {
        const category = this.classifyAppActivity(appName || '', windowTitle);
        // Threshold-based (see heartbeatTickSeconds): a tick without input but with is_idle=false is active time
        const tick = heartbeatTickSeconds(isIdle, durationSeconds);
        const tickProductiveSeconds = tick.activeSeconds;
        const tickIdleSeconds = tick.idleSeconds;

        const updatedMouse = activeSession.mouse_moves + mouseMoves;
        const updatedKeys = activeSession.key_presses + keyPresses;
        const updatedClicks = activeSession.clicks + clicks;
        const updatedProd = activeSession.productive_seconds + tickProductiveSeconds;
        const updatedIdle = activeSession.idle_seconds + tickIdleSeconds;
        const updatedTracked = updatedProd + updatedIdle;
        const activityPct = updatedTracked > 0 ? Math.min(100.0, (updatedProd / updatedTracked) * 100.0) : 0.0;

        activeSession = await this.prisma.workSession.update({
          where: { id: activeSession.id },
          data: {
            mouse_moves: updatedMouse,
            key_presses: updatedKeys,
            clicks: updatedClicks,
            productive_seconds: updatedProd,
            idle_seconds: updatedIdle,
            tracked_seconds: updatedTracked,
            activity_percentage: activityPct,
          },
        });

        if (appName) {
          const lastActivity = await this.prisma.appActivity.findFirst({
            where: { session_id: activeSession.id },
            orderBy: { timestamp: 'desc' },
          });

          if (lastActivity && lastActivity.app_name === appName && lastActivity.window_title === windowTitle) {
            await this.prisma.appActivity.update({
              where: { id: lastActivity.id },
              data: {
                duration_seconds: lastActivity.duration_seconds + durationSeconds,
                mouse_moves: lastActivity.mouse_moves + mouseMoves,
                key_presses: lastActivity.key_presses + keyPresses,
                clicks: lastActivity.clicks + clicks,
                productive_seconds: lastActivity.productive_seconds + tickProductiveSeconds,
                productive_duration: lastActivity.productive_duration + tickProductiveSeconds,
                timestamp: eventTime,
              },
            });
          } else {
            await this.prisma.appActivity.create({
              data: {
                user_id: userId,
                session_id: activeSession.id,
                app_name: appName,
                window_title: windowTitle,
                duration_seconds: durationSeconds,
                mouse_moves: mouseMoves,
                key_presses: keyPresses,
                clicks: clicks,
                productive_seconds: tickProductiveSeconds,
                productive_duration: tickProductiveSeconds,
                timestamp: eventTime,
                is_productive: category === 'productive',
              },
            });
          }
        }
      }
    }

    return {
      success: true,
      message: 'Heartbeat recorded',
      session_id: activeSession.id,
      status: isIdle ? 'Idle' : 'Active',
    };
  }

  async handleActivityBatchSync(userId: number, body: any = {}) {
    const profile = await this.getOrCreateProfile(userId);
    if (!profile.is_tracking_enabled) {
      throw new ForbiddenException('Tracking is disabled for user');
    }

    const now = new Date();
    const deviceId = body?.device_id || 'default';
    const installationUuid = body?.installation_uuid || null;
    const trackerId = body?.tracker_id || null;
    const machineFingerprint = body?.machine_fingerprint || null;
    const rawActivities = Array.isArray(body?.activities) ? body.activities : [];

    if (rawActivities.length === 0) {
      return {
        success: true,
        synced_count: 0,
        skipped_count: 0,
        message: 'No activities to sync',
      };
    }

    const parsedActivities = [];
    for (const item of rawActivities) {
      if (!item || typeof item !== 'object') continue;
      const appName = item.app_name || item.current_app;
      if (!appName) continue;

      let ts = now;
      if (item.timestamp) {
        const p = new Date(item.timestamp);
        if (!isNaN(p.getTime()) && p.getTime() <= now.getTime() + 60 * 1000) {
          ts = p;
        }
      }

      parsedActivities.push({
        app_name: String(appName),
        window_title: item.window_title || item.current_window || '',
        duration_seconds: Math.max(1, Number(item.duration_seconds || 10)),
        is_idle: Boolean(item.is_idle || false),
        mouse_moves: Math.max(0, Number(item.mouse_moves || 0)),
        key_presses: Math.max(0, Number(item.key_presses || 0)),
        clicks: Math.max(0, Number(item.clicks || 0)),
        timestamp: ts,
      });
    }

    parsedActivities.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    if (parsedActivities.length === 0) {
      return {
        success: true,
        synced_count: 0,
        skipped_count: 0,
        message: 'No valid activities in batch',
      };
    }

    const firstTs = parsedActivities[0].timestamp;
    const lastTs = parsedActivities[parsedActivities.length - 1].timestamp;
    const isDesktopDevice = deviceId !== BROWSER_DEVICE_ID;

    // Each activity is filed into the session of this device that covers its own timestamp. A late
    // offline batch (queued while the network was down) therefore lands in the session that was running
    // at the time, extending it when the server had already closed it on a heartbeat timeout, instead of
    // in a separate made-up session (the previous behaviour for batches older than 5 minutes).
    const dayMs = 24 * 3600 * 1000;
    const candidates = await this.prisma.workSession.findMany({
      where: {
        user_id: userId,
        device_id: deviceId,
        OR: [
          { login_time: { gte: new Date(firstTs.getTime() - dayMs), lte: new Date(lastTs.getTime() + dayMs) } },
          { is_active_session: true },
        ],
      },
      orderBy: { login_time: 'asc' },
    });
    const deviceSessions: any[] = candidates.filter((s: any) => s.user_id === userId && s.device_id === deviceId);

    type Touched = {
      session: any;
      created: boolean;
      extended: boolean;
      startMoved: boolean;
      mouse: number;
      keys: number;
      clicks: number;
      prod: number;
      idle: number;
      synced: number;
    };
    const touched = new Map<number, Touched>();
    const touch = (session: any, created = false): Touched => {
      let entry = touched.get(session.id);
      if (!entry) {
        entry = { session, created, extended: false, startMoved: false, mouse: 0, keys: 0, clicks: 0, prod: 0, idle: 0, synced: 0 };
        touched.set(session.id, entry);
      }
      return entry;
    };
    const loginMs = (s: any) => toMs(s.login_time) ?? Number.POSITIVE_INFINITY;
    const endMs = (s: any) => (s.is_active_session ? Number.POSITIVE_INFINITY : toMs(s.logout_time) ?? toMs(s.last_ping) ?? loginMs(s));
    // "Same day" in the reporting time zone, never the server's local zone
    const sameDay = sameReportingDay;

    const sessionFor = async (ts: Date): Promise<Touched> => {
      const t = ts.getTime();
      const started = deviceSessions.filter((s) => loginMs(s) <= t).sort((a, b) => loginMs(b) - loginMs(a));
      const covering = started.find((s) => endMs(s) >= t);
      if (covering) return touch(covering);

      // After a closed session (same day, within MAX_LATE_ATTACH_MS): the tracker was still running offline
      const prior = started[0];
      if (prior && t - endMs(prior) <= MAX_LATE_ATTACH_MS && sameDay(endMs(prior), t)) {
        prior.logout_time = ts;
        if ((toMs(prior.last_ping) ?? 0) < t) prior.last_ping = ts;
        const entry = touch(prior);
        entry.extended = true;
        return entry;
      }

      // Before the next session's first heartbeat (same day): the session began while offline
      const next = deviceSessions.filter((s) => loginMs(s) > t).sort((a, b) => loginMs(a) - loginMs(b))[0];
      if (next && loginMs(next) - t <= MAX_LATE_ATTACH_MS && sameDay(loginMs(next), t)) {
        next.login_time = ts;
        const entry = touch(next);
        entry.startMoved = true;
        return entry;
      }

      // No session of this device near this time: a genuinely separate session
      const live = now.getTime() - t <= SESSION_TIMEOUT_MS && !deviceSessions.some((s) => s.is_active_session);
      const created = await this.prisma.workSession.create({
        data: {
          user_id: userId,
          login_time: ts,
          last_ping: live ? now : ts,
          logout_time: live ? null : ts,
          is_active_session: live,
          device_id: deviceId,
          installation_uuid: installationUuid,
          tracker_id: trackerId,
          machine_fingerprint: machineFingerprint,
        },
      });
      deviceSessions.push(created);
      return touch(created, true);
    };

    let syncedCount = 0;
    let skippedCount = 0;
    let lastSessionId: number | null = null;

    for (const act of parsedActivities) {
      const existing = await this.prisma.appActivity.findFirst({
        where: {
          user_id: userId,
          app_name: act.app_name,
          window_title: act.window_title,
          timestamp: act.timestamp,
        },
      });

      if (existing) {
        skippedCount++;
        continue;
      }

      const entry = await sessionFor(act.timestamp);
      const targetSession = entry.session;
      lastSessionId = targetSession.id;

      const category = this.classifyAppActivity(act.app_name, act.window_title);
      // Same threshold-based rule as a live heartbeat (see heartbeatTickSeconds)
      const tick = heartbeatTickSeconds(act.is_idle, act.duration_seconds);
      const tickProd = tick.activeSeconds;
      const tickIdle = tick.idleSeconds;

      entry.mouse += act.mouse_moves;
      entry.keys += act.key_presses;
      entry.clicks += act.clicks;
      entry.prod += tickProd;
      entry.idle += tickIdle;

      const lastAct = await this.prisma.appActivity.findFirst({
        where: { session_id: targetSession.id },
        orderBy: { timestamp: 'desc' },
      });

      // Merge only forward in time: an activity older than the session's latest row gets its own row
      // (merging would move that row's end timestamp backwards)
      const lastActMs = lastAct ? toMs(lastAct.timestamp) ?? 0 : 0;
      if (lastAct && lastAct.app_name === act.app_name && lastAct.window_title === act.window_title && lastActMs <= act.timestamp.getTime()) {
        await this.prisma.appActivity.update({
          where: { id: lastAct.id },
          data: {
            duration_seconds: lastAct.duration_seconds + act.duration_seconds,
            mouse_moves: lastAct.mouse_moves + act.mouse_moves,
            key_presses: lastAct.key_presses + act.key_presses,
            clicks: lastAct.clicks + act.clicks,
            productive_seconds: lastAct.productive_seconds + tickProd,
            productive_duration: lastAct.productive_duration + tickProd,
            timestamp: act.timestamp,
          },
        });
      } else {
        await this.prisma.appActivity.create({
          data: {
            user_id: userId,
            session_id: targetSession.id,
            app_name: act.app_name,
            window_title: act.window_title,
            duration_seconds: act.duration_seconds,
            mouse_moves: act.mouse_moves,
            key_presses: act.key_presses,
            clicks: act.clicks,
            productive_seconds: tickProd,
            productive_duration: tickProd,
            timestamp: act.timestamp,
            is_productive: category === 'productive',
          },
        });
      }

      entry.synced++;
      syncedCount++;
    }

    for (const entry of touched.values()) {
      const s = entry.session;
      const current = await this.prisma.workSession.findUnique({ where: { id: s.id } });
      if (!current) continue;

      const newProd = current.productive_seconds + entry.prod;
      const newIdle = current.idle_seconds + entry.idle;
      const newTracked = newProd + newIdle;
      const data: any = {
        mouse_moves: current.mouse_moves + entry.mouse,
        key_presses: current.key_presses + entry.keys,
        clicks: current.clicks + entry.clicks,
        productive_seconds: newProd,
        idle_seconds: newIdle,
        tracked_seconds: newTracked,
        activity_percentage: newTracked > 0 ? Math.min(100.0, (newProd / newTracked) * 100.0) : 0.0,
      };
      if (entry.extended) {
        data.logout_time = s.logout_time;
        data.last_ping = s.last_ping;
      }
      if (entry.startMoved) data.login_time = s.login_time;
      if (current.is_active_session) data.last_ping = now;

      await this.prisma.workSession.update({ where: { id: s.id }, data });

      if (!isDesktopDevice) continue;
      // Server-inferred session boundaries move to what the late activity shows
      if (entry.extended) {
        await this.reviseServerEvent(userId, serverEventId.sessionEnd(s.id), new Date(s.logout_time), 'late_offline_batch');
      }
      if (entry.startMoved) {
        await this.reviseServerEvent(userId, serverEventId.sessionStart(s.id), new Date(s.login_time), 'late_offline_batch');
      }
      if (entry.created) {
        const metadata = { inferred_from: 'activities synced late from the offline queue' };
        await this.recordServerEvent({
          userId, sessionId: s.id, deviceId, type: 'session_start', occurredAt: new Date(s.login_time),
          source: EVENT_SOURCES.serverInferred, reason: 'late_offline_batch',
          clientEventId: serverEventId.sessionStart(s.id), metadata,
        });
        if (!s.is_active_session) {
          await this.recordServerEvent({
            userId, sessionId: s.id, deviceId, type: 'session_end', occurredAt: new Date(s.logout_time),
            source: EVENT_SOURCES.serverInferred, reason: 'late_offline_batch',
            clientEventId: serverEventId.sessionEnd(s.id), metadata,
          });
        }
      }
    }

    return {
      success: true,
      synced_count: syncedCount,
      skipped_count: skippedCount,
      session_id: lastSessionId,
      message: `Batch sync complete. Synced: ${syncedCount}, Skipped duplicates: ${skippedCount}`,
    };
  }

  /**
   * Ends the caller's session on the calling device only (`device_id` in the body; the portal sends
   * BROWSER_DEVICE_ID). Previously this ended the user's most recent session on *any* device, so a portal
   * logout could end the desktop tracker's session and vice versa.
   *
   * A request without a device_id is ambiguous — the current desktop tracker and older portal builds both
   * send an empty body — so it ends nothing rather than risk ending another device's session. Such a
   * tracker session is still closed by the normal timeout (logout_time = its last heartbeat).
   */
  async handleLogout(userId: number, body: any = {}) {
    const deviceId = typeof body?.device_id === 'string' ? body.device_id.trim() : '';

    if (!deviceId) {
      return {
        success: false,
        message: 'No session ended: device_id is required to identify which session to end',
        session_id: null,
        ended_session_ids: [],
      };
    }

    const sessions = await this.prisma.workSession.findMany({
      where: {
        user_id: userId,
        device_id: deviceId,
        is_active_session: true,
      },
      orderBy: { login_time: 'desc' },
    });
    const deviceSessions = sessions.filter(
      (s: any) => s.user_id === userId && s.device_id === deviceId && s.is_active_session,
    );

    if (deviceSessions.length === 0) {
      return {
        success: true,
        message: 'No active session found for this device',
        session_id: null,
        ended_session_ids: [],
      };
    }

    const now = new Date();
    for (const session of deviceSessions) {
      await this.prisma.workSession.update({
        where: { id: session.id },
        data: {
          is_active_session: false,
          logout_time: now,
          last_ping: now,
        },
      });
      if (!isBrowserSession(session)) {
        await this.recordServerEvent({
          userId, sessionId: session.id, deviceId, type: 'session_end', occurredAt: now,
          source: EVENT_SOURCES.serverInferred, reason: 'logout_request',
          clientEventId: serverEventId.sessionEnd(session.id),
          metadata: { inferred_from: 'logout request from this device (time = when the server received it)' },
        });
      }
    }

    return {
      success: true,
      message: 'Session ended successfully',
      session_id: deviceSessions[0].id,
      ended_session_ids: deviceSessions.map((s: any) => s.id),
    };
  }

  /**
   * Live status from a user's sessions. Desktop tracker sessions decide Active/Idle/Offline. A browser
   * (portal) session can only make a user Active when they have no desktop session in `sessions` — the
   * existing behaviour for portal-only users — so an open portal tab never makes a disconnected desktop
   * tracker look live.
   */
  resolveLiveStatus(sessions: any[], now: Date = new Date(), options: LiveStatusOptions = {}): LiveStatus {
    const nowMs = now.getTime();
    const breakStartMs = options.openBreak ? options.openBreak.started_at.getTime() : null;
    const byLatestLogin = (a: any, b: any) => (toMs(b.login_time) ?? 0) - (toMs(a.login_time) ?? 0);
    const desktopSessions = sessions.filter((s) => s && !isBrowserSession(s));
    const activeDesktop = desktopSessions.filter((s) => s.is_active_session).sort(byLatestLogin);

    for (const session of activeDesktop) {
      const pingMs = toMs(session.last_desktop_ping) ?? toMs(session.last_ping);
      if (pingMs === null) continue;
      const seconds = Math.floor((nowMs - pingMs) / 1000);
      if (seconds <= LIVE_WINDOW_SECONDS) {
        // A heartbeat from before the break started is not work during the break (the break is what stopped them)
        if (breakStartMs !== null && pingMs <= breakStartMs) continue;
        const idle = Boolean(session.is_desktop_idle) || seconds > STALE_PING_IDLE_SECONDS;
        return { status: idle ? 'Idle' : 'Active', source: 'desktop', session };
      }
    }

    // On Break: an open manual break and no work heartbeat since it started. A disconnection alone never gets here.
    if (options.openBreak) {
      return { status: 'On Break', source: 'desktop', session: null, break_started_at: options.openBreak.started_at };
    }
    if (desktopSessions.length === 0) {
      const activeBrowser = sessions.filter((s) => s && isBrowserSession(s) && s.is_active_session).sort(byLatestLogin);
      for (const session of activeBrowser) {
        const pingMs = toMs(session.last_ping);
        if (pingMs !== null && Math.floor((nowMs - pingMs) / 1000) <= LIVE_WINDOW_SECONDS) {
          return { status: 'Active', source: 'portal', session };
        }
      }
    }

    // Stopped on purpose: the newest desktop session was closed (Stop/Logout) and none is open. A session that is
    // still open but silent is a lost connection: Offline.
    if (options.distinguishStopped && activeDesktop.length === 0 && desktopSessions.length > 0) {
      const newest = [...desktopSessions].sort(byLatestLogin)[0];
      if (!newest.is_active_session) return { status: 'Stopped', source: 'desktop', session: null };
    }

    return { status: 'Offline', source: null, session: null };
  }

  /** Open manual breaks of these users (one bounded query). Never throws: a database without break support just has none. */
  private async loadOpenBreaks(userIds: number[], now: Date): Promise<Map<number, OpenBreak>> {
    if (userIds.length === 0) return new Map();
    try {
      const rows = await this.prisma.trackingActivityLog.findMany({
        where: {
          user_id: { in: userIds },
          activity_type: { in: ['break_start', 'break_end'] as any },
          occurred_at: { gte: new Date(now.getTime() - BREAK_STALE_MS - 3600 * 1000) },
        },
        select: { user_id: true, activity_type: true, occurred_at: true },
        orderBy: { occurred_at: 'asc' },
        take: 5000,
      });
      return resolveOpenBreaks(rows as any, now);
    } catch (err) {
      this.logger.warn(`Could not read break events: ${(err as Error)?.message ?? err}`);
      return new Map();
    }
  }

  // -------------------------------------------------------------
  // 3. EMPLOYEE STATUS SUMMARY
  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // 3. EMPLOYEE STATUS SUMMARY
  // -------------------------------------------------------------
  async getEmployeeStatus(targetUserId?: number) {
    const where: any = {};
    if (targetUserId) where.id = targetUserId;

    const users = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        tracking_profile: true,
      },
    });

    const now = new Date();
    // "Today" is the calendar day in the reporting time zone (Asia/Kolkata), not the server's local day
    const today = reportingToday(now);
    const todayStart = today.start;

    const results = [];
    const openBreaks = await this.loadOpenBreaks(users.map((u) => u.id), now);
    // Today's threshold idle for every employee: two queries in total (not two per employee)
    const liveIdleByUser = await this.loadLiveIdleBatch(users.map((u) => u.id), today, now);

    for (const u of users) {
      // Today's sessions plus any still-open older session, on every device (desktop and browser)
      const todaySessions = await this.prisma.workSession.findMany({
        where: {
          user_id: u.id,
          OR: [
            { login_time: { gte: todayStart } },
            { is_active_session: true },
          ],
        },
      });

      const openBreak = openBreaks.get(u.id) ?? null;
      const live = this.resolveLiveStatus(todaySessions, now, { openBreak, distinguishStopped: true });
      const status = live.status;
      const isLive = live.session !== null;

      // The session shown for this user: the live one, else the newest open desktop session, else any open one
      const byLatestLogin = (a: any, b: any) => (toMs(b.login_time) ?? 0) - (toMs(a.login_time) ?? 0);
      const openSessions = todaySessions.filter((s: any) => s.is_active_session).sort(byLatestLogin);
      const activeSession: any =
        live.session ?? openSessions.find((s: any) => !isBrowserSession(s)) ?? openSessions[0] ?? null;

      let displaySession = activeSession;
      if (!displaySession) {
        displaySession = await this.prisma.workSession.findFirst({
          where: { user_id: u.id },
          orderBy: { last_ping: 'desc' },
        });
      }

      const firstSession = await this.prisma.workSession.findFirst({
        where: { user_id: u.id, login_time: { gte: todayStart } },
        orderBy: { login_time: 'asc' },
      });

      let loginTime: string | null = null;
      let lastPing: string | null = null;
      let currentApp: string | null = null;
      let currentWindow: string | null = null;

      let sessionProductiveSec = 0;
      let sessionIdleSec = 0;

      if (displaySession) {
        lastPing = displaySession.last_ping ? displaySession.last_ping.toISOString() : null;
        sessionProductiveSec = displaySession.productive_seconds || 0;
        sessionIdleSec = displaySession.idle_seconds || 0;
      }

      let dailyProductiveSeconds = 0;
      let counterIdleSeconds = 0;
      let dailyMouseMoves = 0;
      let dailyKeyPresses = 0;
      let dailyClicks = 0;

      for (const s of todaySessions) {
        dailyProductiveSeconds += s.productive_seconds || 0;
        counterIdleSeconds += s.idle_seconds || 0;
        dailyMouseMoves += s.mouse_moves || 0;
        dailyKeyPresses += s.key_presses || 0;
        dailyClicks += s.clicks || 0;
      }

      // Idle time: the History Timeline's threshold-based idle for today (never the per-tick counters, which for
      // sessions that began before the threshold rule still hold old no-input-tick seconds); counters only as a
      // labelled fallback when events cannot be read
      const fromTimeline = liveIdleByUser.get(u.id);
      const liveIdle: LiveIdleResult = fromTimeline ?? {
        seconds: counterIdleSeconds, basis: 'heartbeat_counters', ongoing: false, incompleteIntervals: 0,
        activeSeconds: dailyProductiveSeconds, activeEstimated: true,
      };
      const dailyIdleSeconds = liveIdle.seconds;
      // Active Time: the History Timeline's calculation for the same employee and reporting day (same rows, same `now`)
      const activeBasis: ActiveTimeBasis = fromTimeline ? 'timeline' : 'heartbeat_counters';
      const activeSecondsToday = Math.max(0, Math.floor(liveIdle.activeSeconds));

      if (isLive && activeSession) {
        loginTime = activeSession.login_time.toISOString();

        const latestAct = await this.prisma.appActivity.findFirst({
          where: { session_id: activeSession.id },
          orderBy: { timestamp: 'desc' },
        });

        if (latestAct) {
          currentApp = latestAct.app_name;
          currentWindow = latestAct.window_title;
        }
      }

      const dailyTrackedSeconds = dailyProductiveSeconds + dailyIdleSeconds;
      const activityPct = dailyTrackedSeconds > 0 ? Math.min(100.0, (dailyProductiveSeconds / dailyTrackedSeconds) * 100.0) : 0.0;

      const formatDurationSec = (sec: number) => {
        const s = Math.max(0, Math.floor(sec));
        const h = String(Math.floor(s / 3600)).padStart(2, '0');
        const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
        const sc = String(s % 60).padStart(2, '0');
        return `${h}:${m}:${sc}`;
      };

      const item: any = {
        user_id: u.id,
        username: u.username,
        first_name: u.name ? u.name.split(' ')[0] : u.username,
        last_name: u.name && u.name.split(' ').length > 1 ? u.name.split(' ').slice(1).join(' ') : '',
        full_name: u.name || u.username,
        email: u.email,
        employee_code: `GS-26-${String(u.id).padStart(3, '0')}`,
        is_tracking_enabled: u.tracking_profile?.is_tracking_enabled ?? true,
        screenshots_enabled: u.tracking_profile?.screenshots_enabled ?? true,
        status,
        // What the live status is based on: the desktop tracker, the web portal (users with no desktop
        // session today), or nothing (Offline)
        status_source: live.source,
        /** Set while status is 'On Break': when the manual break started (UTC ISO) */
        break_started_at: live.break_started_at ? live.break_started_at.toISOString() : null,
        login_time: loginTime,
        first_login_time: firstSession ? firstSession.login_time.toISOString() : null,
        last_ping: lastPing,
        total_work_time: formatDurationSec(dailyProductiveSeconds),
        idle_time: formatDurationSec(dailyIdleSeconds),
        activity_percentage: Number(activityPct.toFixed(2)),
        productive_time: formatDurationSec(dailyProductiveSeconds),
        non_productive_time: formatDurationSec(dailyIdleSeconds),
        total_tracked_time: formatDurationSec(dailyTrackedSeconds),
        desktop_work_time: formatDurationSec(dailyTrackedSeconds),
        portal_active_time: '00:00:00',
        break_time: '00:00:00',
        unaccounted_time: '00:00:00',
        total_engagement_time: formatDurationSec(dailyTrackedSeconds),
        session_id: activeSession ? activeSession.id : null,
        session_type: 'desktop',
        current_app: currentApp,
        current_window: currentWindow,
        mouse_moves: dailyMouseMoves,
        key_presses: dailyKeyPresses,
        clicks: dailyClicks,
        productive_seconds: sessionProductiveSec,
        /** Raw heartbeat counter of the displayed session (may include old no-input-tick seconds); see idle_basis */
        idle_seconds: sessionIdleSec,
        /** Today's idle seconds behind idle_time (the History Timeline's idle_seconds for the same employee and day) */
        idle_seconds_today: dailyIdleSeconds,
        /** 'threshold_events' (same calculation as the History Timeline) or 'heartbeat_counters' (fallback) */
        idle_basis: liveIdle.basis,
        /** An idle period is open right now (counted up to now) */
        idle_ongoing: liveIdle.ongoing,
        /** Idle periods today whose end is unknown (not counted, as in the History Timeline) */
        idle_incomplete_count: liveIdle.incompleteIntervals,
        /** Today's Active Time in seconds: identical to the History Timeline's summary.active_seconds for this employee and day */
        active_seconds_today: activeSecondsToday,
        /** active_seconds_today as HH:MM:SS (Live Tracking "Active Time", desktop tracker "Today's Work") */
        active_time: formatDurationSec(activeSecondsToday),
        /** 'timeline' (History Timeline calculation) or 'heartbeat_counters' (labelled fallback when events cannot be read) */
        active_basis: activeBasis,
        /** Some start or end was unknown and was closed at the last known boundary, or the fallback was used */
        active_estimated: liveIdle.activeEstimated,
        /** The instant these values were calculated (UTC ISO); clients extrapolate from here */
        as_of: now.toISOString(),
        /** The reporting day this summary covers */
        report_date: today.date,
        report_time_zone: REPORTING_TIME_ZONE,
      };

      if (targetUserId && activeSession) {
        const appActs = await this.prisma.appActivity.findMany({
          where: { session_id: activeSession.id },
          orderBy: { timestamp: 'desc' },
          take: 50,
        });

        item.app_activities = appActs;

        // Minutes per hour spent in apps classified as productive / non-productive (classifyAppActivity).
        // This is an app classification, not keyboard/mouse inactivity: time without input inside a
        // productive app still counts as productive_apps. (These series were previously named
        // `productive` / `idle`, which presented non-productive apps as employee inactivity.)
        const hourlyTimeline: { hour: string; productive_apps: number; non_productive_apps: number }[] = [];
        for (let h = 0; h < 24; h++) {
          const hourLabel = `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
          hourlyTimeline.push({ hour: hourLabel, productive_apps: 0.0, non_productive_apps: 0.0 });
        }

        const dayActivities = await this.prisma.appActivity.findMany({
          where: { user_id: u.id, timestamp: { gte: todayStart } },
        });

        for (const act of dayActivities) {
          const actMs = toMs(act.timestamp);
          if (actMs === null) continue;
          // Hour of day in the reporting time zone (the chart covers today's reporting day)
          const actHour = Number(zonedParts(new Date(actMs), REPORTING_TIME_ZONE).time.slice(0, 2));
          const category = this.classifyAppActivity(act.app_name, act.window_title || '');
          const durationMins = Math.max(0, Number(act.duration_seconds) || 0) / 60.0;

          if (category === 'productive') {
            hourlyTimeline[actHour].productive_apps += durationMins;
          } else {
            hourlyTimeline[actHour].non_productive_apps += durationMins;
          }
        }

        for (const entry of hourlyTimeline) {
          entry.productive_apps = Number(entry.productive_apps.toFixed(2));
          entry.non_productive_apps = Number(entry.non_productive_apps.toFixed(2));
        }

        item.timeline_data = hourlyTimeline;
      }

      results.push(item);
    }

    return targetUserId ? results[0] || null : results;
  }

  // -------------------------------------------------------------
  // 4. SESSIONS LISTING
  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // HISTORICAL TIMELINE (GET /tracking/reports/timeline, admin)
  // -------------------------------------------------------------
  /**
   * Read-only historical timeline of one employee's desktop tracking for a local date or date range.
   * Three queries in total (employee, sessions, events), each bounded: desktop sessions overlapping the range
   * (at most TIMELINE_MAX_SESSIONS) and their events plus unattached events in the range (at most
   * TIMELINE_MAX_EVENTS). Portal (browser) sessions are not part of the timeline: they record no events.
   * Nothing is written; duplicates are resolved in the response only (see tracking-timeline.ts).
   */
  async getTrackingTimeline(rawQuery: any) {
    const now = new Date();
    const parsed = parseTimelineQuery(rawQuery, now);
    if ('message' in parsed) throw new BadRequestException(parsed.message);
    const query = parsed.query;

    const employee = await this.prisma.user.findUnique({
      where: { id: query.userId },
      select: { id: true, name: true, username: true, email: true, position: true, department: { select: { id: true, name: true } } },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const { start, end } = zonedRange(query.from, query.to, query.tz);
    const { sessionRows, events, truncated } = await this.loadTimelineRows(query.userId, start, end);

    return buildTrackingTimeline({
      sessions: sessionRows as any,
      events: events as any,
      query,
      now,
      employee,
      truncated,
    });
  }

  /**
   * The rows behind a timeline (History Timeline and Live Tracking's idle time): desktop sessions overlapping
   * [start, end) and their events, plus unattached events and nearby break events. Two bounded queries.
   */
  private async loadTimelineRows(userId: number, start: Date, end: Date) {
    // Overlapping the range: started before its end, and ended (or last heard from, when not closed) after its start
    const sessions = await this.prisma.workSession.findMany({
      where: {
        user_id: userId,
        device_id: { not: BROWSER_DEVICE_ID },
        login_time: { lt: end },
        OR: [
          { logout_time: { gte: start } },
          { logout_time: null, last_ping: { gte: start } },
          { logout_time: null, is_active_session: true },
        ],
      },
      select: { id: true, device_id: true, login_time: true, logout_time: true, last_ping: true, is_active_session: true, tracked_seconds: true },
      orderBy: { login_time: 'asc' },
      take: TIMELINE_MAX_SESSIONS + 1,
    });
    let truncated = sessions.length > TIMELINE_MAX_SESSIONS;
    const sessionRows = sessions.slice(0, TIMELINE_MAX_SESSIONS);
    const sessionIds = sessionRows.map((s) => s.id);

    const eventsFound = await this.prisma.trackingActivityLog.findMany({
      where: {
        user_id: userId,
        activity_type: { in: [...CLIENT_EVENT_TYPES] as any },
        OR: [
          ...(sessionIds.length ? [{ session_id: { in: sessionIds } }] : []),
          { session_id: null, occurred_at: { gte: start, lt: end } },
          // A manual break starts in the session Stop Tracking closed and ends in a later one, so a break that touches
          // the range can have its other event in a session outside it (look back up to the abandoned-break limit)
          { activity_type: { in: ['break_start', 'break_end'] as any }, occurred_at: { gte: new Date(start.getTime() - BREAK_STALE_MS), lt: end } },
        ],
      },
      // No metadata: the timeline needs none of it
      select: { id: true, session_id: true, activity_type: true, occurred_at: true, source: true, reason: true, device_id: true, ended_at: true },
      orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }],
      take: TIMELINE_MAX_EVENTS + 1,
    });
    if (eventsFound.length > TIMELINE_MAX_EVENTS) truncated = true;

    return { sessionRows, events: eventsFound.slice(0, TIMELINE_MAX_EVENTS), truncated };
  }

  /**
   * The same rows as loadTimelineRows, for many employees at once: one session query and one event query in total
   * (user_id IN ...), grouped by employee in memory. Each employee gets exactly what the single-employee query returns:
   * the same filters, the same order, and the 500-session / 5,000-event caps (with `truncated`) applied per employee.
   * If a combined result reaches its safety limit, the affected step is redone per employee so no cap can be applied
   * across employees.
   */
  private async loadTimelineRowsForUsers(userIds: number[], start: Date, end: Date): Promise<Map<number, TimelineRowsForUser>> {
    const out = new Map<number, TimelineRowsForUser>();
    const ids = Array.from(new Set(userIds));
    if (ids.length === 0) return out;

    const sessionLimit = (TIMELINE_MAX_SESSIONS + 1) * ids.length;
    const sessions = await this.prisma.workSession.findMany({
      where: {
        user_id: { in: ids },
        device_id: { not: BROWSER_DEVICE_ID },
        login_time: { lt: end },
        OR: [
          { logout_time: { gte: start } },
          { logout_time: null, last_ping: { gte: start } },
          { logout_time: null, is_active_session: true },
        ],
      },
      select: { id: true, user_id: true, device_id: true, login_time: true, logout_time: true, last_ping: true, is_active_session: true, tracked_seconds: true },
      orderBy: [{ login_time: 'asc' }, { id: 'asc' }],
      take: sessionLimit,
    });
    if (sessions.length >= sessionLimit) {
      // Cannot tell which employee hit the cap: fall back to the exact single-employee queries
      for (const id of ids) out.set(id, await this.loadTimelineRows(id, start, end));
      return out;
    }

    const sessionsByUser = new Map<number, any[]>(ids.map((id) => [id, []]));
    for (const s of sessions) sessionsByUser.get(s.user_id)?.push(s);
    const sessionIdsByUser = new Map<number, Set<number>>();
    const truncatedByUser = new Map<number, boolean>();
    for (const id of ids) {
      const list = sessionsByUser.get(id) ?? [];
      truncatedByUser.set(id, list.length > TIMELINE_MAX_SESSIONS);
      const capped = list.slice(0, TIMELINE_MAX_SESSIONS);
      sessionsByUser.set(id, capped);
      sessionIdsByUser.set(id, new Set(capped.map((s) => s.id)));
    }
    const allSessionIds = Array.from(sessionIdsByUser.values()).flatMap((set) => Array.from(set));

    const breakFrom = new Date(start.getTime() - BREAK_STALE_MS);
    const eventLimit = (TIMELINE_MAX_EVENTS + 1) * ids.length;
    const eventsFound = await this.prisma.trackingActivityLog.findMany({
      where: {
        user_id: { in: ids },
        activity_type: { in: [...CLIENT_EVENT_TYPES] as any },
        OR: [
          ...(allSessionIds.length ? [{ session_id: { in: allSessionIds } }] : []),
          { session_id: null, occurred_at: { gte: start, lt: end } },
          { activity_type: { in: ['break_start', 'break_end'] as any }, occurred_at: { gte: breakFrom, lt: end } },
        ],
      },
      select: { id: true, user_id: true, session_id: true, activity_type: true, occurred_at: true, source: true, reason: true, device_id: true, ended_at: true },
      orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }],
      take: eventLimit,
    });
    if (eventsFound.length >= eventLimit) {
      for (const id of ids) out.set(id, await this.loadTimelineRows(id, start, end));
      return out;
    }

    // Per employee, the single-employee query's conditions: its own sessions' events (never another employee's
    // session), its unattached events in the range, and its break events in the break look-back window
    const startMs = start.getTime();
    const endMs = end.getTime();
    const breakFromMs = breakFrom.getTime();
    const eventsByUser = new Map<number, any[]>(ids.map((id) => [id, []]));
    for (const e of eventsFound) {
      const own = sessionIdsByUser.get(e.user_id);
      if (!own) continue;
      const t = new Date(e.occurred_at).getTime();
      const keep =
        (e.session_id !== null && own.has(e.session_id))
        || (e.session_id === null && t >= startMs && t < endMs)
        || ((e.activity_type === 'break_start' || e.activity_type === 'break_end') && t >= breakFromMs && t < endMs);
      if (keep) eventsByUser.get(e.user_id)!.push(e);
    }

    for (const id of ids) {
      const list = eventsByUser.get(id) ?? [];
      out.set(id, {
        sessionRows: sessionsByUser.get(id) ?? [],
        events: list.slice(0, TIMELINE_MAX_EVENTS),
        truncated: (truncatedByUser.get(id) ?? false) || list.length > TIMELINE_MAX_EVENTS,
      });
    }
    return out;
  }

  /**
   * Threshold idle per desktop session for a report day (P1-c, threshold days): idle_start/idle_end periods from
   * buildTrackingTimeline, per session, for sessions overlapping the day and the next one (a report attributes a whole
   * session to its login day, so a session that runs past midnight keeps its later idle too). Two queries in total.
   *
   * Per employee: `available: false` when the employee's events were truncated (the idle total would be incomplete) or
   * the timeline could not be built; returns null when the events could not be read at all (idle then unavailable).
   */
  private async loadThresholdSessionIdle(
    userIds: number[],
    date: string,
    now: Date,
  ): Promise<Map<number, { available: boolean; note: string | null; bySession: Map<number, number> }> | null> {
    const out = new Map<number, { available: boolean; note: string | null; bySession: Map<number, number> }>();
    if (userIds.length === 0) return out;
    const nextDay = addDays(date, 1);
    const { start, end } = zonedRange(date, nextDay, REPORTING_TIME_ZONE);
    let rowsByUser: Map<number, TimelineRowsForUser>;
    try {
      rowsByUser = await this.loadTimelineRowsForUsers(userIds, start, end);
    } catch (err) {
      this.logger.warn(`Could not read tracking events for report idle on ${date}: ${(err as Error)?.message ?? err}`);
      return null;
    }
    for (const userId of userIds) {
      const rows = rowsByUser.get(userId);
      if (!rows) continue;
      if (rows.truncated) {
        out.set(userId, { available: false, note: 'events_truncated', bySession: new Map() });
        continue;
      }
      try {
        const t = buildTrackingTimeline({
          sessions: rows.sessionRows as any,
          events: rows.events as any,
          query: { userId, from: date, to: nextDay, tz: REPORTING_TIME_ZONE, eventTypes: null, page: 1, limit: TIMELINE_MAX_SESSIONS },
          now,
          employee: null,
          truncated: false,
        });
        out.set(userId, { available: true, note: null, bySession: new Map(t.sessions.map((s) => [s.id, s.idle_seconds])) });
      } catch (err) {
        this.logger.warn(`Could not calculate report idle (user ${userId}, ${date}): ${(err as Error)?.message ?? err}`);
        out.set(userId, { available: false, note: 'events_unavailable', bySession: new Map() });
      }
    }
    return out;
  }

  /**
   * Today's idle time for Live Tracking, for every given employee, in the reporting time zone: exactly the History
   * Timeline's idle_seconds for the same employee and day (same rows and caps, same buildTrackingTimeline, same `now`).
   * Closed idle periods count in full, an ongoing one (live session) up to `now`, and an incomplete one (its end unknown)
   * not at all, as in the History Timeline. Two queries in total, whatever the number of employees.
   *
   * An employee missing from the result could not be calculated (the event queries failed, or that employee's
   * timeline could not be built); the caller then falls back to that employee's heartbeat counters, labelled as such.
   */
  private async loadLiveIdleBatch(userIds: number[], today: { date: string; start: Date }, now: Date): Promise<Map<number, LiveIdleResult>> {
    const out = new Map<number, LiveIdleResult>();
    if (userIds.length === 0) return out;
    const end = zonedRange(today.date, today.date, REPORTING_TIME_ZONE).end;

    let rowsByUser: Map<number, TimelineRowsForUser>;
    try {
      rowsByUser = await this.loadTimelineRowsForUsers(userIds, today.start, end);
    } catch (err) {
      this.logger.warn(`Could not read tracking events for live idle time (${userIds.length} employees): ${(err as Error)?.message ?? err}`);
      return out;
    }

    for (const userId of userIds) {
      const rows = rowsByUser.get(userId);
      if (!rows) continue;
      try {
        const t = buildTrackingTimeline({
          sessions: rows.sessionRows as any,
          events: rows.events as any,
          // One page holding every session, so every idle interval is visible below (the summary never depends on paging)
          query: { userId, from: today.date, to: today.date, tz: REPORTING_TIME_ZONE, eventTypes: null, page: 1, limit: TIMELINE_MAX_SESSIONS },
          now,
          employee: null,
          truncated: rows.truncated,
        });
        const idleIntervals = [...t.sessions.flatMap((s) => s.intervals), ...t.unassigned_intervals].filter((iv) => iv.kind === 'idle');
        out.set(userId, {
          seconds: t.summary.idle_seconds,
          basis: 'threshold_events',
          ongoing: idleIntervals.some((iv) => iv.status === 'ongoing'),
          incompleteIntervals: idleIntervals.filter((iv) => iv.status === 'incomplete').length,
          activeSeconds: t.summary.active_seconds,
          activeEstimated: t.summary.active_estimated,
        });
      } catch (err) {
        this.logger.warn(`Could not calculate live idle time (user ${userId}): ${(err as Error)?.message ?? err}`);
      }
    }
    return out;
  }

  async getUserSessions(user: any, filter?: 'today' | 'active') {
    const where: any = { user_id: user.id };

    if (filter === 'active') {
      where.is_active_session = true;
    } else if (filter === 'today') {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      where.login_time = { gte: todayStart };
    }

    return this.prisma.workSession.findMany({
      where,
      orderBy: { login_time: 'desc' },
    });
  }

  // -------------------------------------------------------------
  // 5. REPORTS & ANALYTICS
  // -------------------------------------------------------------
  /**
   * Gaps in a day's tracking, from the timestamps that actually exist.
   *
   * 1. Offline gaps — time between tracking sessions on the same day (session end = logout_time, else
   *    last_ping). When the user has desktop sessions only those are used: browser sessions run alongside
   *    them and would hide desktop gaps. Overlapping sessions are merged so overlaps never produce a gap.
   *
   * 2. Activity gaps — time inside a session with no recorded desktop activity. tracking_app_activity rows
   *    are merged: consecutive heartbeats for the same app/window add their duration to one row and
   *    overwrite `timestamp` with the *latest* heartbeat. So a row's `timestamp` is the END of the period it
   *    covers (the old code treated it as the start and added the duration, pushing each row's end into the
   *    future and hiding real gaps). A row's start is only known as `timestamp - duration_seconds`, which is
   *    exact when its heartbeats were contiguous, so these gaps are flagged `estimated: true`. Rows without
   *    a valid timestamp are ignored; a row without a valid duration has no known start, so no gap is
   *    reported before it. Gaps hidden inside a merged row (same app before and after a pause) cannot be
   *    recovered from existing data and are not reported.
   *
   * Neither kind is a confirmed break: the tracker records no idle or break events.
   */
  detectBreaksAndGaps(sessionsList: any[], activitiesList: any[]) {
    const breaks: any[] = [];
    const sessions = (sessionsList || []).filter(Boolean);
    const activities = (activitiesList || []).filter(Boolean);

    const desktopSessions = sessions.filter((s) => !isBrowserSession(s));
    const gapSessions = desktopSessions.length > 0 ? desktopSessions : sessions;

    const sessionIntervals = gapSessions
      .map((s) => ({ start: toMs(s.login_time), end: toMs(s.logout_time) ?? toMs(s.last_ping) }))
      .filter((iv): iv is Interval => iv.start !== null && iv.end !== null && iv.end >= iv.start)
      .sort((a, b) => a.start - b.start);

    let coveredUntil: number | null = null;
    for (const iv of sessionIntervals) {
      if (coveredUntil !== null && iv.start > coveredUntil
        && sameReportingDay(coveredUntil, iv.start)) {
        const gap = Math.floor((iv.start - coveredUntil) / 1000);
        if (gap >= 60) {
          breaks.push({
            start: new Date(coveredUntil),
            end: new Date(iv.start),
            duration: gap,
            type: 'offline',
            description: 'No tracking session (offline, logged out or tracker stopped)',
            estimated: false,
          });
        }
      }
      coveredUntil = coveredUntil === null ? iv.end : Math.max(coveredUntil, iv.end);
    }

    for (const session of sessions) {
      const rows = activities
        .filter((act) => act.session_id === session.id)
        .map((act) => {
          const durationSec = Number(act.duration_seconds);
          return { end: toMs(act.timestamp), durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null };
        })
        .filter((row): row is { end: number; durationSec: number | null } => row.end !== null)
        .sort((a, b) => a.end - b.end);

      let prevEnd: number | null = null;
      for (const row of rows) {
        if (prevEnd !== null && row.durationSec !== null) {
          const estimatedStart = row.end - row.durationSec * 1000;
          if (estimatedStart > prevEnd) {
            const gap = Math.floor((estimatedStart - prevEnd) / 1000);
            if (gap >= 180) {
              breaks.push({
                start: new Date(prevEnd),
                end: new Date(estimatedStart),
                duration: gap,
                type: 'idle',
                description: 'No desktop activity recorded (gap estimated from merged activity rows)',
                estimated: true,
              });
            }
          }
        }
        prevEnd = prevEnd === null ? row.end : Math.max(prevEnd, row.end);
      }
    }

    breaks.sort((a, b) => a.start.getTime() - b.start.getTime());
    const totalBreakSec = breaks.reduce((acc, b) => acc + b.duration, 0);

    return {
      breaksList: breaks,
      breakCount: breaks.length,
      totalBreakSeconds: totalBreakSec,
    };
  }

  async getDailyReport(params: any) {
    // Report days are Asia/Kolkata calendar days (REPORTING_TIME_ZONE), never the server's local days
    const toLocalDateStr = (d: Date | string) => reportingDateOf(d);

    let startDateStr = reportDateParam(params?.start_date, 'start_date');
    let endDateStr = reportDateParam(params?.end_date, 'end_date');

    if (params?.date && !startDateStr && !endDateStr) {
      startDateStr = reportDateParam(params.date, 'date');
      endDateStr = startDateStr;
    }

    const todayStr = reportingToday(new Date()).date;
    if (!startDateStr) startDateStr = todayStr;
    if (!endDateStr) endDateStr = startDateStr;

    // [00:00 IST of the first day, 00:00 IST of the day after the last day)
    const { start: startDate, end: endExclusive } = zonedRange(startDateStr, endDateStr, REPORTING_TIME_ZONE);

    const userWhere: any = {};
    if (params?.department_id) {
      userWhere.department_id = Number(params.department_id);
    }
    if (params?.user_id) {
      userWhere.id = Number(params.user_id);
    }
    if (params?.search) {
      const search = String(params.search).trim();
      userWhere.OR = [
        { name: { contains: search } },
        { username: { contains: search } },
        { email: { contains: search } },
      ];
    }

    const users = await this.prisma.user.findMany({
      where: userWhere,
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        position: true,
        department: { select: { id: true, name: true } },
      },
    });

    const userIds = users.map((u) => u.id);

    const sessions = await this.prisma.workSession.findMany({
      where: {
        user_id: { in: userIds },
        login_time: { gte: startDate, lt: endExclusive },
      },
      orderBy: { login_time: 'asc' },
    });

    const activities = await this.prisma.appActivity.findMany({
      where: {
        user_id: { in: userIds },
        timestamp: { gte: startDate, lt: endExclusive },
      },
      orderBy: { timestamp: 'asc' },
    });

    const formatDurationSec = (sec: number) => {
      const s = Math.max(0, Math.floor(sec));
      const h = String(Math.floor(s / 3600)).padStart(2, '0');
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const sc = String(s % 60).padStart(2, '0');
      return `${h}:${m}:${sc}`;
    };

    const reportRows: any[] = [];
    const now = new Date();

    // Idle basis per day (P1-c): legacy counters before the threshold-idle effective date, unavailable on that day
    // (mixed), threshold events after it. Unset effective date = every day legacy (the calculation is unchanged).
    const effective = readIdleEffectiveDate();
    if (effective.error) this.logger.error(`${effective.error}; reports use the legacy idle calculation for every day`);
    // Conservative calculation boundary: 00:00 Asia/Kolkata on the effective date (a date, not the deployment instant)
    const boundaryMs = effective.date ? zonedRange(effective.date, effective.date, REPORTING_TIME_ZONE).start.getTime() : null;

    // One pass per Asia/Kolkata calendar day of the range (string dates: no server-time-zone arithmetic)
    for (let dateIso = startDateStr; dateIso <= endDateStr; dateIso = addDays(dateIso, 1)) {
      const idleBasis = reportIdleBasis(dateIso, effective.date);
      // Threshold days: per-session event idle of the day's employees (two queries per day, whatever the employee count)
      const thresholdIdle = idleBasis === 'threshold'
        ? await this.loadThresholdSessionIdle(
          users.map((u) => u.id).filter((id) => sessions.some((s) => s.user_id === id && toLocalDateStr(s.login_time) === dateIso)),
          dateIso,
          now,
        )
        : null;

      for (const u of users) {
        const daySessions = sessions.filter((s) => s.user_id === u.id && toLocalDateStr(s.login_time) === dateIso);
        const dayActivities = activities.filter((a) => a.user_id === u.id && toLocalDateStr(a.timestamp) === dateIso);

        if (daySessions.length === 0) continue;

        const firstLogin = daySessions.reduce((min, s) => (s.login_time < min ? s.login_time : min), daySessions[0].login_time);
        const lastActive = daySessions.reduce((max, s) => {
          const t = s.logout_time || s.last_ping || s.login_time;
          return t > max ? t : max;
        }, daySessions[0].login_time);

        let productiveSec = 0;
        let idleSec = 0;

        // Portal time = browser-session time not already covered by a desktop session. Browser and desktop
        // sessions now run side by side (browser heartbeats no longer fold into the desktop session), so
        // counting both in full would double-count the same minutes in total engagement.
        const sessionInterval = (s: any): Interval | null => {
          const start = toMs(s.login_time);
          const end = toMs(s.logout_time) ?? toMs(s.last_ping) ?? now.getTime();
          return start !== null && end > start ? { start, end } : null;
        };
        const browserIntervals = daySessions.filter((s) => isBrowserSession(s)).map(sessionInterval).filter((iv): iv is Interval => iv !== null);
        const desktopIntervals = daySessions.filter((s) => !isBrowserSession(s)).map(sessionInterval).filter((iv): iv is Interval => iv !== null);
        const portalActiveSec = uncoveredSeconds(browserIntervals, desktopIntervals);

        for (const s of daySessions) {
          const sEnd = s.logout_time || s.last_ping || now;
          const sElapsed = Math.max(0, Math.floor((new Date(sEnd).getTime() - new Date(s.login_time).getTime()) / 1000));
          if (!isBrowserSession(s)) {
            let sProd = Math.max(0, s.productive_seconds || 0);
            let sIdle = Math.max(0, s.idle_seconds || 0);
            if (sProd + sIdle > sElapsed) {
              if (sProd > sElapsed) {
                sProd = sElapsed;
                sIdle = 0;
              } else {
                sIdle = sElapsed - sProd;
              }
            }
            productiveSec += sProd;
            idleSec += sIdle;
          }
        }

        const breakAnalysis = this.detectBreaksAndGaps(daySessions, dayActivities);
        const offlineBreakSec = breakAnalysis.breaksList.filter((b) => b.type === 'offline').reduce((acc, b) => acc + b.duration, 0);
        const idleBreakSec = breakAnalysis.breaksList.filter((b) => b.type === 'idle').reduce((acc, b) => acc + b.duration, 0);

        // Idle of this employee and day by basis. null = unavailable (never zero): the mixed day, or a threshold day
        // whose events could not be read completely
        // A legacy day with a desktop session that started before the effective-date boundary and ran past it (or is
        // still open) is mixed too: that session's counters may hold seconds of both rules
        const rowBasis = rowIdleBasis(idleBasis, daySessions.filter((s) => !isBrowserSession(s)), boundaryMs);
        let reconciledIdleSec: number | null = idleSec;
        let idleNote: string | null = null;
        if (rowBasis.basis === 'mixed') {
          reconciledIdleSec = null;
          idleNote = rowBasis.spansBoundary ? 'spans_effective_date' : 'mixed_calculation';
        } else if (idleBasis === 'threshold') {
          const perUser = thresholdIdle?.get(u.id);
          if (!perUser || !perUser.available) {
            reconciledIdleSec = null;
            idleNote = perUser?.note ?? 'events_unavailable';
          } else {
            // Desktop sessions that started on this day (the report attributes a whole session to its login day)
            reconciledIdleSec = daySessions.filter((s) => !isBrowserSession(s)).reduce((acc, s) => acc + (perUser.bySession.get(s.id) ?? 0), 0);
          }
        }
        // productiveSec is the stored counter capped at the session's elapsed time, on every basis (the loop above)
        const idleAvailable = reconciledIdleSec !== null;
        const reconciledBreakSec = offlineBreakSec + idleBreakSec;

        const spannedDuration = Math.max(0, Math.floor((new Date(lastActive).getTime() - new Date(firstLogin).getTime()) / 1000));
        // Everything derived from idle is unavailable with it (never computed from a zero idle)
        const desktopWorkSec = idleAvailable ? productiveSec + (reconciledIdleSec as number) : null;
        const totalEngagementSec = desktopWorkSec !== null ? desktopWorkSec + portalActiveSec : null;

        const unaccountedSec = idleAvailable
          ? Math.max(0, spannedDuration - (productiveSec + (reconciledIdleSec as number) + portalActiveSec + reconciledBreakSec))
          : null;

        const activityPct = desktopWorkSec === null ? null : desktopWorkSec > 0 ? Math.min(100.0, (productiveSec / desktopWorkSec) * 100.0) : 0.0;
        const fmtOrNull = (sec: number | null) => (sec === null ? null : formatDurationSec(sec));

        const fullName = u.name || u.username;
        const empCode = `GS-26-${String(u.id).padStart(3, '0')}`;
        const deptName = u.department?.name || 'General';

        // Same rule as the live dashboard: desktop sessions decide; a browser session counts only on
        // portal-only days, so an open portal tab cannot make a disconnected tracker look live.
        const status = dateIso === todayStr ? this.resolveLiveStatus(daySessions, now).status : 'Offline';

        reportRows.push({
          employee_name: fullName,
          employee_code: empCode,
          department: deptName,
          date: dateIso,
          productive_time: formatDurationSec(productiveSec),
          // null (not "00:00:00") when idle is unavailable; see idle_basis / idle_available
          idle_time: fmtOrNull(reconciledIdleSec),
          desktop_work_time: fmtOrNull(desktopWorkSec),
          portal_active_time: formatDurationSec(portalActiveSec),
          break_time: formatDurationSec(reconciledBreakSec),
          unaccounted_time: fmtOrNull(unaccountedSec),
          total_engagement_time: fmtOrNull(totalEngagementSec),
          workday_span: formatDurationSec(spannedDuration),
          activity_percentage: activityPct === null ? null : Number(activityPct.toFixed(2)),
          status,
          /** 'legacy' (stored counters), 'mixed' (deployment day: idle unavailable) or 'threshold' (idle events) */
          idle_basis: rowBasis.basis,
          /** False when idle_time (and the values derived from it) is unavailable; a real zero idle is "00:00:00" */
          idle_available: idleAvailable,
          /**
           * Why idle is unavailable: 'mixed_calculation' (the effective date), 'spans_effective_date' (a session of this
           * login day ran across the effective-date boundary), 'events_unavailable' or 'events_truncated'; null otherwise
           */
          idle_unavailable_reason: idleNote,

          user_id: u.id,
          username: u.username,
          full_name: fullName,
          email: u.email,
          first_login: firstLogin ? new Date(firstLogin).toISOString() : null,
          last_active: lastActive ? new Date(lastActive).toISOString() : null,
          total_tracked_time: fmtOrNull(desktopWorkSec),
          break_count: breakAnalysis.breakCount,

          raw_tracked_seconds: desktopWorkSec,
          raw_productive_seconds: productiveSec,
          raw_idle_seconds: reconciledIdleSec,
          raw_desktop_work_seconds: desktopWorkSec,
          raw_portal_active_seconds: portalActiveSec,
          raw_break_seconds: reconciledBreakSec,
          raw_unaccounted_seconds: unaccountedSec,
          raw_total_engagement_seconds: totalEngagementSec,
          raw_workday_span: spannedDuration,
        });
      }
    }

    return reportRows;
  }

  async getWeeklyReport(params: any) {
    const rows = await this.getDailyReport(params);

    const formatDurationSec = (sec: number) => {
      const s = Math.max(0, Math.floor(sec));
      const h = String(Math.floor(s / 3600)).padStart(2, '0');
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const sc = String(s % 60).padStart(2, '0');
      return `${h}:${m}:${sc}`;
    };

    if (!rows || rows.length === 0) {
      return {
        total_weekly_hours: '00:00:00',
        average_activity_percentage: 0.0,
        most_productive_day: '-',
        total_idle_time: '00:00:00',
        attendance_days: 0,
        app_usage_summary: [],
        daily_productivity_trend: [],
        weekly_work_hours: [],
      };
    }

    // Idle and tracked totals are unavailable (null) when a day's idle is unavailable (mixed day), never summed as zero;
    // the sum of the available days and the unavailable dates are returned alongside
    const tracked = sumNullable(rows, 'raw_tracked_seconds');
    const idle = sumNullable(rows, 'raw_idle_seconds');
    const activity = this.knownActivity(rows);
    const avgActivity = activity.percentage;
    const attendanceDays = new Set(rows.map((r: any) => `${r.user_id}_${r.date}`)).size;

    const dayProductivity: Record<string, number> = {};
    for (const r of rows) {
      dayProductivity[r.date] = (dayProductivity[r.date] || 0) + r.raw_productive_seconds;
    }

    let mostProductiveDay = '-';
    const dates = Object.keys(dayProductivity);
    if (dates.length > 0) {
      const topDate = dates.reduce((a, b) => (dayProductivity[a] > dayProductivity[b] ? a : b));
      // Calendar date label without any server-time-zone conversion
      const p = calendarDateParts(topDate);
      mostProductiveDay = `${DAY_LONG[p.weekday]} (${MONTH_SHORT[p.month]} ${String(p.day).padStart(2, '0')})`;
    }

    const userIds = Array.from(new Set(rows.map((r: any) => r.user_id)));
    const activities = await this.prisma.appActivity.findMany({
      where: { user_id: { in: userIds } },
      orderBy: { timestamp: 'desc' },
      take: 200,
    });

    const appGroup: Record<string, { duration: number; productive: number }> = {};
    for (const act of activities) {
      if (!appGroup[act.app_name]) appGroup[act.app_name] = { duration: 0, productive: 0 };
      appGroup[act.app_name].duration += act.duration_seconds || 0;
      appGroup[act.app_name].productive += act.productive_seconds || 0;
    }

    const appUsageSummary = Object.keys(appGroup)
      .map((name) => {
        const cat = this.classifyAppActivity(name, '');
        return {
          app_name: name,
          duration_seconds: appGroup[name].duration,
          duration_formatted: formatDurationSec(appGroup[name].duration),
          is_productive: cat === 'productive',
          category: cat.replace('_', ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
        };
      })
      .sort((a, b) => b.duration_seconds - a.duration_seconds)
      .slice(0, 10);

    const dailyProductivityTrend: any[] = [];
    const dateMap: Record<string, any[]> = {};
    for (const r of rows) (dateMap[r.date] ||= []).push(r);

    for (const dStr of Object.keys(dateMap).sort()) {
      const p = calendarDateParts(dStr);
      const dayIdle = sumNullable(dateMap[dStr], 'raw_idle_seconds');
      dailyProductivityTrend.push({
        date: `${DAY_SHORT[p.weekday]}, ${MONTH_SHORT[p.month]} ${String(p.day).padStart(2, '0')}`,
        productive_hours: Number((dateMap[dStr].reduce((a, r) => a + r.raw_productive_seconds, 0) / 3600.0).toFixed(2)),
        // null on a mixed day (unavailable, not zero)
        idle_hours: dayIdle.total === null ? null : Number((dayIdle.total / 3600.0).toFixed(2)),
        // 'mixed' when any row of the date is mixed (a legacy date can hold a session spanning the effective date)
        idle_basis: dateMap[dStr].some((r) => r.idle_basis === 'mixed') ? 'mixed' : dateMap[dStr][0]?.idle_basis ?? 'legacy',
      });
    }

    const userRowsMap: Record<string, any[]> = {};
    for (const r of rows) (userRowsMap[r.full_name] ||= []).push(r);

    const weeklyWorkHours = Object.keys(userRowsMap).map((name) => {
      const t = sumNullable(userRowsMap[name], 'raw_tracked_seconds');
      return {
        employee: name,
        // null when a day of this employee has unavailable (mixed) idle; hours_known_days sums the other days
        hours: t.total === null ? null : Number((t.total / 3600.0).toFixed(2)),
        hours_known_days: Number((t.known / 3600.0).toFixed(2)),
      };
    });

    return {
      total_weekly_hours: tracked.total === null ? null : formatDurationSec(tracked.total),
      average_activity_percentage: Number(Math.min(100.0, avgActivity).toFixed(2)),
      most_productive_day: mostProductiveDay,
      total_idle_time: idle.total === null ? null : formatDurationSec(idle.total),
      attendance_days: attendanceDays,
      app_usage_summary: appUsageSummary,
      daily_productivity_trend: dailyProductivityTrend,
      weekly_work_hours: weeklyWorkHours,
      ...this.idleAggregateFields(rows, { tracked, idle, activity }, formatDurationSec),
    };
  }

  /** Activity % over the report rows whose idle (and so tracked time) is available; unavailable days are excluded. */
  private knownActivity(rows: any[]): { percentage: number; excludedDates: string[] } {
    const known = rows.filter((r) => r.raw_tracked_seconds !== null && r.raw_tracked_seconds !== undefined);
    const trackedSec = known.reduce((a, r) => a + (r.raw_tracked_seconds || 0), 0);
    const productiveSec = known.reduce((a, r) => a + (r.raw_productive_seconds || 0), 0);
    const excludedDates = Array.from(new Set(rows.filter((r) => !known.includes(r)).map((r) => String(r.date)))).sort();
    return { percentage: trackedSec > 0 ? (productiveSec / trackedSec) * 100.0 : 0.0, excludedDates };
  }

  /**
   * Fields every aggregated report adds so a mixed (unavailable) day is never hidden: the bases of the included days,
   * the dates whose idle is unavailable, the sums over the available days, and the configured effective date.
   */
  private idleAggregateFields(
    rows: any[],
    totals: { tracked: NullableTotal; idle: NullableTotal; activity: { excludedDates: string[] } },
    fmt: (sec: number) => string,
  ) {
    return {
      /** 'legacy' | 'mixed' | 'threshold' bases of the days in this report */
      idle_bases: idleBasesOf(rows),
      /** Dates whose idle time is unavailable (mixed calculation); totals that include them are null */
      idle_unavailable_dates: Array.from(new Set([...totals.idle.unavailableDates, ...totals.tracked.unavailableDates])).sort(),
      /** Idle and tracked time of the days whose idle is available */
      total_idle_time_known_days: fmt(totals.idle.known),
      total_tracked_time_known_days: fmt(totals.tracked.known),
      /** Dates left out of the activity percentage (their tracked time is unavailable) */
      activity_excludes_dates: totals.activity.excludedDates,
      idle_effective_date: readIdleEffectiveDate().date,
    };
  }

  async getMonthlyReport(params: any) {
    // Default month: the current month in the reporting time zone
    const [currentYear, currentMonth] = reportingToday(new Date()).date.split('-').map(Number);
    const year = Number(params?.year || currentYear);
    const month = Number(params?.month || currentMonth);

    const startDateStr = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const endDateStr = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const rows = await this.getDailyReport({ ...params, start_date: startDateStr, end_date: endDateStr });

    const formatDurationSec = (sec: number) => {
      const s = Math.max(0, Math.floor(sec));
      const h = String(Math.floor(s / 3600)).padStart(2, '0');
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const sc = String(s % 60).padStart(2, '0');
      return `${h}:${m}:${sc}`;
    };

    if (!rows || rows.length === 0) {
      return {
        total_monthly_work_hours: '00:00:00',
        total_productive_hours: '00:00:00',
        total_idle_hours: '00:00:00',
        attendance_summary: {
          total_sessions: 0,
          avg_sessions_per_day: 0.0,
          unique_days_worked: 0,
          active_employees_count: 0,
        },
        employee_ranking: [],
        productivity_trends: [],
      };
    }

    // Unavailable (mixed-day) idle makes the idle and tracked totals null, never zero
    const tracked = sumNullable(rows, 'raw_tracked_seconds');
    const totalProductiveSec = rows.reduce((acc: number, r: any) => acc + (r.raw_productive_seconds || 0), 0);
    const idle = sumNullable(rows, 'raw_idle_seconds');

    const uniqueDays = new Set(rows.map((r: any) => r.date)).size;
    const uniqueEmployees = new Set(rows.map((r: any) => r.user_id)).size;

    const empRows: Record<number, any[]> = {};
    for (const r of rows) (empRows[r.user_id] ||= []).push(r);

    const employeeRanking = Object.values(empRows)
      .map((list: any[]) => {
        const first = list[0];
        const productiveSec = list.reduce((a, r) => a + r.raw_productive_seconds, 0);
        const empTracked = sumNullable(list, 'raw_tracked_seconds');
        const empActivity = this.knownActivity(list);
        return {
          user_id: first.user_id,
          full_name: first.full_name,
          employee_code: first.employee_code,
          department: first.department,
          productive_hours: Number((productiveSec / 3600.0).toFixed(2)),
          // null when one of the employee's days has unavailable (mixed) idle; known-days hours alongside
          tracked_hours: empTracked.total === null ? null : Number((empTracked.total / 3600.0).toFixed(2)),
          tracked_hours_known_days: Number((empTracked.known / 3600.0).toFixed(2)),
          // over the employee's days with available idle only
          activity_percentage: Number(Math.min(100.0, empActivity.percentage).toFixed(2)),
          activity_excludes_dates: empActivity.excludedDates,
        };
      })
      .sort((a: any, b: any) => b.productive_hours - a.productive_hours);

    const dateRows: Record<string, any[]> = {};
    for (const r of rows) (dateRows[r.date] ||= []).push(r);
    const productivityTrends = Object.keys(dateRows).map((d) => {
      const p = calendarDateParts(d);
      const list = dateRows[d];
      return {
        date: `${MONTH_SHORT[p.month]} ${String(p.day).padStart(2, '0')}`,
        productive_hours: list.reduce((a, r) => a + Number((r.raw_productive_seconds / 3600.0).toFixed(2)), 0),
        // null on a mixed day (unavailable, not zero)
        idle_hours: list.some((r) => r.raw_idle_seconds === null || r.raw_idle_seconds === undefined)
          ? null
          : list.reduce((a, r) => a + Number((r.raw_idle_seconds / 3600.0).toFixed(2)), 0),
        idle_basis: list.some((r) => r.idle_basis === 'mixed') ? 'mixed' : list[0]?.idle_basis ?? 'legacy',
      };
    });

    return {
      total_monthly_work_hours: tracked.total === null ? null : formatDurationSec(tracked.total),
      total_productive_hours: formatDurationSec(totalProductiveSec),
      total_idle_hours: idle.total === null ? null : formatDurationSec(idle.total),
      ...this.idleAggregateFields(rows, { tracked, idle, activity: this.knownActivity(rows) }, formatDurationSec),
      attendance_summary: {
        total_sessions: rows.length,
        avg_sessions_per_day: Number((rows.length / Math.max(1, uniqueDays)).toFixed(1)),
        unique_days_worked: uniqueDays,
        active_employees_count: uniqueEmployees,
      },
      employee_ranking: employeeRanking,
      productivity_trends: productivityTrends,
    };
  }

  async getEmployeeAnalytics(params: any) {
    const userId = Number(params?.user_id);
    if (!userId) throw new BadRequestException('user_id query parameter is required.');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { department: true },
    });
    if (!user) throw new NotFoundException('User not found');

    // Asia/Kolkata calendar days: end defaults to today, start to six days before the end (seven days in total)
    const todayStr = reportingToday(new Date()).date;
    const endDateStr = reportDateParam(params?.end_date, 'end_date') ?? todayStr;
    const startDateStr = reportDateParam(params?.start_date, 'start_date') ?? addDays(endDateStr, -6);
    const { start: startDateObj, end: endExclusive } = zonedRange(startDateStr, endDateStr, REPORTING_TIME_ZONE);

    const rows = await this.getDailyReport({ user_id: userId, start_date: startDateStr, end_date: endDateStr });
    const userRows = rows.filter((r: any) => r.user_id === userId);

    const activities = await this.prisma.appActivity.findMany({
      where: {
        user_id: userId,
        timestamp: { gte: startDateObj, lt: endExclusive },
      },
      orderBy: { timestamp: 'desc' },
    });

    const sessions = await this.prisma.workSession.findMany({
      where: {
        user_id: userId,
        login_time: { gte: startDateObj, lt: endExclusive },
      },
      orderBy: { login_time: 'asc' },
    });

    const formatDurationSec = (sec: number) => {
      const s = Math.max(0, Math.floor(sec));
      const h = String(Math.floor(s / 3600)).padStart(2, '0');
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const sc = String(s % 60).padStart(2, '0');
      return `${h}:${m}:${sc}`;
    };

    const appStats: Record<string, any> = {};
    let totalAppSec = 0;
    for (const act of activities) {
      const cat = this.classifyAppActivity(act.app_name, act.window_title || '');
      if (!appStats[act.app_name]) {
        appStats[act.app_name] = {
          app_name: act.app_name,
          duration_seconds: 0,
          productive_seconds: 0,
          mouse_moves: 0,
          key_presses: 0,
          category: cat,
          is_productive: cat === 'productive',
        };
      }
      appStats[act.app_name].duration_seconds += act.duration_seconds || 0;
      appStats[act.app_name].productive_seconds += act.productive_seconds || 0;
      appStats[act.app_name].mouse_moves += act.mouse_moves || 0;
      appStats[act.app_name].key_presses += act.key_presses || 0;
      totalAppSec += act.duration_seconds || 0;
    }

    const formattedApps = Object.values(appStats)
      .map((st: any) => ({
        app_name: st.app_name,
        total_time: formatDurationSec(st.duration_seconds),
        productive_time: formatDurationSec(st.productive_seconds),
        mouse_moves: st.mouse_moves,
        key_presses: st.key_presses,
        category: st.category.replace('_', ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
        is_productive: st.is_productive,
        percentage_of_total: Number((totalAppSec > 0 ? (st.duration_seconds / totalAppSec) * 100 : 0).toFixed(2)),
      }))
      .sort((a, b) => b.percentage_of_total - a.percentage_of_total);

    const breakAnalysis = this.detectBreaksAndGaps(sessions, activities);
    const formattedBreaks = breakAnalysis.breaksList.map((b: any) => ({
      start: b.start.toISOString(),
      end: b.end.toISOString(),
      duration: formatDurationSec(b.duration),
      type: b.type,
      description: b.description,
      estimated: Boolean(b.estimated),
    }));

    const totalProd = userRows.reduce((acc: number, r: any) => acc + r.raw_productive_seconds, 0);
    // Idle-derived totals are null when a day's idle is unavailable (mixed day), never summed as zero
    const idle = sumNullable(userRows, 'raw_idle_seconds');
    const tracked = sumNullable(userRows, 'raw_tracked_seconds');
    const unaccounted = sumNullable(userRows, 'raw_unaccounted_seconds');
    const engagement = sumNullable(userRows, 'raw_total_engagement_seconds');
    const totalPortal = userRows.reduce((acc: number, r: any) => acc + r.raw_portal_active_seconds, 0);
    const totalBreak = userRows.reduce((acc: number, r: any) => acc + r.raw_break_seconds, 0);
    const totalBreakCount = userRows.reduce((acc: number, r: any) => acc + r.break_count, 0);

    const activity = this.knownActivity(userRows);
    const avgActPct = activity.percentage;
    const fmtTotal = (t: NullableTotal) => (t.total === null ? null : formatDurationSec(t.total));
    const fullName = user.name || user.username;
    const empCode = `GS-26-${String(user.id).padStart(3, '0')}`;

    return {
      employee: {
        id: user.id,
        username: user.username,
        full_name: fullName,
        email: user.email,
        employee_code: empCode,
        department: user.department?.name || 'General',
      },
      totals: {
        total_tracked_time: fmtTotal(tracked),
        productive_time: formatDurationSec(totalProd),
        idle_time: fmtTotal(idle),
        desktop_work_time: fmtTotal(tracked),
        portal_active_time: formatDurationSec(totalPortal),
        break_time: formatDurationSec(totalBreak),
        unaccounted_time: fmtTotal(unaccounted),
        total_engagement_time: fmtTotal(engagement),
        // over the days with available idle (see activity_excludes_dates)
        activity_percentage: Number(Math.min(100.0, avgActPct).toFixed(2)),
        break_count: totalBreakCount,
        total_break_time: formatDurationSec(totalBreak),
        ...this.idleAggregateFields(userRows, { tracked, idle, activity }, formatDurationSec),
      },
      daily_breakdown: userRows,
      app_usage: formattedApps,
      breaks: formattedBreaks,
    };
  }

  async exportReport(res: any, query: any) {
    const exportFormat = String(query?.format || 'csv').toLowerCase();
    const reportType = String(query?.type || 'daily').toLowerCase();

    let data: any[] = [];
    // Default dates: today in the reporting time zone (the same day getDailyReport uses when no date is given)
    const reportToday = reportingToday(new Date());
    let filename = `report_${reportToday.date}`;

    if (reportType === 'daily') {
      data = await this.getDailyReport(query);
      filename = `daily_report_${query?.start_date || query?.date || reportToday.date}`;
    } else if (reportType === 'weekly') {
      const weekly = await this.getWeeklyReport(query);
      data = (weekly.daily_productivity_trend || []).map((trend: any) => ({
        Date: trend.date,
        'Productive Hours': trend.productive_hours,
        'Idle Hours': trend.idle_hours,
        // unavailable (null) on a mixed day, never productive + 0
        'Total Tracked': trend.idle_hours === null ? null : Number((trend.productive_hours + trend.idle_hours).toFixed(2)),
      }));
      filename = `weekly_report_${query?.start_date || 'week'}`;
    } else if (reportType === 'monthly') {
      const monthly = await this.getMonthlyReport(query);
      // The export keeps its original columns (the ranking's known-days helper fields are not exported)
      data = (monthly.employee_ranking || []).map((r: any) => ({
        user_id: r.user_id,
        full_name: r.full_name,
        employee_code: r.employee_code,
        department: r.department,
        productive_hours: r.productive_hours,
        tracked_hours: r.tracked_hours,
        activity_percentage: r.activity_percentage,
      }));
      filename = `monthly_ranking_${query?.year || Number(reportToday.date.slice(0, 4))}_${query?.month || Number(reportToday.date.slice(5, 7))}`;
    } else if (reportType === 'employee') {
      const employee = await this.getEmployeeAnalytics(query);
      data = employee.daily_breakdown || [];
      filename = `employee_report_${employee.employee?.username || 'analytics'}`;
    }

    // An unavailable (mixed-day) idle value or a value derived from it is exported as the explicit label, never as
    // '-', blank or zero; every other value is exported exactly as the report returns it
    data = data.map((row: any) => {
      const out: any = {};
      for (const [k, v] of Object.entries(row)) out[k] = exportValue(v, IDLE_DERIVED_EXPORT_KEYS.has(k));
      return out;
    });

    if (exportFormat === 'csv') {
      const headers = [
        'Employee Name', 'Employee Code', 'Department', 'Date',
        'Productive Time', 'Idle Time', 'Desktop Work Time', 'Portal Active Time',
        'Break Time', 'Unaccounted Time', 'Total Engagement Time', 'Workday Span',
        'Activity Percentage', 'Status'
      ];
      const keys = [
        'employee_name', 'employee_code', 'department', 'date',
        'productive_time', 'idle_time', 'desktop_work_time', 'portal_active_time',
        'break_time', 'unaccounted_time', 'total_engagement_time', 'workday_span',
        'activity_percentage', 'status'
      ];

      let csvStr = '';
      if (data.length > 0 && (reportType === 'daily' || reportType === 'employee')) {
        csvStr += headers.join(',') + '\n';
        for (const row of data) {
          const line = keys.map((k) => `"${row[k] !== undefined ? row[k] : '-'}"`).join(',');
          csvStr += line + '\n';
        }
      } else if (data.length > 0) {
        const rowKeys = Object.keys(data[0]);
        csvStr += rowKeys.join(',') + '\n';
        for (const row of data) {
          const line = rowKeys.map((k) => `"${row[k] !== undefined ? row[k] : '-'}"`).join(',');
          csvStr += line + '\n';
        }
      } else {
        csvStr = headers.join(',') + '\n';
      }

      res.set({
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}.csv"`,
      });
      // UTF-8 byte order mark (EF BB BF): spreadsheet programs then decode names and labels such as
      // "Mixed calculation – unavailable" as UTF-8 instead of the system code page. Headers, columns and values unchanged.
      return res.send(CSV_UTF8_BOM + csvStr);
    } else if (exportFormat === 'excel') {
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const sheetName = reportType.charAt(0).toUpperCase() + reportType.slice(1);
      const ws = wb.addWorksheet(sheetName);

      let headers: string[] = [];
      let keys: string[] = [];

      if (reportType === 'daily' || reportType === 'reconciliation' || reportType === 'employee') {
        headers = [
          'Employee Name', 'Employee Code', 'Department', 'Date',
          'Productive Time', 'Idle Time', 'Desktop Work Time', 'Portal Active Time',
          'Break Time', 'Unaccounted Time', 'Total Engagement Time', 'Workday Span',
          'Activity Percentage', 'Status'
        ];
        keys = [
          'employee_name', 'employee_code', 'department', 'date',
          'productive_time', 'idle_time', 'desktop_work_time', 'portal_active_time',
          'break_time', 'unaccounted_time', 'total_engagement_time', 'workday_span',
          'activity_percentage', 'status'
        ];
      } else if (data.length > 0) {
        keys = Object.keys(data[0]).filter((k) => !k.startsWith('raw_'));
        headers = keys.map((k) => k.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()));
      }

      if (headers.length > 0) {
        const headerRow = ws.addRow(headers);
        headerRow.height = 24;
        headerRow.eachCell((cell: any) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
          cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        });

        for (const item of data) {
          const rowData = keys.map((k) => (item[k] !== undefined && item[k] !== null ? item[k] : '-'));
          const dataRow = ws.addRow(rowData);
          dataRow.height = 20;
        }

        ws.columns.forEach((column: any) => {
          let maxLen = 12;
          column.eachCell({ includeEmpty: true }, (cell: any) => {
            const valStr = cell.value !== undefined && cell.value !== null ? String(cell.value) : '';
            if (valStr.length > maxLen) {
              maxLen = valStr.length;
            }
          });
          column.width = Math.max(maxLen + 3, 12);
        });
      }

      const excelBuffer = await wb.xlsx.writeBuffer();
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}.xlsx"`,
      });
      return res.send(Buffer.from(excelBuffer));
    } else if (exportFormat === 'pdf') {
      return new Promise<void>((resolve, reject) => {
        try {
          const PDFDocumentRaw = require('pdfkit');
          const PDFDocument = PDFDocumentRaw.default || PDFDocumentRaw;
          const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
          const chunks: Buffer[] = [];

          const possibleFontsDirs = [
            path.join(process.cwd(), 'scripts', 'fonts'),
            path.join(__dirname, '..', '..', '..', 'scripts', 'fonts'),
            path.join(__dirname, '..', '..', 'scripts', 'fonts'),
            path.join(__dirname, '..', 'scripts', 'fonts'),
          ];
          let fontsDir = possibleFontsDirs[0];
          for (const d of possibleFontsDirs) {
            if (fs.existsSync(d)) {
              fontsDir = d;
              break;
            }
          }

          const regFontPath = path.join(fontsDir, 'Poppins-Regular.ttf');
          const medFontPath = path.join(fontsDir, 'Poppins-Medium.ttf');
          const boldFontPath = path.join(fontsDir, 'Poppins-Bold.ttf');

          const hasReg = fs.existsSync(regFontPath);
          const hasMed = fs.existsSync(medFontPath);
          const hasBold = fs.existsSync(boldFontPath);

          if (hasReg) doc.registerFont('Poppins', regFontPath);
          if (hasMed) doc.registerFont('Poppins-Medium', medFontPath);
          if (hasBold) doc.registerFont('Poppins-Bold', boldFontPath);

          const fonts = {
            regular: hasReg ? 'Poppins' : 'Helvetica',
            medium: hasMed ? 'Poppins-Medium' : 'Helvetica-Bold',
            bold: hasBold ? 'Poppins-Bold' : 'Helvetica-Bold',
          };

          doc.on('data', (chunk: Buffer) => chunks.push(chunk));
          doc.on('end', () => {
            const pdfBuffer = Buffer.concat(chunks);
            res.set({
              'Content-Type': 'application/pdf',
              'Content-Disposition': `attachment; filename="${filename}.pdf"`,
            });
            res.send(pdfBuffer);
            resolve();
          });
          doc.on('error', (err: any) => reject(err));

          const startDateStr = String(query?.start_date || query?.date || reportToday.date);
          const endDateStr = String(query?.end_date || query?.date || startDateStr);

          this.generateReportPdf(doc, reportType, startDateStr, endDateStr, data, fonts);
          doc.end();
        } catch (err) {
          console.error('PDFKit exportReport error:', err);
          reject(err);
        }
      });
    }

    throw new BadRequestException('Invalid format requested.');
  }

  private generateReportPdf(doc: any, reportType: string, startDateStr: string, endDateStr: string, data: any[], fonts?: { regular: string; medium: string; bold: string }): void {
    const fontBold = fonts?.bold || 'Poppins-Bold';
    const fontRegular = fonts?.regular || 'Poppins';

    const marginX = 30;
    const marginY = 30;
    const printableWidth = 841.89 - marginX * 2; // 781.89
    const maxY = 595.28 - marginY; // 565.28
    // Set when a cell holds a mixed-day (unavailable) value: a legend is printed under the table
    let hasUnavailable = false;

    const titleReportName = reportType.charAt(0).toUpperCase() + reportType.slice(1);
    doc.fillColor('#1E293B')
       .font(fontBold)
       .fontSize(15)
       .text(`Grehasoft Work Tracking - ${titleReportName} Report (${startDateStr} to ${endDateStr})`, marginX, marginY);

    let currentY = marginY + 28;

    if (!data || data.length === 0) {
      doc.fillColor('#334155')
         .font(fontRegular)
         .fontSize(10)
         .text('No tracking data recorded for this period.', marginX, currentY);
      return;
    }

    interface ColumnDef {
      key: string;
      label: string;
      width: number;
      align: 'left' | 'center' | 'right';
    }

    let columns: ColumnDef[] = [];
    const isLargeReport = reportType === 'daily' || reportType === 'reconciliation' || reportType === 'employee';

    if (isLargeReport) {
      columns = [
        { key: 'employee_name', label: 'Employee\nName', width: 95, align: 'left' },
        { key: 'employee_code', label: 'Employee\nCode', width: 50, align: 'left' },
        { key: 'department', label: 'Department', width: 80, align: 'left' },
        { key: 'date', label: 'Date', width: 55, align: 'center' },
        { key: 'productive_time', label: 'Productive\nTime', width: 50, align: 'center' },
        { key: 'idle_time', label: 'Idle\nTime', width: 47, align: 'center' },
        { key: 'desktop_work_time', label: 'Desktop\nWork', width: 47, align: 'center' },
        { key: 'portal_active_time', label: 'Portal\nActive', width: 47, align: 'center' },
        { key: 'break_time', label: 'Break\nTime', width: 47, align: 'center' },
        { key: 'unaccounted_time', label: 'Unaccounted\nTime', width: 56, align: 'center' },
        { key: 'total_engagement_time', label: 'Total\nEngagement', width: 55, align: 'center' },
        { key: 'workday_span', label: 'Workday\nSpan', width: 50, align: 'center' },
        { key: 'activity_percentage', label: 'Activity\n%', width: 44, align: 'center' },
        { key: 'status', label: 'Status', width: 58, align: 'center' },
      ];
    } else if (reportType === 'weekly') {
      columns = [
        { key: 'Date', label: 'Date', width: 180, align: 'left' },
        { key: 'Productive Hours', label: 'Productive Hours', width: 200, align: 'center' },
        { key: 'Idle Hours', label: 'Idle Hours', width: 200, align: 'center' },
        { key: 'Total Tracked', label: 'Total Tracked', width: 201, align: 'center' },
      ];
    } else if (reportType === 'monthly') {
      columns = [
        { key: 'full_name', label: 'Full Name', width: 160, align: 'left' },
        { key: 'employee_code', label: 'Employee Code', width: 100, align: 'left' },
        { key: 'department', label: 'Department', width: 140, align: 'left' },
        { key: 'productive_hours', label: 'Productive Hours', width: 120, align: 'center' },
        { key: 'tracked_hours', label: 'Tracked Hours', width: 120, align: 'center' },
        { key: 'activity_percentage', label: 'Activity %', width: 141, align: 'center' },
      ];
    }

    const headerFontSize = isLargeReport ? 7 : 10;
    const cellFontSize = isLargeReport ? 6.5 : 8.5;
    const headerHeight = isLargeReport ? 24 : 22;
    const rowHeight = isLargeReport ? 18 : 20;

    const drawHeader = (y: number) => {
      doc.rect(marginX, y, printableWidth, headerHeight)
         .fill('#4F46E5');

      let curX = marginX;
      for (const col of columns) {
        doc.rect(curX, y, col.width, headerHeight)
           .lineWidth(0.5)
           .stroke('#E2E8F0');

        doc.fillColor('#FFFFFF')
           .font(fontBold)
           .fontSize(headerFontSize);

        const lines = col.label.split('\n');
        if (lines.length === 1) {
          doc.text(col.label, curX + 2, y + (headerHeight - headerFontSize) / 2 - 1, {
            width: col.width - 4,
            align: 'center',
            lineBreak: false,
          });
        } else {
          const totalTextHeight = lines.length * (headerFontSize + 1);
          let startTextY = y + (headerHeight - totalTextHeight) / 2;
          for (const line of lines) {
            doc.text(line, curX + 2, startTextY, {
              width: col.width - 4,
              align: 'center',
              lineBreak: false,
            });
            startTextY += headerFontSize + 1;
          }
        }
        curX += col.width;
      }
    };

    drawHeader(currentY);
    currentY += headerHeight;

    for (let rowIndex = 0; rowIndex < data.length; rowIndex++) {
      if (currentY + rowHeight > maxY) {
        doc.addPage();
        currentY = marginY;
        drawHeader(currentY);
        currentY += headerHeight;
      }

      const row = data[rowIndex];
      const bgColor = rowIndex % 2 === 0 ? '#FFFFFF' : '#F1F5F9';

      doc.rect(marginX, currentY, printableWidth, rowHeight)
         .fill(bgColor);

      let curX = marginX;
      for (const col of columns) {
        doc.rect(curX, currentY, col.width, rowHeight)
           .lineWidth(0.5)
           .stroke('#E2E8F0');

        let val = row[col.key];
        if (val === IDLE_UNAVAILABLE_LABEL) {
          // Narrow cell: short marker; the full "Mixed calculation – unavailable" legend is printed under the table
          val = PDF_UNAVAILABLE_MARK;
          hasUnavailable = true;
        } else if (val === undefined || val === null || val === '') {
          val = '-';
        } else {
          val = String(val);
        }

        if (col.key === 'status') {
          if (val === 'Active') doc.fillColor('#16A34A');
          else if (val === 'Idle') doc.fillColor('#D97706');
          else doc.fillColor('#64748B');
        } else {
          doc.fillColor('#1E293B');
        }

        doc.font(fontRegular)
           .fontSize(cellFontSize);

        const textY = currentY + (rowHeight - cellFontSize) / 2 - 1;
        const paddingLeftRight = 3;

        doc.text(val, curX + paddingLeftRight, textY, {
          width: col.width - paddingLeftRight * 2,
          align: col.align,
          lineBreak: false,
        });

        curX += col.width;
      }

      currentY += rowHeight;
    }

    if (hasUnavailable) {
      if (currentY + 30 > maxY) {
        doc.addPage();
        currentY = marginY;
      }
      doc.fillColor('#475569').font(fontRegular).fontSize(8)
         .text(`${PDF_UNAVAILABLE_MARK}: ${IDLE_UNAVAILABLE_LABEL}. Idle time on the threshold-idle deployment day cannot be separated from the earlier calculation, so idle time and the values derived from it are not shown for that day.`,
           marginX, currentY + 8, { width: printableWidth });
    }
  }

  // -------------------------------------------------------------
  // 6. PROFILES CRUD
  // -------------------------------------------------------------
  async getProfiles() {
    return this.prisma.trackingUserProfile.findMany({
      include: { user: { select: { id: true, name: true, username: true } } },
    });
  }

  async getProfileById(id: number) {
    const profile = await this.prisma.trackingUserProfile.findUnique({
      where: { id },
      include: { user: { select: { id: true, name: true, username: true } } },
    });
    if (!profile) throw new NotFoundException('Tracking profile not found');
    return profile;
  }
}
