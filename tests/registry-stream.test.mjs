import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from '@e965/xlsx';
import { writeRegistryXLSX } from '../registry-stream.mjs';
import { prepareWorkbook } from '../prepared-workbook.mjs';
import { preparationChildFlags } from '../prepared-service.mjs';
import { unpackRegistry } from '../public/prepared-data.js';
import { buildIndex, search, listNotes } from '../public/core.js';

async function fixture(t, sheets, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'registry-stream-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  if (options.date1904) book.Workbook = { WBProps: { date1904: true } };
  options.mutate?.(book);
  const bytes = XLSX.write(book, { type: 'buffer', bookType: options.bookType || 'xlsx', bookSST: options.shared, cellDates: options.cellDates });
  const path = join(dir, 'source.xlsx'), output = join(dir, 'package.json');
  await writeFile(path, bytes);
  return { dir, path, output, bytes };
}

const simpleHeader = ['Номер счетчика', 'ЛС', 'Наименование договора', 'ТУ', 'ТП', 'Адрес', 'Примечание'];
for (const shared of [false, true]) for (const date1904 of [false, true]) {
  test(`streaming registry matches every SheetJS field: shared=${shared}, date1904=${date1904}`, async t => {
    const top = ['№ п/п', 'ТУ', 'Номер ТУСТЕК', 'Номер ТУ', 'ЛС / ЛС СТЕК', 'Наименование договора', 'Основные реквизиты', '', 'Адрес точки учета', '', '', 'Прибор учета', '', '', 'События', '', 'Характеристики ТТ', '', 'Примечание', 'Примечание', 'Другой столбец', 'Дата', 'Число', 'Показания', 'Формула', 'Логическое', 'Ошибка'];
    const lower = ['', '', '', '', '', '', 'Состояние ТУ', 'Комментарий', 'Населенный пункт', 'Улица', 'Дом', 'Номер счетчика', 'Вид счетчика', 'Коэффициент трансформации', 'Дата установки', 'Показания', 'Заводской номер ТТ', 'Первичный ток ТТ', '', '', '', '', '', '', '', '', ''];
    const data = [1, 'Объект 1', 12345678901234, '00001', 123456789012, 'Учебный потребитель', 'Вкл', 'строка\nс пробелами', 'Учебный город', 'Учебная улица', 10, 123, 'Модель', 20, 46000.5, 125.75, '00001234567890123456789', 500, 'Проверить ввод', 'Сверить пломбу', 'Сохранить & < > " _x000D_', new Date('2026-01-02T03:04:05Z'), 0.12345, -0.125, 42.75, true, ''];
    const rows = [['Расширенный список'], ['Дата формирования отчета'], [], ['Всего записей', 3], top, lower, data, [2, 'Объект 2', '', '', '000000000002', '', '', '', '', '', '', '000000000000000000123'], top, lower, ['Итого', '', '', '', 'не строка реестра'], [3, 'Объект без ПУ', '', '', '000000000003']];
    const source = await fixture(t, { Реестр: rows, Пояснения: [['справочный лист']], Пустой: [] }, {
      shared, date1904, cellDates: true,
      mutate(book) {
        const ws = book.Sheets.Реестр;
        ws['!merges'] = ['G5:H5', 'I5:K5', 'L5:N5', 'O5:P5', 'Q5:R5'].map(XLSX.utils.decode_range);
        ws.L7.z = '000000'; ws.O7.z = 'dd.mm.yyyy hh:mm:ss'; ws.V7.z = 'yyyy-mm-dd hh:mm:ss';
        ws.W7.z = '0.00%'; ws.X7.z = '#,##0.000'; ws.Y7.f = '40+2.75'; ws.AA7 = { t: 'e', v: 7 };
      },
    });
    await writeRegistryXLSX(source.path, source.output, 'Расширенный список.xlsx');
    const actual = JSON.parse(await readFile(source.output, 'utf8'));
    assert.deepEqual(actual, prepareWorkbook(source.bytes, 'registry', 'Расширенный список.xlsx'));
    const index = buildIndex(unpackRegistry(actual));
    assert.equal(index.records.length, 3);
    assert.equal(search(index, { query: '000123' }).total, 1);
    assert.equal(index.records[0].fields.account, '123456789012');
    assert.equal(index.records[0].values[16], '00001234567890123456789');
    assert.equal(listNotes(index).total, 2);
    assert.ok(!(await readdir(source.dir)).some(name => name.startsWith('xlsx-strings-')));
  });
}

