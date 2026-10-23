import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '@e965/xlsx';
import { parseMatrix, buildIndex, search, detectLayout, restoreNumericIdentifiers, identifierWarnings, unsafeNumericIdentifier, longNumericIdentifier, storedExcelInteger, restoreIdentifier, listTPs, metersByTP, analysisRecords } from '../public/core.js';
import { demo } from '../public/demo.js';
test('analysis registry transfer retains report address and provenance while excluding phones, notes and unrelated fields',()=>{
  const source=parseMatrix([['ЛС','Номер ПУ','ТУ','Адрес','Телефон','Примечание','Стороннее поле'],['001','0002','Точка','Город Тестовый, улица Учебная, 1','12345','Длинное примечание','Лишнее значение']],{file:'Тестовый реестр.xlsx',sheet:'Учебный лист'});
  const compact=analysisRecords(source.records);
  assert.equal(compact[0].fields.account,'001');assert.equal(compact[0].fields.meter,'0002');assert.equal(compact[0].fields.pointName,'Точка');
  assert.equal(compact[0].address,source.records[0].address);assert.equal(compact[0].address,'Город Тестовый, улица Учебная, 1');
  for(const key of ['file','sheet','row'])assert.equal(compact[0][key],source.records[0][key]);
  assert.equal(compact[0].file,'Тестовый реестр.xlsx');assert.equal(compact[0].sheet,'Учебный лист');assert.equal(compact[0].row,2);
  assert.deepEqual(Object.keys(compact[0]).sort(),['address','fields','file','row','sheet']);
  assert.deepEqual(Object.keys(compact[0].fields).sort(),['account','meter','name','point','pointName','pointNumber','power','tp','transformerRatio']);
  for(const key of ['note','phone','address','Стороннее поле'])assert.equal(key in compact[0].fields,false);
  assert.equal('values' in compact[0],false);assert.equal(JSON.stringify(compact).includes('Лишнее значение'),false);
  assert.equal(source.records[0].fields.note,'Длинное примечание');
});

