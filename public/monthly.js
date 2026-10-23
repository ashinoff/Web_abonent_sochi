import { clean, norm, idKey, columnName, restoreIdentifier } from './core.js';

export const MONTHLY_PARSER_VERSION = 3;
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма[йя]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
export const tpKey = value => norm(value).replace(/[‐‑–—]/g, '-').replace(/\s+/g, '');
// A STEK identifier alone does not distinguish all TUs in these exports.
// Keep the local TU number and its name instead of discarding them as fallbacks.
const pointParts = row => [idKey(row.pointNumber), idKey(row.point), norm(row.pointName)];
export function pointKey(row) {
  const parts = pointParts(row);
  return parts.some(Boolean) ? JSON.stringify(parts) : '';
}
export function accountPointKey(row) {
  const point = pointKey(row);
  return point ? JSON.stringify([row.accountKey || idKey(row.account), point]) : '';
}
export function samePoint(a, b) {
  const left = pointParts(a), right = pointParts(b);
  const shared = left.map((value, i) => value && right[i] ? i : -1).filter(i => i >= 0);
  return shared.length > 0 && shared.every(i => left[i] === right[i]);
}
export function selectPointRows(rows, selector) {
  if (!pointKey(selector)) throw new Error('В карточке не указана ТУ. Проверьте столбцы «ТУ», «Номер ТУ» и «Номер ТУСТЕК» в реестре.');
  const matches = rows.filter(row => samePoint(row, selector));
  if (!matches.length) throw new Error('Связка ЛС + ТУ не найдена в файле потребления. Проверьте номер и наименование ТУ в обоих файлах.');
  if (new Set(matches.map(pointKey)).size > 1) throw new Error('Этому ЛС и данным ТУ соответствуют несколько точек. Уточните номер или наименование ТУ в реестре.');
  return matches;
}
export function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = clean(value).replace(/[\s\u202f]/g, '').replace(/−/g, '-').replace(',', '.');
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s) && Number.isFinite(Number(s)) ? Number(s) : null;
}
function month(value) {
  const s = norm(value).replace(/<br\s*\/?>/g, ' ');
  if (/всего/.test(s)) return null;
  for (let m = 0; m < 12; m++) if (new RegExp('(?:^|[^а-я])' + MONTHS[m] + '[а-я]*(?=$|[^а-я])').test(s)) return { m, y: Number(s.match(/20\d{2}/)?.[0]) || null };
  const hit = s.match(/^(?:(20\d{2})[.\/-](\d{1,2})|(\d{1,2})[.\/-](20\d{2}))$/);
  if (hit) { const m = Number(hit[2] || hit[3]) - 1; if (m >= 0 && m < 12) return { m, y: Number(hit[1] || hit[4]) }; }
  return null;
}
function periodFromTitle(rows) {
  for (const row of rows) {
    // A report title may occupy a merged cell or several adjacent cells.
    const s = norm(row.join(' ')); if (!/полезный отпуск|за период|период/.test(s)) continue;
    const named = [...s.matchAll(new RegExp('(' + MONTHS.join('|') + ')[а-я]*\\s+(20\\d{2})', 'g'))];
    if (named.length >= 2) return [month(named[0][0]), month(named[named.length - 1][0])];
  }
  return null;
}
// The 1C/СТЕК ПО export uses "Договор" and "Договор СТЕК" rather
// than the previous "ЛС / Номер договора" and "Лицевой счёт СТЕК".
// The mapping is shared by the existing XLS decoder and the XLSX stream reader.
const accountHeader = s => /^(лс\s*\/\s*номер договора|лс|лс\s*\/\s*лс стек|номер договора|лицевой счет|договор)$/.test(norm(s));
export const isMonthlyHeader = row => row.some(accountHeader) && row.some(v => month(v));
const worksheetCell = (ws, r, c) => ws?.['!data'] ? ws['!data'][r]?.[c] : ws?.[columnName(c)+(r+1)];
export function monthlyLayout(top) {
  const h=top.findIndex(isMonthlyHeader);
  if(h<0)throw new Error('Не найдена шапка с договором/лицевым счётом и помесячным полезным отпуском.');
  const header=top[h].map(clean);
  const cols=header.map((v,c)=>({...month(v),c})).filter(v=>v.m!=null);
  if(!cols.length)throw new Error('Нет столбцов с месяцами.');
  const period=periodFromTitle(top.slice(0,h));
  const explicit=cols.findIndex(c=>c.y!=null);
  let start=period?period[0].y*12+period[0].m:null;
  if(start==null&&explicit>=0)start=cols[explicit].y*12+cols[explicit].m-explicit;
  if(start==null)throw new Error('В шапке нет года. Укажите период отчёта (например, Июнь 2024 — Август 2026) или год каждого месяца.');
  const months=cols.map((c,i)=>{
    const n=start+i,y=Math.floor(n/12),m=n%12;
    if(c.m!==m||(c.y!=null&&c.y!==y))
      throw new Error('Месяцы в шапке не совпадают с периодом отчёта или идут с пропуском. Проверьте годы и порядок столбцов.');
    return {y,m};
  });
  if(period&&period[1].y*12+period[1].m!==start+cols.length-1)
    throw new Error('Количество месячных столбцов не совпадает с периодом в заголовке.');
  const find=rx=>header.findIndex(v=>rx.test(norm(v)));
  const c={
    account:header.findIndex(accountHeader),
    alias:find(/^(лицевой счет стек|лс стек|договор стек)$/),
    point:find(/^(номер точки учета стек|точка учета стек|номер ту\s*стек)$/),
    pointNumber:find(/^(№\s*ту|номер ту|точка учета)$/),
    name:find(/^наименование договора$/),
    pointName:find(/^(фио\s*\/\s*наименование точки учета|ту|наименование ту|наименование точки учета)$/),
    tp:find(/^тп(?:\s*10\s*\/\s*0[.,]4)?$/),
    zone:find(/^(тарифная зона|дифференциация по зонам суток|дифференцация по зонам суток)$/),
    off:find(/^откл$/),
  };
  return {h,cols,months,c,totalCol:find(/^всего.*по/)};
}
function monthlyIdentifier(row,r,col,cellAt) {
  if(col<0)return '';
  const cell=cellAt(r,col),value=cell?.t==='n'?cell.v:row[col];
  if(typeof value==='number'){
    // Use the same nonblocking identifier policy as the registry. XLSX stream
    // cells also carry their original XML number text to avoid JS rounding.
    return clean(restoreIdentifier(String(value),cell||{t:'n',v:value}));
  }
  return clean(value);
}
export function monthlyRecord(row,r,layout,{sheet='Лист1',cellAt=()=>null}={}) {
  const {c,cols,totalCol}=layout;
  const contract=monthlyIdentifier(row,r,c.account,cellAt),alias=monthlyIdentifier(row,r,c.alias,cellAt);
  const account=contract||alias;
  if(!account||/^(итого|всего|лс\b|лицевой счет)/i.test(account))return {record:null,invalid:0,totalsMismatch:0,fallback:0};
  if(!/\d/.test(account))return {record:null,invalid:1,totalsMismatch:0,fallback:0};
  let invalid=0;
  const values=cols.map(({c})=>{
    const value=cellAt(r,c)?.v??row[c],n=numeric(value);
    if(n==null&&clean(value)&&!/^[-—–]$/.test(clean(value)))invalid++;
    return n;
  });
  const total=totalCol<0?null:numeric(row[totalCol]);
  const totalsMismatch=total!=null&&values.every(v=>v!=null)&&Math.abs(total-values.reduce((s,v)=>s+v,0))>0.05?1:0;
  const record={
    account,accountKey:idKey(account),alias,accountFallback:!contract,
    point:monthlyIdentifier(row,r,c.point,cellAt),
    pointNumber:monthlyIdentifier(row,r,c.pointNumber,cellAt),
    name:clean(row[c.name]),pointName:clean(row[c.pointName]),tp:clean(row[c.tp]),
    zone:clean(row[c.zone]),off:clean(row[c.off]),values,source:sheet+':'+(r+1),
  };
  return {record,invalid,totalsMismatch,fallback:!contract?1:0};
}
export function monthlyWarnings({invalid=0,totalsMismatch=0,fallback=0}={}) {
  const warnings=[];
  if(invalid)warnings.push('Нераспознанных значений или строк: '+invalid+'. Пустые/нечисловые объёмы не считаются нулями.');
  if(totalsMismatch)warnings.push('У '+totalsMismatch+' строк итог не совпадает с суммой месяцев; использованы месячные столбцы.');
  if(fallback)warnings.push('Строки без номера договора сохранены по лицевому счёту СТЕК: '+fallback+'.');
  return warnings;
}
export function parseMonthlyMatrix(matrix,options={}) {
  return parseMonthlyRows(matrix.length,r=>matrix[r]||[],options);
}
function parseMonthlyRows(rowCount,rowAt,{sheet='Лист1',worksheet=null,headerAt=rowAt}={}) {
  const top=Array.from({length:Math.min(80,rowCount)},(_,r)=>headerAt(r));
  const layout=monthlyLayout(top),rows=[];
  const count={invalid:0,totalsMismatch:0,fallback:0};
  let hasVolume=false;
  const cellAt=(r,c)=>worksheetCell(worksheet,r,c);
  for(let r=layout.h+1;r<rowCount;r++){
    const row=rowAt(r);
    if(!row.some(v=>clean(v)))continue;
    const result=monthlyRecord(row,r,layout,{sheet,cellAt});
    count.invalid+=result.invalid;count.totalsMismatch+=result.totalsMismatch;count.fallback+=result.fallback;
    if(!result.record)continue;
    hasVolume||=result.record.values.some(v=>v!=null);
    rows.push(result.record);
  }
  if(!rows.length)throw new Error('Нет строк с лицевыми счетами.');
  if(!hasVolume)throw new Error('Нет числовых месячных объёмов потребления.');
  return {months:layout.months,rows,warnings:monthlyWarnings(count)};
}
export function readMonthlyWorkbook(buffer, XLSX) {
  const bytes = new Uint8Array(buffer);
  const valid = [0xd0,0xcf,0x11,0xe0].every((v,i) => bytes[i] === v) || bytes[0] === 0x50 && bytes[1] === 0x4b || bytes[0] === 9 && [0,2,4,8].includes(bytes[1]);
  if (!valid) throw new Error('Выберите книгу Excel в формате XLS или XLSX.');
  const book = XLSX.read(buffer, { type: 'array', dense: true, cellHTML: false, cellNF: true, cellText: false, cellFormula: false, sheetRows: 100002 });
  let result = null; const errors = [];
  for (const name of book.SheetNames) {
    const ws = book.Sheets[name]; if (!ws?.['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    if (range.e.r > 100000 || range.e.c > 255 || ws['!fullref']) throw new Error('Максимум 100 000 строк и 256 столбцов на лист.');
    // Read raw cells a row at a time; do not allocate a second formatted matrix.
    const rowAt = r => Array.from({ length: range.e.c + 1 }, (_, c) => worksheetCell(ws, r, c)?.v ?? '');
    // Format the small header only, including Excel dates displayed as MM/YYYY.
    const headerAt = r => Array.from({ length: range.e.c + 1 }, (_, c) => {
      const cell = worksheetCell(ws, r, c); return cell ? XLSX.utils.format_cell(cell) : '';
    });
    let part;
    try { part = parseMonthlyRows(range.e.r + 1, rowAt, { sheet: name, worksheet: ws, headerAt }); }
    catch (error) {
      // Non-report helper sheets can be skipped. A recognized but invalid report cannot.
      if (!/Не найдена шапка/.test(error.message)) throw new Error(`Лист «${name}»: ${error.message}`);
      errors.push(`Лист «${name}» пропущен: ${error.message}`); continue;
    } finally { delete book.Sheets[name]; }
    if (result && JSON.stringify(result.months) !== JSON.stringify(part.months)) throw new Error('Листы содержат разные периоды отчёта. Оставьте один согласованный период.');
    if (!result) result = part; else { for (const row of part.rows) result.rows.push(row); result.warnings.push(...part.warnings); }
  }
  if (!result) throw new Error(errors[0] || 'Книга не содержит данных.');
  result.warnings.push(...errors);
  return result;
}
// Each report row is an additive input/meter volume, including equal rows of
// the same LS + TU. Keep all rows and their origins; strictSum combines them
// month by month when analysing a TU, account or the selected TP contour.
export function indexMonthly(parsed) {
  const accounts = new Map(), aliases = new Map();
  // A missing contract does not erase a household's monthly volumes. If this
  // STEK LS has exactly one explicit contract elsewhere, retain all its input
  // rows under that contract. Never use a TU's STEK number as an account alias.
  const explicit = new Map(), contractNames = new Map();
  for (const row of parsed.rows) if (!row.accountFallback) {
    contractNames.set(row.accountKey, row.account);
    const alias = idKey(row.alias);
    if (!alias) continue;
    if (!explicit.has(alias)) explicit.set(alias, new Set());
    explicit.get(alias).add(row.accountKey);
  }
  const rows = parsed.rows.map(row => {
    const choices = row.accountFallback && explicit.get(idKey(row.alias));
    if (choices?.size !== 1) return row;
    const key = [...choices][0];
    return { ...row, accountKey: key, account: contractNames.get(key) };
  });
  for (const row of rows) {
    if (!accounts.has(row.accountKey)) accounts.set(row.accountKey, []);
    accounts.get(row.accountKey).push(row);
    for (const alias of [row.accountKey, idKey(row.alias)].filter(Boolean)) {
      if (!aliases.has(alias)) aliases.set(alias, new Set()); aliases.get(alias).add(row.accountKey);
    }
  }
  return { ...parsed, rows, accounts, aliases };
}
export function strictSum(rows, n) {
  return Array.from({ length: n }, (_, i) => rows.length && rows.every(r => r.values[i] != null) ? rows.reduce((s, r) => s + r.values[i], 0) : null);
}
