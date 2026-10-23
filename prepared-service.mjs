import { gzip } from 'node:zlib';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSource, sourceRoleKeys } from './public/source.js';
import { JOURNAL_ANALYSIS_VERSION, EVENTS_PACKAGE_VERSION } from './public/journals.js';
import { MONTHLY_PARSER_VERSION } from './public/monthly.js';
import { PREPARATION_TIMEOUT_MS } from './public/preparation-policy.js';
import { resScope,preparationIssue } from './admin-store.mjs';

const maxBytes = 40 * 1048576;
const compress = promisify(gzip);
const childPath = fileURLToPath(new URL('./prepare-child.mjs', import.meta.url));
async function memoryBudget() {
  let detected;
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const value = Number((await readFile(path, 'utf8')).trim());
      if (Number.isSafeInteger(value) && value >= 256 * 1048576 && value < 1024 ** 4) {
        detected = Math.floor(value / 1048576); break;
      }
    } catch { /* Local development may have no cgroup limit. */ }
  }
  const override = Number(process.env.PREPARE_MEMORY_MB);
  const configured = Number.isInteger(override) && override >= 512 && override <= 8192 ? override : null;
  return {
    containerMB: Math.min(8192, Math.max(256, detected ? Math.min(detected, configured || detected) : configured || 512)),
    detectedMB: detected || null, configuredMB: configured,
    source: detected ? 'cgroup' : configured ? 'env' : 'fallback',
  };
}
export async function preparationMemory() {
  const budget = await memoryBudget();
  return { ...budget, ...preparationLimits(budget.containerMB) };
}
export function preparationLimits(containerMB) {
  // XLSX also retains inflated XML outside V8's heap. A smaller heap encourages
  // collection before those buffers push the whole child over the RSS guard.
  const heapMB = Math.min(1536, 128 + Math.floor(Math.max(0, containerMB - 512) * 0.75),
    512 + Math.floor(Math.max(0, containerMB - 1024) * 0.25));
  const largerContainer = containerMB >= 1536;
  const childMB = Math.min(2000, largerContainer ? Math.floor(containerMB * 0.85) : 160 + Math.max(0, containerMB - 512));
  // Keep at least 192 MiB (and 10% on larger plans) outside both processes for
  // page cache and the container. The combined guard also includes live API work.
  const combinedMB = Math.max(160, Math.min(containerMB - 192, Math.floor(containerMB * (largerContainer ? 0.9 : 0.85))));
  const packageMB = Math.min(256, Math.max(64, Math.floor(containerMB / 8)));
  return { heapMB, childMB, combinedMB, packageMB };
}
export async function preparationChildFlags(path, role, filename, containerMB) {
  const { heapMB, childMB } = preparationLimits(containerMB);
  let streaming = false;
  if (['events', 'registry', 'consumption', 'incoming'].includes(role) && !/\.xlsb$/i.test(filename || '')) {
    const file = await open(path, 'r'), signature = Buffer.alloc(4);
    try { await file.read(signature, 0, 4, 0); } finally { await file.close(); }
    streaming = signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  }
  const streamHeapMB = streaming ? Math.min(heapMB, Math.max(64, childMB - 128)) : heapMB;
  // Streaming XML allocates many short-lived tokens. Bound young space too on
  // small plans, so V8's reservation stays inside the unchanged RSS guard.
  return [`--max-old-space-size=${streamHeapMB}`,
    ...(streaming && streamHeapMB < heapMB ? ['--max-semi-space-size=4'] : [])];
}
async function runLimitedChild(args, containerMB,signal) {
  const { childMB, combinedMB } = preparationLimits(containerMB);
  const flags = await preparationChildFlags(args[0], args[2], args[3], containerMB);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...flags, childPath, ...args],
      { stdio: ['ignore','ignore','pipe'], env: { PATH: process.env.PATH || '', TZ: process.env.TZ || 'UTC' } });
    let stderr = '', reason = null, checking = false;
    const abort=()=>{reason='Подготовка остановлена администратором.';child.kill('SIGKILL');};
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    const timeout = setTimeout(() => { reason = `Подготовка Excel превысила ${PREPARATION_TIMEOUT_MS / 1000} секунд.`; child.kill('SIGKILL'); }, PREPARATION_TIMEOUT_MS);
    // V8 heap limits do not cover workbook buffers and native allocations.
    // Watch actual RSS before the 512 MB container OOM killer acts.
    const monitor = setInterval(async () => {
      if (checking || !child.pid || reason) return;
      checking = true;
      try {
        const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
        const kib = Number(status.match(/^VmRSS:\s*(\d+)\s*kB/m)?.[1]);
        if (kib && (kib > childMB * 1024 || kib * 1024 + process.memoryUsage().rss > combinedMB * 1048576)) {
          reason = 'Недостаточно памяти для подготовки этого Excel на текущем тарифе.';
          child.kill('SIGKILL');
        }
      } catch { /* A completed child may disappear before the next sample. */ }
      finally { checking = false; }
    }, 25);
    child.on('error', error => { reason ||= error.message; });
    child.on('close', (code, childSignal) => {
      signal?.removeEventListener('abort',abort);
      clearTimeout(timeout); clearInterval(monitor);
      if (reason || code !== 0) reject(new Error(reason || stderr.trim() || `Подготовка завершилась (${childSignal || code}).`));
      else resolve();
    });
  });
}
const api = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const validDownloadUrl = value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['yandex.ru','yandex.net','yandex.com','yandexdisk.com'].some(h => u.hostname === h || u.hostname.endsWith('.' + h)); } catch { return false; }
};
export const revisionOf = meta => JSON.stringify([meta.md5 || meta.sha256 || '', meta.modified || '', meta.size]);
// Prepared packages store derived data. Upgrade each parser independently,
// even when its Excel is unchanged, without invalidating other source roles.
const parserRevisionPrefix = role => role === 'instant' ? `instant:v${JOURNAL_ANALYSIS_VERSION}:`
  : role === 'events' ? `events:v${EVENTS_PACKAGE_VERSION}:`
  : role === 'consumption' ? `consumption:v${MONTHLY_PARSER_VERSION}:` : null;
