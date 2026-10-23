import * as XLSX from '@e965/xlsx';
import { detectLayout, parseMatrix, restoreNumericIdentifiers, identifierWarnings } from './public/core.js';
import { readMonthlyWorkbook } from './public/monthly.js';
import { inspectExcelWorkbook } from './public/workbook-check.js';
import { parseIncomingWorkbook } from './public/incoming.js';
import { packRegistry, packMonthly } from './public/prepared-data.js';
import { readJournalWorkbook } from './public/journals.js';

export function prepareWorkbook(buffer, role, filename = '') {
  if (role === 'instant' || role === 'events') return readJournalWorkbook(buffer, XLSX, role);
  if (role === 'consumption') return packMonthly(readMonthlyWorkbook(buffer, XLSX));
  if (role === 'incoming') return parseIncomingWorkbook(buffer, XLSX) || { format: 1, role, ...inspectExcelWorkbook(buffer, XLSX) };
  if (role !== 'registry') throw new Error('Неизвестный вид файла.');
  const book = XLSX.read(buffer, { type: 'array', dense: true, cellText: true, cellDates: false, cellHTML: false, cellFormula: false, cellNF: true, sheetRows: 100002 });
  const sheets = [], skipped = [], warnings=identifierWarnings();
  for (const name of book.SheetNames) {
    const ws = book.Sheets[name]; if (!ws?.['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    if (range.e.r > 100000 || range.e.c > 255 || ws['!fullref']) throw new Error('Реестр слишком большой: максимум 100 000 строк и 256 столбцов на лист.');
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true, range: { s: { r: 0, c: 0 }, e: range.e } });
    try {
      restoreNumericIdentifiers(matrix, ws, detectLayout(matrix, ws['!merges'] || []),warnings);
      const parsed = parseMatrix(matrix, { sheet: name, file: filename, merges: ws['!merges'] || [] });
      if (!parsed.records.length) { skipped.push({ sheet: name, error: 'Нет строк с номером ПУ или ЛС.' }); continue; }
      if (parsed.layout.flattened || parsed.layout.mapping.meter === undefined || parsed.layout.mapping.account === undefined) {
        throw new Error('Сопоставьте столбцы реестра вручную; серверный пакет будет подготовлен после исправления шапки.');
      }
      sheets.push(parsed);
    } catch (error) {
      if (/Excel мог округлить|Сопоставьте столбцы/.test(error.message)) throw error;
      skipped.push({ sheet: name, error: error.message });
    } finally { delete book.Sheets[name]; }
  }
  if (!sheets.length) throw new Error(skipped[0]?.error || 'В файле нет доступных строк реестра.');
  return packRegistry(sheets, skipped, warnings.list());
}
