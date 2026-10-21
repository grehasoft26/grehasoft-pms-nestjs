import { BadRequestException } from '@nestjs/common';
import { addRenewalPeriod, parseRenewalPeriod } from './renewal-period.util';

describe('addRenewalPeriod (calendar months, day clamped to the month end)', () => {
  const add = (from: string, value: number, unit: 'month' | 'year') =>
    addRenewalPeriod(new Date(`${from}T00:00:00.000Z`), { value, unit }).toISOString().slice(0, 10);

  it.each([
    ['2026-10-21', 1, 'year', '2027-10-21'],
    ['2026-10-21', 1, 'month', '2026-11-21'],
    ['2026-12-15', 1, 'month', '2027-01-15'],
    ['2026-01-31', 1, 'month', '2026-02-28'],
    ['2028-01-31', 1, 'month', '2028-02-29'],
    ['2026-05-31', 1, 'month', '2026-06-30'],
    ['2026-01-30', 1, 'month', '2026-02-28'],
    ['2028-02-29', 1, 'year', '2029-02-28'],
    ['2028-02-29', 4, 'year', '2032-02-29'],
    ['2026-02-28', 1, 'year', '2027-02-28'],
    ['2026-10-21', 120, 'month', '2036-10-21'],
    ['2026-10-21', 10, 'year', '2036-10-21'],
  ] as const)('%s + %i %s = %s', (from, value, unit, expected) => {
    expect(add(from, value, unit)).toBe(expected);
  });

  it('12 months equals 1 year', () => {
    expect(add('2027-03-31', 12, 'month')).toBe(add('2027-03-31', 1, 'year'));
  });

  it('returns UTC midnight (a date-only value)', () => {
    expect(addRenewalPeriod(new Date('2026-10-21T00:00:00.000Z'), { value: 1, unit: 'month' }).toISOString()).toBe('2026-11-21T00:00:00.000Z');
  });
});

describe('parseRenewalPeriod', () => {
  it('accepts whole months and years (numbers or numeric strings, any unit case)', () => {
    expect(parseRenewalPeriod(1, 'year')).toEqual({ value: 1, unit: 'year' });
    expect(parseRenewalPeriod('12', 'month')).toEqual({ value: 12, unit: 'month' });
    expect(parseRenewalPeriod(' 3 ', ' YEAR ')).toEqual({ value: 3, unit: 'year' });
  });

  it('accepts the maximum of each unit', () => {
    expect(parseRenewalPeriod(10, 'year')).toEqual({ value: 10, unit: 'year' });
    expect(parseRenewalPeriod(120, 'month')).toEqual({ value: 120, unit: 'month' });
  });

  it('undefined for both = not provided; null/"" for both = cleared', () => {
    expect(parseRenewalPeriod(undefined, undefined)).toBeUndefined();
    expect(parseRenewalPeriod(null, null)).toBeNull();
    expect(parseRenewalPeriod('', '')).toBeNull();
  });

  it.each([
    [0, 'year'],
    [-1, 'month'],
    [1.5, 'year'],
    ['1.5', 'year'],
    ['abc', 'month'],
    [11, 'year'],
    [121, 'month'],
    [true, 'year'],
    [1, 'week'],
    [1, 'day'],
    [1, 'years'],
  ])('rejects value %p with unit %p', (value, unit) => {
    expect(() => parseRenewalPeriod(value, unit)).toThrow(BadRequestException);
  });

  it('requires value and unit together', () => {
    expect(() => parseRenewalPeriod(1, undefined)).toThrow('Renewal period value and unit must be provided together.');
    expect(() => parseRenewalPeriod(undefined, 'year')).toThrow('Renewal period value and unit must be provided together.');
    expect(() => parseRenewalPeriod(1, null)).toThrow('Renewal period value and unit must be provided together.');
    expect(() => parseRenewalPeriod('', 'month')).toThrow('Renewal period value and unit must be provided together.');
  });
});