test('leading zeroes, exact matches, duplicates and partial lookup', () => {
  const parsed = parseMatrix(demo.sheets[0].matrix);
  const index = buildIndex([parsed]);
  assert.equal(index.records.length, 4);
  assert.equal(search(index, { query: '00123456' }).total, 1);
  assert.equal(search(index, { query: '123456' }).total, 0);
  assert.equal(search(index, { query: ' 0012 3456 ' }).total, 1);
  assert.equal(search(index, { query: '00000001001', field: 'account' }).total, 2);
  assert.equal(search(index, { query: '1234', partial: true }).total, 2);
  assert.equal(search(index, { query: 'Сочи примерная 12', field: 'address' }).total, 2);
});
test('flattened two-level header matching the provided 1C structure', () => {
  const top = ['№ п/п', 'ТУ', 'Номер ТУСТЕК', 'Номер ТУ', 'ЛС / ЛС СТЕК', 'Наименование договора', 'Основные реквизиты', 'Адрес точки учета'];
  const lower = ['Субабонент', 'Состояние ТУ', 'Населенный пункт', 'Улица', 'Дом', 'Корпус', 'Квартира', 'Телефон', 'Подстанция', 'Фидер10', 'Опора 10Кв', 'ТП', 'Максимальная мощность', 'Вид счетчика', 'Номер счетчика', 'Коэффициент трансформации'];
  const row = ['1', 'Здание', '0000777', '', '000001001', 'Учебный абонент', '', 'Вкл', 'Сочи', 'Примерная', '12', '', '', '', 'ПС Пример', 'ВЛ-1', '', 'ТП-100', '15', 'РиМ', '00123456', '1'];
  const parsed = parseMatrix([['Отчёт'], [], top, lower, row]);
  assert.equal(parsed.layout.flattened, true);
  assert.equal(parsed.records[0].fields.meter, '00123456');
  assert.equal(parsed.records[0].fields.account, '000001001');
  assert.equal(parsed.records[0].fields.transformerRatio, '1');
  assert.equal(parsed.records[0].address, 'Сочи, Примерная, д. 12');
  assert.equal(parsed.records[0].values.length, row.length);
});
test('quick TT ratio comes from the meter group, with original values and empty cells preserved', () => {
  const rows = [
    ['ЛС', 'Характеристики ТН', 'Прибор учета', ''],
    ['', 'Коэффициент трансформации', 'Номер счетчика', 'Коэффициент трансформации'],
    ['001', '600', '005', '40'],
    ['002', '600', '006', 0],
    ['003', '600', '007', ''],
    ['004', '600', '008', '12,5'],
  ];
  const merges = [{s:{r:0,c:0},e:{r:1,c:0}}, {s:{r:0,c:2},e:{r:0,c:3}}];
  const parsed = parseMatrix(rows, {merges});
  assert.deepEqual(parsed.records.map(r=>r.fields.transformerRatio), ['40','0','','12,5']);
  assert.equal(search(buildIndex([parsed]),{query:'005'}).records[0].fields.transformerRatio,'40');
  const combined = parseMatrix([['ЛС','Номер ПУ','Прибор учёта\nКоэфициент трансформации'],['001','005','100/5']]);
  assert.equal(combined.records[0].fields.transformerRatio,'100/5');
});
test('native Excel merged headers retain positions and unknown fields', () => {
  const rows = [['Отчёт'], ['ЛС / ЛС СТЕК', 'Наименование договора', 'Прибор учета', '', 'Дополнительное поле'], ['', '', 'Вид счетчика', 'Номер счетчика'], ['00001001', 'Пример', 'РиМ', '00123456', 'Сохранить']];
  const merges = [{s:{r:1,c:0},e:{r:2,c:0}}, {s:{r:1,c:1},e:{r:2,c:1}}, {s:{r:1,c:2},e:{r:1,c:3}}, {s:{r:1,c:4},e:{r:2,c:4}}];
  const parsed = parseMatrix(rows, { merges });
  assert.equal(parsed.records[0].fields.meter, '00123456');
  assert.equal(parsed.records[0].fields.account, '00001001');
  assert.equal(parsed.records[0].values[4], 'Сохранить');
});
test('real XLSX decoding preserves padded and long numeric identifiers', () => {
  const ws = XLSX.utils.aoa_to_sheet([['ЛС','Номер счетчика'], [123456789012, 12345]]);
  ws.B2.z = '00000000'; delete ws.B2.w;
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, ws, 'Реестр');
  const decoded = XLSX.read(XLSX.write(book, {type:'buffer',bookType:'xlsx'}), {type:'buffer',cellNF:true});
  const sheet = decoded.Sheets['Реестр'];
  const matrix = XLSX.utils.sheet_to_json(sheet, {header:1,raw:false,defval:''});
  restoreNumericIdentifiers(matrix, sheet, detectLayout(matrix));
  const r = parseMatrix(matrix).records[0];
  assert.equal(r.fields.account, '123456789012'); assert.equal(r.fields.meter, '00012345');
});
test('import long numeric meter IDs without blocking the book; flag risky formats', () => {
  const ws=XLSX.utils.aoa_to_sheet([['ЛС','Номер счетчика'],['000001',10000000000000000]]);
  const matrix=XLSX.utils.sheet_to_json(ws,{header:1,raw:false});
  const warnings=identifierWarnings();
  restoreNumericIdentifiers(matrix,ws,detectLayout(matrix),warnings);
  const index=buildIndex([parseMatrix(matrix)]);
  assert.equal(index.records.length,1);
  assert.equal(index.records[0].fields.meter,'10000000000000000');
  assert.equal(search(index,{query:'10000000000000000'}).total,1);
  assert.match(warnings.list().join(' '),/Столбец B.*Номер счетчика.*Excel.*округлены/);
});
test('streamed numeric XML text is preserved despite JS Number rounding', () => {
  const original='9876543210123456789',approx=Number(original);
  assert.equal(Number.isSafeInteger(approx),false);
  assert.equal(storedExcelInteger(original),original);
  assert.equal(storedExcelInteger('9.876543210123456789E+18'),original);
  assert.equal(storedExcelInteger('1.2345e+3'),null);
  assert.equal(storedExcelInteger('1.2345e+6'),'1234500');
  assert.equal(storedExcelInteger('1e+999'),null);
  assert.equal(restoreIdentifier('9.87654E+18',{t:'n',v:approx,z:'General',raw:original}),original);
  assert.equal(restoreIdentifier('9.87654E+18',{t:'n',v:approx,z:'General',raw:'9.876543210123456789E+18'}),original);
});
test('confirmed 6003481006073610 stays intact even when the XLSX cell is numeric', () => {
  const number=6003481006073610;
  assert.equal(Number.isSafeInteger(number),true);
  assert.equal(unsafeNumericIdentifier({t:'n',v:number}),false);
  assert.equal(longNumericIdentifier({t:'n',v:number}),true);
  const ws=XLSX.utils.aoa_to_sheet([['ЛС','Номер счетчика'],['230703231250',number]]);
  const matrix=XLSX.utils.sheet_to_json(ws,{header:1,raw:false,defval:''});
  const warnings=identifierWarnings();
  restoreNumericIdentifiers(matrix,ws,detectLayout(matrix),warnings);
  const index=buildIndex([parseMatrix(matrix)]);
  assert.equal(index.records[0].fields.meter,'6003481006073610');
  assert.equal(search(index,{query:'6003481006073610'}).total,1);
  assert.match(warnings.list().join(' '),/Столбец B.*Номер счетчика.*Excel мог округлить/);
});
test('schema correction, empty rows, repeated headers, and zero are handled', () => {
  const rows = [['ЛС','Номер ПУ','Заметка'], ['a','b','0'], [], ['ЛС','Номер ПУ','Заметка'], ['c','d',0]];
  const parsed = parseMatrix(rows, {overrides:{meter:0,account:1}});
  assert.equal(parsed.records.length, 2); assert.equal(parsed.records[0].fields.meter, 'a'); assert.equal(parsed.records[1].values[2], '0');
});
test('25,000 rows across sheets are indexed and paginated correctly', () => {
  const extras = Array.from({length:42},(_,i)=>`Поле ${i+4}`);
  const rows = [['ЛС','Номер счетчика','ФИО',...extras], ...Array.from({length:25000},(_,i)=>[String(100000+i),String(i).padStart(8,'0'),'Пример',...extras.map((_,j)=>j%2?'':'Значение')])];
  const start = performance.now();
  const a = parseMatrix(rows,{sheet:'А'}), b = parseMatrix([rows[0],rows[1]],{sheet:'Б'});
  const index = buildIndex([a,b]);
  const result = search(index,{query:'00024999'});
  assert.equal(result.records[0].fields.account,'124999');
  assert.equal(search(index,{query:'00000000'}).total,2);
  const page = search(index,{query:'000',partial:true,offset:30,limit:30});
  assert.equal(page.records.length,30);
  console.log(`25,001 rows: parse + index + exact lookup ${(performance.now()-start).toFixed(1)} ms (Node, not phone benchmark)`);
});
test('TP count deduplicates meters across sheets but retains accounts, points and source rows', () => {
  const head = ['ЛС','Номер ПУ','ТП','ТУ','Номер ТУСТЕК','Номер ТУ'];
  const a = parseMatrix([head,
    ['001','00001','ТП-10','Здание','000701','77'],
    ['001','00002','ТП-10','Второй ввод','000702','78'],
    ['002','','ТП-10','Без ПУ','000703','79'],
    ['003','00001','ТП-2','Другой источник','000704','80'],
    ['004','00004','','Без ТП','000705','81']], {sheet:'А'});
  const b = parseMatrix([head, ['005','000 01',' тп-10 ','Пристройка','000706','82']], {sheet:'Б'});
  const index = buildIndex([a,b]), tps = listTPs(index);
  assert.deepEqual(tps.map(t=>[t.name,t.total,t.missingMeters]), [['ТП-2',1,0],['ТП-10',2,1]]);
  const result = metersByTP(index,{key:'тп-10'});
  assert.equal(result.total,2); assert.equal(result.missingMeters,1);
  assert.equal(result.meters[0].meter,'00001');
  assert.deepEqual(result.meters[0].variants.map(v=>[v.account,v.point,v.pointName]), [['001','000701','Здание'],['005','000706','Пристройка']]);
  assert.equal(result.meters[1].variants[0].account,'001');
  assert.equal(search(index,{query:'0000',partial:true}).total,5);
  assert.throws(()=>metersByTP(index,{key:'нет'}),/ТП не найдена/);
});
test('a 200-meter TP register paginates without losing or counting repeated rows', () => {
  const rows = [['ЛС','Номер ПУ','ТП'], ...Array.from({length:200},(_,i)=>['001',String(i).padStart(8,'0'),'ТП-1'])];
  rows.push(rows[1]);
  const index=buildIndex([parseMatrix(rows)]);
  const a=metersByTP(index,{key:'тп-1'}), b=metersByTP(index,{key:'тп-1',offset:100});
  assert.equal(a.total,200); assert.equal(a.meters.length,100); assert.equal(b.meters.length,100);
  assert.equal(new Set([...a.meters,...b.meters].map(m=>m.meter)).size,200);
  assert.equal(a.meters[0].variants.length,2);
  const filtered=metersByTP(index,{key:'тп-1',query:'00000199'});
  assert.equal(filtered.totalInTP,200); assert.equal(filtered.total,1);
  assert.equal(filtered.meters[0].meter,'00000199');
  assert.equal(metersByTP(index,{key:'тп-1',query:'несуществующий'}).total,0);
});