test('source row numbers, sparse rows and a late additional column stay unchanged', async t => {
  const rows = [simpleHeader, ['001', '0001', 'Учебный потребитель'], [], ['002', '0001']];
  rows[120] = ['003', '0002', '', '', '', '', 'Примечание'];
  rows[120][79] = 'Поздний столбец';
  const f = await fixture(t, { Лист1: rows });
  await writeRegistryXLSX(f.path, f.output, 'Реестр.xlsx');
  const actual = JSON.parse(await readFile(f.output, 'utf8'));
  assert.deepEqual(actual, prepareWorkbook(f.bytes, 'registry', 'Реестр.xlsx'));
  assert.deepEqual(actual.sheets[0].rows.map(row => row[0]), [2, 4, 121]);
  assert.equal(actual.sheets[0].layout.labels.length, 80);
  assert.equal(actual.sheets[0].rows.at(-1)[1][79], 'Поздний столбец');
});

test('one header per worksheet, skipped sheets and empty registry sheets match the existing parser', async t => {
  const f = await fixture(t, { НетШапки: [['справка']], БезДанных: [simpleHeader], Первый: [simpleHeader, ['001', '0001']], Второй: [simpleHeader, ['002', '0001']] });
  await writeRegistryXLSX(f.path, f.output);
  assert.deepEqual(JSON.parse(await readFile(f.output, 'utf8')), prepareWorkbook(f.bytes, 'registry'));
});

test('unsafe 17-digit numeric meter is imported, indexed and flagged without altering existing search records', async t => {
  for (const z of ['General', '0000000000000000']) {
    const f = await fixture(t, { Реестр: [simpleHeader, [10000000000000000, '0001']] }, { mutate: book => { book.Sheets.Реестр.A2.z = z; } });
    const warnings=await writeRegistryXLSX(f.path,f.output,'Расширенный список.xlsx');
    const pack=JSON.parse(await readFile(f.output,'utf8'));
    assert.equal(pack.sheets[0].rows.length,1);
    assert.equal(pack.sheets[0].rows[0][1][0],'10000000000000000');
    assert.deepEqual(warnings,pack.warnings);
    assert.deepEqual(pack,prepareWorkbook(f.bytes,'registry','Расширенный список.xlsx'));
    assert.equal(search(buildIndex(unpackRegistry(pack)),{query:'10000000000000000'}).total,1);
    assert.match(warnings.join(' '),/Столбец A.*Номер счетчика/);
    assert.ok(!(await readdir(f.dir)).some(name => name.startsWith('xlsx-strings-')));
  }
});

test('row/column safeguards and manual mapping requirements remain in force', async t => {
  const broad = await fixture(t, { Лист1: [simpleHeader, ['001', '0001']] }, { mutate: book => { book.Sheets.Лист1['!ref'] = 'A1:IW2'; } });
  await assert.rejects(writeRegistryXLSX(broad.path, broad.output), /100 000 строк и 256 столбцов/);
  const long = await fixture(t, { Лист1: [simpleHeader, ['001', '0001']] }, { mutate: book => { book.Sheets.Лист1['!ref'] = 'A1:G100003'; } });
  await assert.rejects(writeRegistryXLSX(long.path, long.output), /100 000 строк и 256 столбцов/);
  const missing = await fixture(t, { Лист1: [['Номер счетчика', 'Адрес'], ['001', 'Учебный адрес']] });
  await assert.rejects(writeRegistryXLSX(missing.path, missing.output), /Сопоставьте столбцы/);
  const noRows = await fixture(t, { Лист1: [simpleHeader] });
  await assert.rejects(writeRegistryXLSX(noRows.path, noRows.output), /Нет строк с номером ПУ или ЛС/);
});

