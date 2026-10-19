import { BadRequestException } from '@nestjs/common';

/**
 * Sorting and expiry filters for the Servers and Domains lists (GET /infrastructure/servers and
 * /infrastructure/domains). They run in the database, so they cover every record the user may
 * see, not just the loaded page.
 */

/** Expiry alert window in days; same value as the frontend alerts (DOMAIN_EXPIRY_ALERT_WINDOW_DAYS). */
export const EXPIRY_ALERT_WINDOW_DAYS = 30;
/** Shorter window offered as a list filter. */
export const EXPIRY_SOON_WINDOW_DAYS = 7;

/** `expiry` query values. */
export const EXPIRY_FILTERS = ['expired', 'within_7', 'within_30', 'none'] as const;
export type ExpiryFilter = (typeof EXPIRY_FILTERS)[number];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The viewer's calendar date as UTC midnight. expiry_date is a DATE column (stored and returned
 * as UTC midnight), so comparing whole UTC-midnight dates has no timezone off-by-one. The client
 * sends its own local date (`today=YYYY-MM-DD`) because "today" depends on where the viewer is;
 * without it the server's local date is used.
 */
export const parseToday = (today: unknown, now: Date = new Date()): Date => {
  if (today === undefined || today === null || today === '') {
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  }
  const match = String(today).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!date || date.getUTCMonth() !== Number(match![2]) - 1 || date.getUTCDate() !== Number(match![3])) {
    throw new BadRequestException('today must be a valid date (YYYY-MM-DD).');
  }
  return date;
};

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * MS_PER_DAY);

/**
 * Prisma condition on expiry_date for an `expiry` filter, or undefined for no filter.
 * - expired: before today
 * - within_7 / within_30: today up to and including today + N days (expired records excluded;
 *   expiring today counts, as in the alerts)
 * - none: no expiry date
 */
export const expiryFilterWhere = (filter: unknown, today: Date): Record<string, unknown> | undefined => {
  if (filter === undefined || filter === null || filter === '' || filter === 'all') return undefined;
  switch (filter as ExpiryFilter) {
    case 'expired':
      return { expiry_date: { lt: today } };
    case 'within_7':
      return { expiry_date: { gte: today, lte: addDays(today, EXPIRY_SOON_WINDOW_DAYS) } };
    case 'within_30':
      return { expiry_date: { gte: today, lte: addDays(today, EXPIRY_ALERT_WINDOW_DAYS) } };
    case 'none':
      return { expiry_date: null };
    default:
      throw new BadRequestException(`expiry must be one of: ${EXPIRY_FILTERS.join(', ')}.`);
  }
};

/**
 * Prisma orderBy for `ordering=expiry_date` (earliest first, the default) or `-expiry_date`
 * (latest first). Records without an expiry date come last in both directions; ties keep the
 * newest record first, so paging is stable.
 */
export const expiryOrderBy = (ordering: unknown): any[] => {
  if (ordering !== undefined && ordering !== null && ordering !== '' && ordering !== 'expiry_date' && ordering !== '-expiry_date') {
    throw new BadRequestException('ordering must be expiry_date or -expiry_date.');
  }
  const sort = ordering === '-expiry_date' ? 'desc' : 'asc';
  return [{ expiry_date: { sort, nulls: 'last' } }, { id: 'desc' }];
};

/** Search term: trimmed, or undefined when empty. */
export const searchTerm = (search: unknown): string | undefined => {
  const term = String(search ?? '').trim();
  return term ? term : undefined;
};
