/**
 * Tracking state-transition events (Phase 2): the event vocabulary, limits and the validation of
 * events a desktop tracker sends to POST /tracking/events. Pure functions, no database access.
 */

/** Event types a desktop tracker may send. The legacy enum values active/idle/offline are not accepted. */
export const CLIENT_EVENT_TYPES = [
  'session_start',
  'session_end',
  'idle_start',
  'idle_end',
  'lock',
  'unlock',
  'sleep',
  'resume',
  'offline_start',
  'offline_end',
  // Stage 4: a manual break (Stop Tracking -> Start Tracking in the desktop tracker)
  'break_start',
  'break_end',
] as const;
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

/** Types that open a period; only these may carry ended_at / duration_seconds (the end of that period). */
export const PERIOD_OPENING_TYPES: ReadonlySet<ClientEventType> = new Set<ClientEventType>([
  'session_start',
  'idle_start',
  'lock',
  'sleep',
  'offline_start',
  'break_start',
]);

export const EVENT_SOURCES = {
  desktopClient: 'desktop_client',
  serverHeartbeat: 'server_heartbeat',
  serverInferred: 'server_inferred',
} as const;

export const MAX_EVENTS_PER_BATCH = 200;
/** Events queued offline may arrive late, but not older than this. */
export const MAX_EVENT_AGE_MS = 30 * 24 * 3600 * 1000;
/** Allowed clock skew for timestamps slightly in the future. */
export const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
export const MAX_DURATION_SECONDS = 31 * 24 * 3600;
export const MAX_METADATA_BYTES = 2048;
export const MAX_DEVICE_ID_LENGTH = 255;
/** client_event_id values with this prefix are reserved for server-generated events. */
export const SERVER_EVENT_ID_PREFIX = 'srv:';
/** ended_at must agree with occurred_at + duration_seconds within this tolerance when both are sent. */
const DURATION_TOLERANCE_SECONDS = 1;

const CLIENT_EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/;
const REASON_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** ISO-8601 date-time with an explicit zone (Z or ±hh:mm). .NET "o" sends 7 fractional digits. */
const ISO_WITH_ZONE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/;

export type EventRejection =
  | 'invalid_event'
  | 'invalid_client_event_id'
  | 'reserved_client_event_id'
  | 'invalid_type'
  | 'invalid_occurred_at'
  | 'occurred_at_in_future'
  | 'occurred_at_too_old'
  | 'device_mismatch'
  | 'invalid_session_id'
  | 'session_not_permitted'
  | 'ended_at_not_allowed'
  | 'invalid_ended_at'
  | 'ended_before_occurred'
  | 'invalid_duration'
  | 'duration_mismatch'
  | 'invalid_reason'
  | 'invalid_metadata'
  | 'metadata_too_large'
  | 'storage_error';

export interface ValidatedEvent {
  client_event_id: string;
  type: ClientEventType;
  occurred_at: Date;
  session_id: number | null;
  reason: string | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  metadata: Record<string, unknown> | null;
}

export type ValidationResult =
  | { ok: true; event: ValidatedEvent }
  | { ok: false; error: EventRejection; message: string; client_event_id: string | null };

/**
 * Parses an ISO-8601 timestamp that carries an explicit zone, so the stored UTC instant is exactly
 * the one the producer meant. Timestamps without a zone are ambiguous and rejected (null).
 */
