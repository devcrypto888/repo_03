/**
 * Allocating a shared cost (a processing batch, a freight bill) across the
 * outputs that consumed it, proportionally to a weight such as qty.
 *
 * Naive `round(total * w_i / sum(w))` per output doesn't add back up to the
 * total. Over thousands of batches the books drift by real money. This uses
 * the largest-remainder method on integer minor units (cents):
 *
 *   1. floor every share
 *   2. hand the leftover cents, one each, to the outputs with the largest
 *      fractional remainders, with a stable tie-break on id
 *
 * The result sums exactly to the total, every share is within 1 cent of its
 * exact value, and re-running with the same input gives the same output.
 */
export interface AllocationInput {
  id: string;
  weight: number;
}

export function allocateLargestRemainder(totalMinor: number, inputs: AllocationInput[]): Map<string, number> {
  if (!Number.isInteger(totalMinor)) throw new Error('totalMinor must be an integer number of minor units');
  const result = new Map<string, number>();
  const positive = inputs.filter((i) => i.weight > 0);
  if (!positive.length) {
    inputs.forEach((i) => result.set(i.id, 0));
    return result;
  }

  const sumW = positive.reduce((s, i) => s + i.weight, 0);
  const sign = Math.sign(totalMinor) || 1;
  const abs = Math.abs(totalMinor);

  const shares = positive.map((i) => {
    const exact = (abs * i.weight) / sumW;
    const floor = Math.floor(exact);
    return { id: i.id, floor, rem: exact - floor };
  });

  let leftover = abs - shares.reduce((s, x) => s + x.floor, 0);
  shares
    .slice()
    .sort((a, b) => b.rem - a.rem || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .forEach((s) => {
      if (leftover > 0) {
        s.floor += 1;
        leftover--;
      }
    });

  for (const i of inputs) result.set(i.id, 0);
  for (const s of shares) result.set(s.id, sign * s.floor);
  return result;
}

/**
 * Multi-stage cost roll-up: a batch's input cost plus its processing cost
 * flows into its outputs. Outputs can be inputs to later batches, so costs
 * cascade. Batches are processed in topological order. A cycle (data error)
 * is reported instead of looping forever.
 */
export interface Batch {
  id: string;
  inputs: { packageId: string; qty: number }[];
  outputs: { packageId: string; qty: number }[];
  processingCostMinor: number;
}

export function cascadeCosts(batches: Batch[], baseCostMinor: Map<string, number>): { cost: Map<string, number>; cycles: string[][] } {
  const cost = new Map(baseCostMinor);
  const producer = new Map<string, string>();
  for (const b of batches) for (const o of b.outputs) producer.set(o.packageId, b.id);

  const byId = new Map(batches.map((b) => [b.id, b]));
  const state = new Map<string, 'visiting' | 'done'>();
  const order: Batch[] = [];
  const cycles: string[][] = [];

  const visit = (id: string, path: string[]) => {
    const s = state.get(id);
    if (s === 'done') return;
    if (s === 'visiting') {
      cycles.push([...path.slice(path.indexOf(id)), id]);
      return;
    }
    state.set(id, 'visiting');
    const b = byId.get(id)!;
    for (const inp of b.inputs) {
      const up = producer.get(inp.packageId);
      if (up) visit(up, [...path, id]);
    }
    state.set(id, 'done');
    order.push(b);
  };
  for (const b of batches) visit(b.id, []);

  for (const b of order) {
    // Input cost is proportional to the share of each input package consumed.
    let inputMinor = 0;
    for (const inp of b.inputs) inputMinor += cost.get(inp.packageId) ?? 0;
    const shares = allocateLargestRemainder(
      inputMinor + b.processingCostMinor,
      b.outputs.map((o) => ({ id: o.packageId, weight: o.qty })),
    );
    for (const [pkg, minor] of shares) cost.set(pkg, (cost.get(pkg) ?? 0) + minor);
  }

  return { cost, cycles };
}
