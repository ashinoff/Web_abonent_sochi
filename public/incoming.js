import { clean, norm, restoreIdentifier } from './core.js';
import { numeric } from './monthly.js';

export const INCOMING_SCHEMA='meter-monthly-v1';
export const incomingFields=['meter','tp','power','consumerType','voltage','subscriber','address','values','source'];

const labelPatterns={
  meter:/^(?:№\s*пу|номер\s*(?:пу|счетчика)|заводской номер пу|серийный номер пу)$/,
  tp:/^тп(?:\s*10\s*\/\s*0[.,]4)?$/,
  power:/^разрешенная мощность(?:,\s*квт)?$/,
  consumerType:/^тип(?:\s*\(юр\s*\/\s*физ\))?$/,
  voltage:/^напряжение(?:,\s*кв(?:\s*\(.*\))?)?$/,
  subscriber:/^(?:абонент|наименование абонента)$/,
  address:/^адрес(?: объекта)?$/,
};
const MONTH_LIMIT=180;

export function incomingMonth(value,date1904=false) {
  if(value instanceof Date&&!Number.isNaN(value.valueOf())){
    const y=value.getUTCFullYear(),m=value.getUTCMonth(),d=value.getUTCDate();
    return y>=2000&&y<=2100&&d===1?{y,m}:null;
  }
  if(typeof value==='number'){
    if(!Number.isInteger(value)||value<30000||value>80000)return null;
    // Both Excel epochs, including the Excel 1900 leap-year quirk.
    const date=new Date(Date.UTC(1899,11,30)+(value+(date1904?1462:0))*86400000);
    const y=date.getUTCFullYear(),m=date.getUTCMonth();
    return y>=2000&&y<=2100&&date.getUTCDate()===1?{y,m}:null;
  }
  const s=clean(value);
  let match=/^0?1[.\/-](0?[1-9]|1[0-2])[.\/-](20\d{2})$/.exec(s);
  if(match)return {y:Number(match[2]),m:Number(match[1])-1};
  match=/^(20\d{2})[.\/-](0?[1-9]|1[0-2])[.\/-]0?1$/.exec(s);
  return match?{y:Number(match[1]),m:Number(match[2])-1}:null;
}
export function incomingLayout(top,{cellAt=()=>null,date1904=false}={}) {
  for(let h=0;h<Math.min(top.length,80);h++){
    const header=(top[h]||[]).map(clean);
    const keys=header.map(norm),fieldCols={};
    for(const [key,pattern] of Object.entries(labelPatterns))
      fieldCols[key]=keys.findIndex(label=>pattern.test(label));
    if(fieldCols.meter<0||fieldCols.tp<0)continue;
    const cols=[];
    for(let c=0;c<header.length;c++){
      const cell=cellAt(h,c);
      const month=incomingMonth(cell?.v,date1904)||incomingMonth(header[c],date1904);
      if(month)cols.push({...month,c});
    }
    if(!cols.length)continue;
    if(cols.length>MONTH_LIMIT)throw new Error('В «Приём» слишком много месячных колонок (максимум 180).');
    for(let i=1;i<cols.length;i++){
      const prev=cols[i-1],current=cols[i];
      if(current.c<=prev.c||current.y*12+current.m!==prev.y*12+prev.m+1)
        throw new Error('Месяцы «Приёма» идут не по порядку или с пропусками. Проверьте даты в заголовках.');
    }
    if(cols[0].c<=Math.max(...Object.values(fieldCols)))
      throw new Error('Месячные значения «Приёма» должны располагаться после полей абонента.');
    return {h,fields:fieldCols,cols,months:cols.map(({y,m})=>({y,m}))};
  }
  return null;
}
function textIdentifier(cell,display) {
  if(cell?.t==='n'&&Number.isInteger(cell.v)){
    // The XLSX streaming reader supplies exact raw XML numeric text.
    // No attempts to invent numbers Excel rounded before export.
    return clean(restoreIdentifier(String(cell.v),cell));
  }
  return clean(display);
}
export function incomingRecord(row,number,layout,{sheet='Лист1',cellAt=()=>null}={}){
  const get=(field)=>{
    const c=layout.fields[field];
    return c<0?'':row[c]??'';
  };
  const meterCol=layout.fields.meter, meter=textIdentifier(cellAt(number-1,meterCol),get('meter'));
  const tp=clean(get('tp'));
  const powerRaw=clean(get('power')), voltageRaw=clean(get('voltage'));
  const power=powerRaw?numeric(powerRaw):null;
  const voltage=voltageRaw?numeric(voltageRaw):null;
  let invalidVolumes=0;
  const values=layout.cols.map(({c})=>{
    const cell=cellAt(number-1,c),value=cell?.v??row[c];
    const n=numeric(value);
    if(n==null&&clean(value)&&!/^[-—–]$/.test(clean(value)))invalidVolumes++;
    return n;
  });
  if(!meter&&!tp&&!values.some(v=>v!=null))
    return {record:null,invalidVolumes:0,invalidMeta:0,missingMeter:0};
  // Preserve rows lacking meter for source visibility, but warn about the
  // missing key. A later balance algorithm must not silently match them.
  return {
    record:[meter,tp,power,clean(get('consumerType')),voltage,
      clean(get('subscriber')),clean(get('address')),values,sheet+':'+number],
    invalidVolumes,
    invalidMeta:Number(Boolean(powerRaw&&power==null))+Number(Boolean(voltageRaw&&voltage==null)),
    missingMeter:meter?0:1,
  };
}
export function incomingWarnings({invalidVolumes=0,invalidMeta=0,missingMeter=0}={}) {
  const warnings=[];
  if(invalidVolumes)warnings.push('В «Приёме» нераспознанных месячных значений: '+invalidVolumes+'. Они оставлены пустыми, а не заменены нулём.');
  if(invalidMeta)warnings.push('В «Приёме» некорректных значений мощности/напряжения: '+invalidMeta+'. Они не участвуют в будущих расчётах.');
  if(missingMeter)warnings.push('В «Приёме» строк без номера ПУ: '+missingMeter+'. Они сохранены для проверки, но не могут автоматически сопоставляться со счётчиком.');
  return warnings;
}
export function incomingPack(months,rows,warnings=[]) {
  return {format:1,role:'incoming',schema:INCOMING_SCHEMA,months,rows,warnings,
    stats:{rows:rows.length,months:months.length}};
}
export function parseIncomingWorkbook(buffer,XLSX) {
  const book=XLSX.read(buffer,{type:'array',dense:true,cellHTML:false,cellText:false,
    cellFormula:false,cellNF:true,sheetRows:100002});
  let months=null,rows=[],found=false;
  const counters={invalidVolumes:0,invalidMeta:0,missingMeter:0};
  for(const name of book.SheetNames){
    const ws=book.Sheets[name];
    if(!ws?.['!ref'])continue;
    const range=XLSX.utils.decode_range(ws['!ref']);
    if(range.e.r>100000||range.e.c>255||ws['!fullref'])
      throw new Error('Файл слишком большой: максимум 100 000 строк и 256 столбцов на лист.');
    const cell=(r,c)=>ws['!data']?ws['!data'][r]?.[c]:ws[XLSX.utils.encode_cell({r,c})];
    const top=Array.from({length:Math.min(range.e.r+1,80)},(_,r)=>
      Array.from({length:range.e.c+1},(_,c)=>{
        const v=cell(r,c);
        return v?XLSX.utils.format_cell(v):'';
      }));
    const layout=incomingLayout(top,{cellAt:cell,date1904:Boolean(book.Workbook?.WBProps?.date1904)});
    if(!layout)continue;
    if(months&&JSON.stringify(months)!==JSON.stringify(layout.months))
      throw new Error('Листы «Приёма» содержат разные месячные периоды.');
    months=layout.months;found=true;
    for(let r=layout.h+1;r<=range.e.r;r++){
      const row=Array.from({length:range.e.c+1},(_,c)=>cell(r,c)?.v??'');
      const result=incomingRecord(row,r+1,layout,{sheet:name,cellAt:cell});
      for(const k of Object.keys(counters))counters[k]+=result[k];
      if(result.record)rows.push(result.record);
    }
    delete book.Sheets[name];
  }
  if(!found)return null;
  if(!rows.length)throw new Error('В «Приёме» нет строк с данными ПУ и месячными значениями.');
  return incomingPack(months,rows,incomingWarnings(counters));
}
