import test from 'node:test';
import assert from 'node:assert/strict';
import { createSochiServer } from '../sochi-server.mjs';
import * as XLSX from '@e965/xlsx';
import { randomBytes } from 'node:crypto';
import { SOCHI_CHUNK_BYTES } from '../sochi-chunk-upload.mjs';
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
    const templateUrl='/api/admin/template?role=events';
    assert.equal((await api(templateUrl)).status,401,'templates require authentication');
    assert.equal((await api(templateUrl,{headers:{Cookie:userCookie}})).status,403,
      'employees must not download admin templates');
    const template=await api(templateUrl,{headers:{Cookie:adminCookie}});
    assert.equal(template.status,200);
    assert.match(template.headers.get('content-type'),/spreadsheetml/);
    assert.match(template.headers.get('content-disposition'),/attachment/);
    const templateBytes=Buffer.from(await template.arrayBuffer());
    assert.equal(templateBytes[0],0x50);
    assert.deepEqual(XLSX.utils.sheet_to_json(XLSX.read(templateBytes,{type:'buffer'}).Sheets['46. События по точкам учёта'.slice(0,31)],{header:1})[0],
      ['Серийный','Дата и время','Дополнительная информация']);
    assert.equal((await api('/api/admin/template?role=unknown',{headers:{Cookie:adminCookie}})).status,400);
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

    // New monthly intake: keep all 69 dates and their null/zero distinction.
    // Original one-shot and chunked uploads use the same parser/DB pipeline.
    const intakeHeader=['№ ПУ','ТП','Разрешенная мощность, кВт','Тип (юр/физ)',
      'Напряжение, кВ (0,22 / 0,4; пусто = авто)','Абонент','Адрес',
      ...Array.from({length:69},(_,i)=>'01.'+String(i%12+1).padStart(2,'0')+'.'+(2021+Math.floor(i/12)))];
    const intakeValues=Array(69).fill(null);
    intakeValues[0]=61524;intakeValues[1]='63 696';intakeValues[20]=0;intakeValues[62]=422414;
    const intakeRow=['12289174707473','КН-5-1000',null,null,null,
      'ввод 1 - КН-5-1000 ПУ № 12289174707473',null,...intakeValues];
    const intakeBook=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(intakeBook,XLSX.utils.aoa_to_sheet([intakeHeader,intakeRow]),'Приём');
    const intakeUploaded=await api(uploadUrl,{method:'POST',
      headers:{Cookie:adminCookie,'Content-Type':'application/octet-stream','X-Sochi-Upload':'1'},
      body:XLSX.write(intakeBook,{type:'buffer',bookType:'xlsx'})});
    const intakeResponse=await intakeUploaded.json();
    assert.equal(intakeUploaded.status,200,JSON.stringify(intakeResponse));
    const intakePath=canonicalSochiPath(SOCHI_RES_PATHS[0],'incoming');
    const intakeSaved=await server.preparedStore.getJson(SOCHI_SOURCE,intakePath,'incoming');
    const intakePack=JSON.parse(intakeSaved.json);
    assert.equal(intakePack.schema,'meter-monthly-v1');
    assert.equal(intakePack.months.length,69);
    assert.equal(intakePack.rows.length,1);
    assert.equal(intakePack.rows[0][0],'12289174707473');
    assert.equal(intakePack.rows[0][7][0],61524);
    assert.equal(intakePack.rows[0][7][1],63696);
    assert.equal(intakePack.rows[0][7][20],0);
    assert.equal(intakePack.rows[0][7][62],422414);
    assert.equal(intakePack.rows[0][7][68],null);
    const invalidImport=await api(uploadUrl,{method:'POST',
      headers:{Cookie:adminCookie,'Content-Type':'application/octet-stream','X-Sochi-Upload':'1'},
      body:Buffer.from('not an xlsx workbook')});
    assert.ok(invalidImport.status>=400,'invalid XLSX must be rejected');
    const errorsView=await (await api('/api/admin/database',{headers:{Cookie:adminCookie}})).json();
    assert.ok(errorsView.events.some(event=>event.code==='upload_failed'&&event.res_path===SOCHI_RES_PATHS[0]),
      'failed imports should be visible in admin database analysis');
    // Long numeric meter cells must no longer veto whole-book imports.
    // Preserve the stored XLSX number and expose nonblocking warnings.
    const badNumber=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(badNumber,XLSX.utils.aoa_to_sheet([
      ['ЛС','Номер счетчика'],['000001',10000000000000000],
    ]),'Реестр');
    const registryUploadRoute='/api/admin/upload?resPath='+encodeURIComponent(SOCHI_RES_PATHS[0])+'&role=registry&filename='+encodeURIComponent('Расширенный список.xlsx');
    const acceptedLong=await api(registryUploadRoute,{method:'POST',
      headers:{Cookie:adminCookie,'Content-Type':'application/octet-stream','X-Sochi-Upload':'1'},
      body:XLSX.write(badNumber,{type:'buffer',bookType:'xlsx'})});
    const longResult=await acceptedLong.json();
    assert.equal(acceptedLong.status,200,JSON.stringify(longResult));
    assert.match(longResult.warnings?.join(' ')||'',/Столбец B.*Номер счетчика/);
    const longQuery=await json('/api/registry',{resPath:SOCHI_RES_PATHS[0],
      action:'search',payload:{field:'meter',query:'10000000000000000'}},userCookie);
    assert.equal(longQuery.status,200);
    assert.equal((await longQuery.json()).result.total,1);

    // Secondary TT factory serials are still visible but are not keys for
    // subscriber search. The import succeeds with an integrity warning.
    const peripheral=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(peripheral,XLSX.utils.aoa_to_sheet([
      ['ЛС','Номер счетчика','Заводской номер ТТ (А)'],
      ['000001','00000012345678',1234567890123456],
    ]),'Реестр');
    const accepted=await api(registryUploadRoute,{method:'POST',
      headers:{Cookie:adminCookie,'Content-Type':'application/octet-stream','X-Sochi-Upload':'1'},
      body:XLSX.write(peripheral,{type:'buffer',bookType:'xlsx'})});
    const savedWithWarning=await accepted.json();
    assert.equal(accepted.status,200,JSON.stringify(savedWithWarning));
    assert.ok(savedWithWarning.warnings?.some(note=>/Столбец C.*Заводской номер ТТ/.test(note)));
    const currentAdmin=await (await api('/api/admin/database',{headers:{Cookie:adminCookie}})).json();
    assert.ok(currentAdmin.folders.find(f=>f.res_path===SOCHI_RES_PATHS[0]).statuses.registry.warnings.some(note=>/Столбец C/.test(note)));

    // This 16-digit numeric factory number is confirmed correct by the
    // operator and fits into Number.MAX_SAFE_INTEGER. Keep every digit for
    // the indexed meter search and warn about the XLSX export format.
    const confirmed=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(confirmed,XLSX.utils.aoa_to_sheet([
      ['ЛС','Номер счетчика'],
      ['230703231250',6003481006073610],
    ]),'Реестр');
    const acceptedMeter=await api(registryUploadRoute,{method:'POST',
      headers:{Cookie:adminCookie,'Content-Type':'application/octet-stream','X-Sochi-Upload':'1'},
      body:XLSX.write(confirmed,{type:'buffer',bookType:'xlsx'})});
    const acceptedMeterResult=await acceptedMeter.json();
    assert.equal(acceptedMeter.status,200,JSON.stringify(acceptedMeterResult));
    assert.ok(acceptedMeterResult.warnings?.some(note=>/Столбец B.*Номер счетчика/.test(note)));
    const verifiedSearch=await json('/api/registry',{resPath:SOCHI_RES_PATHS[0],
      action:'search',payload:{field:'meter',query:'6003481006073610'}},userCookie);
    assert.equal(verifiedSearch.status,200);
    assert.equal((await verifiedSearch.json()).result.total,1);
    const verifiedStatus=await (await api('/api/admin/database',{headers:{Cookie:adminCookie}})).json();
    assert.ok(verifiedStatus.folders.find(f=>f.res_path===SOCHI_RES_PATHS[0]).statuses.registry.warnings.some(note=>/Столбец B/.test(note)));


    // Amvera-style ingress rejects large single bodies: the new API must
    // accept a real Excel workbook split into many small authenticated POSTs.
    const largeBook=XLSX.utils.book_new();
    const opaque=randomBytes(400*1024).toString('base64');
    const largeRows=[['ТП','Отпуск']];
    for(let i=0;i<opaque.length;i+=10000)largeRows.push(['ТП-123',opaque.slice(i,i+10000)]);
    XLSX.utils.book_append_sheet(largeBook,XLSX.utils.aoa_to_sheet(largeRows),'Приём');
    const largeBytes=XLSX.write(largeBook,{type:'buffer',bookType:'xlsx'});
    assert.ok(largeBytes.length>SOCHI_CHUNK_BYTES,'a full XLSX must exceed the proxy-safe chunk size');
    const startPath='/api/admin/upload/start';
    const meta={resPath:SOCHI_RES_PATHS[0],role:'incoming',filename:'Приём.xlsx',size:largeBytes.length};
    assert.equal((await json(startPath,meta,userCookie)).status,403,'employees cannot initiate an upload');
    const started=await json(startPath,meta,adminCookie);
    const uploadSession=await started.json();
    assert.equal(started.status,200,JSON.stringify(uploadSession));
    assert.equal(uploadSession.chunkSize,SOCHI_CHUNK_BYTES);
    let index=0;
    for(let offset=0;offset<largeBytes.length;offset+=SOCHI_CHUNK_BYTES,index++){
      const part=largeBytes.subarray(offset,Math.min(offset+SOCHI_CHUNK_BYTES,largeBytes.length));
      const response=await api('/api/admin/upload/chunk?uploadId='+encodeURIComponent(uploadSession.uploadId)+'&index='+index,{
        method:'POST',headers:{Cookie:adminCookie,'Content-Type':'application/octet-stream','X-Sochi-Upload':'1'},body:part,
      });
      const chunkResult=await response.json();
      assert.equal(response.status,200,JSON.stringify(chunkResult));
      assert.equal(chunkResult.received,offset+part.length);
    }
    assert.ok(index>=2,'one large Excel requires multiple requests');
    const completed=await json('/api/admin/upload/complete',{uploadId:uploadSession.uploadId},adminCookie);
    const completion=await completed.json();
    assert.equal(completed.status,200,JSON.stringify(completion));
    assert.equal(completion.ok,true);
    assert.equal((await json('/api/admin/upload/cancel',{uploadId:uploadSession.uploadId},adminCookie)).status,404,
      'completed workbook must be removed from temporary storage');

    const filePath=canonicalSochiPath(SOCHI_RES_PATHS[0],'incoming');
    const prepared=await api('/api/prepared?path='+encodeURIComponent(filePath)+'&role=incoming',{headers:{Cookie:userCookie}});
    assert.equal(prepared.status,200);
    assert.equal((await prepared.json()).role,'incoming');
    const directory=await api('/api/directory?path='+encodeURIComponent(SOCHI_RES_PATHS[0]),{headers:{Cookie:userCookie}});
    assert.equal((await directory.json())._embedded.items[0].path,filePath);
    const registryBook=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(registryBook,XLSX.utils.aoa_to_sheet([
      ['ЛС','Номер счетчика','ФИО','Адрес','ТП'],
      ['000001','000123456','Иванов','г. Сочи, Тестовая 1','ТП-1'],
      ['000002','000555999','Петров','г. Сочи, Тестовая 2','ТП-2'],
    ]),'Абоненты');
    const registryBytes=XLSX.write(registryBook,{type:'buffer',bookType:'xlsx'});
    const registryUpload='/api/admin/upload?resPath='+encodeURIComponent(SOCHI_RES_PATHS[0])+'&role=registry&filename='+encodeURIComponent('Расширенный список.xlsx');
    const uploadedRegistry=await api(registryUpload,{method:'POST',
      headers:{Cookie:adminCookie,'Content-Type':'application/octet-stream','X-Sochi-Upload':'1'},body:registryBytes});
    assert.equal(uploadedRegistry.status,200,await uploadedRegistry.text().catch(()=>'')); 
    const askRegistry=async(action,payload={},resPath=SOCHI_RES_PATHS[0])=>
      json('/api/registry',{action,resPath,payload},userCookie);
    const registrySummary=await askRegistry('summary');
    assert.equal(registrySummary.status,200);
    assert.equal((await registrySummary.json()).result.count,2);
    const searched=await askRegistry('search',{query:'123456',field:'meter'});
    assert.equal(searched.status,200);
    const found=(await searched.json()).result;
    assert.equal(found.total,1);
    assert.equal(found.records[0].fields.account,'000001');
    const record=await askRegistry('record',{id:found.records[0].id});
    assert.equal((await record.json()).result.fields.meter,'000123456');
    assert.equal((await askRegistry('summary',{},SOCHI_RES_PATHS[1])).status,403);
    const monthlyBook=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(monthlyBook,XLSX.utils.aoa_to_sheet([
      ['ЛС/Номер договора','ТУ','ТП','Январь 2026','Февраль 2026'],
      ['000001','Дом 1','ТП-1',100,200],
      ['000002','Дом 2','ТП-2',50,60],
    ]),'ПО');
    const monthlyUpload='/api/admin/upload?resPath='+encodeURIComponent(SOCHI_RES_PATHS[0])+'&role=consumption&filename='+encodeURIComponent('ПО.xlsx');
    const monthlySaved=await api(monthlyUpload,{method:'POST',
      headers:{Cookie:adminCookie,'Content-Type':'application/octet-stream','X-Sochi-Upload':'1'},
      body:XLSX.write(monthlyBook,{type:'buffer',bookType:'xlsx'})});
    assert.equal(monthlySaved.status,200,await monthlySaved.text().catch(()=>'')); 
    const beforeBalance=await json('/api/analysis',{resPath:SOCHI_RES_PATHS[0],action:'analysisTP',tp:'ТП-1'},userCookie);
    assert.equal(beforeBalance.status,200);
    assert.equal((await beforeBalance.json()).result.balance.status,'no-tp',
      'previously loaded intake references a different TP');

    // Replace the intake with two input PUs on TP-1 and verify a live scoped
    // balance after the intake revision invalidates the analysis cache.
    const balanceBook=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(balanceBook,XLSX.utils.aoa_to_sheet([
      ['№ ПУ','ТП','Разрешенная мощность, кВт','Тип (юр/физ)',
       'Напряжение, кВ (0,22 / 0,4; пусто = авто)','Абонент','Адрес','01.01.2026','01.02.2026'],
      ['INPUT-1','ТП-1',null,null,null,'Ввод 1','',140,260],
      ['INPUT-2','ТП-1',null,null,null,'Ввод 2','',60,40],
      ['INPUT-3','ТП-2',null,null,null,'Ввод 3','',70,80],
    ]),'Приём');
    const replaced=await api(uploadUrl,{method:'POST',
      headers:{Cookie:adminCookie,'Content-Type':'application/octet-stream','X-Sochi-Upload':'1'},
      body:XLSX.write(balanceBook,{type:'buffer',bookType:'xlsx'})});
    const changed=await replaced.json();
    assert.equal(replaced.status,200,JSON.stringify(changed));
    const tpAnalysis=await json('/api/analysis',{resPath:SOCHI_RES_PATHS[0],
      action:'analysisTP',tp:'ТП-1'},userCookie);
    assert.equal(tpAnalysis.status,200);
    const tpDetails=(await tpAnalysis.json()).result;
    assert.equal(tpDetails.balance.status,'ready');
    assert.equal(tpDetails.balance.intakeMeterCount,2);
    assert.equal(tpDetails.balance.comparedMonths,2);
    assert.deepEqual(tpDetails.balance.values,[200,300]);
    assert.deepEqual(tpDetails.values,[100,200]);
    assert.equal(tpDetails.balance.totalIntake,500);
    assert.equal(tpDetails.balance.totalOutgoing,300);
    assert.equal(tpDetails.balance.imbalance,200);
    assert.equal(tpDetails.balance.pct,40);
    assert.equal(tpDetails.balance.elevated,2);
    const tpChoicesRes=await json('/api/analysis',{resPath:SOCHI_RES_PATHS[0],action:'analysisTPs'},userCookie);
    const tpChoices=(await tpChoicesRes.json()).result;
    assert.equal(tpChoices.find(item=>item.name==='ТП-1').incoming,true);
    assert.equal(tpChoices.find(item=>item.name==='ТП-2').incoming,true);
    const remoteTP=await json('/api/analysis',{resPath:SOCHI_RES_PATHS[1],
      action:'analysisTP',tp:'ТП-1'},userCookie);
    assert.equal(remoteTP.status,403,'TP balance is scoped to permitted RES');

    const analysisSummary=await json('/api/analysis',{resPath:SOCHI_RES_PATHS[0],action:'analysisSummary'},userCookie);
    assert.equal(analysisSummary.status,200);
    assert.equal((await analysisSummary.json()).result.accountCount,2);
    const accountAnalysis=await json('/api/analysis',{resPath:SOCHI_RES_PATHS[0],action:'analysisConsumer',account:'000001'},userCookie);
    assert.equal(accountAnalysis.status,200,await accountAnalysis.text().catch(()=>'')); 
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
