const storageKey='abonent.identity.v1';
const roleName={user:'Пользователь',admin:'Администратор',superadmin:'Суперадминистратор'};
export function initAccountUI({onLogout=()=>{},onChange=()=>{},canRefresh=()=>true,reload=()=>location.reload(),fetcher=(...args)=>fetch(...args)}={}){
  const $=selector=>document.querySelector(selector),dialog=$('#login-dialog');
  let enabled=false,user=null,offline=false,expiry=null,opening=null;
  function save(){try{if(user)localStorage.setItem(storageKey,JSON.stringify({user,expiresAt:expiry}));else localStorage.removeItem(storageKey);}catch{}}
  function render(){
    $('#account-section').hidden=!enabled;$('#account-name').textContent=user?.name||'Вход не выполнен';
    $('#account-description').textContent=user?[user.login,roleName[user.role],offline?'Работа без связи':''].filter(Boolean).join(' · '):'Войдите в свою учётную запись.';
    $('#admin-tab').hidden=!enabled||!['admin','superadmin'].includes(user?.role);
    $('#admin-upload-open').hidden=$('#admin-tab').hidden;
    $('#account-logout').disabled=!user;onChange({enabled,user,offline});
  }
  const status=value=>{$('#login-message').textContent=value;$('#login-message').hidden=!value;};
  async function api(path,body){
    const response=await fetcher(new URL('./api/auth/'+path,location.href),{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000),...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
    const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'Не удалось войти.'),{status:response.status});return data;
  }
  function requireLogin(message=''){
    if(!enabled||opening)return opening;
    for(const modal of document.querySelectorAll('dialog[open]'))if(modal!==dialog)modal.close();
    user=null;offline=false;save();render();status(message);dialog.showModal();$('#login-login').focus();
    opening=new Promise(resolve=>{dialog.addEventListener('authenticated',()=>{opening=null;resolve();},{once:true});});return opening;
  }
  function savedIdentity(){try{const data=JSON.parse(localStorage.getItem(storageKey)||'null');if(data?.user?.active&&new Date(data.expiresAt).getTime()>Date.now()){user=data.user;expiry=data.expiresAt;offline=true;render();return true;}}catch{}return false;}
  dialog.addEventListener('cancel',event=>event.preventDefault());
  $('#login-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=$('#login-submit');if(button.disabled)return;button.disabled=true;status('Входим…');
    try{const data=await api('login',{login:$('#login-login').value,password:$('#login-password').value});user=data.user;expiry=data.expiresAt;offline=false;save();render();$('#login-password').value='';dialog.close();dialog.dispatchEvent(new Event('authenticated'));reload();}
    catch(error){status(error.message);}finally{button.disabled=false;}
  });
  $('#account-logout').addEventListener('click',async()=>{
    const button=$('#account-logout');button.disabled=true;
    try{await api('logout',{});user=null;save();onLogout();reload();}
    catch(error){$('#account-message').textContent='Для полного выхода нужна связь: '+error.message;$('#account-message').hidden=false;}
    finally{button.disabled=false;}
  });
  window.addEventListener('abonent-auth-required',()=>{if(enabled&&!dialog.open)void requireLogin('Сессия завершена. Войдите снова.');});
  window.addEventListener('online',async()=>{
    if(!enabled||dialog.open||!canRefresh())return;
    try{const data=await api('session');if(!data.user){void requireLogin('Войдите снова для работы с сервером.');}else{user=data.user;expiry=data.expiresAt;offline=false;save();render();}}catch{}
  });
  return{
    get enabled(){return enabled;},get user(){return user;},get isAdmin(){return !enabled||['admin','superadmin'].includes(user?.role);},
    async start(auth){
      enabled=Boolean(auth?.enabled);if(!enabled){render();return;}
      if(!navigator.onLine){
        if(savedIdentity())return;
        await requireLogin('Для первого входа нужна связь. Ранее сохранённые данные доступны после входа.');return;
      }
      try{const data=await api('session');user=data.user;expiry=data.expiresAt;if(user){save();render();return;}}
      catch(error){if((!error.status||error.status>=500)&&savedIdentity())return;await requireLogin(error.message);return;}
      await requireLogin();
    },
  };
}
