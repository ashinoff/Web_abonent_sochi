export const clean = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
export const norm = value => clean(value).toLocaleLowerCase('ru').replace(/ё/g, 'е');
export const idKey = value => norm(value).replace(/\s+/g, '');
const aliases = {
  meter: ['номер счетчика', 'заводской номер счетчика', 'номер пу', 'заводской номер пу', 'серийный номер', 'счетчик номер'],
  account: ['лс / лс стек', 'лс', 'л/с', 'лицевой счет', 'номер лс', 'номер лицевого счета', 'лс стек'],
  name: ['наименование договора', 'фио', 'абонент', 'наименование абонента', 'потребитель', 'наименование потребителя'],
  locality: ['населенный пункт', 'город', 'н.п.'], street: ['улица'], house: ['дом', 'номер дома'],
  building: ['корпус'], flat: ['квартира', 'кв.'], address: ['адрес', 'адрес точки учета', 'адрес объекта'],
  phone: ['телефон', 'контактный телефон'], status: ['состояние ту', 'статус', 'состояние'],
  model: ['вид счетчика', 'тип счетчика', 'модель счетчика', 'тип пу'],
  receipt: ['показания с квитанции показания', 'показания с квитанции'],
  note: ['примечание', 'примечания'],
  latitude: ['широта', 'latitude'], longitude: ['долгота', 'longitude'],
  transformerRatio: ['коэффициент трансформации', 'коэфициент трансформации', 'коэф. трансформации', 'коэф трансформации', 'коэффициент трансформации тт', 'коэф тт', 'коэф. тт', 'прибор учета коэффициент трансформации', 'прибор учета коэфициент трансформации'],
  station: ['подстанция', 'пс'], feeder: ['фидер10', 'фидер 10', 'фидер'], tp: ['тп'],
  power: ['максимальная мощность', 'мощность'], point: ['номер тустек', 'номер ту стек', 'номер точки учета', 'код точки учета'],
  pointNumber: ['номер ту', '№ ту'], pointName: ['ту', 'точка учета', 'наименование ту', 'наименование точки учета', 'объект учета'],
};
// Header names are fixed. A registry can contain millions of values: do not
// rebuild and traverse the complete alias list for every source cell.
const aliasFields = new Map();
for (const [key, options] of Object.entries(aliases)) for (const option of options) if (!aliasFields.has(option)) aliasFields.set(option, key);
export function fieldKey(label) {
  const parts = norm(label).split(' · ').reverse();
  for (const part of parts) {
    if (/^примечани[ея](?: \(\d+\))?$/.test(part)) return 'note';
    const key = aliasFields.get(part);
    if (key) return key;
  }
  return null;
}
function headerScore(row) {
  const keys = new Set(row.map(fieldKey).filter(Boolean));
  return (keys.has('meter') ? 7 : 0) + (keys.has('account') ? 7 : 0) + Math.min(keys.size, 6);
}
export function detectLayout(matrix, merges = []) {
  // Header detection never needs a cleaned copy of the entire registry.
  const rows = matrix.slice(0, 96).map(row => row.map(clean));
  let start = -1, best = 0;
  for (let i = 0; i < Math.min(rows.length, 80); i++) {
    const score = headerScore(rows[i]);
    if (score > best) { best = score; start = i; }
  }
  if (start < 0 || best < 8) throw new Error('Не найдена шапка с номером ПУ или лицевым счётом. Проверьте, что выбран реестр абонентов.');
  // A flattened two-line 1C header loses its merged-cell offsets when copied.
  // Recognize this exact layout; do not apply a blind fixed-column mapping.
  let flattened = false;
  const flattenedTop = r => r >= 0 && norm(rows[r + 1]?.[0]) === 'субабонент' && fieldKey(rows[r]?.[4]) === 'account' && norm(rows[r]?.[5]) === 'наименование договора';
  if (!merges.length && flattenedTop(start)) flattened = true;
  else if (!merges.length && flattenedTop(start - 1)) { start--; flattened = true; }
  let end = start;
  if (flattened) end = start + 1;
  else {
    // Select the top of a merged header block if the most descriptive row is below it.
    const enclosing = merges.filter(m => m.s.r <= start && m.e.r >= start && m.e.r - m.s.r < 6);
    if (enclosing.length) start = Math.min(start, ...enclosing.map(m => m.s.r));
    end = Math.max(end, ...merges.filter(m => m.s.r >= start && m.s.r <= end && m.e.r - m.s.r < 6).map(m => m.e.r));
    while (end + 1 < rows.length && end - start < 4 && headerScore(rows[end + 1]) >= 8 && !/^\d+$/.test(rows[end + 1][0] || '')) end++;
  }
  const width = Math.max(0, ...rows.slice(start, Math.min(rows.length, end + 11)).map(r => r.length));
  if (width > 256) throw new Error('В реестре больше 256 столбцов. Удалите лишние столбцы из выгрузки.');
  let labels;
  if (flattened) {
    labels = [...rows[start].slice(0, 6), ...rows[start + 1]];
  } else {
    labels = Array.from({ length: width }, (_, c) => {
      const parts = [];
      for (let r = start; r <= end; r++) {
        const merge = merges.find(m => m.s.r <= r && m.e.r >= r && m.s.c <= c && m.e.c >= c);
        const text = merge ? rows[merge.s.r]?.[merge.s.c] : rows[r]?.[c];
        if (text && !parts.includes(text)) parts.push(text);
      }
      return parts.join(' · ');
    });
  }
  labels = Array.from({ length: width }, (_, c) => labels[c] || `Столбец ${columnName(c)}`);
  const seen = new Map();
  labels = labels.map(label => { const n = (seen.get(label) || 0) + 1; seen.set(label, n); return n === 1 ? label : `${label} (${n})`; });
  const mapping = {};
  labels.forEach((label, c) => { const key = fieldKey(label); if (key && mapping[key] === undefined) mapping[key] = c; });
  // The requested quick value belongs to the meter section, not a similarly named TN field.
  const meterRatio = labels.findIndex(label => norm(label).includes('прибор учета') && fieldKey(label) === 'transformerRatio');
  if (meterRatio >= 0) mapping.transformerRatio = meterRatio;
  return { start, end, labels, mapping, flattened };
}
export function columnName(n) { let result = ''; for (n++; n; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result; return result; }
export function identifierColumns(layout) {
  const columns = new Set(['meter', 'account', 'point', 'pointNumber', 'phone'].map(key => layout.mapping[key]).filter(Number.isInteger));
  for (const [c, label] of layout.labels.entries()) if (/номер|телефон|лицевой|^лс/i.test(label)) columns.add(c);
  return columns;
}
// Long numeric serials are not a reason to discard tens of thousands of
// otherwise valid subscribers. The stored XLSX XML number is authoritative
// for what this file contains, although Excel may already have rounded the
// original data before saving it.
export const unsafeNumericIdentifier = cell => cell?.t === 'n' && Number.isInteger(cell.v) &&
  !Number.isSafeInteger(cell.v);
export const longNumericIdentifier = cell => cell?.t === 'n' && Number.isInteger(cell.v) &&
  Math.abs(cell.v) >= 1e15;

// Expand Excel's stored decimal/scientific notation using string operations,
// never IEEE-754 number arithmetic. This preserves the numeric *value stored
// in the XLSX XML* even if JS Number cannot represent it precisely. It cannot
// recover digits Excel rounded before writing the XML.
export function storedExcelInteger(raw) {
  const match=/^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(raw??'').trim());
  if(!match)return null;
  const [,sign,whole,fraction='',exponent='0']=match;
  const shift=Number(exponent),digits=whole+fraction;
  if(!Number.isSafeInteger(shift)||Math.abs(shift)>128||digits.length>128)return null;
  const point=whole.length+shift;
  let integer;
  if(point>=digits.length)integer=digits+'0'.repeat(point-digits.length);
  else if(point>0) {
    if(!/^0*$/.test(digits.slice(point)))return null;
    integer=digits.slice(0,point);
  }else {
    if(!/^0*$/.test(digits))return null;
    integer='0';
  }
  integer=integer.replace(/^0+(?=\d)/,'');
  return sign==='-'&&integer!=='0'?'-'+integer:integer;
}
// Aggregate short warnings by source column instead of blocking an entire
// registry for one long numeric meter. Do not imply that the pre-Excel number
// has been verified or that previously rounded digits can be recovered.
export function identifierWarnings() {
  const affected=new Map();
  return {
    add(column,label,row) {
      let item=affected.get(column);
      if(!item){item={label,count:0,examples:[]};affected.set(column,item);}
      item.count++;
      if(item.examples.length<4)item.examples.push(row);
    },
    list() {
      return [...affected].map(([column,item])=>
        `Столбец ${columnName(column)} («${item.label}»): ${item.count} длинных числовых номеров импортированы в виде, записанном в Excel. Исходные цифры могли быть округлены при экспорте. Примеры строк: ${item.examples.join(', ')}. При необходимости сверьте с первичной системой.`);
    },
  };
}
export function restoreIdentifier(value,cell) {
  if(cell?.t!=='n'||!Number.isInteger(cell.v))return value;
  // In streaming XLSX, cell.raw is the actual XML <v> text; for legacy XLS
  // the parser can only supply its decoded numeric representation.
  const stored=storedExcelInteger(cell.raw??String(cell.v));
  if(unsafeNumericIdentifier(cell)) {
    if(!stored)return clean(value)||String(cell.v);
    // Preserve a deliberate all-zero Excel formatting mask for serials.
    return /^0+$/.test(cell.z||'')&&cell.z.length>stored.length
      ?stored.padStart(cell.z.length,'0'):stored;
  }
  return /e[+-]\d+/i.test(String(value)) || !cell.z || cell.z==='General'
    ?stored??String(cell.v):value;
}
export function isRegistryDataRow(values) {
  return values.some(Boolean) && headerScore(values) < 8 && !/^(итого|всего)(\s|$)/i.test(values[0]);
}
export function restoreNumericIdentifiers(matrix,worksheet,layout,warnings=identifierWarnings()) {
  // XLS / non-streaming fallback. Preserve the numeric value available from
  // the decoder, flag questionable long identifiers, never reject the book.
  const columns=identifierColumns(layout);
  for(let r=layout.end+1;r<matrix.length;r++)for(const c of columns) {
    const cell=worksheet['!data']?worksheet['!data'][r]?.[c]:worksheet[`${columnName(c)}${r+1}`];
    if(longNumericIdentifier(cell))warnings.add(c,layout.labels[c],r+1);
    const value=restoreIdentifier(matrix[r]?.[c],cell);
    if(value!==matrix[r]?.[c])matrix[r][c]=value;
  }
  return matrix;
}
export function parseMatrix(matrix, { sheet = 'Лист1', file = '', merges = [], overrides = null } = {}) {
  const layout = detectLayout(matrix, merges);
  if (overrides) {
    for (const key of ['meter', 'account']) {
      delete layout.mapping[key];
      if (Number.isInteger(overrides[key]) && overrides[key] >= 0) layout.mapping[key] = overrides[key];
    }
  }
  if (layout.mapping.meter === undefined && layout.mapping.account === undefined) throw new Error('Укажите столбец номера ПУ или лицевого счёта.');
  const records = [];
  for (let r = layout.end + 1; r < matrix.length; r++) {
    const values = Array.from({ length: layout.labels.length }, (_, c) => clean(matrix[r]?.[c]));
    if (!isRegistryDataRow(values)) continue;
    const record = recordFromValues(values, layout, sheet, file, r + 1);
    if (!record.fields.meter && !record.fields.account) continue;
    records.push(record);
  }
  return { records, layout, sheet, file, sample: records.slice(0, 3).map(r => r.values) };
}
export function recordFromValues(values, layout, sheet, file, row) {
    const get = key => values[layout.mapping[key]] || '';
    const address = [get('locality'), get('street'), get('house') && `д. ${get('house')}`, get('building') && `корп. ${get('building')}`, get('flat') && `кв. ${get('flat')}`].filter(Boolean).join(', ') || get('address');
    const fields = Object.fromEntries(Object.keys(layout.mapping).map(key => [key, get(key)]));
    return { id: `${sheet}:${row}`, row, sheet, file, values, fields, address, meterKey: idKey(get('meter')), accountKey: idKey(get('account')), addressKey: norm(address) };
}
export function buildIndex(sheets) {
  const records = sheets.flatMap(s => s.records);
  // Count populated source cells, without deduplicating meters, accounts or text.
  const notes = [];
  let hasNotesColumn = false;
  for (const sheet of sheets) {
    const columns = sheet.layout.labels.flatMap((label, c) => fieldKey(label) === 'note' ? [c] : []);
    hasNotesColumn ||= columns.length > 0;
    for (const record of sheet.records) for (const c of columns) {
      const note = clean(record.values[c]);
      if (note) notes.push({ id: record.id, fields: record.fields, address: record.address, sheet: record.sheet, row: record.row, note });
    }
  }
  const meter = new Map(), account = new Map(), tp = new Map();
  records.forEach((record, index) => {
    for (const [map, key] of [[meter, record.meterKey], [account, record.accountKey]]) {
      if (key) { const ids = map.get(key) || []; ids.push(index); map.set(key, ids); }
    }
    const tpKey = norm(record.fields.tp);
    if (tpKey) {
      if (!tp.has(tpKey)) tp.set(tpKey, { key: tpKey, name: record.fields.tp, meters: new Map(), missingMeters: 0 });
      const group = tp.get(tpKey);
      if (!record.meterKey) group.missingMeters++;
      else {
        if (!group.meters.has(record.meterKey)) group.meters.set(record.meterKey, []);
        group.meters.get(record.meterKey).push(index);
      }
    }
  });
  return { records, meter, account, tp, notes, hasNotesColumn };
}
export function listNotes(index, { query = '', offset = 0, limit = 100 } = {}) {
  const q = norm(query);
  const found = index.notes.filter(r => !q || norm([r.note, r.fields.meter, r.fields.account, r.fields.name, r.fields.tp, r.fields.point, r.fields.pointNumber, r.fields.pointName, r.address].filter(Boolean).join(' ')).includes(q));
  return { total: found.length, totalInRegistry: index.notes.length, notes: found.slice(offset, offset + Math.min(limit, 200)) };
}
export function listMapNotes(index) {
  const fields = ['meter','account','name','tp','point','pointNumber','pointName','locality','street','house','building','latitude','longitude'];
  return index.notes.map(note => ({ ...note, fields:Object.fromEntries(fields.filter(key => note.fields[key]).map(key => [key,note.fields[key]])) }));
}
export function notificationRecord(index, fields = {}) {
  if (!fields.meter && !fields.account) throw new Error('Нет номера ПУ или лицевого счёта.');
  const keys=['meter','account',...(fields.point || fields.pointNumber ? ['point','pointNumber'] : ['pointName'])].filter(key=>fields[key]);
  const records=index.records.filter(record=>keys.every(key=>idKey(record.fields[key])===idKey(fields[key])));
  if (!records.length) throw new Error('Потребитель этой отметки не найден в текущем реестре. Возможно, реестр обновился.');
  return { id:records[0].id,variants:records.map(record=>({id:record.id,account:record.fields.account || '',point:record.fields.point || record.fields.pointNumber || '',pointName:record.fields.pointName || '',sheet:record.sheet,row:record.row})) };
}
// Only these fields are needed to relate consumption to registry points.
export function analysisRecords(records) {
  const keys = ['account', 'point', 'pointNumber', 'pointName', 'meter', 'tp', 'power', 'name', 'transformerRatio'];
  return records.map(record => ({ fields: Object.fromEntries(keys.map(key => [key, record.fields[key] ?? ''])), address: record.address || '', file: record.file || '', sheet: record.sheet || '', row: record.row }));
}
export function listTPs(index) {
  return [...index.tp.values()].map(({ key, name, meters, missingMeters }) => ({ key, name, total: meters.size, missingMeters }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
}
export function metersByTP(index, { key, query = '', offset = 0, limit = 100 }) {
  const tp = index.tp.get(key);
  if (!tp) throw new Error('ТП не найдена в текущем реестре.');
  const q = norm(query), numberQuery = idKey(query);
  const groups = [...tp.meters.values()].filter(ids => !q || ids.some(i => {
    const r = index.records[i];
    return r.meterKey.includes(numberQuery) || r.accountKey.includes(numberQuery) || norm([r.fields.point, r.fields.pointNumber, r.fields.pointName, r.fields.name, r.address].filter(Boolean).join(' ')).includes(q);
  })).sort((a, b) => index.records[a[0]].fields.meter.localeCompare(index.records[b[0]].fields.meter, 'ru', { numeric: true }));
  return { key: tp.key, name: tp.name, total: groups.length, totalInTP: tp.meters.size, missingMeters: tp.missingMeters,
    meters: groups.slice(offset, offset + Math.min(limit, 200)).map(ids => {
      const rows = ids.map(i => index.records[i]);
      return { meter: rows[0].fields.meter, variants: rows.map(r => ({ id: r.id, account: r.fields.account || '', point: r.fields.point || r.fields.pointNumber || '', pointName: r.fields.pointName || '', name: r.fields.name || '', address: r.address, sheet: r.sheet, row: r.row })) };
    }) };
}
export function search(index, { query, field = 'meter', partial = false, offset = 0, limit = 30 }) {
  if (!['meter', 'account', 'address'].includes(field)) throw new Error('Неизвестное поле поиска.');
  const q = field === 'address' ? norm(query) : idKey(query);
  if (!q) return { total: 0, records: [] };
  let matches;
  if (field !== 'address' && !partial) matches = (index[field].get(q) || []).map(i => index.records[i]);
  else matches = index.records.filter(r => field === 'address' ? q.split(' ').every(word => r.addressKey.includes(word)) : r[`${field}Key`].includes(q));
  return { total: matches.length, records: matches.slice(offset, offset + limit) };
}
