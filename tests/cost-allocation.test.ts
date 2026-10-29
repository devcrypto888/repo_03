import { describe, expect, it } from 'vitest';
import { allocateLargestRemainder, cascadeCosts } from '../src/reports/cost-allocation';

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe('allocateLargestRemainder', () => {
  it('sums exactly to the total', () => {
    const r = allocateLargestRemainder(100, [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }]);
    expect(sum(r)).toBe(100);
    expect([...r.values()].sort()).toEqual([33, 33, 34]);
  });

  it('every share is within one minor unit of exact', () => {
    const inputs = Array.from({ length: 37 }, (_, i) => ({ id: `p${i}`, weight: (i * 7919) % 101 + 1 }));
    const total = 1_234_567;
    const r = allocateLargestRemainder(total, inputs);
    const W = inputs.reduce((s, i) => s + i.weight, 0);
    for (const i of inputs) expect(Math.abs(r.get(i.id)! - (total * i.weight) / W)).toBeLessThan(1);
    expect(sum(r)).toBe(total);
  });

  it('is deterministic with ties (stable on id)', () => {
    const a = allocateLargestRemainder(1, [{ id: 'y', weight: 1 }, { id: 'x', weight: 1 }]);
    const b = allocateLargestRemainder(1, [{ id: 'x', weight: 1 }, { id: 'y', weight: 1 }]);
    expect([...a]).toEqual(expect.arrayContaining([...b]));
    expect(a.get('x')).toBe(1);
  });

  it('handles negative totals (credits)', () => {
    const r = allocateLargestRemainder(-100, [{ id: 'a', weight: 2 }, { id: 'b', weight: 1 }]);
    expect(sum(r)).toBe(-100);
    expect(r.get('a')).toBe(-67);
  });

  it('zero-weight outputs get zero', () => {
    const r = allocateLargestRemainder(50, [{ id: 'a', weight: 0 }, { id: 'b', weight: 5 }]);
    expect(r.get('a')).toBe(0);
    expect(r.get('b')).toBe(50);
  });
});

describe('cascadeCosts', () => {
  it('flows cost through chained batches', () => {
    // raw (1000) → B1 (+200) → mid ×2 → B2 (+100) → final
    const { cost, cycles } = cascadeCosts(
      [
        { id: 'B2', inputs: [{ packageId: 'mid1', qty: 1 }, { packageId: 'mid2', qty: 1 }], outputs: [{ packageId: 'final', qty: 1 }], processingCostMinor: 100 },
        { id: 'B1', inputs: [{ packageId: 'raw', qty: 1 }], outputs: [{ packageId: 'mid1', qty: 3 }, { packageId: 'mid2', qty: 1 }], processingCostMinor: 200 },
      ],
      new Map([['raw', 1000]]),
    );
    expect(cycles).toEqual([]);
    expect(cost.get('mid1')).toBe(900);
    expect(cost.get('mid2')).toBe(300);
    expect(cost.get('final')).toBe(1300);
  });

  it('reports cycles instead of looping', () => {
    const { cycles } = cascadeCosts(
      [
        { id: 'A', inputs: [{ packageId: 'y', qty: 1 }], outputs: [{ packageId: 'x', qty: 1 }], processingCostMinor: 0 },
        { id: 'B', inputs: [{ packageId: 'x', qty: 1 }], outputs: [{ packageId: 'y', qty: 1 }], processingCostMinor: 0 },
      ],
      new Map(),
    );
    expect(cycles.length).toBeGreaterThan(0);
  });
});
