import { BadRequestException } from '@nestjs/common';
import { businessToday, parseDateOnly, toDateKey } from './date-only.util';

describe('businessToday (calendar date in the business timezone)', () => {
  const iso = (d: Date) => d.toISOString();

  it('uses Asia/Kolkata: 20:00 UTC on 21 Oct is already 22 Oct there', () => {
    expect(iso(businessToday(new Date('2026-10-21T20:00:00Z'), 'Asia/Kolkata'))).toBe('2026-10-22T00:00:00.000Z');
    expect(iso(businessToday(new Date('2026-10-21T18:29:00Z'), 'Asia/Kolkata'))).toBe('2026-10-21T00:00:00.000Z');
  });

  it('honours another configured timezone', () => {
    expect(iso(businessToday(new Date('2026-10-21T02:00:00Z'), 'America/New_York'))).toBe('2026-10-20T00:00:00.000Z');
  });

  it('falls back to Asia/Kolkata for an unknown timezone', () => {
    expect(iso(businessToday(new Date('2026-10-21T20:00:00Z'), 'Not/AZone'))).toBe('2026-10-22T00:00:00.000Z');
  });

  it('toDateKey formats a date-only value', () => {
    expect(toDateKey(new Date('2026-10-21T00:00:00.000Z'))).toBe('2026-10-21');
    expect(toDateKey(null)).toBeNull();
  });
});

describe('parseDateOnly', () => {
  const iso = (v: unknown) => (parseDateOnly(v, 'Date') as Date).toISOString();

  it('parses YYYY-MM-DD to UTC midnight of that calendar day', () => {
    expect(iso('2026-10-21')).toBe('2026-10-21T00:00:00.000Z');
  });

  it('keeps the calendar day of a value with a time part', () => {
    expect(iso('2026-10-21T00:00:00.000Z')).toBe('2026-10-21T00:00:00.000Z');
    expect(iso('2026-10-21T23:59:59+05:30')).toBe('2026-10-21T00:00:00.000Z');
  });

  it('accepts leap days and month ends', () => {
    expect(iso('2028-02-29')).toBe('2028-02-29T00:00:00.000Z');
    expect(iso('2026-12-31')).toBe('2026-12-31T00:00:00.000Z');
  });

  it('undefined means not provided; null and "" mean cleared', () => {
    expect(parseDateOnly(undefined, 'Date')).toBeUndefined();
    expect(parseDateOnly(null, 'Date')).toBeNull();
    expect(parseDateOnly('', 'Date')).toBeNull();
  });

  it.each(['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '21-10-2026', 'tomorrow', '2026/10/21', 12345])(
    'rejects %p with a labelled 400',
    (value) => {
      expect(() => parseDateOnly(value, 'Expiry date')).toThrow(BadRequestException);
      expect(() => parseDateOnly(value, 'Expiry date')).toThrow('Expiry date must be a valid date (YYYY-MM-DD).');
    },
  );
});
