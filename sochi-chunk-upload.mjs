import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fault } from './accounts.mjs';
import { maxUploadBytes, prepareSochiWorkbookFile, validateSochiWorkbookFilename } from './sochi-import.mjs';

// 256 KiB stays below the common 1 MiB reverse-proxy body cap. The app still
// supports an 80 MiB Excel; no HTTP request contains that entire workbook.
export const SOCHI_CHUNK_BYTES = 256 * 1024;
const SESSION_TTL = 30 * 60 * 1000;
const MAX_SESSIONS = 3;

export function checkSochiChunkRequest(req) {
  if (req.headers['content-type'] !== 'application/octet-stream' ||
      req.headers['x-sochi-upload'] !== '1' ||
      req.headers['sec-fetch-site'] === 'cross-site')
    throw fault('Часть файла разрешено отправлять только с этого сайта.',415,'invalid_upload');
  if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
    throw fault('Загрузка с другого сайта запрещена.',403,'forbidden');
}

// Sessions belong to a logged-in administrator, not just a guessable file
// name. Only tiny metadata live in memory; Excel bytes stay in a temporary
// directory and are parsed from disk by the existing bounded child process.
export function createSochiChunkUploads({
  now = () => Date.now(), maxSessions = MAX_SESSIONS,
  prepare = prepareSochiWorkbookFile,
} = {}) {
  const sessions = new Map();
  async function discard(session) {
    if (sessions.get(session.id) === session) sessions.delete(session.id);
    await rm(session.directory,{recursive:true,force:true});
  }
  async function clearExpired() {
    await Promise.all([...sessions.values()]
      .filter(session => !session.busy && session.expires <= now())
      .map(discard));
  }
  const timer = setInterval(() => {
    void clearExpired().catch(error => console.warn('Sochi upload cleanup:',error.message));
  },5*60*1000);
  timer.unref?.();
  function owned(actor,id) {
    const session = sessions.get(id);
    if (!session || session.owner !== actor?.id)
      throw fault('Сессия загрузки отсутствует или принадлежит другому администратору. Выберите Excel снова.',404,'upload_not_found');
    if (session.expires <= now() && !session.busy)
      throw fault('Время загрузки истекло. Выберите файл повторно.',410,'upload_expired');
    return session;
  }
  async function start({actor,resPath,role,filename,size}) {
    validateSochiWorkbookFilename(filename);
    if (!Number.isSafeInteger(size) || size < 1 || size > maxUploadBytes)
      throw fault('Excel превышает лимит 80 МБ или имеет неверный размер.',413,'file_too_large');
    await clearExpired();
    for (const previous of sessions.values()) if (previous.owner === actor.id) {
      if (previous.busy) throw fault('Предыдущая загрузка ещё обрабатывается.',409,'upload_busy');
      await discard(previous); // The user explicitly started another upload.
    }
    if (sessions.size >= maxSessions)
      throw fault('Сейчас выполняется слишком много загрузок. Повторите позже.',429,'upload_busy');
    const directory=await mkdtemp(join(tmpdir(),'sochi-chunks-'));
    const id=randomBytes(24).toString('base64url');
    const session={
      id,owner:actor.id,resPath,role,filename,size,
      directory,path:join(directory,'workbook'),output:join(directory,'package.json'),
      received:0,nextIndex:0,hash:createHash('sha256'),expires:now()+SESSION_TTL,busy:false,
    };
    sessions.set(id,session);
    return {uploadId:id,chunkSize:SOCHI_CHUNK_BYTES,maxFileMB:maxUploadBytes/1048576};
  }
  async function chunk(req,{actor,uploadId,index}) {
    checkSochiChunkRequest(req);
    const session=owned(actor,uploadId);
    if (session.busy) throw fault('Другая операция с этой загрузкой ещё выполняется.',409,'upload_busy');
    if (!Number.isSafeInteger(index) || index !== session.nextIndex)
      throw fault('Неверный порядок частей Excel. Повторите загрузку файла.',409,'chunk_order');
    const expected=Math.min(SOCHI_CHUNK_BYTES,session.size-session.received);
    if (expected <= 0) throw fault('Все части файла уже переданы.',409,'upload_complete');
    if (req.headers['content-length'] != null && Number(req.headers['content-length']) !== expected)
      throw fault('Неверная длина части файла.',400,'chunk_size');
    session.busy=true;
    let received=0;
    try {
      await pipeline(req,new Transform({
        transform(data,encoding,callback) {
          received+=data.length;
          if (received > expected) return callback(fault('Часть файла превышает 256 КБ.',413,'chunk_too_large'));
          session.hash.update(data);
          callback(null,data);
        },
      }),createWriteStream(session.path,{flags:index===0?'wx':'a'}));
      if (received !== expected) throw fault('Получена неполная часть Excel. Повторите загрузку.',400,'chunk_incomplete');
      session.received+=received;
      session.nextIndex++;
      session.expires=now()+SESSION_TTL;
      return {received:session.received,size:session.size,nextIndex:session.nextIndex};
    } catch(error) {
      // A partial chunk cannot be replayed safely. Delete it, preserving the
      // last successfully published PostgreSQL workbook.
      await discard(session);
      throw error;
    } finally {
      session.busy=false;
    }
  }
  async function complete({actor,uploadId,save,onError=async()=>{}}) {
    const session=owned(actor,uploadId);
    if (session.busy) throw fault('Передача файла ещё выполняется.',409,'upload_busy');
    if (session.received !== session.size)
      throw fault('Не все части Excel переданы. Подождите завершения загрузки.',409,'upload_incomplete');
    session.busy=true;
    try {
      const received=await prepare(session.path,session.output,{
        role:session.role,filename:session.filename,size:session.size,
        hash:session.hash.digest('hex'),
      });
      return await save(session,received);
    } catch(error) {
      // Preserve the RES and file role for the audit log even when the parser
      // fails before the database save callback runs.
      try {await onError(session,error);}
      catch(logError) {console.warn('Sochi upload audit log failed:',logError.message);}
      throw error;
    } finally {
      session.busy=false;
      await discard(session);
    }
  }
  async function cancel({actor,uploadId}) {
    const session=owned(actor,uploadId);
    if(session.busy)throw fault('Загрузка в обработке. Отмена сейчас недоступна.',409,'upload_busy');
    await discard(session);
    return {ok:true};
  }
  async function close() {
    clearInterval(timer);
    await Promise.all([...sessions.values()].map(discard));
  }
  return {start,chunk,complete,cancel,clearExpired,close};
}
