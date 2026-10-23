import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { createPreparedStore } from './prepared-store.mjs';
import { createAccessControl, createAdminHandler, readAdminJson, onlyFields } from './access-control.mjs';
import { createMapGeocoder } from './map-geocoder.mjs';
import { createNotificationsHandler } from './user-notifications.mjs';
import { createSochiAnalytics } from './sochi-analytics.mjs';
import { createSochiRegistry } from './sochi-registry.mjs';
import { receiveSochiWorkbook } from './sochi-import.mjs';
import { createSochiChunkUploads } from './sochi-chunk-upload.mjs';
import { preparationMemory } from './prepared-service.mjs';
import { fault, superAdminConfig } from './accounts.mjs';
import { sourceRoleKeys } from './public/source.js';
import { PREPARATION_BUILD } from './public/preparation-policy.js';
import { SOCHI_SOURCE, SOCHI_ENTERPRISE_PATH, SOCHI_RES_PATHS, SOCHI_ROLES, canAccessRes, canonicalSochiPath } from './public/sochi-config.js';

const root = resolve(fileURLToPath(new URL('./public/', import.meta.url)));
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};
const sendJson = (res,status,data) => {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
};
const validPath = value => typeof value==='string' && value.startsWith('/') && value.length<4096 && !value.includes('\0') && !value.split('/').includes('..');
function directoryItems(path,folders,offset) {
  let items;
  if(path==='/') items=folders.length?[{type:'dir',path:SOCHI_ENTERPRISE_PATH,name:SOCHI_ENTERPRISE_PATH.slice(1)}]:[];
  else if(path===SOCHI_ENTERPRISE_PATH)items=folders.map(f=>({type:'dir',path:f.res_path,name:f.res_name}));
  else {
    const folder=folders.find(f=>f.res_path===path);
    if(folder) items=Object.values(folder.statuses||{}).filter(s=>s.path&&s.state!=='missing')
      .map(s=>({type:'file',path:s.path,name:s.path.split('/').at(-1),originalName:s.file,size:s.size,modified:s.modified}));
    else {
      const status=folders.flatMap(f=>Object.values(f.statuses||{})).find(s=>s.path===path);
      return status?{type:'file',path:status.path,name:status.file,size:status.size,modified:status.modified}:null;
    }
  }
  if(!items) return null;
  items.sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  return {type:'dir',path,_embedded:{items:items.slice(offset,offset+100),total:items.length}};
}
function accessFolders(user,folders) {
  return folders.filter(folder=>canAccessRes(user,folder.res_path));
}
function assertScope(user,path) {
  if(!canAccessRes(user,path))throw fault('РЭС не входит в вашу зону доступа.',403,'res_forbidden');
}
export function createSochiServer(options={}) {
  const env=options.env||process.env;
  if(!env.SUPER_ADMIN_LOGIN||!env.SUPER_ADMIN_PASSWORD)throw new Error('Для Сочи обязательны SUPER_ADMIN_LOGIN и SUPER_ADMIN_PASSWORD.');
  superAdminConfig(env);
  const store=options.preparedStore||createPreparedStore({...env,SOCHI_APP:'1'});
  if(!store)throw new Error('Для Сочи обязательна база PostgreSQL: задайте DB_HOST, DB_PORT, DB_NAME, DB_USER и DB_PASSWORD.');
  const access=createAccessControl({env,store,sendJson});
  const geocoder=options.mapGeocoder||createMapGeocoder();
  const registry=createSochiRegistry({store,source:SOCHI_SOURCE});
  const analytics=createSochiAnalytics({store,source:SOCHI_SOURCE,registry});
  const notifications=createNotificationsHandler({
    source:SOCHI_SOURCE,store,sendJson,canAccess:(req,path)=>canAccessRes(req.account,path),
    canClear:req=>['admin','superadmin'].includes(req.account?.role),
  });
  const admin=createAdminHandler({
    store,source:SOCHI_SOURCE,access,sendJson,enforceSochiScope:true,
    prepared:{status:()=>({syncing:false,preparing:false,activeFiles:0}),cancelRes:()=>{}},
    state:()=>({sync:{state:'ready',checkedAt:null,issue:null},preparation:{syncing:false,preparing:false,activeFiles:0}}),
    refreshCatalog:async()=>{throw fault('Синхронизация с внешними дисками отключена.',405);},
  });
  let uploadQueue=Promise.resolve();
  const uploads=createSochiChunkUploads();
  async function logUploadFailure(actor,resPath,role,error) {
    // The original Excel remains in a temporary file only; logs contain
    // the reason and scope, never file bytes or customer data.
    try {
      await store.appendAdminEvent(SOCHI_SOURCE,{
        category:'upload',code:'upload_failed',resPath,actor:actor.login,
        message:'Не удалось загрузить '+role+': '+String(error.message||'Ошибка обработки Excel').slice(0,320),
      });
    } catch(logError) {
      console.warn('Sochi upload audit log unavailable:',logError.message);
    }
  }
  async function saveUploaded(actor,{resPath,role,filename},received) {
    const extension=/\.xls$/i.test(filename||'')?'.xls':'.xlsx';
    const path=canonicalSochiPath(resPath,role,extension);
    const status=await store.saveSochiUpload(SOCHI_SOURCE,{
      resPath,role,path,filename,size:received.size,revision:received.revision,
      json:received.json,actor:actor.login,
    });
    registry.invalidate(resPath);
    analytics.invalidate(resPath);
    return {ok:true,role,resPath,status};
  }
  // Only the memory-intensive workbook preparation + DB swap are serialized;
  // small authenticated chunks may arrive while an unrelated file is parsed.
  async function sequentialSave(work) {
    const prior=uploadQueue;
    let release;
    uploadQueue=new Promise(resolve=>{release=resolve;});
    try {await prior;return await work();}
    finally {release();}
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self' https://photon.komoot.io https://nominatim.openstreetmap.org; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    try {
      const url=new URL(req.url,'http://localhost');
      if(await access.authRoute(req,res,url))return;
      if(url.pathname==='/api/config') {
        if(req.method!=='GET')throw fault('Метод не поддерживается.',405);
        sendJson(res,200,{publicUrl:SOCHI_SOURCE,configured:true,proxy:true,prepared:true,sochi:true,
          localUploads:true,maxFileMB:80,databaseConnected:true,enterprise:SOCHI_ENTERPRISE_PATH,
          preparation:{build:PREPARATION_BUILD,registryReader:'streaming-xlsx'},
          maps:{geocoder:geocoder.hostname},auth:{enabled:true}});
        return;
      }
      if(url.pathname.startsWith('/api/')) {
        req.account=await access.require(req);
        if(!req.account)throw fault('Войдите в учётную запись.',401,'auth_required');
      }
      if(url.pathname==='/api/admin/template') {
        // Template downloads are always authenticated, even though examples contain
        // only fictitious data. A normal employee must not enter admin workflows.
        await access.requireAdmin(req);
        if(req.method!=='GET')throw fault('Метод не поддерживается.',405);
        const role=url.searchParams.get('role');
        if(!sourceRoleKeys.includes(role))throw fault('Выберите тип файла.');
        // Do not load the heavy Excel library on every Sochi server start.
        // Administrators use templates occasionally; normal API requests stay lightweight.
        const { buildSochiTemplate }=await import('./sochi-template.mjs');
        const file=buildSochiTemplate(role);
        res.writeHead(200,{
          'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.filename),
          'Content-Length':file.buffer.length,
          'Cache-Control':'no-store',
        });
        res.end(file.buffer);
        return;
      }
      if(url.pathname==='/api/admin/upload/start') {
        const actor=await access.requireAdmin(req);
        if(req.method!=='POST')throw fault('Метод не поддерживается.',405);
        const body=await readAdminJson(req);
        onlyFields(body,['resPath','role','filename','size']);
        if(!SOCHI_RES_PATHS.includes(body.resPath)||!sourceRoleKeys.includes(body.role))
          throw fault('Выберите РЭС и тип файла.');
        const result=await uploads.start({actor,...body});
        sendJson(res,200,{ok:true,...result});
        return;
      }
      if(url.pathname==='/api/admin/upload/chunk') {
        const actor=await access.requireAdmin(req);
        if(req.method!=='POST')throw fault('Метод не поддерживается.',405);
        const uploadId=url.searchParams.get('uploadId');
        const index=Number(url.searchParams.get('index'));
        const result=await uploads.chunk(req,{actor,uploadId,index});
        sendJson(res,200,{ok:true,...result});
        return;
      }
      if(url.pathname==='/api/admin/upload/complete') {
        const actor=await access.requireAdmin(req);
        if(req.method!=='POST')throw fault('Метод не поддерживается.',405);
        const body=await readAdminJson(req);
        onlyFields(body,['uploadId']);
        const result=await sequentialSave(()=>uploads.complete({
          actor,uploadId:body.uploadId,
          save:(session,received)=>saveUploaded(actor,session,received),
          onError:(session,error)=>logUploadFailure(actor,session.resPath,session.role,error),
        }));
        sendJson(res,200,result);
        return;
      }
      if(url.pathname==='/api/admin/upload/cancel') {
        const actor=await access.requireAdmin(req);
        if(req.method!=='POST')throw fault('Метод не поддерживается.',405);
        const body=await readAdminJson(req);
        onlyFields(body,['uploadId']);
        sendJson(res,200,await uploads.cancel({actor,uploadId:body.uploadId}));
        return;
      }
      if(url.pathname==='/api/admin/upload') {
        const actor=await access.requireAdmin(req);
        if(req.method!=='POST')throw fault('Метод не поддерживается.',405);
        const resPath=url.searchParams.get('resPath'),role=url.searchParams.get('role'),filename=url.searchParams.get('filename');
        if(!SOCHI_RES_PATHS.includes(resPath)||!sourceRoleKeys.includes(role))throw fault('Выберите РЭС и тип файла.');
        try {
          const result=await sequentialSave(async()=>{
            const received=await receiveSochiWorkbook(req,{role,filename});
            return saveUploaded(actor,{resPath,role,filename},received);
          });
          sendJson(res,200,result);
        } catch(error) {
          await logUploadFailure(actor,resPath,role,error);
          throw error;
        }
        return;
      }
      if(url.pathname==='/api/admin/analysis-settings') {
        const actor=await access.requireAdmin(req);
        if(req.method!=='POST')throw fault('Метод не поддерживается.',405);
        const body=await readAdminJson(req);
        onlyFields(body,['settings']);
        if(!body.settings||typeof body.settings!=='object'||Array.isArray(body.settings))throw fault('Некорректные параметры анализа.');
        const settings=await store.saveSochiAnalysisSettings(SOCHI_SOURCE,body.settings,actor.login);
        sendJson(res,200,{ok:true,settings});return;
      }
      if(url.pathname==='/api/admin/refresh-catalog')throw fault('Облачные источники отключены. Файлы загружает администратор.',405);
      if(url.pathname.startsWith('/api/admin/')) {await admin(req,res,url);return;}
      if(url.pathname==='/api/registry'){
        if(req.method!=='POST')throw fault('Метод не поддерживается.',405);
        const body=await readAdminJson(req);
        onlyFields(body,['resPath','action','payload']);
        assertScope(req.account,body.resPath);
        const result=await registry.query(body);
        sendJson(res,200,{result});return;
      }
      if(url.pathname==='/api/analysis-settings') {
        if(req.method!=='GET')throw fault('Метод не поддерживается.',405);
        sendJson(res,200,{settings:await store.getSochiAnalysisSettings(SOCHI_SOURCE)});return;
      }
      if(url.pathname==='/api/analysis') {
        if(req.method!=='POST')throw fault('Метод не поддерживается.',405);
        const body=await readAdminJson(req);
        onlyFields(body,['resPath','action','account','tp','point']);
        assertScope(req.account,body.resPath);
        const result=await analytics.query(body);
        sendJson(res,200,{result});return;
      }
      if(url.pathname==='/api/user-notifications') {await notifications(req,res,url);return;}
      if(url.pathname==='/api/map-geocode') {
        if(req.method!=='POST')throw fault('Метод не поддерживается.',405);
        const body=await readAdminJson(req);
        onlyFields(body,['address']);
        if(typeof body.address!=='string'||body.address.length>700)throw fault('Некорректный адрес.');
        sendJson(res,200,{candidates:await geocoder.lookup(body.address)});return;
      }
      if(url.pathname==='/api/diagnostics') {
        if(req.method!=='GET')throw fault('Метод не поддерживается.',405);
        let database={state:'connected',issue:null},folders=[];
        try {await store.ready?.();folders=await store.listFolders(SOCHI_SOURCE);}
        catch {database={state:'error',issue:'unavailable'};}
        sendJson(res,200,{sochi:true,source:{state:'configured',issue:null},database,catalog:{state:folders.length?'ready':'empty',resCount:folders.length,enterpriseCount:1},
          sync:{state:'ready',issue:null},memory:await preparationMemory(),snapshotStorage:store.snapshotStorage||'json'});return;
      }
      if(url.pathname==='/api/load-map') {
        if(req.method!=='GET')throw fault('Метод не поддерживается.',405);
        sendJson(res,200,{folders:accessFolders(req.account,await store.listFolders(SOCHI_SOURCE)).map(f=>({...f,load_blocked:false}))});return;
      }
      if(url.pathname==='/api/directory') {
        if(req.method!=='GET')throw fault('Метод не поддерживается.',405);
        const path=url.searchParams.get('path')||'/';
        if(!validPath(path))throw fault('Некорректный путь.');
        const folders=accessFolders(req.account,await store.listFolders(SOCHI_SOURCE));
        if(path!== '/' && path!==SOCHI_ENTERPRISE_PATH)assertScope(req.account,path);
        const offset=Math.max(0,Math.min(100000,Number(url.searchParams.get('offset'))||0));
        const data=directoryItems(path,folders,offset);
        if(!data)throw fault('Файл или папка не найдены в базе.',404,'not_found');
        sendJson(res,200,data);return;
      }
      if(url.pathname==='/api/prepared') {
        if(!['GET','HEAD'].includes(req.method))throw fault('Метод не поддерживается.',405);
        const path=url.searchParams.get('path')||'',role=url.searchParams.get('role')||'';
        if(!sourceRoleKeys.includes(role)||!validPath(path)||!/\.xlsx?$/i.test(path))throw fault('Некорректный запрос.');
        assertScope(req.account,path);
        const folder=(await store.listFolders(SOCHI_SOURCE)).find(f=>f.res_path===SOCHI_RES_PATHS.find(r=>path.startsWith(r+'/')));
        if(!folder||folder.statuses?.[role]?.path!==path)throw fault('Пакет этого РЭС не найден.',404,'not_found');
        // RES loading controls affect administrator writes, not reading published snapshots.
        const meta=await store.getMeta(SOCHI_SOURCE,path,role);
        if(!meta)throw fault('Файл ещё не загружен администратором.',404,'not_found');
        const revision=Buffer.from(meta.revision).toString('base64url');
        const headers={'ETag':'"'+revision+'"','Cache-Control':'no-store','X-Prepared-Revision':revision,'X-Prepared-Stale':'0'};
        if(req.headers['if-none-match']==='"'+revision+'"'){res.writeHead(304,headers);res.end();return;}
        if(req.method==='HEAD'){res.writeHead(200,headers);res.end();return;}
        const item=await store.getJson(SOCHI_SOURCE,path,role);
        if(!item)throw fault('Пакет отсутствует в базе.',404,'not_found');
        res.writeHead(200,{...headers,'Content-Type':'application/json; charset=utf-8','Content-Encoding':'gzip'});
        const encoded=Readable.from([item.json]).pipe(createGzip());
        encoded.on('error',()=>res.destroy());
        encoded.pipe(res);
        return;
      }
      if(url.pathname.startsWith('/api/'))throw fault('Адрес API не найден.',404,'not_found');
      if(!['GET','HEAD'].includes(req.method))throw fault('Метод не поддерживается.',405);
      const file=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
      if(file!==root&&!file.startsWith(root+sep))throw fault('Некорректный адрес.',400);
      const info=await stat(file);
      if(!info.isFile())throw fault('Страница не найдена.',404);
      const ext=extname(file).toLowerCase();
      res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':ext==='.html'?'no-cache':'public, max-age=300'});
      if(req.method==='HEAD')res.end();else createReadStream(file).pipe(res);
    } catch(error) {
      if(error.code==='ENOENT'){sendJson(res,404,{error:'Страница не найдена.'});return;}
      if(!error.status)console.error('Sochi request error:',error.message);
      sendJson(res,error.status||500,{error:error.status?error.message:'Ошибка сервера. Проверьте базу или журнал приложения.',code:error.code||'server_error'});
    }
  });
  server.preparedStore=store;
  server.accessControl=access;
  server.on('close',()=>{
    void Promise.allSettled([Promise.resolve(store.close?.()),uploads.close()]);
  });
  return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const server=createSochiServer();
  const port=Number(process.env.PORT)||3000;
  await server.preparedStore.ready();
  server.listen(port,'0.0.0.0',()=>console.log('Web_abonent_sochi: PostgreSQL ready, port '+port+'. Яндекс Диск отключён.'));
}
