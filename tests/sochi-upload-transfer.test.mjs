import test from 'node:test';
import assert from 'node:assert/strict';
import { transferSochiExcel } from '../public/sochi-upload-transfer.js';

class FakeXHR extends EventTarget {
  constructor(status=200,reply='{"ok":true}') {
    super();
    this.upload=new EventTarget();
    this.headers={};
    this.statusCode=status;
    this.reply=reply;
  }
  open(method,url,async) { this.request={method,url,async}; }
  setRequestHeader(name,value) { this.headers[name]=value; }
  send(file) {
    this.file=file;
    queueMicrotask(()=>{
      const event=new Event('progress');
      Object.defineProperties(event,{
        lengthComputable:{value:true},loaded:{value:512},total:{value:1024}
      });
      this.upload.dispatchEvent(event);
      this.upload.dispatchEvent(new Event('load'));
      this.status=this.statusCode;
      this.responseText=this.reply;
      this.dispatchEvent(new Event('load'));
    });
  }
}

test('Browser XHR sends raw Excel, reports actual bytes, then waits for database confirmation',async()=>{
  const xhr=new FakeXHR(),events=[],file={name:'Реестр.xlsx',size:1024};
  const payload=await transferSochiExcel('https://sochi.example.test/api/admin/upload',file,{
    xhrFactory:()=>xhr,
    onProgress:(sent,total)=>events.push(['sending',sent,total]),
    onTransferred:()=>events.push(['processing']),
  });
  assert.equal(payload.ok,true);
  assert.deepEqual(xhr.request,{method:'POST',url:'https://sochi.example.test/api/admin/upload',async:true});
  assert.deepEqual(xhr.headers,{'Content-Type':'application/octet-stream','X-Sochi-Upload':'1'});
  assert.equal(xhr.withCredentials,true);
  assert.equal(xhr.file,file);
  assert.deepEqual(events,[['sending',512,1024],['processing']]);
});

test('Browser XHR exposes the real parser error and never confirms an invalid response',async()=>{
  const file={name:'ПО.xlsx',size:10};
  await assert.rejects(()=>transferSochiExcel('https://sochi.example.test/api/admin/upload',file,{
    xhrFactory:()=>new FakeXHR(400,'{"error":"Нет столбцов с месяцами"}')
  }),/Нет столбцов с месяцами/);
  await assert.rejects(()=>transferSochiExcel('https://sochi.example.test/api/admin/upload',file,{
    xhrFactory:()=>new FakeXHR(200,'<html>maintenance</html>')
  }),/не подтвердил сохранение/);
});
