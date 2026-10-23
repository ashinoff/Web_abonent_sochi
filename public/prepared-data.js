import { idKey, recordFromValues } from './core.js';
import { MONTHLY_PARSER_VERSION } from './monthly.js';

// Keep each column name and object key once per workbook, while preserving all
// source cells for the full meter card and each monthly row for analysis.
export function packRegistry(sheets, skipped = [], warnings = []) {
  return { format: 1, role: 'registry', skipped, ...(warnings.length?{warnings}:{}), sheets: sheets.map(({ sheet, file, layout, records }) => ({
    sheet, file, layout, rows: records.map(({ row, values }) => [row, values]),
  })) };
}
export function unpackRegistry(pack) {
  if (pack?.format !== 1 || pack.role !== 'registry' || !Array.isArray(pack.sheets)) throw new Error('Неизвестный формат реестра.');
  return pack.sheets.map(({ sheet, file, layout, rows }) => {
    if (!Array.isArray(rows) || !Array.isArray(layout?.labels) || !layout.mapping) throw new Error('Неполный пакет реестра.');
    const records = rows.map(([row, values]) => recordFromValues(values, layout, sheet, file, row));
    return { sheet, file, layout, records, sample: records.slice(0, 3).map(r => r.values) };
  });
}
export const monthlyKeys = ['account','alias','point','pointNumber','name','pointName','tp','zone','off','values','source','accountFallback'];
export function packMonthly(parsed) {
  return { format: 1, role: 'consumption', parserVersion: MONTHLY_PARSER_VERSION, months: parsed.months, warnings: parsed.warnings,
    rows: parsed.rows.map(row => monthlyKeys.map(key => row[key])) };
}
export function unpackMonthly(pack) {
  if (pack?.format !== 1 || pack.role !== 'consumption' || !Array.isArray(pack.months) || !Array.isArray(pack.rows)) throw new Error('Неизвестный формат потребления.');
  return { months: pack.months, warnings: pack.warnings, rows: pack.rows.map(cells => {
    if (!Array.isArray(cells) || !Array.isArray(cells[9])) throw new Error('Неполный пакет потребления.');
    const row = Object.fromEntries(monthlyKeys.map((key, i) => [key, cells[i]]));
    row.accountKey = idKey(row.account);
    return row;
  }) };
}
