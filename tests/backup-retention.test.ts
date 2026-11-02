import { describe, expect, it } from 'vitest';
import { keepSet } from '../src/jobs/backup';

const day = 86400_000;

describe('keepSet (GFS retention)', () => {
  const now = new Date('2025-06-30T03:00:00Z');
  const keys = Array.from({ length: 400 }, (_, i) => {
    const date = new Date(now.getTime() - i * day);
    return { key: `pg/${date.toISOString().slice(0, 10)}.sql.gz`, date };
  });

  it('keeps 14 dailies, 8 weeklies, 12 monthlies (overlapping)', () => {
    const keep = keepSet(keys, now);
    // Overlap means fewer than 34, but it must include all of the last 14 days.
    for (let i = 0; i < 14; i++) expect(keep.has(keys[i].key)).toBe(true);
    expect(keep.size).toBeLessThanOrEqual(34);
    expect(keep.size).toBeGreaterThanOrEqual(20);
  });

  it('never deletes anything younger than 48h', () => {
    const fresh = [
      { key: 'a', date: new Date(now.getTime() - 3600_000) },
      { key: 'b', date: new Date(now.getTime() - 2 * 3600_000) },
    ];
    const keep = keepSet(fresh, now, { daily: 1, weekly: 0, monthly: 0 });
    expect(keep.has('a') && keep.has('b')).toBe(true);
  });

  it('keeps the oldest monthly within a year', () => {
    const keep = keepSet(keys, now);
    const months = new Set([...keep].map((k) => k.slice(3, 10)));
    expect(months.size).toBeGreaterThanOrEqual(12);
  });
});
