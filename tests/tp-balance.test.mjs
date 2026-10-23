import test from 'node:test';
import assert from 'node:assert/strict';
import { createTpBalances } from '../public/tp-balance.js';
import { createAnalysisService } from '../public/analysis-service.js';
import { indexMonthly } from '../public/monthly.js';

const months=[0,1,2,3].map(m=>({y:2026,m}));
const intake=(rows,period=months)=>({
  format:1,role:'incoming',schema:'meter-monthly-v1',months:period,
  rows:rows.map(({meter,tp,values})=>[meter,tp,null,'физ',null,'Абонент','',values,'Приём:2']),
});
const model=rows=>indexMonthly({months,rows:rows.map((r,i)=>({
  account:r.account,accountKey:r.account,alias:'',
  point:'ТУ-'+i,tp:r.tp,values:r.values,name:'Абонент '+i,
  source:'ПО:'+i,
})),warnings:[]});

test('TP balance adds all input meters, sums consumer ПО and applies 10% threshold month by month',()=>{
  const pack=intake([
    {meter:'A',tp:'ТП-1',values:[100,100,null,50]},
    {meter:'B',tp:'тп – 1',values:[40,50,30,0]},
    {meter:'C',tp:'ТП-2',values:[900,900,900,900]},
  ]);
  const source=model([
    {account:'1',tp:'ТП-1',values:[70,80,50,30]},
    {account:'2',tp:'ТП-1',values:[30,30,40,20]},
    {account:'3',tp:'ТП-2',values:[900,900,900,900]},
  ]);
  const service=createAnalysisService(source,[],{},pack);
  assert.equal(service.summary.balanceSource.status,'available');
  assert.equal(service.tps().find(tp=>tp.name==='ТП-1').incoming,true);
  const result=service.contour('ТП-1',{balPct:10}),b=result.balance;
  assert.equal(b.status,'ready');
  assert.equal(b.intakeMeterCount,2);
  assert.deepEqual(b.values,[140,150,null,50]);
  assert.deepEqual(result.values,[100,110,90,50]);
  assert.deepEqual(b.months.map(r=>r.imbalance),[40,40,null,0]);
  assert.deepEqual(b.months.map(r=>r.status),['high','high','incomplete','ok']);
  assert.equal(b.comparedMonths,3);
  assert.equal(b.missingIntake,1);
  assert.equal(b.totalIntake,340);
  assert.equal(b.totalOutgoing,260);
  assert.equal(b.imbalance,80);
  assert.equal(b.pct,23.529412);
  assert.equal(b.elevated,2);
  assert.equal(b.negative,0);
  assert.equal(result.incoming.status,'ready');
  assert.deepEqual(result.incoming.values,[140,150,null,50]);
  assert.equal(service.contour('ТП-2',{balPct:10}).balance.imbalance,0);
});
test('TP balance never treats gaps, unknown inputs or zero intake as a computed percent',()=>{
  const service=createAnalysisService(model([
    {account:'1',tp:'ТП-1',values:[50,null,40,0]},
  ]),[],{},intake([
    {meter:'A',tp:'ТП-1',values:[100,100,0,0]},
    {meter:'B',tp:'ТП-1',values:[null,20,30,0]},
  ]));
  const b=service.contour('ТП-1',{}).balance;
  assert.equal(b.status,'incomplete');
  assert.equal(b.comparedMonths,0);
  assert.equal(b.totalIntake,null);
  assert.deepEqual(b.months.map(r=>r.status),
    ['incomplete','incomplete','zero-intake','zero-intake']);
  assert.ok(b.warnings.some(w=>/Неполные месяцы/.test(w)));
});
test('TP balance preserves negative imbalance and never disguises PO greater than intake',()=>{
  const service=createAnalysisService(model([
    {account:'1',tp:'ТП-1',values:[150,99,0,0]},
  ]),[],{},intake([{meter:'A',tp:'ТП-1',values:[100,100,100,100]}]));
  const b=service.contour('ТП-1',{balPct:10}).balance;
  assert.equal(b.months[0].imbalance,-50);
  assert.equal(b.months[0].pct,-50);
  assert.equal(b.months[0].status,'negative');
  assert.equal(b.months[1].pct,1);
  assert.equal(b.months[1].status,'ok');
  assert.equal(b.negative,1);
  assert.equal(b.elevated,0);
});
test('duplicate meter rows are deduplicated only when exactly equal; conflicting months stay unknown',()=>{
  const s=createTpBalances(intake([
    {meter:'0001',tp:'ТП-1',values:[100,100,200,50]},
    {meter:'0001',tp:'ТП-1',values:[100,200,200,50]},
    {meter:'0002',tp:'ТП-1',values:[30,30,30,30]},
  ]));
  const b=s.compare('ТП-1',months,[110,120,100,60]);
  assert.equal(b.intakeMeterCount,2);
  assert.equal(b.duplicateMeters,1);
  assert.deepEqual(b.values,[130,null,230,80]);
  assert.deepEqual(b.months.map(r=>r.imbalance),[20,null,130,20]);
  assert.equal(b.comparedMonths,3);
  assert.equal(b.uncertain,1);
  assert.ok(b.warnings.some(w=>/Повторяющихся/.test(w)));
});
test('a meter listed under two distinct TP contours is never counted by either',()=>{
  const svc=createTpBalances(intake([
    {meter:'X',tp:'ТП-1',values:[100,100,100,100]},
    {meter:'X',tp:'ТП-2',values:[100,100,100,100]},
    {meter:'Y',tp:'ТП-1',values:[10,10,10,10]},
  ]));
  for(const name of ['ТП-1','ТП-2']) {
    const b=svc.compare(name,months,[10,10,10,10]);
    assert.equal(b.comparedMonths,0);
    assert.equal(b.multipleTP,1);
  }
});
test('source errors remain explicit when legacy, absent or nonmatching; intake-only TP appears in list',()=>{
  const usage=model([{account:'1',tp:'ТП-1',values:[10,10,10,10]}]);
  const missing=createAnalysisService(usage);
  assert.equal(missing.contour('ТП-1',{}).incoming.values,null);
  assert.equal(missing.contour('ТП-1',{}).balance.status,'not-loaded');
  const old=createAnalysisService(usage,[],{}, {format:1,role:'incoming',sheets:1});
  assert.equal(old.contour('ТП-1',{}).balance.status,'legacy');
  const one=createAnalysisService(usage,[],{},intake([
    {meter:'IN-3',tp:'ТП-3',values:[100,100,100,100]},
  ]));
  assert.equal(one.contour('ТП-1',{}).balance.status,'no-tp');
  assert.equal(one.tps().find(tp=>tp.name==='ТП-3').incomingOnly,true);
  assert.equal(one.contour('ТП-3',{}).balance.status,'no-consumption');
  assert.equal(one.contour('ТП-3',{}).results.length,0);
  assert.equal(one.contour('ТП-3',{}).total,null);
});
test('compare only exact calendar months, not position; preserve negative adjustments and completeness',()=>{
  const later=[{y:2025,m:11},{y:2026,m:0},{y:2026,m:1},{y:2026,m:2}];
  const svc=createTpBalances(intake([{meter:'A',tp:'ТП-1',values:[100,150,200,220]}],later));
  const b=svc.compare('ТП-1',months,[110,100,110,100]);
  assert.deepEqual(b.values,[150,200,220,null]);
  assert.deepEqual(b.months.map(r=>r.status),['high','high','high','outside']);
  assert.equal(b.comparedMonths,3);
  assert.equal(b.outside,1);
  const obsolete=createTpBalances(intake([{meter:'A',tp:'ТП-1',values:[1]}],[{y:2020,m:0}]));
  assert.equal(obsolete.compare('ТП-1',months,[1,1,1,1]).status,'no-overlap');
});