const preparedRevisionOf = (meta, role) => (parserRevisionPrefix(role) || '') + revisionOf(meta);

export function createPreparedService({ source, store, yandex }) {
  const pending = new Map(), pendingResponses = new Map(), metadataChecked = new Map(),active=new Map(),upgradeFailures=new Map();
  const allowed=(path,expected)=>store.assertLoadAllowed?.(source,path,expected);
  async function report(path,role,error){
    const issue=preparationIssue(error);if(['res_blocked','res_changed'].includes(issue.code))return;
    await store.appendAdminEvent?.(source,{resPath:resScope(path),category:'preparation',...issue}).catch(()=>{});
  }
  let queue = Promise.resolve(), responseQueue = Promise.resolve(), syncing = false, preparing = false;
  const responseFrom = async (entry, stale = false) => ({ revision: entry.revision,
    payload: await compress(entry.json ?? JSON.stringify(entry.data)), updated_at: entry.updated_at, stale });
  function target(path, suffix = '') {
    const url = new URL(api + suffix); url.searchParams.set('public_key', source); url.searchParams.set('path', path); return url;
  }
  async function download(path, size, destination,signal) {
    signal.throwIfAborted();const { href } = await (await yandex(target(path, '/download'),{signal})).json();signal.throwIfAborted();
    let address = href;
    for (let i = 0; i < 4; i++) {
      if (!validDownloadUrl(address)) throw new Error('Яндекс Диск вернул неподдерживаемый адрес скачивания.');
      const response = await fetch(address, { redirect: 'manual', signal: AbortSignal.any([signal,AbortSignal.timeout(90000)]) });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Адрес перенаправления отсутствует.');
        address = new URL(location, address).href; await response.body?.cancel(); continue;
      }
      if (!response.ok) throw new Error('Не удалось скачать Excel с Яндекс Диска.');
      if (size > maxBytes || Number(response.headers.get('content-length')) > maxBytes)
        throw new Error('Размер Excel превышает 40 МБ.');
      let bytes = 0;
      const limiter = new Transform({ transform(chunk, _, callback) {
        bytes += chunk.length;
        callback(bytes > maxBytes ? new Error('Размер Excel превышает 40 МБ.') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destination),{signal});
      return;
    }
    throw new Error('Слишком много перенаправлений при скачивании.');
  }
  async function prepare(directory, role, filename,signal) {
    const started = performance.now();
    try {
      const path = join(directory, 'workbook');
      const output = join(directory, 'package.json');
      const { containerMB } = await memoryBudget();
      await runLimitedChild([path, output, role, filename], containerMB,signal);
      signal.throwIfAborted();
      const { packageMB } = preparationLimits(containerMB);
      if ((await stat(output)).size > packageMB * 1048576) throw new Error(`Пакет Excel превышает лимит ${packageMB} МБ.`);
      const json = await readFile(output, 'utf8');
      console.info(`Excel [${role}]: подготовлен за ${Math.round((performance.now() - started) / 1000)} с.`);
      return json;
    } catch (error) {
      const message = /heap out of memory|allocation failed/i.test(error.message || '')
        ? 'Файл превышает доступный лимит памяти подготовки Excel.' : error.message || 'Ошибка подготовки Excel.';
      throw new Error(`[${role}; ${Math.round((performance.now() - started) / 1000)} с] ${message.trim().slice(0, 350)}`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  const readMeta = (path, role) => store.getMeta ? store.getMeta(source, path, role) : store.get(source, path, role);
  async function load(path, role) {
    const policy=await allowed(path);
    const key = role + ':' + path+':'+JSON.stringify(policy?[policy.globalGeneration,policy.generation]:[]);
    if (!pending.has(key)) {
      const controller=new AbortController();active.set(key,{controller,path});
      const work = (async () => {
        const previous = await readMeta(path, role);
        let meta;
        try { meta = await (await yandex(target(path),{signal:controller.signal})).json(); }
        catch (error) { await allowed(path,policy);await report(path,role,error);if (previous) return { ...previous, stale: true }; throw error; }
        await allowed(path,policy);controller.signal.throwIfAborted();
        if (meta.type !== 'file' || !/\.xlsx?$/i.test(meta.name || '') || !Number.isFinite(meta.size) || meta.size > maxBytes) throw new Error('Файл Excel недоступен или превышает 40 МБ.');
        const revision = preparedRevisionOf(meta, role);
        if (previous?.revision === revision) {
          await store.markFile?.(source, path, role, 'ready', previous.updated_at,policy);
          return previous;
        }
        // A single Excel parse at a time prevents 2–5 concurrent visitors from
        // multiplying peak memory during a cache miss.
        const task = async () => {
          await allowed(path,policy);controller.signal.throwIfAborted();
          const current = await readMeta(path, role);
          if (current?.revision === revision) {
            await store.markFile?.(source, path, role, 'ready', current.updated_at,policy);
            return current;
          }
          const directory = await mkdtemp(join(tmpdir(), 'abonent-prepare-'));
          let json;
          try {
            await download(path, meta.size, join(directory, 'workbook'),controller.signal);
            await allowed(path,policy);json = await prepare(directory, role, meta.name,controller.signal);
          } catch (error) {
            await rm(directory, { recursive: true, force: true });
            throw error;
          }
          await allowed(path,policy);controller.signal.throwIfAborted();
          if (store.putRaw) await store.putRaw(source, path, role, revision, json,policy);
          else await store.put(source, path, role, revision, JSON.parse(json),policy);
          await store.markFile?.(source, path, role, 'ready', new Date(),policy);
          return { revision, updated_at: new Date() };
        };
        const next = queue.then(task); queue = next.catch(() => {});
        try { return await next; } catch (error) {await allowed(path,policy);await report(path,role,error);if (previous) return { ...previous, stale: true }; throw error; }
      })().finally(() => {pending.delete(key);active.delete(key);});
      pending.set(key, work);
    }
    return pending.get(key);
  }
  async function fromDatabase(path, role, etag) {
    const policy=await allowed(path);
    const key = JSON.stringify([path, role, etag,policy?.generation,policy?.globalGeneration]);
    if (!pendingResponses.has(key)) {
      const work = (async () => {
        let stale = false;
        const parserPrefix = parserRevisionPrefix(role);
        const meta = store.getMeta || parserPrefix ? await readMeta(path, role) : null;
        const checkedKey = `${role}:${path}`;
        const parserChanged = parserPrefix && meta && !String(meta.revision).startsWith(parserPrefix);
        const upgradeKey = parserPrefix ? JSON.stringify([path, role, parserPrefix, policy?.globalGeneration, policy?.generation]) : null;
        if (upgradeKey && !parserChanged) upgradeFailures.delete(upgradeKey);
        const failedAt = upgradeKey && upgradeFailures.get(upgradeKey);
        const upgradePaused = parserChanged && failedAt != null && Date.now() - failedAt < 60000;
        if (upgradePaused) stale = true;
        // Check parser compatibility before conditional 304 responses and before
        // the normal 15-minute source refresh interval. The existing queue and
        // policy-generation guards still bound and authorize this preparation.
        if (!upgradePaused && (parserChanged || meta && Date.now() - new Date(meta.updated_at).getTime() > 15 * 60 * 1000 &&
            Date.now() - (metadataChecked.get(checkedKey) || 0) > 15 * 60 * 1000)) {
          metadataChecked.set(checkedKey, Date.now());
          stale = Boolean((await load(path, role)).stale);
          await allowed(path,policy);
          if (parserChanged) {
            if (stale) {
              // A failed migration of a huge workbook should not restart for
              // every visitor. Generation-scoped keys cannot survive a clear or
              // permission change, and denial errors never reach this cache.
              while (upgradeFailures.size >= 256) upgradeFailures.delete(upgradeFailures.keys().next().value);
              upgradeFailures.set(upgradeKey, Date.now());
            } else upgradeFailures.delete(upgradeKey);
          }
        }
        if (etag && store.getRevision) {
          const revision = await store.getRevision(source, path, role);
          await allowed(path,policy);if (revision && etag === `"${Buffer.from(revision).toString('base64url')}"`) return { revision, unchanged: true, stale };
        }
        if (store.getMeta && !meta) await load(path, role);
        // Database JSON and compression are large; bound them to one response
        // at a time even when several different RES are opened together.
        const next = responseQueue.then(async () => {
          await allowed(path,policy);
          const read = store.getJson || store.get;
          const saved = await read.call(store, source, path, role);
          const entry = saved || (await load(path, role), await read.call(store, source, path, role));
          await allowed(path,policy);if(!entry)throw new Error('Подготовленный пакет недоступен.');
          const result=await responseFrom(entry, stale || Boolean(entry.stale));await allowed(path,policy);return result;
        });
        responseQueue = next.catch(() => {});
        return next;
      })().finally(() => pendingResponses.delete(key));
      pendingResponses.set(key, work);
    }
    return pendingResponses.get(key);
  }
  async function list(path) {
    const items = []; let offset = 0;
    do {
      const url = target(path); url.searchParams.set('limit', '100'); url.searchParams.set('offset', String(offset));
      const data = await (await yandex(url)).json();
      if (data.type !== 'dir') throw new Error('Ожидалась папка РЭС.');
      const page = data._embedded?.items || []; items.push(...page); offset += page.length;
      if (!page.length || offset >= (data._embedded?.total ?? offset)) break;
      if (offset > 10000) throw new Error('Слишком много файлов в папке.');
    } while (true);
    return items;
  }
  async function syncAll({ prepare = true } = {}) {
    if (syncing) return;
    syncing = true;
    try {
      const seen = [];
      let partialError = null;
      const previousFolders = prepare || !store.listFolders ? new Map() :
        new Map((await store.listFolders(source)).map(folder => [folder.res_path, folder.statuses || {}]));
      const enterprises = (await list('/')).filter(x => x.type === 'dir');
      for (const enterprise of enterprises) {
        let resources;
        try { resources = (await list(enterprise.path)).filter(x => x.type === 'dir'); }
        catch (error) { partialError ||= error; await report(enterprise.path,'catalog',error);console.warn(`Каталог ${enterprise.path}: ${error.message}`); continue; }
        for (const res of resources) {
          const policy=await store.getLoadPolicy?.(source,res.path);
          if(policy?.blocked){
            const old=previousFolders.get(res.path)||{};
            await store.putFolder?.(source,{path:res.path,name:res.name,enterprisePath:enterprise.path,enterpriseName:enterprise.name},
              Object.fromEntries(sourceRoleKeys.map(role=>[role,{...old[role],state:'blocked'}])),policy);
            seen.push(res.path);continue;
          }
          let files;
          try { files = await list(res.path); }
          catch (error) { partialError ||= error;await report(res.path,'catalog',error); console.warn(`Каталог ${res.path}: ${error.message}`); continue; }
          const statuses = {};
          for (const role of sourceRoleKeys) {
            const file = findSource(files, role);
            if (!file) { statuses[role] = { state: 'missing' }; continue; }
            if (!prepare) {
              const old = previousFolders.get(res.path)?.[role];
              const unchanged = old?.path === file.path && old?.modified === file.modified && old?.size === file.size;
              statuses[role] = { ...(unchanged ? old : {}), state: unchanged ? old.state : 'pending',
                file: file.name, path: file.path, size: file.size, modified: file.modified };
              continue;
            }
            try {
              const result = await load(file.path, role);
              statuses[role] = { state: result.stale ? 'stale' : 'ready', file: file.name, path: file.path,
                size: file.size, modified: file.modified, updatedAt: result.updated_at };
            } catch (error) {
              statuses[role] = { state: 'error', file: file.name, path: file.path, size: file.size, modified: file.modified };
              Object.assign(statuses[role],preparationIssue(error));
              console.warn(`Подготовка ${role} в ${res.path}: ${error.message}`);
            }
          }
          await store.putFolder?.(source, { path: res.path, name: res.name,
            enterprisePath: enterprise.path, enterpriseName: enterprise.name }, statuses,policy);
          seen.push(res.path);
        }
      }
      if (seen.length && !partialError) await store.pruneFolders?.(source, seen);
      if (partialError) throw partialError;
    } catch(error){await report('/','catalog',error);throw error;} finally { syncing = false; }
  }
  async function prepareNext() {
    if (syncing || preparing || !store.listFolders || !store.putFolder) return false;
    preparing = true;
    try {
      const folders = await store.listFolders(source);
      for (const folder of folders) {
        if(folder.load_blocked||(await store.getLoadPolicy?.(source,folder.res_path))?.blocked)continue;
        const policy=await store.getLoadPolicy?.(source,folder.res_path);
        for (const role of sourceRoleKeys) {
          const status = folder.statuses?.[role];
          if (status?.state !== 'pending' || !status.path) continue;
          const statuses = { ...folder.statuses };
          try {
            const result = await load(status.path, role);
            statuses[role] = { ...status, state: result.stale ? 'stale' : 'ready', updatedAt: result.updated_at };
          } catch (error) {
            statuses[role] = { ...status, state: 'error' };
            Object.assign(statuses[role],preparationIssue(error));
            console.warn(`Подготовка ${role} в ${folder.res_path}: ${error.message}`);
          }
          await store.putFolder(source, { path: folder.res_path, name: folder.res_name,
            enterprisePath: folder.enterprise_path, enterpriseName: folder.enterprise_name }, statuses,policy);
          return true;
        }
      }
      return false;
    } finally { preparing = false; }
  }
  return { load, fromDatabase, syncAll, prepareNext,
    status:()=>({syncing,preparing,activeFiles:active.size}),
    cancelRes(path){for(const item of active.values())if(path==='/'||resScope(item.path)===path)item.controller.abort();},
  };
}

// Sochi imports only local Excel in a bounded parser subprocess.
export async function prepareUploadedXlsx(path,output,role,filename,signal){
  const {containerMB}=await memoryBudget();
  await runLimitedChild([path,output,role,filename],containerMB,signal);
  const {packageMB}=preparationLimits(containerMB);
  if((await stat(output)).size>packageMB*1048576)throw new Error('Подготовленный пакет Excel превышает лимит '+packageMB+' МБ.');
  return readFile(output,'utf8');
}
