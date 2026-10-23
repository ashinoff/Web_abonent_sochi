import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTpBalance } from '../public/tp-balance-ui.js';
import { createTpBalances } from '../public/tp-balance.js';

const months=[{y:2026,m:0},{y:2026,m:1},{y:2026,m:2}];
function balance(){
  const pack={format:1,role:'incoming',schema:'meter-monthly-v1',months,rows:[
    ['PU1','ТП-1',null,null,null,'','','',[].slice(),null],
  ]};
  pack.rows=[[ 'PU1','ТП-1',null,null,null,'Абонент','',[100,200,null],'Приём:2']];
  return createTpBalances(pack).compare('ТП-1',months,[60,150,80],{threshold:10});
}
test('TP balance panel shows matching intake/ПО volumes, imbalance and month statuses',()=>{
  const b=balance(),html=renderTpBalance(b);
  assert.match(html,/ТЕХНИЧЕСКИЙ БАЛАНС ТП/);
  assert.match(html,/Приём − полезный отпуск/);
  assert.match(html,/Сопоставлено 2 из 3 месяцев/);
  assert.match(html,/Небаланс/);
  assert.match(html,/40/);
  assert.match(html,/Порог положительного небаланса/);
  assert.match(html,/мар 2026/);
  assert.match(html,/Неполные данные/);
  assert.match(html,/фев 2026/);
  assert.match(html,/янв 2026/);
  assert.match(html,/кВт·ч/);
  assert.match(html,/Нет полных данных|—/);
  assert.ok(!html.includes('Заводской номер'));
});
test('Missing/legacy intake and mismatched TP never display fabricated zero balance',()=>{
  const a=renderTpBalance(createTpBalances(null).compare('ТП-1',months,[50,50,50]));
  const b=renderTpBalance(createTpBalances({format:1,role:'incoming',sheets:1}).compare('ТП-1',months,[50,50,50]));
  const c=renderTpBalance(createTpBalances({format:1,role:'incoming',schema:'meter-monthly-v1',months,
    rows:[['PU1','ТП-2',null,null,null,'','','',[100,100,100],'Приём:2']]}).compare('ТП-1',months,[50,50,50]));
  for(const text of [a,b,c]) {
    assert.match(text,/Нельзя считать отсутствие данных нулевым/);
    assert.doesNotMatch(text,/tp-balance-summary/);
  }
});
test('Text from imported data is HTML escaped before rendering balance warnings',()=>{
  const html=renderTpBalance({...balance(),warnings:['<img src=x onerror=alert(1)>']});
  assert.doesNotMatch(html,/<img/);
  assert.match(html,/&lt;img/);
});
