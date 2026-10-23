import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { createSochiChunkUploads, SOCHI_CHUNK_BYTES } from '../sochi-chunk-upload.mjs';

const actor={id:'admin-1',login:'admin'};
const other={id:'admin-2',login:'other'};
const scope='/Сочинское предприятие электрических сетей/Адлерский РЭС';
const workbook=Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.alloc(SOCHI_CHUNK_BYTES*2+19,71)]);
function chunkRequest(data,{contentType='application/octet-stream',origin='https://sochi.example.test',host='sochi.example.test'}={}){
  const req=Readable.from([data]);
  req.headers={
    'content-type':contentType,
    'content-length':String(data.length),
    'x-sochi-upload':'1','origin':origin,'host':host,'sec-fetch-site':'same-origin',
  };
  return req;
}

test('Chunk assembler validates ordered 256 KiB segments, authenticated owner and complete SHA-256',async t=>{
  let saving=0;
  const uploads=createSochiChunkUploads({prepare:async(path,output,metadata)=>{
    const bytes=await readFile(path);
    assert.deepEqual(bytes,workbook,'Excel contents must be reconstructed byte-for-byte');
    assert.equal(metadata.size,workbook.length);
    assert.equal(metadata.hash,createHash('sha256').update(workbook).digest('hex'));
    return {size:bytes.length,revision:'registry:sochi-v1:'+metadata.hash,json:'{"role":"incoming"}'};
  }});
  t.after(()=>uploads.close());
  const session=await uploads.start({
    actor,resPath:scope,role:'incoming',filename:'Приём.xlsx',size:workbook.length,
  });
  assert.equal(session.chunkSize,SOCHI_CHUNK_BYTES);
  assert.match(session.uploadId,/^[A-Za-z0-9_-]{32}$/);
  await assert.rejects(()=>uploads.chunk(chunkRequest(workbook.subarray(0,SOCHI_CHUNK_BYTES)),{
    actor:other,uploadId:session.uploadId,index:0,
  }),error=>error.status===404);
  await assert.rejects(()=>uploads.chunk(chunkRequest(workbook.subarray(0,SOCHI_CHUNK_BYTES)),{
    actor,uploadId:session.uploadId,index:1,
  }),error=>error.status===409);
  await assert.rejects(()=>uploads.complete({
    actor,uploadId:session.uploadId,save:async()=>{},
  }),error=>error.status===409);
  for(let i=0;i<workbook.length;i+=SOCHI_CHUNK_BYTES){
    const index=i/SOCHI_CHUNK_BYTES;
    const piece=workbook.subarray(i,i+SOCHI_CHUNK_BYTES);
    const result=await uploads.chunk(chunkRequest(piece),{actor,uploadId:session.uploadId,index});
    assert.equal(result.received,Math.min(i+SOCHI_CHUNK_BYTES,workbook.length));
    assert.equal(result.nextIndex,index+1);
  }
  const finished=await uploads.complete({
    actor,uploadId:session.uploadId,
    save:async(session,prepared)=>{
      assert.equal(session.resPath,scope);
      assert.equal(session.filename,'Приём.xlsx');
      saving++;
      return {ok:true,...prepared};
    },
  });
  assert.equal(finished.ok,true);
  assert.equal(saving,1,'database swap must occur once, only at /complete');
  await assert.rejects(()=>uploads.cancel({actor,uploadId:session.uploadId}),
    error=>error.status===404,'completed session must no longer exist');
});

test('Corrupt parts and cross-site writes are rejected and temporary files are discarded',async t=>{
  const uploads=createSochiChunkUploads({prepare:async()=>{throw new Error('should not prepare')}});
  t.after(()=>uploads.close());
  const begin=()=>uploads.start({actor,resPath:scope,role:'registry',filename:'Расширенный список.xlsx',size:SOCHI_CHUNK_BYTES+1});
  const first=await begin();
  await assert.rejects(()=>uploads.chunk(chunkRequest(workbook.subarray(0,SOCHI_CHUNK_BYTES),{origin:'https://attacker.example.test'}),{
    actor,uploadId:first.uploadId,index:0,
  }),error=>error.status===403);
  assert.equal((await uploads.cancel({actor,uploadId:first.uploadId})).ok,true);
  const second=await begin();
  await assert.rejects(()=>uploads.chunk(chunkRequest(Buffer.alloc(100)),{actor,uploadId:second.uploadId,index:0}),
    error=>error.status===400);
  await assert.rejects(()=>uploads.cancel({actor,uploadId:second.uploadId}),
    error=>error.status===404,'short chunk cleans its temporary session');
});

test('Starting a fresh upload abandons an interrupted upload for the same administrator',async t=>{
  const uploads=createSochiChunkUploads();
  t.after(()=>uploads.close());
  const params={actor,resPath:scope,role:'registry',filename:'Расширенный список.xlsx',size:10};
  const first=await uploads.start(params);
  const next=await uploads.start(params);
  assert.notEqual(first.uploadId,next.uploadId);
  await assert.rejects(()=>uploads.cancel({actor,uploadId:first.uploadId}),
    error=>error.status===404);
  await assert.rejects(()=>uploads.cancel({actor:other,uploadId:next.uploadId}),
    error=>error.status===404);
  assert.equal((await uploads.cancel({actor,uploadId:next.uploadId})).ok,true);
});
