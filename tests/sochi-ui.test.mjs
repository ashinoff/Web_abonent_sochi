import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Window } from 'happy-dom';
import { IDBFactory } from 'fake-indexeddb';
import { SOCHI_ENTERPRISE_PATH, SOCHI_RES_PATHS } from '../public/sochi-config.js';

const expected=SOCHI_RES_PATHS[0],other=SOCHI_RES_PATHS[1],source='sochi:local:v1';
async function until(fn,name){
  for(let i=0;i<1000;i++){if(fn())return;await delay(5);}
  assert.fail('Timed out: '+name);
}
test('Sochi browser sees one enterprise, scoped RES, server search and no automatic raw downloads',async t=>{
  const page=new Window({url:'https://sochi.example.test/',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}});
  page.document.write(await readFile(new URL('../public/index.html',import.meta.url),'utf8'));
  const navigator={onLine:true,storage:{estimate:async()=>({quota:1e9,usage:0})},
    serviceWorker:{controller:{},addEventListener(){},register:async()=>({update:async()=>{}}),ready:Promise.resolve({})}};
  const globalValues={window:page,document:page.document,localStorage:page.localStorage,location:page.location,
    navigator,indexedDB:new IDBFactory(),requestAnimationFrame:page.requestAnimationFrame.bind(page),
    cancelAnimationFrame:page.cancelAnimationFrame.bind(page),matchMedia:()=>({matches:true})};
  for(const [key,value] of Object.entries(globalValues))
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  const $=selector=>page.document.querySelector(selector);
  const callPaths=[];
  const directory={
    [SOCHI_ENTERPRISE_PATH]:SOCHI_RES_PATHS.slice(0,2).map(path=>({type:'dir',path,name:path.split('/').at(-1)})),
    [expected]:['Расширенный список.xlsx','ПО.xlsx'].map(name=>({type:'file',path:expected+'/'+name,name,size:5000})),
  };
  const user={id:'test-sochi-user',login:'resident',name:'Сотрудник РЭС',active:true,role:'user',resPaths:[expected,other]};
  t.mock.method(globalThis,'fetch',async(input,opts={})=>{
    const url=new URL(input),path=url.pathname;
    callPaths.push(path);
    if(path==='/api/config')return Response.json({proxy:true,prepared:true,sochi:true,databaseConnected:true,
      localUploads:true,publicUrl:source,maxFileMB:80,auth:{enabled:true}});
    if(path==='/api/auth/session')return Response.json({user,expiresAt:'2099-01-01T00:00:00.000Z'});
    if(path==='/api/analysis-settings')return Response.json({settings:{}});
    if(path==='/api/directory'){
      const folder=url.searchParams.get('path')||'/';
      const items=folder==='/'?[{type:'dir',path:SOCHI_ENTERPRISE_PATH,name:'Сочинское предприятие электрических сетей'}]:directory[folder]||[];
      return Response.json({type:'dir',path:folder,_embedded:{items,total:items.length}});
    }
    if(path==='/api/load-map')return Response.json({folders:[{
      enterprise_path:SOCHI_ENTERPRISE_PATH,enterprise_name:SOCHI_ENTERPRISE_PATH.slice(1),
      res_path:expected,res_name:'Адлерский РЭС',statuses:{
        registry:{state:'ready',file:'Расширенный список.xlsx',path:expected+'/Расширенный список.xlsx',size:5000},
        consumption:{state:'ready',file:'ПО.xlsx',path:expected+'/ПО.xlsx',size:5000},
      }}]});
    if(path==='/api/registry'){
      const body=JSON.parse(opts.body);
      assert.equal(body.resPath,expected);
      if(body.action==='summary')return Response.json({result:{count:2,notesCount:0,hasNotesColumn:false,
        sheets:[{sheet:'Реестр',layout:{labels:['ЛС','Номер ПУ','ФИО'],mapping:{account:0,meter:1}},sample:[]}],skipped:[]}});
      if(body.action==='search')return Response.json({result:{total:1,records:[{id:'Реестр:2',fields:{account:'0001',meter:'000123',name:'Тестовый абонент',tp:'ТП-1'},address:'Сочи, Ленина 1',sheet:'Реестр',row:2}]}});
      if(body.action==='record')return Response.json({result:{id:'Реестр:2',fields:{account:'0001',meter:'000123',name:'Тестовый абонент'},address:'Сочи, Ленина 1',
        file:'Расширенный список.xlsx',sheet:'Реестр',row:2,labels:['ЛС','Номер ПУ','ФИО'],values:['0001','000123','Тестовый абонент']}});
      if(body.action==='notes')return Response.json({result:{notes:[],total:0,totalInRegistry:0}});
      if(body.action==='mapNotes')return Response.json({result:[]});
      if(body.action==='tps')return Response.json({result:[]});
      throw Error('Unknown registry action '+body.action);
    }
    if(path==='/api/analysis'){
      const body=JSON.parse(opts.body);
      if(body.action==='analysisSummary')return Response.json({result:{months:[{y:2026,m:0}],warnings:[],rowCount:2,accountCount:2,missingTP:0}});
      return Response.json({result:{}});
    }
    if(path==='/api/diagnostics')return Response.json({database:{state:'connected'},catalog:{state:'ready'},source:{state:'ready'}});
    if(path==='/api/user-notifications')return Response.json({generation:0,items:[]});
    throw Error('Unexpected Sochi request: '+url.href);
  });
  class DummyWorker {
    postMessage({id}){queueMicrotask(()=>this.onmessage?.({data:{id,result:true}}));}
    terminate(){}
  }
  globalThis.Worker=DummyWorker;
  t.after(async()=>{await delay(250);page.dispatchEvent(new page.Event('pagehide'));await delay(20);await page.happyDOM.close();});
  await import('../public/app.js?sochi-ui-test');
  await until(()=>$('#res-list').querySelectorAll('[data-res]').length===2,'automatic Sochi RES directory');
  assert.equal($('#district-button'),null,'enterprise picker must be removed entirely');
  assert.equal($('#enterprise-dialog'),null,'enterprise modal must be removed entirely');
  assert.equal(page.document.querySelector('[data-open-enterprises]'),null,'no back button to another enterprise');
  assert.ok($('#res-button').closest('.header-inner'),'RES selection belongs to the site header');
  assert.equal($('.header-unit')?.textContent.includes('Сочинский ПЭС'),true);
  assert.ok($('#search-submit').closest('.search-inline'),'search magnifier belongs beside the search field');
  assert.equal($('#search-submit').querySelectorAll('svg').length,1);
  assert.equal($('#tp-open').closest('#search-form'),null,'TP registry cannot be part of subscriber search');
  assert.equal($('#contour-open').closest('#search-form'),null,'TP contour analysis cannot be part of subscriber search');
  assert.notEqual($('#tp-open').closest('.tp-feature-card'),$('#contour-open').closest('.tp-feature-card'));

  assert.equal($('#admin-upload-open').hidden,true,'regular employee must not see administrator upload shortcut');
  assert.equal($('#settings-open').hidden,true,'admin settings must be hidden from staff');
  assert.equal($('#db-health-tab').hidden,true,'DB error analysis must be admin-only');
  assert.equal($('#staff-logout').hidden,false,'staff keeps an explicit sign-out action');
  assert.equal($('#load-map-settings').parentElement.id,'staff-offline-map-slot','employee offline management must not live in settings');
  $('#offline-open').click();
  await until(()=>callPaths.includes('/api/load-map'),'staff offline map loads scoped RES');
  assert.equal($('#settings-dialog').open,false,'employee offline workflow does not open admin settings');
  assert.equal($('#staff-offline-map-slot').hidden,false);
  $('#offline-dialog').close();
  assert.equal($('#res-list').querySelectorAll('[data-res]').length,2);
  $('#res-button').click();
  $('#res-list').querySelector('[data-res]').click();
  await until(()=>$('#registry-indicator').dataset.state==='on'&&$('#consumption-indicator').dataset.state==='on','server-side data ready');
  assert.equal($('#source-files').querySelector('[data-choose-source]').hidden,true);
  assert.equal($('#analysis-settings').querySelector('[data-setting]')?.disabled,true);
  assert.equal($('#base-indicator').dataset.state,'on','base must reflect a successful authorized DB catalog read');
  assert.equal($('#incoming-indicator').dataset.state,'off','incoming is missing from the selected RES');
  assert.match($('#registry-indicator').getAttribute('aria-label'),/Адлерский РЭС/);
  $('#search-input').value='000123';
  $('#search-form').dispatchEvent(new page.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>$('#results').textContent.includes('Тестовый абонент'),'server-side search results');
  assert.equal(callPaths.includes('/api/prepared'),false,'online page must not bulk-download registry or consumption');
  assert.equal(callPaths.includes('/api/resources'),false,'no Yandex resource request');
  assert.equal(callPaths.includes('/api/registry'),true);
  $('#res-button').click();
  $('#res-list').querySelectorAll('[data-res]')[1].click();
  await until(()=>$('#res-label').textContent==='Краснополянский РЭС'&&
    $('#registry-indicator').dataset.state==='off'&&
    $('#consumption-indicator').dataset.state==='off','second RES has missing data');
  assert.equal($('#base-indicator').dataset.state,'on','global database stays connected while this RES lacks files');
  assert.match($('#registry-indicator').getAttribute('aria-label'),/Краснополянский РЭС/);
  assert.equal($('#settings-dialog').open,false,'missing staff data must not open the admin settings');
  assert.match($('#results').textContent,/Реестр не подключён/);
});
