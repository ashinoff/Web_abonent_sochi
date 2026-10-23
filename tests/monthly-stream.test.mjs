import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from '@e965/xlsx';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeMonthlyXLSX } from '../monthly-stream.mjs';
import { prepareWorkbook } from '../prepared-workbook.mjs';
import { parseMonthlyMatrix, indexMonthly } from '../public/monthly.js';
import { unpackMonthly } from '../public/prepared-data.js';

const months=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const fields=[
  'Вид потребителя','Договор СТЕК','Точка учета СТЕК','Договор','Точка учета',
  'Дифференцация по зонам суток','Наименование договора',
  'Наименование точки учета','Наименование точки поставки',
  'Тарифная группа','Ценовая категория','Расчет фактической мощности',
  'Населенный пункт','Улица','Дом','Квартира','Подстанция','Фидер',
  'ТП 10/0.4','Балансовая принадлежность ТП','Линия 04','Опора 04',
  'Количество тр-ров','Мощность тр-ра 1','Мощность тр-ра 2',
  'Мощность тр-ра 3','Мощность тр-ра 4',
  'Расчет потерь производится в % или размер потерь кВт',
  'Напряжение тарифное','Напряжение физическое','Тип прибора учета',
  'Заводской номер прибора учета','Место установки ПУ','Дата установки ПУ',
  '1-фазный или 3-фазный прибор учета','Коэфф трансформ','Вид Включения',
  'Тип ТТ','Тип ТН','Катерогия технологического присоединения',
  'Разрешенная мощность','Дата события','Показание события',
  'Тип события','Контролер','Код сетевой организации',
  'Сетевая организация','Сбытовая организация','Сектор экономики','Включена',
];
const monthHeads=Array.from({length:69},(_,i)=>months[i%12]+' '+(2021+Math.floor(i/12)));
const header=[...fields,...monthHeads];
assert.equal(fields.length,50);
assert.equal(header.length,119);
function sourceRow(i=0){
  const row=Array(119).fill('');
  row[0]='ФИЗ';row[1]=1024+i;row[2]='';row[3]=1073000129+i;
  row[4]=215+i;row[5]=1;row[7]='Общедомовой учет ул. Черноморская,76';
  row[9]='Сельское население';row[12]='Каневская ст-ца';row[13]='Черноморская ул';
  row[14]=76;row[18]='КН-2-1041';row[31]='012754174802797';
  row[35]=60;row[49]='Да';
  for(let n=0;n<69;n++)row[50+n]=3240+i+(n%6)*60;
  return row;
}
async function fixture(t,rows,{bookSST=false}={}){
  const dir=await mkdtemp(join(tmpdir(),'sochi-monthly-stream-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'ПО');
  const buffer=XLSX.write(wb,{type:'buffer',bookType:'xlsx',bookSST});
  const path=join(dir,'ПО.xlsx'),output=join(dir,'package.json');
  await writeFile(path,buffer);
  return {path,output,buffer};
}
test('Actual Sochi ПО headings map all 69 monthly periods, contract, STEK TU and TP',()=>{
  const parsed=parseMonthlyMatrix([header,[],sourceRow(0)]);
  assert.equal(parsed.months.length,69);
  assert.deepEqual(parsed.months[0],{y:2021,m:0});
  assert.deepEqual(parsed.months.at(-1),{y:2026,m:8});
  assert.equal(parsed.rows.length,1);
  const item=parsed.rows[0];
  assert.equal(item.account,'1073000129');
  assert.equal(item.alias,'1024');
  assert.equal(item.point,'');
  assert.equal(item.pointNumber,'215');
  assert.equal(item.tp,'КН-2-1041');
  assert.equal(item.pointName,'Общедомовой учет ул. Черноморская,76');
  assert.equal(item.zone,'1');
  assert.equal(item.values.length,69);
  assert.equal(item.values[0],3240);
  assert.equal(item.values[68],3240+(68%6)*60);
  assert.equal(parsed.warnings.length,0);
  assert.equal(indexMonthly(parsed).accounts.size,1);
});
for(const bookSST of [false,true]){
  test('119-column, 69-month XLSX streaming matches the SheetJS reference; shared strings='+bookSST,async t=>{
    const f=await fixture(t,[['Потребление за 2021-2026'],header,sourceRow(0),sourceRow(1),sourceRow(2)],{bookSST});
    const info=await writeMonthlyXLSX(f.path,f.output);
    const actual=JSON.parse(await readFile(f.output,'utf8'));
    const reference=prepareWorkbook(f.buffer,'consumption','ПО.xlsx');
    assert.deepEqual(actual,reference);
    assert.equal(info.rows,3);
    assert.equal(actual.months.length,69);
    const parsed=unpackMonthly(actual);
    assert.deepEqual(parsed.rows.map(row=>row.account),['1073000129','1073000130','1073000131']);
  });
}
test('Streaming monthly parser handles thousands of 119-column rows without a SheetJS worksheet in the child',async t=>{
  const total=1500;
  const rows=[header,...Array.from({length:total},(_,i)=>sourceRow(i))];
  const f=await fixture(t,rows);
  const started=Date.now();
  const result=await writeMonthlyXLSX(f.path,f.output);
  assert.equal(result.rows,total);
  const pack=JSON.parse(await readFile(f.output,'utf8'));
  assert.equal(pack.rows.length,total);
  assert.equal(pack.rows[0][0],'1073000129');
  assert.equal(pack.rows.at(-1)[0],String(1073000129+total-1));
  assert.equal(pack.rows[0][9].length,69);
  assert.equal(pack.rows.at(-1)[9][68],3240+total-1+(68%6)*60);
  console.log('1500x119 Sochi streaming XLSX elapsed ms:',Date.now()-started);
});
test('Unordered/missing months remain a real spreadsheet error, not an implicit zero',()=>{
  const invalid=[...header];
  invalid[52]='Апрель 2021'; // Expected March
  assert.throws(()=>parseMonthlyMatrix([invalid,sourceRow()]),/пропуском/);
});
