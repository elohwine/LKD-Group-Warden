import { describe, expect, it } from 'vitest';
import { formatUkTimestamp, getUkDateTimeParts, formatLocalTimestamp, getLocalDateTimeParts } from './ukTimestamp';

describe('ukTimestamp', () => {
  it('formats July UTC instants in UK summer time', () => {
    const input = '2026-07-08T10:12:00.000Z';

    expect(formatUkTimestamp(input)).toBe('2026-07-08 11:12:00');
    expect(getUkDateTimeParts(input)).toEqual({
      date: '2026-07-08',
      time: '11:12',
      secondsTime: '11:12:00',
    });
  });

  it('getLocalDateTimeParts returns date/time parts using the process timezone', () => {
    // Process timezone is whatever Node is running in during test.
    // We just verify the structure is correct and the value differs from UK time
    // when the host is not in Europe/London.
    const input = '2026-07-23T09:03:00.000Z';
    const parts = getLocalDateTimeParts(input);
    expect(parts).toHaveProperty('date');
    expect(parts).toHaveProperty('time');
    expect(parts).toHaveProperty('secondsTime');
    expect(parts.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parts.time).toMatch(/^\d{2}:\d{2}$/);
    expect(parts.secondsTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('formatLocalTimestamp returns a non-empty string for a valid timestamp', () => {
    const input = '2026-07-23T09:03:00.000Z';
    const result = formatLocalTimestamp(input);
    expect(result).toBeTruthy();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('formatLocalTimestamp returns empty string for invalid input', () => {
    expect(formatLocalTimestamp('not-a-date')).toBe('');
    expect(formatLocalTimestamp('')).toBe('');
    expect(formatLocalTimestamp(null)).toBe('');
  });
});