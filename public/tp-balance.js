import { idKey } from './core.js';
import { tpKey } from './monthly.js';
import { INCOMING_SCHEMA } from './incoming.js';

const calendarKey=({y,m})=>Number.isInteger(y)&&Number.isInteger(m)&&m>=0&&m<12?y*12+m:null;
const validVolume=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const round=value=>Math.round(value*1e6)/1e6;

// Safe, read-only aggregation. A monthly "Приём" row is a kWh volume for
// one physical intake PU, not a meter reading or an extra consumer from ПО.
// Never apply TT coefficients again, infer missing months as zero, or
// estimate technical losses. A balance is possible only for complete,
// matching calendar months from both independent files.
export function createTpBalances(pack=null) {
  if(!pack)return empty('not-loaded','Файл «Приём» ещё не загружен.');
  if(pack?.schema!==INCOMING_SCHEMA||pack.role!=='incoming'||
      !Array.isArray(pack.months)||!Array.isArray(pack.rows))
    return empty('legacy','«Приём» загружен в старом формате без помесячных объёмов. Загрузите помесячную выгрузку.');

  const slots=new Map();
  for(let i=0;i<pack.months.length;i++){
    const key=calendarKey(pack.months[i]);
    if(key==null||slots.has(key))return empty('invalid','У «Приёма» некорректные или повторяющиеся месяцы.');
    slots.set(key,i);
  }
  const groups=new Map(),meterGroups=new Map();
  let unassigned=0;
  for(const line of pack.rows) {
    if(!Array.isArray(line)||!Array.isArray(line[7]))continue;
    const tp=String(line[1]??'').trim(),meter=idKey(line[0]),key=tpKey(tp);
    if(!key){unassigned++;continue;}
    if(!groups.has(key))groups.set(key,{name:tp,byMeter:new Map(),unknown:[]});
    const group=groups.get(key);
    if(!meter){
      group.unknown.push(line[7]);
      continue;
    }
    if(!group.byMeter.has(meter))group.byMeter.set(meter,[]);
    group.byMeter.get(meter).push(line[7]);
    if(!meterGroups.has(meter))meterGroups.set(meter,new Set());
    meterGroups.get(meter).add(key);
  }

  // Persist only compact per-TP month sums and quality indicators. Do not
  // keep thousands of full incoming rows in the server's long-lived cache.
  const aggregated=new Map();
  for(const [key,group] of groups){
    const sums=Array(pack.months.length).fill(null),uncertain=Array(pack.months.length).fill(0);
    const duplicates=[...group.byMeter.values()].filter(list=>list.length>1).length;
    for(let i=0;i<sums.length;i++){
      let sum=0,missing=0;
      for(const [meter,rows] of group.byMeter){
        // A meter linked to several TPs has no effective-date attribution.
        if(meterGroups.get(meter).size!==1){missing++;uncertain[i]++;continue;}
        const values=rows.map(series=>series[i]??null);
        if(values.some(v=>!validVolume(v))){missing++;continue;}
        if(!values.every(v=>v===values[0])) {
          missing++;uncertain[i]++;
          continue; // Never double-count a conflicting duplicate PU.
        }
        sum+=values[0]; // Equal duplicate lines contribute once.
      }
      if(group.unknown.length) {
        for(const values of group.unknown)if(values[i]!=null){missing++;uncertain[i]++;}
      }
      if(!missing&&group.byMeter.size)sums[i]=round(sum);
    }
    aggregated.set(key,{
      name:group.name,values:sums,uncertain,meters:group.byMeter.size,
      rows:[...group.byMeter.values()].reduce((n,list)=>n+list.length,group.unknown.length),
      duplicates,unknownMeters:group.unknown.length,
      multipleTP:[...group.byMeter.keys()].filter(meter=>meterGroups.get(meter).size>1).length,
    });
  }

  function compare(tp,consumptionMonths,consumptionValues,{threshold=10,hasConsumption=true}={}){
    const key=tpKey(tp),item=aggregated.get(key);
    if(!item)return empty('no-tp','ТП не найдена в загруженном файле «Приём».',key);
    if(!hasConsumption||!Array.isArray(consumptionMonths)||!Array.isArray(consumptionValues))return empty('no-consumption','Для выбранной ТП нет помесячного полезного отпуска в ПО.',key);
    let intakeSum=0,outgoingSum=0,complete=0,missingIntake=0,missingOutgoing=0,outside=0,
      elevated=0,negative=0,uncertain=0;
    const monthRows=consumptionMonths.map((date,i)=>{
      const slot=slots.get(calendarKey(date)),outgoing=consumptionValues[i];
      if(slot===undefined){outside++;return {y:date.y,m:date.m,intake:null,outgoing:validVolume(outgoing)?outgoing:null,imbalance:null,pct:null,status:'outside'};}
      const incoming=item.values[slot];
      if(item.uncertain[slot])uncertain++;
      if(incoming==null)missingIntake++;
      if(!validVolume(outgoing))missingOutgoing++;
      // Intake of 0 cannot be the denominator for percentage balance.
      if(incoming==null||!validVolume(outgoing)||incoming<=0){
        return {y:date.y,m:date.m,intake:incoming,outgoing:validVolume(outgoing)?outgoing:null,
          imbalance:null,pct:null,status:incoming===0&&validVolume(outgoing)?'zero-intake':'incomplete'};
      }
      const imbalance=round(incoming-outgoing),pct=round(100*imbalance/incoming);
      complete++;intakeSum+=incoming;outgoingSum+=outgoing;
      let status='ok';
      if(pct<0){negative++;status='negative';}
      else if(pct>threshold){elevated++;status='high';}
      return {y:date.y,m:date.m,intake:incoming,outgoing,imbalance,pct,status};
    });
    const totalIntake=complete?round(intakeSum):null,
      totalOutgoing=complete?round(outgoingSum):null,
      imbalance=complete?round(intakeSum-outgoingSum):null,
      pct=totalIntake>0?round(100*imbalance/totalIntake):null;
    const warning=[];
    if(unassigned)warning.push('В файле «Приём» есть '+unassigned+' строк без ТП. Они не распределены между контурами и могут влиять на полноту баланса.');
    if(item.duplicates)warning.push('Повторяющихся номеров вводных ПУ: '+item.duplicates+'. Совпадающие строки учитываются один раз; конфликтующие месяцы исключены.');
    if(item.unknownMeters)warning.push('Строк без номера вводного ПУ: '+item.unknownMeters+'. При наличии значений соответствующий месяц исключён.');
    if(item.multipleTP)warning.push('Вводных ПУ с привязкой к нескольким ТП: '+item.multipleTP+'. Без дат переподключения их объёмы не распределяются.');
    if(uncertain)warning.push('Месяцев с неоднозначным техническим учётом: '+uncertain+'. Они не участвуют в балансе.');
    if(missingIntake||missingOutgoing||outside)warning.push('Неполные месяцы не считаются нулём и исключены из итогов.');
    const status=complete?'ready':outside===consumptionMonths.length?'no-overlap':'incomplete';
    return {status,tp:item.name,months:monthRows,values:monthRows.map(row=>row.intake),
      comparedMonths:complete,totalMonths:consumptionMonths.length,threshold,
      totalIntake,totalOutgoing,imbalance,pct,elevated,negative,
      missingIntake,missingOutgoing,outside,uncertain,
      intakeMeterCount:item.meters,intakeRows:item.rows,duplicateMeters:item.duplicates,
      multipleTP:item.multipleTP,unknownMeters:item.unknownMeters,
      warnings:warning,
    };
  }
  return {
    status:'available',
    hasTP:tp=>aggregated.has(tpKey(tp)),
    tpList:()=>[...aggregated.values()].map(g=>({name:g.name,meters:g.meters})),
    summary:{tpCount:aggregated.size,unassignedRows:unassigned,months:pack.months.length},
    compare,
  };
}

function empty(status,message,tp=''){
  const result={status,message,tp,values:null,months:[],warnings:[],
    comparedMonths:0,totalIntake:null,totalOutgoing:null,imbalance:null,pct:null};
  return {
    ...result,
    hasTP:()=>false,tpList:()=>[],summary:{tpCount:0,unassignedRows:0,months:0},
    compare:()=>({...result}),
  };
}
