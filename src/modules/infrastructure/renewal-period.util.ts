import { BadRequestException } from '@nestjs/common';

/**
 * Renewal period of a domain or server: a whole number of months or years. Used by the renewal
 * fields and endpoints (renewals extend the current expiry date by this period).
 */

export const RENEWAL_PERIOD_UNITS = ['month', 'year'] as const;
export type RenewalPeriodUnit = (typeof RENEWAL_PERIOD_UNITS)[number];

/** Upper bounds per unit: 10 years is the longest registration registrars offer. */
export const MAX_RENEWAL_PERIOD: Record<RenewalPeriodUnit, number> = { month: 120, year: 10 };

export type RenewalPeriod = { value: number; unit: RenewalPeriodUnit };

/**
 * Validates a renewal period. Both parts must be given together: undefined for both -> undefined
 * (not provided), null/"" for both -> null (cleared). The value must be a positive whole number
 * (numeric strings such as "12" are accepted, "1.5", "0", "-1" and "abc" are not) within the
 * unit's maximum. Invalid input is a 400.
 */
export function parseRenewalPeriod(value: unknown, unit: unknown): RenewalPeriod | null | undefined {
  const isEmpty = (v: unknown) => v === null || v === '';
  if (value === undefined && unit === undefined) return undefined;
  if (isEmpty(value) && isEmpty(unit)) return null;
  if (value === undefined || unit === undefined || isEmpty(value) || isEmpty(unit)) {
    throw new BadRequestException('Renewal period value and unit must be provided together.');
  }

  const normalizedUnit = String(unit).trim().toLowerCase();
  if (!(RENEWAL_PERIOD_UNITS as readonly string[]).includes(normalizedUnit)) {
    throw new BadRequestException(`Renewal period unit must be one of: ${RENEWAL_PERIOD_UNITS.join(', ')}.`);
  }
  const periodUnit = normalizedUnit as RenewalPeriodUnit;

  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const count = /^\d+$/.test(text) ? Number(text) : NaN;
  const max = MAX_RENEWAL_PERIOD[periodUnit];
  if (!Number.isInteger(count) || count < 1 || count > max) {
    throw new BadRequestException(`Renewal period must be a whole number of ${periodUnit}s from 1 to ${max}.`);
  }
  return { value: count, unit: periodUnit };
}

const daysInMonth = (year: number, monthIndex: number) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

/**
 * Adds a renewal period to a date-only value (UTC midnight), on calendar months: the day is kept,
 * or clamped to the last day of a shorter target month (31 Jan + 1 month = 28/29 Feb,
 * 29 Feb 2028 + 1 year = 28 Feb 2029). Renewals always extend the current expiry date.
 */
export function addRenewalPeriod(date: Date, period: RenewalPeriod): Date {
  const months = period.unit === 'year' ? period.value * 12 : period.value;
  const total = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const monthIndex = total % 12;
  const day = Math.min(date.getUTCDate(), daysInMonth(year, monthIndex));
  return new Date(Date.UTC(year, monthIndex, day));
}
