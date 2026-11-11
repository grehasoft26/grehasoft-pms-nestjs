import { isCalendarDate } from './tracking-timeline';

/**
 * Report idle time across the change from the old idle rule to the threshold rule (P1-c, option B).
 *
 * The heartbeat counters `work_session.idle_seconds` used to count every ~10 s tick without keyboard/mouse input as idle;
 * from the deployment of the threshold rule a tick is idle only when the tracker reports is_idle. Stored counters are
 * never rewritten, and a counter cannot be split at the moment of deployment, so reports label every day:
 *
 * - 'legacy'    (before the effective date): the stored counters, exactly as before;
 * - 'mixed'     (the effective date itself, and any earlier login day with a session that ran across 00:00 Asia/Kolkata
 *               of the effective date or is still open): such sessions may hold both kinds of seconds, which cannot be
 *               separated; idle (and everything derived from it) is UNAVAILABLE (null), never estimated;
 * - 'threshold' (after the effective date): idle from idle_start/idle_end events via buildTrackingTimeline.
 *
 * The effective date is the Asia/Kolkata calendar date of the production deployment, configured with
 * TRACKING_THRESHOLD_IDLE_EFFECTIVE_DATE=YYYY-MM-DD (see docs/TRACKING_IDLE_EFFECTIVE_DATE.md). Unset = every day is
 * 'legacy', i.e. the report calculation is unchanged.
 */
export const IDLE_EFFECTIVE_DATE_ENV = 'TRACKING_THRESHOLD_IDLE_EFFECTIVE_DATE';

/** Shown instead of a value that cannot be calculated on the mixed (deployment) day. */
export const IDLE_UNAVAILABLE_LABEL = 'Mixed calculation – unavailable';

export type ReportIdleBasis = 'legacy' | 'mixed' | 'threshold';

export interface IdleEffectiveDateConfig {
  /** YYYY-MM-DD (Asia/Kolkata calendar date), or null when unset or invalid */
  date: string | null;
  /** Why a configured value was rejected (the reports then behave as if it were unset) */
  error: string | null;
}

/**
 * Reads the effective date. Strict: exactly YYYY-MM-DD and a real calendar date; anything else is rejected (and
 * reported), never guessed, and the reports keep the legacy calculation.
 */
export const readIdleEffectiveDate = (env: Record<string, string | undefined> = process.env): IdleEffectiveDateConfig => {
  const raw = env[IDLE_EFFECTIVE_DATE_ENV];
  if (raw === undefined || raw.trim() === '') return { date: null, error: null };
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !isCalendarDate(value)) {
    return { date: null, error: `${IDLE_EFFECTIVE_DATE_ENV} must be a calendar date in YYYY-MM-DD format (Asia/Kolkata); got "${raw}"` };
  }
  return { date: value, error: null };
};

/** The idle basis of a report day (YYYY-MM-DD, Asia/Kolkata). */
export const reportIdleBasis = (date: string, effectiveDate: string | null): ReportIdleBasis => {
  if (!effectiveDate || date < effectiveDate) return 'legacy';
  return date === effectiveDate ? 'mixed' : 'threshold';
};

/**
 * True when a session's stored counters may hold seconds of both rules: it started before the effective-date
 * boundary (00:00 Asia/Kolkata on the effective date) and ended at or after it, or is still open.
 *
 * Conservative on purpose: the effective date is a date, not the deployment instant, so a session that ended on the
 * effective date before the deployment is treated as spanning it too. Its end is logout_time, else its last heartbeat
 * (last_ping); a session without either is treated as spanning (its end is unknown).
 */
export const sessionSpansBoundary = (
  session: { login_time: Date | string; logout_time?: Date | string | null; last_ping?: Date | string | null; is_active_session?: boolean | null },
  boundaryMs: number,
): boolean => {
  const start = new Date(session.login_time).getTime();
  if (!(start < boundaryMs)) return false;
  if (session.is_active_session) return true;
  const endValue = session.logout_time ?? session.last_ping ?? null;
  if (endValue === null || endValue === undefined) return true;
  const end = new Date(endValue).getTime();
  return !Number.isFinite(end) || end >= boundaryMs;
};

/** The basis of a report day for one set of an employee's sessions: a legacy day with a spanning session is mixed. */
export const rowIdleBasis = (
  dayBasis: ReportIdleBasis,
  desktopSessions: Parameters<typeof sessionSpansBoundary>[0][],
  boundaryMs: number | null,
): { basis: ReportIdleBasis; spansBoundary: boolean } => {
  if (dayBasis !== 'legacy' || boundaryMs === null) return { basis: dayBasis, spansBoundary: false };
  const spans = desktopSessions.some((s) => sessionSpansBoundary(s, boundaryMs));
  return spans ? { basis: 'mixed', spansBoundary: true } : { basis: 'legacy', spansBoundary: false };
};

/** UTF-8 byte order mark prefixed to CSV exports, so spreadsheet programs (Excel) decode non-ASCII text as UTF-8. */
export const CSV_UTF8_BOM = '﻿';

export interface NullableTotal {
  /** Sum over all rows, or null when any row's value is unavailable (never counted as zero) */
  total: number | null;
  /** Sum over the rows whose value is available */
  known: number;
  /** Report dates (YYYY-MM-DD) whose value is unavailable, sorted, without duplicates */
  unavailableDates: string[];
}

/** Sums `key` over report rows; a null value makes the total null (unavailable) instead of adding zero. */
export const sumNullable = (rows: any[], key: string): NullableTotal => {
  let known = 0;
  const unavailable = new Set<string>();
  for (const r of rows) {
    const v = r?.[key];
    if (v === null || v === undefined) unavailable.add(String(r?.date ?? ''));
    else known += Number(v) || 0;
  }
  const unavailableDates = Array.from(unavailable).sort();
  return { total: unavailableDates.length ? null : known, known, unavailableDates };
};

/** The distinct idle bases of report rows, in calendar order (legacy, mixed, threshold). */
export const idleBasesOf = (rows: any[]): ReportIdleBasis[] =>
  (['legacy', 'mixed', 'threshold'] as ReportIdleBasis[]).filter((b) => rows.some((r) => (r?.idle_basis ?? 'legacy') === b));

/** For exports: a null (unavailable) value of an idle-derived field becomes the explicit label, never '-' or 0. */
export const exportValue = (value: unknown, idleDerived: boolean): unknown =>
  (value === null || value === undefined) && idleDerived ? IDLE_UNAVAILABLE_LABEL : value;

/** Report row fields whose value depends on idle time (null on the mixed day). */
export const IDLE_DERIVED_ROW_KEYS = [
  'idle_time', 'desktop_work_time', 'total_tracked_time', 'total_engagement_time', 'unaccounted_time', 'activity_percentage',
  'raw_idle_seconds', 'raw_tracked_seconds', 'raw_desktop_work_seconds', 'raw_total_engagement_seconds', 'raw_unaccounted_seconds',
] as const;
