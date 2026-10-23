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


test('Large Excel is transmitted as bounded chunks, not one payload, and confirmed only after commit',async()=>{
  const bytes=new Uint8Array(256*1024*2+100);
  bytes[0]=0x50;bytes[1]=0x4b;bytes[2]=0x03;bytes[3]=0x04;
  const file=new Blob([bytes]);
  file.name='Расширенный список.xlsx';
  const requests=[],progress=[],events=[],uploadId='A'.repeat(32);
  const fetcher=async(input,opts)=>{
    const url=new URL(input);
    requests.push({url,opts});
    if(url.pathname.endsWith('/start')){
      const body=JSON.parse(opts.body);
      assert.equal(body.size,file.size);
      assert.equal(body.filename,file.name);
      return Response.json({ok:true,uploadId,chunkSize:256*1024});
    }
    if(url.pathname.endsWith('/chunk')){
      const index=Number(url.searchParams.get('index'));
      assert.equal(opts.body.size,index===2?100:256*1024);
      return Response.json({ok:true,nextIndex:index+1,received:Math.min((index+1)*256*1024,file.size)});
    }
    if(url.pathname.endsWith('/complete')){
      assert.equal(JSON.parse(opts.body).uploadId,uploadId);
      events.push('saving');
      return Response.json({ok:true,role:'registry'});
    }
    throw new Error('Unknown URL '+url);
  };
  const result=await transferSochiExcel('https://sochi.example.test/api/admin/upload?resPath=%2Fsome-res&role=registry&filename=%D0%A0.xlsx',file,{
    fetcher,onProgress:(loaded,total)=>progress.push([loaded,total]),onTransferred:()=>events.push('all chunks received'),
  });
  assert.equal(result.ok,true);
  assert.deepEqual(requests.map(v=>v.url.pathname.split('/').at(-1)),
    ['start','chunk','chunk','chunk','complete']);
  assert.ok(requests.filter(v=>v.url.pathname.endsWith('/chunk')).every(v=>v.opts.body.size<=256*1024));
  assert.deepEqual(progress.at(-1),[file.size,file.size]);
  assert.deepEqual(events,['all chunks received','saving']);
  assert.equal(requests.some(v=>v.url.pathname==='/api/admin/upload'),false,'no large direct POST');
});

test('Rejecting a segment with 413 cleans temporary upload and surfaces ingress limit',async()=>{
  const file=new Blob([new Uint8Array(256*1024+1)]);
  file.name='ПО.xlsx';
  const seen=[];
  const fetcher=async(input,opts)=>{
    const path=new URL(input).pathname;
    seen.push(path.split('/').at(-1));
    if(path.endsWith('/start'))return Response.json({ok:true,uploadId:'B'.repeat(32),chunkSize:256*1024});
    if(path.endsWith('/chunk'))return Response.json({error:'payload too large'},{status:413});
    if(path.endsWith('/cancel'))return Response.json({ok:true});
    throw Error('Unknown request '+path);
  };
  await assert.rejects(
    ()=>transferSochiExcel('https://sochi.example.test/api/admin/upload?resPath=abc&role=consumption&filename=%D0%9F%D0%9E.xlsx',file,{fetcher}),
    /Даже часть Excel размером 256 КБ отклонена сервером/
  );
  assert.deepEqual(seen,['start','chunk','cancel']);
});
