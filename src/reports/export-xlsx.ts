import * as XLSX from 'xlsx';
import type { RollforwardRow } from './rollforward';
import type { StockSummaryRow } from './stock-summary';

/**
 * Accountant-friendly workbook: real numbers (not strings), number formats,
 * frozen header, auto-ish column widths, and a totals row with SUM formulas
 * so edits in Excel recalculate.
 */
export function rollforwardWorkbook(month: string, rows: RollforwardRow[], stock: StockSummaryRow[]): Buffer {
  const wb = XLSX.utils.book_new();

  const rfHeader = ['Category', 'Opening qty', 'Opening value', 'Receipts qty', 'Receipts value', 'Shipped qty', 'Shipped value', 'Consumed qty', 'Consumed value', 'Adjust qty', 'Closing qty', 'Closing value', 'Snapshot qty', 'Unexplained qty'];
  const rfData = rows.map((r) => [
    r.category, r.openingQty, r.openingValue, r.receiptsQty, r.receiptsValue, r.shippedQty, r.shippedValue,
    r.consumedQty, r.consumedValue, r.adjustmentsQty, r.closingQty, r.closingValue, r.snapshotQty, r.unexplainedQty,
  ]);
  const rf = XLSX.utils.aoa_to_sheet([rfHeader, ...rfData]);
  addTotalsRow(rf, rfHeader.length, rfData.length);
  formatColumns(rf, rfHeader, { value: '#,##0.00', qty: '#,##0.000' });
  rf['!freeze'] = { xSplit: 1, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, rf, `Rollforward ${month}`);

  const stHeader = ['Category', 'Size', 'Variant', 'Packaging', 'Packages', 'Receiving', 'In process', 'Ready', 'Ready cost', 'Avg unit cost', 'Reserved'];
  const stData = stock.map((s) => [s.category, s.size, s.variant, s.packaging, s.packageCount, s.receivingQty, s.inProcessQty, s.readyQty, s.readyCost, s.readyAvgUnitCost ?? '', s.reservedQty]);
  const st = XLSX.utils.aoa_to_sheet([stHeader, ...stData]);
  formatColumns(st, stHeader, { cost: '#,##0.00', qty: '#,##0.000' });
  st['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: stData.length, c: stHeader.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, st, 'Stock by SKU');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
}

function addTotalsRow(ws: XLSX.WorkSheet, cols: number, dataRows: number) {
  const r = dataRows + 1;
  ws[XLSX.utils.encode_cell({ r, c: 0 })] = { t: 's', v: 'Total' };
  for (let c = 1; c < cols; c++) {
    const col = XLSX.utils.encode_col(c);
    ws[XLSX.utils.encode_cell({ r, c })] = { t: 'n', f: `SUM(${col}2:${col}${dataRows + 1})` };
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r, c: cols - 1 } });
}

function formatColumns(ws: XLSX.WorkSheet, header: string[], fmt: Record<string, string>) {
  const range = XLSX.utils.decode_range(ws['!ref']!);
  ws['!cols'] = header.map((h) => ({ wch: Math.max(10, h.length + 2) }));
  header.forEach((h, c) => {
    const key = Object.keys(fmt).find((k) => h.toLowerCase().includes(k));
    if (!key) return;
    for (let r = 1; r <= range.e.r; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && (cell.t === 'n' || cell.f)) cell.z = fmt[key];
    }
  });
}
