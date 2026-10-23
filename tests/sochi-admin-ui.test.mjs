import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Window } from 'happy-dom';
import { SOCHI_RES_PATHS } from '../public/sochi-config.js';
import { initAdminUI } from '../public/admin-ui.js';

async function until(condition,label){
  for(let i=0;i<300;i++){if(condition())return;await delay(5);}
  assert.fail('Timed out: '+label);
}

test('Sochi admin sees seven RES scopes, manages staff visibility and uploads XLSX by selected RES and type',async t=>{
  const page=new Window({url:'https://sochi.example.test/',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}});
  page.document.write(await readFile(new URL('../public/index.html',import.meta.url),'utf8'));
  for(const [key,value] of Object.entries({window:page,document:page.document,location:page.location,navigator:{onLine:true}})){
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  const $=selector=>page.document.querySelector(selector);
  const admin={id:'admin-id',role:'superadmin',active:true,login:'admin',name:'Администратор'};
  const users=[];
  const requests=[];
  let changeCount=0;
  const folder=res_path=>({
    res_path,load_blocked:false,local_blocked:false,enterprise_name:'Сочинское предприятие электрических сетей',
    res_name:res_path.split('/').at(-1),statuses:res_path===SOCHI_RES_PATHS[1]?{events:{state:'ready',file:'События.xlsx'}}:{}
  });
  const fetcher=async(input,options={})=>{
    const url=new URL(input);
    const path=url.pathname,method=options.method||'GET';
    requests.push({path,method,url,body:options.body});
    if(path==='/api/admin/accounts'&&method==='GET')return Response.json({accounts:[admin,...users]});
    if(path==='/api/admin/database'&&method==='GET')return Response.json({
      overview:{database_bytes:512,snapshot_count:1,payload_bytes:512,account_count:users.length+1},
      folders:SOCHI_RES_PATHS.map(folder),events:[],globalBlocked:false
    });
    if(path==='/api/admin/accounts'&&method==='POST'){
      const body=JSON.parse(options.body);
      const item={id:'employee-id',bootstrap:false,...body,resPaths:body.resPaths||[]};
      users.push(item);
      return Response.json({account:item});
    }
    if(path==='/api/admin/accounts/employee-id'&&method==='PATCH'){
      Object.assign(users[0],JSON.parse(options.body));return Response.json({account:users[0]});
    }
    if(path==='/api/admin/upload'&&method==='POST')return Response.json({ok:true});
    throw new Error('Unexpected admin API request: '+method+' '+path);
  };
  const ui=initAdminUI({account:()=>admin,fetcher,onDatabaseChanged:()=>changeCount++});
  t.after(async()=>{page.dispatchEvent(new page.Event('pagehide'));await page.happyDOM.close();});
  $('#admin-settings').hidden=false;
  await ui.refresh();
  assert.equal($('#admin-res-checkboxes').querySelectorAll('[data-res-scope]').length,7);
  assert.equal($('#admin-upload-res').options.length,7);
  assert.equal($('#admin-upload-role').options.length,5);
  assert.equal(page.document.querySelector('[data-open-enterprises]'),null);

  $('#admin-add-account').click();
  $('#admin-user-name').value='Инспектор Сочи';
  $('#admin-user-login').value='inspector';
  $('#admin-user-password').value='valid-long-password';
  $('#admin-scope-all').click();
  assert.equal($('#admin-res-checkboxes').querySelectorAll('input:checked').length,7);
  $('#admin-scope-none').click();
  assert.equal($('#admin-res-checkboxes').querySelectorAll('input:checked').length,0);
  const boxes=$('#admin-res-checkboxes').querySelectorAll('[data-res-scope]');
  boxes[0].checked=true;boxes[1].checked=true;
  $('#admin-account-form').dispatchEvent(new page.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>users.length===1&&$('#admin-account-form').hidden,'account create request');
  const created=requests.find(item=>item.path==='/api/admin/accounts'&&item.method==='POST');
  assert.deepEqual(JSON.parse(created.body).resPaths,[SOCHI_RES_PATHS[0],SOCHI_RES_PATHS[1]]);
  await until(()=>$('#admin-account-list').textContent.includes('Адлерский РЭС'),'account scope names visible');
  assert.match($('#admin-account-list').textContent,/Краснополянский РЭС/);
  $('#admin-account-list').querySelector('[data-account-edit="1"]').click();
  assert.equal($('#admin-res-checkboxes').querySelectorAll('input:checked').length,2);
  boxes[0].checked=false;
  $('#admin-account-form').dispatchEvent(new page.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>requests.some(item=>item.method==='PATCH'),'account scope edit');
  const edit=requests.find(item=>item.method==='PATCH');
  assert.deepEqual(JSON.parse(edit.body).resPaths,[SOCHI_RES_PATHS[1]]);

  $('#admin-upload-res').value=SOCHI_RES_PATHS[1];
  $('#admin-upload-role').value='events';
  $('#admin-upload-res').dispatchEvent(new page.Event('change'));
  assert.match($('#admin-upload-current').textContent,/События.xlsx/);
  Object.defineProperty($('#admin-upload-file'),'files',{configurable:true,value:[{name:'Новый журнал.xlsx',size:1000}]});
  $('#admin-upload-form').dispatchEvent(new page.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>requests.some(item=>item.path==='/api/admin/upload'),'file upload');
  const upload=requests.find(item=>item.path==='/api/admin/upload');
  assert.equal(upload.url.searchParams.get('resPath'),SOCHI_RES_PATHS[1]);
  assert.equal(upload.url.searchParams.get('role'),'events');
  assert.equal(upload.url.searchParams.get('filename'),'Новый журнал.xlsx');
  assert.equal(upload.body.name,'Новый журнал.xlsx');
  await until(()=>changeCount===1,'admin upload completion');
  assert.match($('#admin-upload-message').textContent,/Готово.*Краснополянский РЭС/);
});
