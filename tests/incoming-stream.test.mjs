import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '@e965/xlsx';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeIncomingXLSX } from '../incoming-stream.mjs';
import { parseIncomingWorkbook, incomingMonth, incomingLayout } from '../public/incoming.js';
import { prepareWorkbook } from '../prepared-workbook.mjs';
import { prepareUploadedXlsx, preparationChildFlags } from '../prepared-service.mjs';

const names=['№ ПУ','ТП','Разрешенная мощность, кВт','Тип (юр/физ)',
  'Напряжение, кВ (0,22 / 0,4; пусто = авто)','Абонент','Адрес'];
const dates=Array.from({length:69},(_,i)=>'01.'+String(i%12+1).padStart(2,'0')+'.'+(2021+Math.floor(i/12)));
const header=[...names,...dates];
const month=(row,monthIndex,value)=>{row[7+monthIndex]=value;return row;};
function sourceRows(){
  const a=Array(76).fill('');
  Object.assign(a,{0:'1415172',1:'ВЗ-3-79',5:'ввод 1 - ВЗ-3-79 ПУ № 1415172'});
  month(a,0,'61 524');month(a,1,'63 696');month(a,34,38);
  month(a,62,422414);month(a,67,'101 220'); // Month 69 blank
  const b=Array(76).fill('');
  Object.assign(b,{0:'1646871',1:'КИ-1-1096',5:'ввод 1 - КИ-1-1096 ПУ № 1646871'});
  month(b,48,65873);month(b,49,'67 495');month(b,68,'42 661'); // Historic blanks
  const c=Array(76).fill('');
  Object.assign(c,{0:'12289174707473',1:'КН-5-1000',2:'',3:'',4:'',
    5:'ввод 1 - КН-5-1000 ПУ № 12289174707473'});
  month(c,20,'80 171');month(c,67,'106 967');month(c,68,'71 720');
  const d=Array(76).fill('');
  Object.assign(d,{0:'12289167515299',1:'К-9-220',2:15.5,3:'юр',4:'0,4',
    5:'ввод 1 - К-9-220 ПУ № 12289167515299',6:'Учебная улица, 1'});
  month(d,19,'54 321');month(d,31,0);month(d,52,'276 275');
  return [a,b,c,d];
}
async function fixture(t,rows,{bookSST=false,excelDateHeader=false,bookType='xlsx'}={}){
  const dir=await mkdtemp(join(tmpdir(),'incoming-sochi-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const book=XLSX.utils.book_new();
  const ws=XLSX.utils.aoa_to_sheet(rows);
  if(excelDateHeader){
    for(let i=0;i<69;i++){
      const col=XLSX.utils.encode_cell({r:0,c:7+i});
      const value=(Date.UTC(2021+Math.floor(i/12),i%12,1)-Date.UTC(1899,11,30))/86400000;
      ws[col]={t:'n',v:value,z:'dd.mm.yyyy'};
    }
  }
  XLSX.utils.book_append_sheet(book,ws,'Приём');
  const bytes=Buffer.from(XLSX.write(book,{type:'buffer',bookType,bookSST,compression:bookType==='xlsx'}));
  const path=join(dir,bookType==='xlsx'?'Приём.xlsx':'Приём.xls');
  const output=join(dir,'package.json');
  await writeFile(path,bytes);
  return {path,output,bytes};
}
test('Given date headers match 69 months from January 2021 to September 2026',()=>{
  assert.equal(header.length,76);
  assert.deepEqual(incomingMonth('01.01.2021'),{y:2021,m:0});
  assert.deepEqual(incomingMonth('01.09.2026'),{y:2026,m:8});
  assert.equal(incomingMonth('20.01.2021'),null);
  assert.deepEqual(incomingMonth(44197),{y:2021,m:0});
  const layout=incomingLayout([header]);
  assert.equal(layout.cols.length,69);
  assert.equal(layout.fields.meter,0);
  assert.equal(layout.fields.tp,1);
  assert.deepEqual(layout.months.at(-1),{y:2026,m:8});
});
for(const shared of [false,true]){
  for(const serial of [false,true]){
    test('Monthly Приём streaming matches XLSX standard parser (shared='+shared+', numeric date headers='+serial+')',async t=>{
      const f=await fixture(t,[header,...sourceRows()],{bookSST:shared,excelDateHeader:serial});
      const result=await writeIncomingXLSX(f.path,f.output);
      assert.equal(result.rows,4);
      assert.equal(result.months.length,69);
      const pack=JSON.parse(await readFile(f.output,'utf8'));
      assert.deepEqual(pack,prepareWorkbook(f.bytes,'incoming'));
      assert.equal(pack.role,'incoming');
      assert.equal(pack.schema,'meter-monthly-v1');
      assert.equal(pack.rows.length,4);
      assert.equal(pack.rows[0][0],'1415172');
      assert.equal(pack.rows[0][1],'ВЗ-3-79');
      assert.equal(pack.rows[0][2],null);
      assert.equal(pack.rows[0][4],null);
      assert.equal(pack.rows[0][7][0],61524);
      assert.equal(pack.rows[0][7][1],63696);
      assert.equal(pack.rows[0][7][34],38);
      assert.equal(pack.rows[0][7][62],422414);
      assert.equal(pack.rows[0][7][68],null,'blank month is missing, never zero');
      assert.equal(pack.rows[1][7][0],null);
      assert.equal(pack.rows[1][7][48],65873);
      assert.equal(pack.rows[1][7][68],42661);
      assert.equal(pack.rows[2][0],'12289174707473');
      assert.equal(pack.rows[2][7][68],71720);
      assert.equal(pack.rows[3][2],15.5);
      assert.equal(pack.rows[3][3],'юр');
      assert.equal(pack.rows[3][4],0.4);
      assert.equal(pack.rows[3][7][31],0,'explicit zero must stay zero');
    });
  }
}
test('Legacy incoming template and arbitrary populated spreadsheets remain accepted',async t=>{
  for(const rows of [
    [['ТП','Номер счетчика','Дата приёма','Начальные показания','Конечные показания','Объём, кВт·ч','Примечание'],['ТП-100','000012345678','2026-10-23',12000,13200,1200,'Пример']],
    [['ТП','Отпуск'],['ТП-123',1000]],
  ]){
    const f=await fixture(t,rows);
    const result=await writeIncomingXLSX(f.path,f.output);
    const packageJSON=JSON.parse(await readFile(f.output,'utf8'));
    assert.equal(result.legacy,true);
    assert.deepEqual(packageJSON,prepareWorkbook(f.bytes,'incoming'));
    assert.deepEqual(packageJSON,{format:1,role:'incoming',sheets:1});
  }
});
test('Old XLS format accepts the new monthly intake layout',async t=>{
  const f=await fixture(t,[header,...sourceRows()],{bookType:'biff8'});
  const pack=prepareWorkbook(f.bytes,'incoming');
  assert.equal(pack.rows.length,4);
  assert.equal(pack.months.length,69);
  assert.equal(pack.rows[0][7][0],61524);
  assert.equal(pack.rows[0][7][68],null);
});
test('Bad or missing chronological month labels fail clearly instead of shifting columns',async t=>{
  const wrong=[...header];
  wrong[9]='01.04.2021'; // March missing
  const f=await fixture(t,[wrong,...sourceRows()]);
  await assert.rejects(writeIncomingXLSX(f.path,f.output),/Месяцы.*пропусками/);
  assert.throws(()=>prepareWorkbook(f.bytes,'incoming'),/Месяцы.*пропусками/);
});
test('Incoming stream handles 1400 long monthly rows in bounded parser child',async t=>{
  const base=sourceRows()[0];
  const rows=[header,...Array.from({length:1400},(_,i)=>{
    const row=[...base];row[0]=String(2000000+i);row[7]=i;return row;
  })];
  const f=await fixture(t,rows,{bookSST:true});
  const limits=await preparationChildFlags(f.path,'incoming','Приём.xlsx',512);
  assert.deepEqual(limits,['--max-old-space-size=64','--max-semi-space-size=4']);
  const json=await prepareUploadedXlsx(f.path,f.output,'incoming','Приём.xlsx');
  const pack=JSON.parse(json);
  assert.equal(pack.rows.length,1400);
  assert.equal(pack.months.length,69);
  assert.equal(pack.rows.at(-1)[0],'2001399');
  assert.equal(pack.rows[0][7][0],0);
});