test('preparation process detects XLSX by signature and keeps the old XLS parser', async t => {
  for (const bookType of ['xlsx', 'biff8']) {
    const f = await fixture(t, { Лист1: [simpleHeader, ['000001', '00000001']] }, { bookType });
    const flags = await preparationChildFlags(f.path, 'registry', 'Расширенный список.xls', 512);
    assert.deepEqual(flags, bookType === 'xlsx' ? ['--max-old-space-size=64', '--max-semi-space-size=4'] : ['--max-old-space-size=128']);
    const child = spawn(process.execPath, [...flags, new URL('../prepare-child.mjs', import.meta.url).pathname, f.path, f.output, 'registry', 'Расширенный список.xls'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', chunk => { error += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, error);
    assert.deepEqual(JSON.parse(await readFile(f.output, 'utf8')), prepareWorkbook(f.bytes, 'registry', 'Расширенный список.xls'));
    assert.deepEqual(await preparationChildFlags(f.path, 'instant', '31.xlsx', 512), ['--max-old-space-size=128']);
  }
});


// The Sochi "Расширенный список" has a merged three-level 1C header.
// A bad TT serial at row 9895 must not invalidate the registry; a bad
// meter/LS/point identifier must never be silently rounded into a search key.
function sochiHeaderRows({brokenMeter=false,confirmedMeter=false}={}) {
  const top=Array(69).fill(''),middle=Array(69).fill(''),bottom=Array(69).fill('');
  for(const [col,value] of [[0,'№ п/п'],[1,'ТУ'],[2,'Номер ТУСТЕК'],
    [3,'Номер ТУ'],[4,'ЛС / ЛС СТЕК'],[5,'Наименование договора'],
    [6,'Основные реквизиты'],[14,'Адрес точки учета'],[19,'Подключение'],
    [23,'Прибор учета'],[31,'События'],[37,'Рассчитанные величины'],
    [39,'Характеристики ТТ'],[61,'Характеристики ТН']])top[col]=value;
  for(const [col,value] of [[24,'Номер счетчика'],[21,'ТП'],
    [14,'Населенный пункт'],[15,'Улица'],[16,'Дом'],
    [40,'Заводской номер ТТ (А)'],[47,'Заводской номер ТТ (В)'],
    [54,'Заводской номер ТТ (С)'],[62,'Заводской номер ТН']])bottom[col]=value;
  const first=Array(69).fill('');
  Object.assign(first,{0:1,2:'00000102345',3:'2',4:'00000001001',
    5:'Учебный абонент',14:'Сочи',15:'Тестовая',16:'10',
    21:'ТП-100',24:'000000001234567',40:'Заводской ТТ 1'});
  const damaged=Array(69).fill('');
  Object.assign(damaged,{0:9892,2:'00000102345',3:'2',4:'00000001001',
    5:'Тестовый абонент',14:'Сочи',15:'Тестовая',16:'12',
    21:'ТП-100',24:brokenMeter?10000000000000000:confirmedMeter?6003481006073610:'000000001234568',
    40:1234567890123456});
  const rows=[top,middle,bottom,first];
  rows[9894]=damaged;
  return rows;
}
function sochiFixture(t,{brokenMeter=false,confirmedMeter=false}={}){
  return fixture(t,{Реестр:sochiHeaderRows({brokenMeter,confirmedMeter})},{
    mutate(book){
      book.Sheets.Реестр['!merges']=[
        'A1:A3','B1:B3','C1:C3','D1:D3','E1:E3','F1:F3',
        'X1:AE1','AN1:BI1'
      ].map(XLSX.utils.decode_range);
    }
  });
}
test('Sochi three-level 69-column header: numeric long TT serial at row 9895 is a visible warning, not a failed registry',async t=>{
  const f=await sochiFixture(t);
  const warnings=await writeRegistryXLSX(f.path,f.output,'Расширенный список.xlsx');
  const streamed=JSON.parse(await readFile(f.output,'utf8'));
  assert.equal(streamed.sheets.length,1);
  assert.equal(streamed.sheets[0].rows.length,2);
  assert.equal(streamed.sheets[0].rows[1][0],9895);
  assert.equal(streamed.sheets[0].layout.mapping.meter,24);
  assert.equal(streamed.sheets[0].layout.mapping.account,4);
  assert.ok(warnings.length>0);
  assert.match(warnings.join('\n'),/Столбец AO.*Заводской номер ТТ.*9895/);
  assert.deepEqual(streamed.warnings,warnings);
  const fallback=prepareWorkbook(f.bytes,'registry','Расширенный список.xlsx');
  assert.deepEqual(streamed,fallback);
  assert.equal(buildIndex(unpackRegistry(streamed)).records.length,2);
});
test('Sochi three-level header accepts a 17-digit numeric meter at Y9895 with warning',async t=>{
  const f=await sochiFixture(t,{brokenMeter:true});
  const warnings=await writeRegistryXLSX(f.path,f.output,'Расширенный список.xlsx');
  const result=JSON.parse(await readFile(f.output,'utf8'));
  assert.equal(result.sheets[0].rows[1][0],9895);
  assert.equal(result.sheets[0].rows[1][1][24],'10000000000000000');
  assert.match(warnings.join(' '),/Столбец Y.*Номер счетчика.*9895/);
  assert.deepEqual(result,prepareWorkbook(f.bytes,'registry','Расширенный список.xlsx'));
  assert.equal(search(buildIndex(unpackRegistry(result)),{query:'10000000000000000'}).total,1);
});

test('Sochi 1C three-level header imports verified numeric meter 6003481006073610 at Y9895',async t=>{
  const f=await sochiFixture(t,{confirmedMeter:true});
  const warnings=await writeRegistryXLSX(f.path,f.output,'Расширенный список.xlsx');
  const pack=JSON.parse(await readFile(f.output,'utf8'));
  assert.equal(pack.sheets[0].rows[1][0],9895);
  assert.equal(pack.sheets[0].rows[1][1][24],'6003481006073610');
  assert.ok(warnings.some(message=>/Столбец Y.*Номер счетчика.*9895/.test(message)));
  const index=buildIndex(unpackRegistry(pack));
  assert.equal(search(index,{query:'6003481006073610',field:'meter'}).total,1);
  assert.deepEqual(pack,prepareWorkbook(f.bytes,'registry','Расширенный список.xlsx'));
});

test('Sochi importer accepts three long numeric meters at Y11631, Y25267 and Y40018 in one workbook',async t=>{
  const rows=sochiHeaderRows(),numbers=[
    [11631,10000000000000000],
    [25267,20000000000000000],
    [40018,30000000000000000],
  ];
  for(const [row,number] of numbers) {
    const record=Array(69).fill('');
    record[0]=row;record[4]='230703231250';record[5]='Тестовый потребитель';
    record[14]='Учебный город';record[15]='Тестовая улица';
    record[21]='ТП-100';record[24]=number;
    rows[row-1]=record;
  }
  const f=await fixture(t,{Реестр:rows},{
    mutate(book){book.Sheets.Реестр['!merges']=[
      'A1:A3','B1:B3','C1:C3','D1:D3','E1:E3','F1:F3','X1:AE1','AN1:BI1',
    ].map(XLSX.utils.decode_range);}
  });
  const warnings=await writeRegistryXLSX(f.path,f.output,'Расширенный список.xlsx');
  const pack=JSON.parse(await readFile(f.output,'utf8'));
  assert.equal(pack.sheets[0].rows.length,5);
  const byRow=new Map(pack.sheets[0].rows);
  for(const [row,number] of numbers) {
    assert.equal(byRow.get(row)[24],String(number));
    assert.equal(search(buildIndex(unpackRegistry(pack)),{query:String(number)}).total,1);
    assert.match(warnings.join(' '),new RegExp('\\b'+row+'\\b'));
  }
  assert.match(warnings.join(' '),/Столбец Y.*Номер счетчика/);
  assert.deepEqual(pack,prepareWorkbook(f.bytes,'registry','Расширенный список.xlsx'));
});
