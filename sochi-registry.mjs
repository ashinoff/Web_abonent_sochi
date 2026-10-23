import { buildIndex, search, listTPs, metersByTP, listNotes, listMapNotes, notificationRecord, analysisRecords } from './public/core.js';
import { unpackRegistry } from './public/prepared-data.js';
import { fault } from './accounts.mjs';

const allowedActions=new Set(['summary','search','record','tps','tpMeters','notes','mapNotes','notificationRecord']);
function assertQuery(payload) {
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw fault('Некорректный запрос реестра.');
  for(const key of ['query','key','id','field']){
    if(payload[key]!=null&&(typeof payload[key]!=='string'||payload[key].length>300))throw fault('Некорректный параметр '+key);
  }
  for(const key of ['offset','limit']){
    if(payload[key]!=null&&(!Number.isSafeInteger(payload[key])||payload[key]<0||payload[key]>100000))throw fault('Некорректная страница.');
  }
  if(payload.fields!=null&&(typeof payload.fields!=='object'||Array.isArray(payload.fields)||Object.keys(payload.fields).length>20||
    Object.values(payload.fields).some(value=>typeof value!=='string'||value.length>300)))throw fault('Некорректные данные уведомления.');
}
export function createSochiRegistry({store,source}){
  const cache=new Map();
  const pending=new Map();
  async function get(resPath){
    const folder=(await store.listFolders(source)).find(f=>f.res_path===resPath);
    const path=folder?.statuses?.registry?.path;
    if(!path)throw fault('Администратор ещё не загрузил реестр этой РЭС.',404,'no_registry');
    const revision=(await store.getMeta(source,path,'registry'))?.revision;
    if(!revision)throw fault('Реестр пока не подготовлен.',404,'no_registry');
    const signature=JSON.stringify([resPath,path,revision]);
    if(cache.get(resPath)?.signature===signature)return cache.get(resPath);
    if(pending.has(signature))return pending.get(signature);
    const task=(async()=>{
      const entry=await store.getJson(source,path,'registry');
      if(!entry)throw fault('Реестр отсутствует в базе.',404,'no_registry');
      const sheets=unpackRegistry(JSON.parse(entry.json));
      const index=buildIndex(sheets);
      const summary={
        count:index.records.length,notesCount:index.notes.length,hasNotesColumn:index.hasNotesColumn,
        sheets:sheets.map(({sheet,layout,sample})=>({sheet,layout,sample})),
        skipped:[],revision,
      };
      cache.delete(resPath);
      cache.set(resPath,{signature,index,sheets,summary});
      while(cache.size>1)cache.delete(cache.keys().next().value);
      return cache.get(resPath);
    })().finally(()=>pending.delete(signature));
    pending.set(signature,task);
    return task;
  }
  return {
    get,invalidate(resPath){cache.delete(resPath);},
    async analysisRecords(resPath){const {index}=await get(resPath);return analysisRecords(index.records);},
    async query({resPath,action,payload={}}){
      if(!allowedActions.has(action))throw fault('Неизвестное действие реестра.',400,'invalid_action');
      assertQuery(payload);
      const {index,sheets,summary}=await get(resPath);
      if(action==='summary')return summary;
      if(action==='search')return search(index,{query:payload.query||'',field:payload.field||'meter',partial:true,
        offset:payload.offset||0,limit:Math.min(100,payload.limit||30)});
      if(action==='record'){
        const record=index.records.find(r=>r.id===payload.id);
        if(!record)throw fault('Запись не найдена.',404,'record_not_found');
        return {...record,labels:sheets.find(s=>s.sheet===record.sheet)?.layout.labels||[]};
      }
      if(action==='tps')return listTPs(index);
      if(action==='tpMeters')return metersByTP(index,{key:payload.key,query:payload.query||'',offset:payload.offset||0,limit:Math.min(200,payload.limit||100)});
      if(action==='notes')return listNotes(index,{query:payload.query||'',offset:payload.offset||0,limit:Math.min(200,payload.limit||100)});
      if(action==='mapNotes')return listMapNotes(index);
      return notificationRecord(index,payload.fields||{});
    },
  };
}
