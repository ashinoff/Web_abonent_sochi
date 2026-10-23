import test from 'node:test';
import assert from 'node:assert/strict';
import { createSochiServer } from '../sochi-server.mjs';
import * as XLSX from '@e965/xlsx';
import { SOCHI_SOURCE, SOCHI_ENTERPRISE_PATH, SOCHI_RES_NAMES, SOCHI_RES_PATHS, canAccessRes, canonicalSochiPath } from '../public/sochi-config.js';

test('Sochi has exactly one enterprise and seven stable RES',()=>{
  assert.equal(SOCHI_RES_PATHS.length,7);
  assert.equal(new Set(SOCHI_RES_NAMES).size,7);
  assert.ok(SOCHI_RES_PATHS.every(path=>path.startsWith(SOCHI_ENTERPRISE_PATH+'/')));
  assert.equal(canonicalSochiPath(SOCHI_RES_PATHS[0],'registry'),SOCHI_RES_PATHS[0]+'/Расширенный список.xlsx');
  assert.equal(canAccessRes({role:'user',res_paths:[SOCHI_RES_PATHS[0]]},SOCHI_RES_PATHS[0]),true);
  assert.equal(canAccessRes({role:'user',res_paths:[SOCHI_RES_PATHS[0]]},SOCHI_RES_PATHS[1]),false);
  assert.equal(canAccessRes({role:'admin'},SOCHI_RES_PATHS[1]+'/ПО.xlsx'),true);
  assert.equal(canAccessRes({role:'user',res_paths:[SOCHI_RES_PATHS[0]]},'/Чужой РЭС'),false);
});
test('Sochi cannot start with anonymous access or without PostgreSQL',()=>{
  assert.throws(()=>createSochiServer({env:{}}),/SUPER_ADMIN/);
  assert.throws(()=>createSochiServer({env:{SUPER_ADMIN_LOGIN:'safetycheck',SUPER_ADMIN_PASSWORD:'LongPassword123'}}),/PostgreSQL/);
});
test('Sochi API uses authenticated scoped DB catalog and admin-only rules',async t=>{
  if(!process.env.TEST_DB_HOST){t.skip('PostgreSQL integration database not configured');return;}
  const login='sochi-integration-superadmin',password='long-sochi-integration-password';
  const env={SUPER_ADMIN_LOGIN:login,SUPER_ADMIN_PASSWORD:password,SUPER_ADMIN_NAME:'Тестовый администратор',
    DB_HOST:process.env.TEST_DB_HOST,DB_PORT:process.env.TEST_DB_PORT,
    DB_NAME:process.env.TEST_DB_NAME,DB_USER:process.env.TEST_DB_USER,DB_PASSWORD:process.env.TEST_DB_PASSWORD};
  const server=createSochiServer({env});
  await server.preparedStore.ready();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const api=async(path,options={})=>fetch(base+path,options);
  const json=async(path,body,cookie,method='POST')=>api(path,{method,
    headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
    body:JSON.stringify(body)});
  try {
    assert.equal((await (await api('/api/config')).json()).publicUrl,SOCHI_SOURCE);
    assert.equal((await api('/api/directory?path=%2F')).status,401);
    assert.equal((await api('/api/resources?path=%2F')).status,401);
    let logged=await json('/api/auth/login',{login,password});
    assert.equal(logged.status,200);
    const adminCookie=logged.headers.get('set-cookie').split(';')[0];
    const folderResponse=await api('/api/directory?path=%2F',{headers:{Cookie:adminCookie}});
    const folder=await folderResponse.json();
    assert.equal(folder._embedded.items.length,1);
    assert.equal(folder._embedded.items[0].path,SOCHI_ENTERPRISE_PATH);
    const res=await api('/api/directory?path='+encodeURIComponent(SOCHI_ENTERPRISE_PATH),{headers:{Cookie:adminCookie}});
    const resList=await res.json();
    assert.equal(resList._embedded.total,7);
    const created=await json('/api/admin/accounts',{name:'Участковый сотрудник',login:'sochi-res-scope-test',password:'long-res-scope-password',role:'user',resPaths:[SOCHI_RES_PATHS[0]]},adminCookie);
    assert.equal(created.status,200);
    const {account}=await created.json();
    assert.deepEqual(account.resPaths,[SOCHI_RES_PATHS[0]]);
    const userLogin=await json('/api/auth/login',{login:'sochi-res-scope-test',password:'long-res-scope-password'});
    assert.equal(userLogin.status,200);
    const userCookie=userLogin.headers.get('set-cookie').split(';')[0];
    const list=await api('/api/load-map',{headers:{Cookie:userCookie}});
    const limited=await list.json();
    assert.equal(limited.folders.length,1);
    assert.equal(limited.folders[0].res_path,SOCHI_RES_PATHS[0]);
    assert.equal((await api('/api/directory?path='+encodeURIComponent(SOCHI_RES_PATHS[1]),{headers:{Cookie:userCookie}})).status,403);
    assert.equal((await api('/api/prepared?path='+encodeURIComponent(SOCHI_RES_PATHS[1]+'/ПО.xlsx')+'&role=consumption',{headers:{Cookie:userCookie}})).status,403);
    const resDenied=await json('/api/analysis',{resPath:SOCHI_RES_PATHS[1],action:'analysisTPs'},userCookie);
    assert.equal(resDenied.status,403);
    assert.equal((await json('/api/admin/analysis-settings',{settings:{red:60}},userCookie)).status,403);
    assert.equal((await api('/api/resources',{headers:{Cookie:userCookie}})).status,404);
    const book=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['ТП','Отпуск'],['ТП-123',1000]]),'Лист1');
    const bytes=XLSX.write(book,{type:'buffer',bookType:'xlsx'});
    const uploadUrl='/api/admin/upload?resPath='+encodeURIComponent(SOCHI_RES_PATHS[0])+'&role=incoming&filename='+encodeURIComponent('Приём.xlsx');
    assert.equal((await api(uploadUrl,{method:'POST',headers:{Cookie:userCookie,'Content-Type':'application/octet-stream','X-Sochi-Upload':'1'},body:bytes})).status,403,
      'employee must not upload even a valid workbook');
    const uploaded=await api(uploadUrl,{method:'POST',headers:{Cookie:adminCookie,'Content-Type':'application/octet-stream','X-Sochi-Upload':'1'},body:bytes});
    assert.equal(uploaded.status,200,await uploaded.text().catch(()=>'')); 
    const filePath=canonicalSochiPath(SOCHI_RES_PATHS[0],'incoming');
    const prepared=await api('/api/prepared?path='+encodeURIComponent(filePath)+'&role=incoming',{headers:{Cookie:userCookie}});
    assert.equal(prepared.status,200);
    assert.equal((await prepared.json()).role,'incoming');
    const directory=await api('/api/directory?path='+encodeURIComponent(SOCHI_RES_PATHS[0]),{headers:{Cookie:userCookie}});
    assert.equal((await directory.json())._embedded.items[0].path,filePath);
    const saved=await json('/api/admin/analysis-settings',{settings:{red:60,amber:25}},adminCookie);
    assert.equal(saved.status,200);
    const read=await (await api('/api/analysis-settings',{headers:{Cookie:userCookie}})).json();
    assert.equal(read.settings.red,60);
    assert.equal(read.settings.amber,25);
    const deleteUser=await json('/api/admin/accounts/'+account.id,{},adminCookie,'DELETE');
    assert.equal(deleteUser.status,200);
    assert.equal((await api('/api/load-map',{headers:{Cookie:userCookie}})).status,401);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
