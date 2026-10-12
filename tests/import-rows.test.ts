import { describe, expect, it } from 'vitest';
import { parseRowsDetailed, rowHash } from '../src/jobs/import-rows';

const csv = (s: string) => Buffer.from(s.trim() + '\n');

describe('parseRowsDetailed', () => {
  it('maps header aliases case-insensitively and strips BOM', () => {
    const { rows, errors } = parseRowsDetailed(
      csv('﻿Package ID,Group,Dimension,Class,Quantity,Price,State\nP-1,Boxes,40x60,A,"1,250.5",2.10,Ready'),
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ externalId: 'P-1', category: 'Boxes', size: '40x60', variant: 'A', qty: 1250.5, unitCost: 2.1, status: 'Ready' });
  });

  it('collects per-line errors without dropping good rows', () => {
    const { rows, errors } = parseRowsDetailed(csv('id,category,size,variant,qty\nA,c,s,v,10\nB,c,s,v,-3\nC,c,s,v,abc'));
    expect(rows.map((r) => r.externalId)).toEqual(['A']);
    expect(errors.map((e) => e.line)).toEqual([3, 4]);
  });

  it('falls back to Receiving for unknown statuses', () => {
    const { rows } = parseRowsDetailed(csv('id,category,size,variant,qty,status\nA,c,s,v,1,weird'));
    expect(rows[0].status).toBe('Receiving');
  });
});

describe('rowHash', () => {
  const base = { externalId: 'A', category: 'c', size: 's', variant: 'v', qty: 1, status: 'Ready' as const };

  it('ignores representation noise', () => {
    expect(rowHash({ ...base, qty: 1 })).toBe(rowHash({ ...base, qty: 1.0 }));
  });

  it('changes when a tracked field changes', () => {
    expect(rowHash(base)).not.toBe(rowHash({ ...base, qty: 2 }));
    expect(rowHash(base)).not.toBe(rowHash({ ...base, station: 'L2' }));
  });
});
