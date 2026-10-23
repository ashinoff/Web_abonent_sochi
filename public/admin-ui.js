import { formatBytes } from './offline-copies.js';
import { SOCHI_RES_NAMES, SOCHI_RES_PATHS, SOCHI_ROLES } from './sochi-config.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const roleName={user:'Пользователь',admin:'Администратор',superadmin:'Суперадминистратор'};
const dates=value=>value?new Date(value).toLocaleString('ru-RU'):'—';
const scopeLabel=user=>user.role==='user'?(user.resPaths||[]).map(path=>SOCHI_RES_NAMES[SOCHI_RES_PATHS.indexOf(path)]||path).join(', ')||'не назначены':'все 7 РЭС';
export function initAdminUI({account,onDatabaseChanged=()=>{},fetcher=(...args)=>fetch(...args)}){
  const $=selector=>document.querySelector(selector),panel=$('#admin-settings');
  let accounts=[],database=null,editing=null,loading=false,version=0;
  const resChecks=$('#admin-res-checkboxes'),resBlock=$('#admin-user-res-scopes');
  if(resChecks)resChecks.innerHTML=SOCHI_RES_PATHS.map((path,i)=>
    `<label><input type="checkbox" data-res-scope="${esc(path)}"><span>${esc(SOCHI_RES_NAMES[i])}</span></label>`).join('');
  const uploadRes=$('#admin-upload-res'),uploadRole=$('#admin-upload-role');
  if(uploadRes)uploadRes.innerHTML=SOCHI_RES_PATHS.map((path,i)=>
    `<option value="${esc(path)}">${esc(SOCHI_RES_NAMES[i])}</option>`).join('');
  if(uploadRole)uploadRole.innerHTML=Object.entries(SOCHI_ROLES).map(([role,name])=>
    `<option value="${role}">${esc(name)}</option>`).join('');
  const updateScopes=()=>{if(resBlock)resBlock.hidden=$('#admin-user-role').value!=='user';};
  // A user's scope is an explicit list of RES; admin and superadmin see all seven.
  for(const [id,checked] of [['#admin-scope-all',true],['#admin-scope-none',false]]){
    $(id)?.addEventListener('click',()=>resChecks?.querySelectorAll('[data-res-scope]').forEach(box=>{box.checked=checked;}));
  }
  $('#admin-user-role').addEventListener('change',updateScopes);
  const status=(selector,value,pending=false)=>{$(selector).textContent=value;$(selector).hidden=!value;$(selector).classList.toggle('loading',pending);};
  function allowed(){return ['admin','superadmin'].includes(account()?.role);}
  async function api(path,method='GET',body){
    if(!navigator.onLine)throw new Error('Для администрирования нужна связь.');
    const response=await fetcher(new URL('./api/admin/'+path,location.href),{method,credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000),...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Не удалось выполнить действие.');return data;
  }
  function form(user=null){
    editing=user;$('#admin-account-form').hidden=false;$('#admin-account-title').textContent=user?'Изменить учётную запись':'Новая учётная запись';
    $('#admin-user-name').value=user?.name||'';$('#admin-user-login').value=user?.login||'';$('#admin-user-password').value='';$('#admin-user-password').required=!user;
    $('#admin-user-role').replaceChildren();for(const role of account()?.role==='superadmin'?['user','admin','superadmin']:['user']){const option=document.createElement('option');option.value=role;option.textContent=roleName[role];$('#admin-user-role').append(option);}
    $('#admin-user-role').value=user?.role||'user';$('#admin-user-active').checked=user?.active??true;
    if(resChecks)resChecks.querySelectorAll('[data-res-scope]').forEach(box=>{box.checked=Boolean(user?.resPaths?.includes(box.dataset.resScope));});
    updateScopes();
    status('#admin-account-message','');$('#admin-account-form').scrollIntoView({block:'start',behavior:'smooth'});$('#admin-user-name').focus();
  }
  function renderAccounts(){
    $('#admin-account-list').innerHTML=accounts.map((user,i)=>`<article class="admin-account" data-account-id="${esc(user.id)}"><div><strong>${esc(user.name)}</strong><span>${esc(user.login)} · ${esc(roleName[user.role])}</span><small>${user.active?'Доступ разрешён':'Доступ отключён'} · Зона видимости: ${esc(scopeLabel(user))}${user.bootstrap?' · Настраивается в переменных Амверы':''}</small></div>${user.bootstrap?'':`<div class="admin-row-actions"><button type="button" class="secondary" data-account-edit="${i}">Изменить</button><button type="button" class="secondary admin-danger" data-account-delete="${i}" ${user.id===account()?.id?'disabled':''}>Удалить</button></div>`}</article>`).join('')||'<p class="hint">Учётных записей пока нет. Создайте пользователя.</p>';
  }
  function renderDatabase(){
    if(!database)return;const value=database.overview;
    $('#admin-db-summary').innerHTML=`<div class="admin-metrics"><div><span>База подключена</span><strong>${esc(formatBytes(Number(value.database_bytes)))}</strong></div><div><span>Пакетов в базе</span><strong>${esc(value.snapshot_count)}</strong></div><div><span>Объём пакетов</span><strong>${esc(formatBytes(Number(value.payload_bytes)))}</strong></div><div><span>Учётных записей</span><strong>${esc(value.account_count)}</strong></div></div><p class="hint">${database.globalBlocked?'Вся загрузка приостановлена.':'Загрузка разрешена для открытых РЭС.'} ${database.catalogRunning||database.preparation?.syncing?'Проверяем карту папок…':''}</p>`;
    $('#admin-global-policy').textContent=database.globalBlocked?'Разрешить общую загрузку':'Приостановить всю загрузку';
    const query=$('#admin-res-search').value.trim().toLowerCase(),groups=new Map();
    for(const folder of database.folders){if(query&&![folder.res_name,folder.enterprise_name].some(value=>value.toLowerCase().includes(query)))continue;if(!groups.has(folder.enterprise_name))groups.set(folder.enterprise_name,[]);groups.get(folder.enterprise_name).push(folder);}
    const open=new Set([...$('#admin-res-list').querySelectorAll('details[open]')].map(node=>node.dataset.enterprise));
    $('#admin-res-list').innerHTML=[...groups].map(([name,folders])=>`<details class="admin-enterprise" data-enterprise="${esc(name)}" ${query||open.has(name)?'open':''}><summary>${esc(name)}<small>${folders.length} РЭС</small></summary>${folders.map(folder=>{
      const errors=Object.entries(folder.statuses||{}).filter(([,state])=>state.state==='error'||state.state==='stale');
      return `<article class="admin-res"><div><strong>${esc(folder.res_name)}</strong><span class="admin-policy" data-blocked="${Boolean(folder.load_blocked)}">${folder.load_blocked?'Загрузка закрыта':'Загрузка открыта'}</span></div><p class="hint">Пакетов: ${esc(folder.package_count??'—')} · ${esc(formatBytes(Number(folder.payload_bytes||0)))} · Проверено: ${esc(dates(folder.checked_at))}</p>${errors.map(([role,item])=>`<p class="admin-error">${esc({registry:'Реестр',consumption:'ПО',incoming:'Приём',instant:'Журнал 31',events:'Журнал 46'}[role] || role)}: ${esc(item.message||'Ошибка подготовки. Проверьте файл и соединение.')}</p>`).join('')}<div class="admin-row-actions"><button type="button" class="secondary" data-res-policy="${esc(folder.res_path)}" data-blocked="${Boolean(folder.local_blocked)}" ${database.globalBlocked?'disabled':''}>${folder.local_blocked?'Разрешить загрузку':'Закрыть загрузку'}</button><button type="button" class="secondary admin-danger" data-res-clear="${esc(folder.res_path)}">Очистить данные РЭС</button></div></article>`;
    }).join('')}</details>`).join('')||'<p class="hint">РЭС не найдены. Обновите карту папок.</p>';
    renderUploadCurrent();
    $('#admin-events').innerHTML=database.events.map(event=>`<article class="admin-event"><strong>${esc(event.message)}</strong><span>${esc(event.res_path==='/'?'Все РЭС':event.res_path||'')}${event.actor?' · '+esc(event.actor):''}</span><small>${esc(dates(event.created_at))} · ${esc(event.code)}</small></article>`).join('')||'<p class="hint">Ошибок и событий пока нет.</p>';
  }
  function renderUploadCurrent(){
    const node=$('#admin-upload-current');
    if(!node)return;
    const resPath=uploadRes?.value,role=uploadRole?.value;
    if(!SOCHI_RES_PATHS.includes(resPath)||!Object.hasOwn(SOCHI_ROLES,role)){
      node.textContent='Выберите РЭС и тип файла.';return;
    }
    if(!database){node.textContent='Проверяем текущий файл в базе…';return;}
    const folder=database.folders?.find(item=>item.res_path===resPath);
    if(folder?.load_blocked||folder?.local_blocked){
      node.textContent='Загрузка в этот РЭС закрыта. Разрешите её в разделе «Карта папок и загрузка».';return;
    }
    const existing=folder?.statuses?.[role];
    node.textContent=existing?.state==='ready'
      ? 'Сейчас в базе: '+(existing.file||SOCHI_ROLES[role])+'. Новый файл заменит эту версию после успешной обработки.'
      : 'Для выбранного РЭС источник «'+SOCHI_ROLES[role]+'» ещё не загружен.';
  }
  uploadRes?.addEventListener('change',renderUploadCurrent);
  uploadRole?.addEventListener('change',renderUploadCurrent);
  async function refresh({silent=false}={}){
    if(loading||!allowed()||(silent&&panel.hidden))return;loading=true;const run=++version;if(!silent)status('#admin-message','Проверяем базу и учётные записи…',true);
    try{const result=await Promise.all([api('accounts'),api('database')]);if(run!==version)return;accounts=result[0].accounts;database=result[1];renderAccounts();renderDatabase();status('#admin-message','');}
    catch(error){status('#admin-message',error.message);}finally{loading=false;}
  }
  async function action(button,work){if(button.disabled)return;button.disabled=true;try{await work();await refresh();}catch(error){status('#admin-message',error.message);}finally{button.disabled=false;}}
  $('#admin-refresh').addEventListener('click',()=>{void refresh();});
  $('#admin-add-account').addEventListener('click',()=>form());$('#admin-account-cancel').addEventListener('click',()=>{$('#admin-account-form').hidden=true;editing=null;$('#admin-user-password').value='';});
  $('#admin-account-list').addEventListener('click',event=>{
    const edit=event.target.closest('[data-account-edit]');if(edit){form(accounts[Number(edit.dataset.accountEdit)]);return;}
    const remove=event.target.closest('[data-account-delete]');if(!remove)return;const user=accounts[Number(remove.dataset.accountDelete)];
    if(window.confirm(`Удалить учётную запись «${user.name}» (${user.login})? Её действующие сессии будут закрыты.`))void action(remove,()=>api('accounts/'+user.id,'DELETE',{}));
  });
  $('#admin-account-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=$('#admin-account-save');if(button.disabled)return;button.disabled=true;
    try{const body={name:$('#admin-user-name').value,login:$('#admin-user-login').value,role:$('#admin-user-role').value,active:$('#admin-user-active').checked};if($('#admin-user-password').value)body.password=$('#admin-user-password').value;
      if(body.role==='user'&&resChecks){body.resPaths=[...resChecks.querySelectorAll('[data-res-scope]:checked')].map(node=>node.dataset.resScope);if(!body.resPaths.length)throw new Error('Назначьте пользователю хотя бы один РЭС.');}
      const saved=await api('accounts'+(editing?'/'+editing.id:''),editing?'PATCH':'POST',body);$('#admin-user-password').value='';$('#admin-account-form').hidden=true;editing=null;await refresh();[...$('#admin-account-list').children].find(row=>row.dataset.accountId===saved.account.id)?.scrollIntoView({block:'nearest',behavior:'smooth'});}
    catch(error){status('#admin-account-message',error.message);}finally{button.disabled=false;}
  });
  $('#admin-res-search').addEventListener('input',renderDatabase);
  $('#admin-res-list').addEventListener('click',event=>{
    const policy=event.target.closest('[data-res-policy]'),clear=event.target.closest('[data-res-clear]');
    if(policy){const blocked=policy.dataset.blocked!=='true';void action(policy,async()=>{await api('res-policy','POST',{resPath:policy.dataset.resPolicy,blocked});onDatabaseChanged();});}
    if(clear&&window.confirm('Очистить пакеты этого РЭС в серверной базе и закрыть его загрузку? Учётные записи, отметки и копии на телефонах сохранятся.'))void action(clear,async()=>{await api('clear-data','POST',{resPath:clear.dataset.resClear,confirm:true});onDatabaseChanged();});
  });
  $('#admin-global-policy').addEventListener('click',event=>{if(database&&window.confirm(database.globalBlocked?'Разрешить общую загрузку? Отдельные закрытые РЭС останутся закрытыми.':'Приостановить загрузку всех РЭС?'))void action(event.currentTarget,async()=>{await api('res-policy','POST',{resPath:'/',blocked:!database.globalBlocked});onDatabaseChanged();});});
  $('#admin-clear-database').addEventListener('click',event=>{if(window.confirm('Очистить ВСЕ подготовленные пакеты текущего источника и приостановить всю загрузку? Учётные записи и пользовательские отметки сохранятся.'))void action(event.currentTarget,async()=>{await api('clear-data','POST',{resPath:'/',confirm:true});onDatabaseChanged();});});
  $('#admin-clear-events').addEventListener('click',event=>{if(window.confirm('Очистить журнал ошибок и действий?'))void action(event.currentTarget,()=>api('clear-events','POST',{}));});
  $('#admin-catalog-refresh').addEventListener('click',event=>{void refresh();});
  $('#admin-upload-form')?.addEventListener('submit',async event=>{
    event.preventDefault();
    if(!allowed())return;
    const button=$('#admin-upload-submit'),file=$('#admin-upload-file').files[0];
    const resPath=uploadRes.value,role=uploadRole.value;
    if(!navigator.onLine){status('#admin-upload-message','Для загрузки Excel требуется подключение к серверу.');return;}
    if(!SOCHI_RES_PATHS.includes(resPath)||!Object.hasOwn(SOCHI_ROLES,role)){status('#admin-upload-message','Выберите РЭС и тип файла.');return;}
    if(!file)return;
    if(!/\.(xls|xlsx)$/i.test(file.name)){status('#admin-upload-message','Выберите файл Excel в формате XLS или XLSX.');return;}
    if(file.size>80*1048576){status('#admin-upload-message','Файл больше 80 МБ.');return;}
    button.disabled=true;
    status('#admin-upload-message','Загружаем и обрабатываем Excel на сервере. Не закрывайте страницу.',true);
    try{
      const url=new URL('./api/admin/upload',location.href);
      url.searchParams.set('resPath',resPath);url.searchParams.set('role',role);url.searchParams.set('filename',file.name);
      const response=await fetcher(url,{method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Content-Type':'application/octet-stream','X-Sochi-Upload':'1'},body:file});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'Сервер не принял файл.');
      const resName=SOCHI_RES_NAMES[SOCHI_RES_PATHS.indexOf(resPath)];
      status('#admin-upload-message','Готово: '+file.name+'. Обновлён источник «'+SOCHI_ROLES[role]+'» для '+resName+'.');
      $('#admin-upload-file').value='';
      onDatabaseChanged();
      await refresh();
    }catch(error){status('#admin-upload-message','Ошибка загрузки: '+error.message);}
    finally{button.disabled=false;}
  });
  const timer=setInterval(()=>{if(allowed()&&!panel.hidden&&$('#settings-dialog').open&&navigator.onLine&&document.visibilityState==='visible')void refresh({silent:true});},10000);timer?.unref?.();
  renderUploadCurrent();
  window.addEventListener('pagehide',()=>clearInterval(timer));return{refresh,reset(){version++;accounts=[];database=null;editing=null;$('#admin-account-form').hidden=true;$('#admin-user-password').value='';}};
}
