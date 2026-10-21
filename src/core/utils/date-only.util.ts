import { BadRequestException } from '@nestjs/common';

/**
 * Parses a date-only value ("YYYY-MM-DD", optionally with a time part) to UTC midnight
 * so the stored DATE matches the selected calendar day. Impossible dates (2026-02-30) and
 * anything else that is not a calendar date are refused with a 400.
 * undefined -> undefined (not provided), null/"" -> null (cleared).
 */
export function parseDateOnly(value: any, label: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!date || date.getUTCMonth() !== Number(match![2]) - 1 || date.getUTCDate() !== Number(match![3])) {
    throw new BadRequestException(`${label} must be a valid date (YYYY-MM-DD).`);
  }
  return date;
}

/** "YYYY-MM-DD" of a date-only value (UTC midnight), or null. */
export function toDateKey(date: Date | null | undefined): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** Business timezone for "today" (BUSINESS_TIMEZONE, default Asia/Kolkata). */
export const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Kolkata';

/**
 * Today's calendar date in the business timezone, as UTC midnight (comparable with DATE
 * columns). An unknown BUSINESS_TIMEZONE falls back to Asia/Kolkata.
 */
export function businessToday(now: Date = new Date(), timeZone: string = process.env.BUSINESS_TIMEZONE || DEFAULT_BUSINESS_TIMEZONE): Date {
  let key: string;
  try {
    key = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    key = new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }
  return parseDateOnly(key, 'Today') as Date;
}
