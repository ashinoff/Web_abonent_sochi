import { openSync, closeSync, writeSync } from 'node:fs';
import * as XLSX from '@e965/xlsx';
import { clean, detectLayout, identifierColumns, criticalIdentifierColumns, unsafeNumericIdentifier, longNumericIdentifier, identifierIssue, identifierWarnings, restoreIdentifier, isRegistryDataRow } from './public/core.js';
import { openStreamingWorkbook, parseXML, column, excelText, xmlError, MAX_CELL_BYTES, MAX_ENTRY_BYTES } from './xlsx-stream.mjs';

const registryLimit = () => new Error('Реестр слишком большой: максимум 100 000 строк и 256 столбцов на лист.');
const manualHeader = () => new Error('Сопоставьте столбцы реестра вручную; серверный пакет будет подготовлен после исправления шапки.');

function cellValue(cell, content, strings, date1904) {
  const z = cell.z || 'General';
  if (cell.type === 's') return { t: 's', v: content.trim() ? strings.get(Number(content)) : '', z };
  if (cell.type === 'inlineStr' || cell.type === 'str') return { t: 's', v: excelText(content), z };
  if (cell.type === 'e' || !content.trim()) return { t: 'z', v: '', z };
  if (cell.type === 'b') return { t: 'b', v: /^(1|true)$/i.test(content), z };
  const value = cell.type === 'd'
    ? XLSX.utils.aoa_to_sheet([[new Date(content)]], { date1904 }).A1?.v
    : Number(content);
  if (!Number.isFinite(value)) throw xmlError('неверное числовое значение ячейки.');
  return { t: 'n', v: value, z };
}

function displayCell(cell, date1904) {
  if (cell.t === 'z') return '';
  if (cell.z === 'General' && cell.t === 's') return clean(cell.v);
  try { return clean(XLSX.SSF.format(cell.z, cell.v, { date1904 })); }
  catch {
    // sheet_to_json also handles SheetJS's date fallback when a producer uses
    // a date format that SSF does not support. Preserve that existing display.
    return clean(XLSX.utils.sheet_to_json({ A1: { ...cell }, '!ref': 'A1' }, { header: 1, raw: false, defval: '' })[0]?.[0]);
  }
}

// Merged headers can be stored after sheetData. The first pass keeps only the
// first 96 rows and header merges; the second emits one complete source row at a
// time. Neither pass retains worksheet XML, cell objects or the full matrix.
async function readRows(workbook, sheet, { firstRowsOnly = false, onRow, onTag, onExtent } = {}) {
  const { book, formats, strings, info } = workbook;
  let row = [], number = 0, previousRow = 0, nextColumn = 0, cell, content = '', valueText = false, inlineText = false, phonetic = 0;
  await parseXML(book, sheet.path, {
    open(name, attr) {
      onTag?.(name, attr);
      if (name === 'row') {
        number = attr.r ? Number(attr.r) : previousRow + 1;
        if (!Number.isSafeInteger(number) || number <= previousRow) throw xmlError('неверный порядок строк реестра.');
        if (number > 100001) throw registryLimit();
        previousRow = number; row = []; nextColumn = 0;
      }
      if (name === 'c') {
        const col = attr.r ? column(attr.r) : nextColumn;
        if (col == null) throw xmlError('неверная ссылка на ячейку.');
        if (attr.r && Number(attr.r.match(/\d+$/)?.[0]) !== number) throw xmlError('ячейка не принадлежит своей строке.');
        if (col > 255) throw registryLimit();
        nextColumn = col + 1;
        cell = { col, type: attr.t || 'n', z: formats[Number(attr.s || 0)] || 'General', wanted: !firstRowsOnly || number <= 96 };
        content = '';
      }
      if (name === 'rPh') phonetic++;
      if (name === 'v' && cell) valueText = true;
      if (name === 't' && cell && !phonetic) inlineText = true;
    },
    text(text) {
      if (cell?.wanted && (valueText || inlineText)) {
        content += text;
        if (content.length > MAX_CELL_BYTES) throw xmlError('слишком длинная ячейка.');
      }
    },
    close(name) {
      if (name === 'v') valueText = false;
      if (name === 't') inlineText = false;
      if (name === 'rPh') phonetic--;
      if (name === 'c' && cell) {
        if (cell.wanted) row[cell.col] = cellValue(cell, content, strings, info.date1904);
        cell = null;
      }
      if (name === 'row') {
        onExtent?.(number, nextColumn);
        if (!firstRowsOnly || number <= 96) onRow?.(number, row);
      }
    },
  }, MAX_ENTRY_BYTES);
}

