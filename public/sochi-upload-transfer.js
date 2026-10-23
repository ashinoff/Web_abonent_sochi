// Same-origin XLS/XLSX upload for the Sochi administrator.
// Browser XMLHttpRequest supplies genuine upload bytes progress. The fetcher
// override keeps tests and non-browser execution independent of XHR.
export async function transferSochiExcel(url,file,{fetcher=null,onProgress=()=>{},onTransferred=()=>{},xhrFactory=()=>new XMLHttpRequest()}={}){
  if(!file)throw new Error('Выберите Excel для загрузки.');
  const headers={'Content-Type':'application/octet-stream','X-Sochi-Upload':'1'};
  const finish=(httpStatus,body)=>{
    let data=null;
    try {data=typeof body==='string'?JSON.parse(body):body;}catch{}
    if(httpStatus<200||httpStatus>=300)
      throw new Error(data?.error||'Ошибка сервера (HTTP '+httpStatus+'). Проверьте журнал загрузки в «Анализе базы».');
    if(!data||data.ok!==true)throw new Error('Сервер не подтвердил сохранение файла. Проверьте его состояние в базе.');
    return data;
  };
  if(fetcher){
    const response=await fetcher(url,{method:'POST',credentials:'same-origin',cache:'no-store',headers,body:file});
    onTransferred();
    const body=await response.json().catch(()=>null);
    return finish(response.status,body);
  }
  return new Promise((resolve,reject)=>{
    let xhr;
    try {
      xhr=xhrFactory();
      xhr.open('POST',String(url),true);
      xhr.withCredentials=true;
      // Includes the server-side Excel preparation phase. Do not impose a
      // short fetch timeout on real 28+ MB registries.
      xhr.timeout=15*60*1000;
      for(const [name,value]of Object.entries(headers))xhr.setRequestHeader(name,value);
      xhr.upload.addEventListener('progress',event=>{
        if(event.lengthComputable&&event.total>0)onProgress(event.loaded,event.total);
      });
      xhr.upload.addEventListener('load',()=>onTransferred());
      xhr.addEventListener('load',()=>{
        try{resolve(finish(xhr.status,xhr.responseText));}catch(error){reject(error);}
      });
      xhr.addEventListener('error',()=>reject(new Error('Сеть оборвалась при загрузке. Проверьте Amvera и повторите отправку.')));
      xhr.addEventListener('timeout',()=>reject(new Error('Сервер слишком долго готовит Excel. Проверьте «Анализ базы» и журнал Amvera.')));
      xhr.addEventListener('abort',()=>reject(new Error('Загрузка была прервана до подтверждения сохранения.')));
      xhr.send(file);
    }catch(error){reject(error);}
  });
}