export const parseZonedTimestamp = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const match = ISO_WITH_ZONE_RE.exec(value.trim());
  if (!match) return null;
  const [, dateTime, fraction, zone] = match;
  // Keep millisecond precision (DATETIME(3)); extra digits are truncated, not rounded
  const ms = fraction ? `.${fraction.slice(0, 3).padEnd(3, '0')}` : '';
  const parsed = new Date(`${dateTime}${ms}${zone}`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/**
 * Validates one event from a desktop batch. `deviceId` is the batch's device; an event may repeat it
 * but not name another device. Session ownership is checked by the service (it needs the database).
 */
export const validateClientEvent = (raw: unknown, deviceId: string, nowMs: number): ValidationResult => {
  const reject = (error: EventRejection, message: string, id: string | null = null): ValidationResult => ({
    ok: false,
    error,
    message,
    client_event_id: id,
  });

  if (!isPlainObject(raw)) return reject('invalid_event', 'Each event must be a JSON object');

  const id = typeof raw.client_event_id === 'string' ? raw.client_event_id.trim() : '';
  if (!CLIENT_EVENT_ID_RE.test(id)) {
    return reject('invalid_client_event_id', 'client_event_id must be 8-100 characters of letters, digits, . _ : -');
  }
  if (id.toLowerCase().startsWith(SERVER_EVENT_ID_PREFIX)) {
    return reject('reserved_client_event_id', `client_event_id must not start with "${SERVER_EVENT_ID_PREFIX}"`, id);
  }

  const type = raw.type ?? raw.event_type;
  if (typeof type !== 'string' || !(CLIENT_EVENT_TYPES as readonly string[]).includes(type)) {
    return reject('invalid_type', `type must be one of: ${CLIENT_EVENT_TYPES.join(', ')}`, id);
  }
  const eventType = type as ClientEventType;

  const occurredAt = parseZonedTimestamp(raw.occurred_at);
  if (!occurredAt) {
    return reject('invalid_occurred_at', 'occurred_at must be an ISO-8601 timestamp with a zone, e.g. 2026-11-07T04:30:00.000Z', id);
  }
  if (occurredAt.getTime() > nowMs + MAX_CLOCK_SKEW_MS) return reject('occurred_at_in_future', 'occurred_at is in the future', id);
  if (occurredAt.getTime() < nowMs - MAX_EVENT_AGE_MS) return reject('occurred_at_too_old', 'occurred_at is older than 30 days', id);

  if (raw.device_id !== undefined && raw.device_id !== null && (typeof raw.device_id !== 'string' || raw.device_id.trim() !== deviceId)) {
    return reject('device_mismatch', 'An event cannot name a different device than its batch', id);
  }

  let sessionId: number | null = null;
  if (raw.session_id !== undefined && raw.session_id !== null) {
    if (typeof raw.session_id !== 'number' || !Number.isSafeInteger(raw.session_id) || raw.session_id <= 0) {
      return reject('invalid_session_id', 'session_id must be a positive integer', id);
    }
    sessionId = raw.session_id;
  }

  let reason: string | null = null;
  if (raw.reason !== undefined && raw.reason !== null) {
    if (typeof raw.reason !== 'string' || !REASON_RE.test(raw.reason)) {
      return reject('invalid_reason', 'reason must be 1-64 characters of letters, digits, _ . -', id);
    }
    reason = raw.reason;
  }

  const hasEnded = raw.ended_at !== undefined && raw.ended_at !== null;
  const hasDuration = raw.duration_seconds !== undefined && raw.duration_seconds !== null;
  if ((hasEnded || hasDuration) && !PERIOD_OPENING_TYPES.has(eventType)) {
    return reject('ended_at_not_allowed', `ended_at / duration_seconds are only accepted on ${[...PERIOD_OPENING_TYPES].join(', ')}`, id);
  }

  let endedAt: Date | null = null;
  if (hasEnded) {
    endedAt = parseZonedTimestamp(raw.ended_at);
    if (!endedAt) return reject('invalid_ended_at', 'ended_at must be an ISO-8601 timestamp with a zone', id);
    if (endedAt.getTime() > nowMs + MAX_CLOCK_SKEW_MS) return reject('invalid_ended_at', 'ended_at is in the future', id);
    if (endedAt.getTime() < occurredAt.getTime()) return reject('ended_before_occurred', 'ended_at is before occurred_at', id);
  }

  let durationSeconds: number | null = null;
  if (hasDuration) {
    const d = raw.duration_seconds;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > MAX_DURATION_SECONDS) {
      return reject('invalid_duration', `duration_seconds must be an integer from 0 to ${MAX_DURATION_SECONDS}`, id);
    }
    durationSeconds = d;
  }

  if (endedAt && durationSeconds !== null) {
    const span = (endedAt.getTime() - occurredAt.getTime()) / 1000;
    if (Math.abs(span - durationSeconds) > DURATION_TOLERANCE_SECONDS) {
      return reject('duration_mismatch', 'duration_seconds does not match ended_at - occurred_at', id);
    }
  } else if (endedAt) {
    durationSeconds = Math.round((endedAt.getTime() - occurredAt.getTime()) / 1000);
    if (durationSeconds > MAX_DURATION_SECONDS) return reject('invalid_duration', 'The period is longer than allowed', id);
  } else if (durationSeconds !== null) {
    endedAt = new Date(occurredAt.getTime() + durationSeconds * 1000);
    if (endedAt.getTime() > nowMs + MAX_CLOCK_SKEW_MS) return reject('invalid_duration', 'occurred_at + duration_seconds is in the future', id);
  }

  let metadata: Record<string, unknown> | null = null;
  if (raw.metadata !== undefined && raw.metadata !== null) {
    if (!isPlainObject(raw.metadata)) return reject('invalid_metadata', 'metadata must be a JSON object', id);
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(raw.metadata), 'utf8');
    } catch {
      return reject('invalid_metadata', 'metadata must be serialisable JSON', id);
    }
    if (size > MAX_METADATA_BYTES) return reject('metadata_too_large', `metadata must be at most ${MAX_METADATA_BYTES} bytes`, id);
    metadata = raw.metadata;
  }

  return {
    ok: true,
    event: {
      client_event_id: id,
      type: eventType,
      occurred_at: occurredAt,
      session_id: sessionId,
      reason,
      ended_at: endedAt,
      duration_seconds: durationSeconds,
      metadata,
    },
  };
};
