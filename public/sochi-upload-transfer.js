// Same-origin Excel upload with true browser progress. Files larger than
// 256 KiB go through small authenticated requests: ingress proxies no longer
// receive the whole 28-80 MiB workbook in one HTTP body.
export const SOCHI_CHUNK_BYTES = 256 * 1024;
const MIME='application/octet-stream';
const UPLOAD_HEADERS={'Content-Type':MIME,'X-Sochi-Upload':'1'};

function parseResult(status,body,{chunk=false}={}) {
  let data=null;
  try {data=typeof body==='string'?JSON.parse(body):body;}catch{}
  if(status<200||status>=300) {
    const detail=data?.error || (typeof body==='string' && body.length<300 && !/<[a-z!]/i.test(body) ? body.trim() : '') || ('Ошибка HTTP '+status);
    if(status===413&&chunk)
      throw new Error('Даже часть Excel размером 256 КБ отклонена сервером (HTTP 413). Проверьте лимит запросов Amvera.');
    if(status===413)
      throw new Error('Сервер отклонил слишком большой запрос (HTTP 413). Для крупных файлов используется передача частями.');
    throw new Error(detail);
  }
  if(!data||data.ok!==true)
    throw new Error('Сервер не подтвердил сохранение файла. Проверьте его состояние в базе.');
  return data;
}
async function postJson(url,body,fetcher) {
  const run=fetcher||((...args)=>fetch(...args));
  const response=await run(url,{
    method:'POST',credentials:'same-origin',cache:'no-store',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
    signal:AbortSignal.timeout(15*60*1000),
  });
  return parseResult(response.status,await response.text());
}
function postBinary(url,bytes,{xhrFactory,fetcher,onProgress,expectedLength,chunk=false}) {
  if(fetcher) return (async()=>{
    const response=await fetcher(url,{
      method:'POST',credentials:'same-origin',cache:'no-store',
      headers:UPLOAD_HEADERS,body:bytes,
    });
    const result=parseResult(response.status,await response.text(),{chunk});
    if(onProgress)onProgress(expectedLength,expectedLength);
    return result;
  })();
  return new Promise((resolve,reject)=>{
    let xhr;
    try {
      xhr=xhrFactory();
      xhr.open('POST',String(url),true);
      xhr.withCredentials=true;
      xhr.timeout=chunk?90000:15*60*1000;
      for(const [key,value] of Object.entries(UPLOAD_HEADERS))xhr.setRequestHeader(key,value);
      xhr.upload.addEventListener('progress',event=>{
        if(event.lengthComputable&&event.total>0)onProgress?.(Math.min(event.loaded,expectedLength),expectedLength);
      });
      xhr.upload.addEventListener('load',()=>{
        // TCP transfer complete is NOT proof that PostgreSQL saved the file.
        // The final /complete response is the only confirmation.
      });
      xhr.addEventListener('load',()=>{
        try {resolve(parseResult(xhr.status,xhr.responseText,{chunk}));}
        catch(error){reject(error);}
      });
      xhr.addEventListener('error',()=>reject(new Error('Сеть оборвалась при передаче Excel. Выберите файл и повторите загрузку.')));
      xhr.addEventListener('timeout',()=>reject(new Error('Время ответа сервера истекло. Проверьте Amvera и повторите загрузку.')));
      xhr.addEventListener('abort',()=>reject(new Error('Передача Excel прервана до сохранения в базе.')));
      xhr.send(bytes);
    } catch(error) {reject(error);}
  });
}
async function chunkedTransfer(url,file,{fetcher,onProgress,onTransferred,xhrFactory}) {
  const target=new URL(url);
  const startUrl=new URL(target);
  startUrl.pathname=target.pathname+'/start';
  startUrl.search='';
  const init=await postJson(startUrl,{
    resPath:target.searchParams.get('resPath'),
    role:target.searchParams.get('role'),
    filename:target.searchParams.get('filename'),size:file.size,
  },fetcher);
  const {uploadId,chunkSize}=init;
  if(typeof uploadId!=='string'||!/^[a-zA-Z0-9_-]{32}$/.test(uploadId)||
    !Number.isSafeInteger(chunkSize)||chunkSize<1||chunkSize>SOCHI_CHUNK_BYTES)
    throw new Error('Сервер вернул некорректные параметры загрузки по частям.');
  let complete=false;
  try {
    for(let start=0,index=0;start<file.size;start+=chunkSize,index++){
      const end=Math.min(file.size,start+chunkSize);
      const urlChunk=new URL(target);
      urlChunk.pathname=target.pathname+'/chunk';
      urlChunk.search='';
      urlChunk.searchParams.set('uploadId',uploadId);
      urlChunk.searchParams.set('index',String(index));
      const data=await postBinary(urlChunk,file.slice(start,end),{
        xhrFactory,fetcher,chunk:true,expectedLength:end-start,
        onProgress:(loaded)=>onProgress?.(start+Math.min(loaded,end-start),file.size),
      });
      if(data.nextIndex!==index+1||data.received!==end)
        throw new Error('Сервер подтвердил некорректную часть Excel. Повторите загрузку.');
      onProgress?.(end,file.size);
    }
    onTransferred?.();
    const completeUrl=new URL(target);
    completeUrl.pathname=target.pathname+'/complete';
    completeUrl.search='';
    const result=await postJson(completeUrl,{uploadId},fetcher);
    complete=true;
    return result;
  } finally {
    if(!complete){
      // Clear an incomplete temporary workbook even if the proxy rejected a
      // chunk. Cleanup errors must never hide the meaningful original error.
      const cancelUrl=new URL(target);
      cancelUrl.pathname=target.pathname+'/cancel';
      cancelUrl.search='';
      try {await postJson(cancelUrl,{uploadId},fetcher);}catch{}
    }
  }
}
export async function transferSochiExcel(url,file,{
  fetcher=null,onProgress=()=>{},onTransferred=()=>{},
  xhrFactory=()=>new XMLHttpRequest(),
}={}) {
  if(!file)throw new Error('Выберите Excel для загрузки.');
  if(file.size>80*1048576)throw new Error('Excel превышает лимит 80 МБ.');
  if(file.size>SOCHI_CHUNK_BYTES){
    if(typeof file.slice!=='function')throw new Error('Этот браузер не может отправить Excel частями.');
    return chunkedTransfer(url,file,{fetcher,onProgress,onTransferred,xhrFactory});
  }
  const result=await postBinary(url,file,{
    fetcher,xhrFactory,onProgress,expectedLength:file.size,
  });
  onTransferred();
  return result;
}
