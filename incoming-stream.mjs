import * as XLSX from '@e965/xlsx';
import { writeFile } from 'node:fs/promises';
import { openStreamingWorkbook } from './xlsx-stream.mjs';
import { displayCell, readRows, PackageWriter } from './registry-stream.mjs';
import { incomingLayout, incomingRecord, incomingWarnings, INCOMING_SCHEMA } from './public/incoming.js';

// The 7 metadata columns + 69 monthly intake values can produce millions of
// worksheet cells. Decode ZIP/XML in bounded streams, keep just one row, and
// write compact arrays straight to disk. The old (inspection-only) incoming
// format remains accepted as {format:1,role:'incoming',sheets:N}.
export async function writeIncomingXLSX(path,output){
  const workbook=await openStreamingWorkbook(path,XLSX.SSF.get_table());
  let writer=null,months=null,totalRows=0,populatedSheets=0,recognized=false;
  const warnings={invalidVolumes:0,invalidMeta:0,missingMeter:0};
  try {
    for(const sheet of workbook.info.sheets){
      if(!sheet.path)continue;
      const prefix=[];let layout=null,populated=false;
      await readRows(workbook,sheet,{
        onTag(name,attr){
          if(name==='dimension'&&attr.ref){
            const range=XLSX.utils.decode_range(attr.ref);
            if(range.e.r>100000||range.e.c>255)
              throw new Error('Файл слишком большой: максимум 100 000 строк и 256 столбцов на лист.');
          }
        },
        onRow(number,cells){
          if(cells.some(cell=>cell?.v!==''&&cell?.v!=null))populated=true;
          if(!layout){
            if(number>80)return;
            const row=Array.from({length:cells.length},(_,c)=>
              cells[c]?displayCell(cells[c],workbook.info.date1904):'');
            prefix[number-1]=row;
            layout=incomingLayout(prefix,{
              cellAt:(r,c)=>r===number-1?cells[c]:null,
              date1904:workbook.info.date1904,
            });
            if(!layout)return;
            if(months&&JSON.stringify(months)!==JSON.stringify(layout.months))
              throw new Error('Листы «Приёма» содержат разные месячные периоды.');
            recognized=true;
            if(!months){
              months=layout.months;
              writer=new PackageWriter(output);
              writer.add(JSON.stringify({format:1,role:'incoming',schema:INCOMING_SCHEMA,months}).slice(0,-1)+',"rows":[');
            }
            return;
          }
          const width=layout.cols.at(-1).c+1;
          const row=Array.from({length:width},(_,c)=>cells[c]?.v??'');
          const item=incomingRecord(row,number,layout,{
            sheet:sheet.name,cellAt:(_,c)=>cells[c],
          });
          if(!item.record)return;
          for(const key of Object.keys(warnings))warnings[key]+=item[key];
          writer.add((totalRows++?',':'')+JSON.stringify(item.record));
        },
      });
      if(populated)populatedSheets++;
    }
    if(!recognized){
      if(!populatedSheets)throw new Error('В файле нет заполненных листов.');
      // No new-style date header: retain the old importer contract, which
      // validates the workbook rather than inventing unsupported balances.
      await writeFile(output,JSON.stringify({format:1,role:'incoming',sheets:populatedSheets}));
      return {rows:0,months:[],warnings:[],legacy:true};
    }
    if(!totalRows)throw new Error('В «Приёме» нет строк с данными ПУ и месячными значениями.');
    const notes=incomingWarnings(warnings);
    writer.add('],"warnings":'+JSON.stringify(notes)+',"stats":'+JSON.stringify({rows:totalRows,months:months.length})+'}');
    return {rows:totalRows,months,warnings:notes,legacy:false};
  }finally{
    try{writer?.close();}finally{await workbook.close();}
  }
}
