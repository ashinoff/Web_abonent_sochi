import { randomBytes } from 'node:crypto';
import { SOCHI_RES_PATHS } from './public/sochi-config.js';
import { fault,superAdminConfig,accountLogin,accountPassword,accountName,roles,publicAccount,verifyPassword,sessionHash } from './accounts.mjs';

export async function readAdminJson(req){
  if(req.headers['sec-fetch-site']==='cross-site'||!String(req.headers['content-type']||'').startsWith('application/json'))throw fault('Нужен JSON-запрос с этого сайта.',415);
  if(req.headers.origin){const expected=new URL(req.headers.origin);if(expected.host!==req.headers.host)throw fault('Запрос с другого сайта запрещён.',403,'forbidden');}
  const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>8192)throw fault('Запрос слишком большой.',413);chunks.push(chunk);}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fault('Некорректный JSON.');}
  if(!body||typeof body!=='object'||Array.isArray(body))throw fault('Некорректный запрос.');return body;
}
export function onlyFields(body,fields){if(Object.keys(body).some(key=>!fields.includes(key)))throw fault('Неизвестное поле запроса.');}
const cookieName='abonent_session';
function token(req){const value=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);return /^[\w-]{43}$/.test(value||'')?value:null;}
function cookie(req,value,age){const secure=req.socket.encrypted||String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https';return`${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure?'; Secure':''}`;}
export function createAccessControl({env,store,sendJson}){
  const enabled=Boolean(env.SUPER_ADMIN_LOGIN||env.SUPER_ADMIN_PASSWORD);let config,configurationError;
  try{config=superAdminConfig(env);}catch(error){configurationError=error;}
  let initializing;const failures=new Map(),addresses=new Map();
  async function ready(){
    if(configurationError)throw configurationError;
    if(!enabled||!store?.ensureBootstrap)throw fault('Для учётных записей настройте суперадмина и PostgreSQL.',503,'auth_config');
    initializing ||=store.ensureBootstrap(config).catch(error=>{initializing=null;throw error.status?error:fault('База учётных записей недоступна. Проверьте подключение PostgreSQL в Амвере.',503,'database_unavailable');});await initializing;
  }
  async function identity(req){if(!enabled)return null;await ready();const value=token(req);if(!value)return null;try{return await store.session(sessionHash(value));}catch(error){throw error.status?error:fault('База учётных записей недоступна. Проверьте подключение PostgreSQL в Амвере.',503,'database_unavailable');}}
  const info=user=>({enabled,user:publicAccount(user),expiresAt:user?.expires_at||null});
  function limited(req,login){
    const address=req.socket.remoteAddress||'local',key=address+':'+login,now=Date.now();
    for(const [key,value]of failures)if(value.until<now)failures.delete(key);
    for(const [key,value]of addresses)if(value.until<now)addresses.delete(key);
    if(failures.size>=5000&&!failures.has(key))throw fault('Слишком много запросов входа.',429,'login_limited');
    const aggregate=addresses.get(address)||{count:0,until:now+15*60000};if(aggregate.count>=200)throw fault('Слишком много попыток входа с этого подключения. Повторите через 15 минут.',429,'login_limited');
    const value=failures.get(key)||{count:0,until:now+15*60000};if(value.count>=10)throw fault('Слишком много попыток входа. Повторите через 15 минут.',429,'login_limited');
    value.count++;aggregate.count++;failures.set(key,value);addresses.set(address,aggregate);return()=>{failures.delete(key);aggregate.count=Math.max(0,aggregate.count-1);};
  }
  return{
    enabled,ready,identity,
    async authRoute(req,res,url){
      if(!url.pathname.startsWith('/api/auth/'))return false;
      if(url.pathname==='/api/auth/session'&&req.method==='GET'){sendJson(res,200,info(await identity(req)));return true;}
      if(url.pathname==='/api/auth/login'&&req.method==='POST'){
        await ready();const body=await readAdminJson(req);onlyFields(body,['login','password']);const login=accountLogin(body.login);
        if(typeof body.password!=='string'||body.password.length>128)throw fault('Неверный логин или пароль.',401,'invalid_credentials');
        const success=limited(req,login),user=await store.findAccount(login);
        const correct=await verifyPassword(body.password,user?.password_hash);
        if(!correct||!user?.active)throw fault('Неверный логин или пароль.',401,'invalid_credentials');
        const value=randomBytes(32).toString('base64url'),expires=new Date(Date.now()+7*86400000);
        await store.createSession(user.id,sessionHash(value),expires,user.password_hash);success();
        res.setHeader('Set-Cookie',cookie(req,value,7*86400));sendJson(res,200,info({...user,expires_at:expires}));return true;
      }
      if(url.pathname==='/api/auth/logout'&&req.method==='POST'){
        await readAdminJson(req);const value=token(req);if(enabled&&value){await ready();await store.revokeSession(sessionHash(value));}
        res.setHeader('Set-Cookie',cookie(req,'',0));sendJson(res,200,{enabled,user:null});return true;
      }
      throw fault('Метод или адрес не поддерживается.',405);
    },
    async require(req){const user=await identity(req);if(enabled&&!user)throw fault('Войдите в учётную запись.',401,'auth_required');return user;},
    async requireAdmin(req){const user=await identity(req);if(!user||!['admin','superadmin'].includes(user.role))throw fault('Требуются права администратора.',403,'forbidden');return user;},
  };
}

export function createAdminHandler({store,source,access,prepared,sendJson,state,refreshCatalog,enforceSochiScope=false,cancelRes=path=>prepared?.cancelRes(path)}){
  let catalogJob=null;
  async function event(actor,code,message){await store.appendAdminEvent(source,{category:'accounts',code,message,actor:actor.login});}
  return async(req,res,url)=>{
    const actor=await access.requireAdmin(req);
    if(!store?.databaseOverview)throw fault('Управление базой не подключено.',503);
    const path=url.pathname;
    if(path==='/api/admin/accounts'&&req.method==='GET'){sendJson(res,200,{accounts:(await store.listAccounts(actor)).map(publicAccount)});return;}
    const account=path.match(/^\/api\/admin\/accounts\/([0-9a-f-]{36})$/i);
    if(path==='/api/admin/accounts'&&req.method==='POST'||account&&['PATCH','DELETE'].includes(req.method)){
      const body=await readAdminJson(req);
      if(req.method==='DELETE'){onlyFields(body,[]);await store.deleteAccount(actor,account[1]);await event(actor,'account_deleted','Учётная запись удалена.');sendJson(res,200,{ok:true});return;}
      onlyFields(body,['name','login','password','role','active','resPaths']);const data={};
      if(body.name!==undefined||!account)data.name=accountName(body.name);
      if(body.login!==undefined||!account)data.login=accountLogin(body.login);
      if(body.password!==undefined&&body.password!=='')data.password=accountPassword(body.password);
      if(body.role!==undefined){if(!roles.has(body.role))throw fault('Неизвестная роль.');data.role=body.role;}
      if(body.active!==undefined){if(typeof body.active!=='boolean')throw fault('Некорректное состояние учётной записи.');data.active=body.active;}
      if(body.resPaths!==undefined){if(!Array.isArray(body.resPaths)||body.resPaths.length>SOCHI_RES_PATHS.length||body.resPaths.some(path=>!SOCHI_RES_PATHS.includes(path)))throw fault('Неизвестный РЭС в зоне доступа.');data.resPaths=[...new Set(body.resPaths)];}
      if(enforceSochiScope && !account && (body.role===undefined||body.role==='user') && !data.resPaths?.length)throw fault('Выберите хотя бы один РЭС для пользователя.');
      if(enforceSochiScope && body.role==='user' && account && data.resPaths?.length===0)throw fault('Пользователю нужен хотя бы один РЭС.');
      const saved=await store.saveAccount(actor,account?.[1],data);await event(actor,account?'account_updated':'account_created','Учётная запись '+(account?'изменена.':'создана.'));
      sendJson(res,200,{account:publicAccount(saved)});return;
    }
    if(path==='/api/admin/database'&&req.method==='GET'){
      await store.ready?.();const policies=await store.listLoadPolicies(source);
      sendJson(res,200,{state:'connected',overview:await store.databaseOverview(source),folders:await(store.listAdminFolders?.(source)||store.listFolders(source)),
        events:await store.listAdminEvents(source),globalBlocked:Boolean(policies.find(p=>p.res_path==='/')?.blocked),catalogRunning:Boolean(catalogJob),...state()});return;
    }
    if(req.method!=='POST')throw fault('Метод или адрес не поддерживается.',405);
    const body=await readAdminJson(req);
    if(path==='/api/admin/res-policy'||path==='/api/admin/clear-data'){
      onlyFields(body,path.endsWith('res-policy')?['resPath','blocked']:['resPath','confirm']);
      const resPath=body.resPath;
      if(resPath!=='/'&&!(await store.listFolders(source)).some(folder=>folder.res_path===resPath))throw fault('Этот РЭС отсутствует в карте базы.',404);
      if(path.endsWith('res-policy')){
        if(typeof body.blocked!=='boolean')throw fault('Укажите состояние загрузки.');
        await store.setLoadPolicy(source,resPath,body.blocked,actor.login);if(body.blocked)cancelRes(resPath);
        sendJson(res,200,{ok:true});return;
      }
      if(body.confirm!==true)throw fault('Подтвердите очистку.');
      const result=await store.clearResData(source,resPath,actor.login);cancelRes(resPath);sendJson(res,200,{ok:true,...result});return;
    }
    if(path==='/api/admin/clear-events'){onlyFields(body,[]);await store.clearAdminEvents(source,actor.login);sendJson(res,200,{ok:true});return;}
    if(path==='/api/admin/refresh-catalog'){
      onlyFields(body,[]);
      if(!catalogJob)catalogJob=refreshCatalog().catch(()=>{}).finally(()=>{catalogJob=null;});
      sendJson(res,202,{ok:true,running:true});return;
    }
    throw fault('Адрес не найден.',404);
  };
}
