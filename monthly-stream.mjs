import * as XLSX from '@e965/xlsx';
import { openStreamingWorkbook } from './xlsx-stream.mjs';
import { readRows, displayCell, PackageWriter } from './registry-stream.mjs';
import { isMonthlyHeader, monthlyLayout, monthlyRecord, monthlyWarnings, MONTHLY_PARSER_VERSION } from './public/monthly.js';
import { monthlyKeys } from './public/prepared-data.js';

const limit=()=>new Error('Максимум 100 000 строк и 256 столбцов на лист.');
const missing=()=>new Error('Книга не содержит листа с договором/ЛС и помесячным потреблением.');
function identicalMonths(a,b) {
  return a.length===b.length&&a.every((m,i)=>m.y===b[i].y&&m.m===b[i].m);
}

// Keep XLSX ZIP, compressed XML and shared strings off the V8 heap.
// The full 45k x 119 SheetJS worksheet would keep millions of cell objects,
// whereas this reader emits one row at a time to a compact JSON array on disk.
// The JSON shape is exactly packMonthly(readMonthlyWorkbook(...)).
export async function writeMonthlyXLSX(path,output) {
  const workbook=await openStreamingWorkbook(path,XLSX.SSF.get_table());
  const writer=new PackageWriter(output);
  let months=null,rows=0,hasVolume=false,firstError=null;
  const counters={invalid:0,totalsMismatch:0,fallback:0};
  const skipped=[];
  try {
    for(const sheet of workbook.info.sheets) {
      if(!sheet.path)continue;
      const prefix=[],date1904=workbook.info.date1904;
      let layout=null,recognized=false,partRows=0;
      try {
        await readRows(workbook,sheet,{
          onTag(name,attr) {
            if(name==='dimension'&&attr.ref) {
              const range=XLSX.utils.decode_range(attr.ref);
              if(range.e.r>100000||range.e.c>255)throw limit();
            }
          },
          onRow(number,cells) {
            if(!layout){
              if(number>80)return;
              const header=Array.from({length:Math.max(cells.length,1)},(_,i)=>
                cells[i]?displayCell(cells[i],date1904):'');
              prefix[number-1]=header;
              if(!isMonthlyHeader(header))return;
              layout=monthlyLayout(Array.from({length:number},(_,i)=>prefix[i]||[]));
              recognized=true;
              if(months&&!identicalMonths(months,layout.months))
                throw new Error('Листы содержат разные периоды отчёта. Оставьте один согласованный период.');
              if(!months) {
                months=layout.months;
                writer.add(JSON.stringify({format:1,role:'consumption',parserVersion:MONTHLY_PARSER_VERSION,months}).slice(0,-1)+',"rows":[');
              }
              return;
            }
            if(number<=layout.h+1)return;
            // Reuse the same column mapping, null handling, monthly volumes,
            // STEK account fallbacks and warning rules as the normal parser.
            const row=Array.from({length:Math.max(cells.length,layout.c.account+1)},(_,c)=>
              cells[c]?.v??'');
            if(!row.some(v=>v!==''&&v!=null))return;
            const item=monthlyRecord(row,number-1,layout,{
              sheet:sheet.name,cellAt:(_,col)=>cells[col],
            });
            counters.invalid+=item.invalid;
            counters.totalsMismatch+=item.totalsMismatch;
            counters.fallback+=item.fallback;
            if(!item.record)return;
            const record=item.record;
            hasVolume||=record.values.some(v=>v!=null);
            writer.add((rows++?',':'')+JSON.stringify(monthlyKeys.map(key=>record[key])));
            partRows++;
          },
        });
      }catch(error){
        // Once the report header is recognized, all decoding failures are
        // real import failures, not grounds to silently omit that worksheet.
        if(recognized||/Максимум 100 000|Некорректный XLSX/.test(error.message))
          throw new Error('Лист «'+sheet.name+'»: '+error.message);
        if(!firstError)firstError=error.message;
        skipped.push('Лист «'+sheet.name+'» пропущен: '+error.message);
        continue;
      }
      if(!recognized){
        const reason='Не найдена шапка с договором/лицевым счётом и помесячным полезным отпуском.';
        skipped.push('Лист «'+sheet.name+'» пропущен: '+reason);
        if(!firstError)firstError=reason;
      }else if(!partRows) {
        // Even if a workbook has other valid sheets, an empty recognized
        // sheet is retained in the audit warnings, not as fake 0 kWh rows.
        skipped.push('Лист «'+sheet.name+'»: нет строк с лицевыми счетами.');
      }
    }
    if(!months||!rows)throw new Error(firstError||'Нет строк с лицевыми счетами.');
    if(!hasVolume)throw new Error('Нет числовых месячных объёмов потребления.');
    const warnings=[...monthlyWarnings(counters),...skipped];
    writer.add('],"warnings":'+JSON.stringify(warnings)+'}');
    return {rows,months,warnings};
  }finally{
    try{writer.close();}finally{await workbook.close();}
  }
}