async function sheetLayout(workbook, sheet) {
  const matrix = [], merges = []; let width = 0, height = 0, mergeCount = 0, cellsSeen = false;
  await readRows(workbook, sheet, {
    firstRowsOnly: true,
    onTag(name, attr) {
      if (name === 'c') cellsSeen = true;
      if (name === 'dimension' && attr.ref) {
        const range = XLSX.utils.decode_range(attr.ref);
        if (range.e.r > 100000 || range.e.c > 255) throw registryLimit();
        width = Math.max(width, range.e.c + 1); height = Math.max(height, range.e.r + 1);
      }
      if (name === 'mergeCell' && attr.ref) {
        if (++mergeCount > 100000) throw xmlError('слишком много объединённых ячеек.');
        const merge = XLSX.utils.decode_range(attr.ref);
        if (merge.s.r < 96) merges.push(merge);
      }
    },
    onRow(number, cells) {
      matrix[number - 1] = cells.map(cell => displayCell(cell, workbook.info.date1904));
    },
    onExtent(number, columns) { height = Math.max(height, number); width = Math.max(width, columns); },
  });
  if (!height || !cellsSeen) return null;
  // Preserve the old detector's distinction between genuinely unmerged copied
  // headers and worksheets with merges outside the header sample.
  if (mergeCount && !merges.length) merges.push({ s: { r: 96, c: 0 }, e: { r: 96, c: 0 } });
  const sample = Array.from({ length: Math.min(height, 96) }, (_, r) => Array.from({ length: width }, (_, c) => matrix[r]?.[c] || ''));
  return detectLayout(sample, merges);
}

class PackageWriter {
  constructor(path) { this.fd = openSync(path, 'w'); this.pending = []; this.bytes = 0; }
  add(text) {
    const bytes = Buffer.from(text); this.pending.push(bytes); this.bytes += bytes.length;
    if (this.bytes >= 256 * 1024) this.flush();
  }
  flush() {
    if (!this.bytes) return;
    const bytes = Buffer.concat(this.pending, this.bytes); let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset, bytes.length - offset);
    this.pending = []; this.bytes = 0;
  }
  close() { try { this.flush(); } finally { closeSync(this.fd); } }
}

export async function writeRegistryXLSX(path, output, filename = '') {
  const workbook = await openStreamingWorkbook(path, XLSX.SSF.get_table());
  let writer;
  try {
    writer = new PackageWriter(output);
    writer.add('{"format":1,"role":"registry","sheets":[');
    const skipped = [], warnings=identifierWarnings(), invalid={count:0,examples:[]}; let sheetCount = 0;
    for (const sheet of workbook.info.sheets) {
      if (!sheet.path) continue;
      let layout;
      try { layout = await sheetLayout(workbook, sheet); }
      catch (error) {
        if (/Реестр слишком большой|Некорректный XLSX/.test(error.message)) throw error;
        skipped.push({ sheet: sheet.name, error: error.message }); continue;
      }
      if (!layout) continue;
      const columns = identifierColumns(layout),critical=criticalIdentifierColumns(layout); let count = 0;
      await readRows(workbook, sheet, { onRow(number, cells) {
        if (number <= layout.end + 1) return;
        let invalidRow=false;
        const values = Array.from({ length: layout.labels.length }, (_, c) => {
          const cell=cells[c];
          const value = cell ? displayCell(cell, workbook.info.date1904) : '';
          if(!columns.has(c))return clean(value);
          if(unsafeNumericIdentifier(cell)){
            if(critical.has(c)){
              invalidRow=true;
              invalid.count++;
              if(invalid.examples.length<8)invalid.examples.push(identifierIssue(number,c,layout.labels[c]));
            }else warnings.add(c,layout.labels[c],number);
            // Non-safe integers cannot supply trustworthy key IDs. Secondary
            // serials remain visible exactly as Excel rendered them.
            return clean(value);
          }
          if(longNumericIdentifier(cell))
            // A precisely representable 16-digit meter must remain searchable
            // under its full number. Warn that the source Excel may have
            // rounded the original input, without changing its stored digits.
            warnings.add(c,layout.labels[c],number);
          return clean(restoreIdentifier(value,cell,number,{column:c,label:layout.labels[c]}));
        });
        if(invalidRow)return;
        if (!isRegistryDataRow(values) || !values[layout.mapping.meter] && !values[layout.mapping.account]) return;
        if (layout.flattened || layout.mapping.meter === undefined || layout.mapping.account === undefined) throw manualHeader();
        if (!count) {
          writer.add((sheetCount ? ',' : '') + JSON.stringify({ sheet: sheet.name, file: filename, layout }).slice(0, -1) + ',"rows":[');
          sheetCount++;
        }
        writer.add((count++ ? ',' : '') + JSON.stringify([number, values]));
      } });
      if (count) writer.add(']}');
      else skipped.push({ sheet: sheet.name, error: 'Нет строк с номером ПУ или ЛС.' });
    }
    if(invalid.count)throw new Error(`Проверка ключевых идентификаторов: ${invalid.count} некорректных ячеек. ${invalid.examples.join(' ')}${invalid.count>invalid.examples.length?` И ещё ${invalid.count-invalid.examples.length}.`:''}`);
    if (!sheetCount) throw new Error(skipped[0]?.error || 'В файле нет доступных строк реестра.');
    const notes=warnings.list();
    writer.add('],"skipped":' + JSON.stringify(skipped) + (notes.length?',"warnings":'+JSON.stringify(notes):'') + '}');
    return notes;
  } finally { try { writer?.close(); } finally { await workbook.close(); } }
}
