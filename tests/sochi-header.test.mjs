import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

test('Sochi header has only the selected RES name and equal-size icon-only actions',async t=>{
  const page=new Window({url:'https://sochi.example.test/',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}});
  t.after(()=>page.happyDOM.close());
  page.document.write(await readFile(new URL('../public/index.html',import.meta.url),'utf8'));
  const $=selector=>page.document.querySelector(selector);
  const res=$('#res-button');
  assert.ok(res.closest('.header-inner'));
  assert.equal(res.textContent.trim(),'Выберите РЭС');
  assert.equal(res.querySelector('small'),null,'no redundant RES caption');
  const title=$('#res-label');
  title.textContent='Адлерский РЭС';
  assert.equal(res.textContent.trim(),'Адлерский РЭС');
  assert.equal(res.querySelector('.header-res-chevron use').getAttribute('href'),'#i-chevron');
  const kinds=[['#notes-open','#i-bell'],['#admin-upload-open','#i-upload'],['#settings-open','#i-settings']];
  for(const [selector,href] of kinds){
    const button=$(selector);
    assert.ok(button.classList.contains('header-icon-button'),selector);
    assert.equal(button.querySelectorAll(':scope > svg').length,1,selector);
    assert.equal(button.querySelector(':scope > svg use').getAttribute('href'),href,selector);
    assert.equal(button.textContent.trim(),'','no visible caption inside '+selector);
    assert.ok(button.getAttribute('aria-label')?.length,'icon-only controls need accessible names');
    assert.ok(button.getAttribute('title')?.length,'icon-only controls need hover help');
  }
  assert.equal($('#admin-upload-open').hidden,true,'upload is still role-gated');
  const css=await readFile(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.match(css,/--header-control-size:50px/);
  assert.match(css,/\.header-actions\s+\.header-icon-button[\s\S]*?width:var\(--header-control-size\)/);
  assert.match(css,/\.header-actions\s+\.header-res-button\s+#res-label\s*\{[\s\S]*?font-size:18px/);
  assert.match(css,/\.header-actions\s+\.header-res-button\s+#res-label\s*\{[\s\S]*?color:#fff/);
  assert.match(css,/--header-control-size:45px/,'mobile controls use the same variable');
});
