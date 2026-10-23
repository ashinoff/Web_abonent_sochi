import { readBoundedBuffer } from './download-buffer.js';
import { clean, norm, fieldKey } from './core.js';
import { demo, demoMonthly } from './demo.js';
import { findSource, isExcelFile, isRegistryFile, isConsumptionFile, REGISTRY_NAME, CONSUMPTION_NAME, INCOMING_NAME, INSTANT_NAME, EVENTS_NAME, sourceRoleKeys } from './source.js';
import { initSourceFiles } from './source-files.js';
import { attachDialogSwipe } from './gestures.js';
import { groupRecordFields } from './record-sections.js';
import { initAnalysisUI } from './analysis-ui.js';
import { initNotesUI } from './notes-ui.js';
import { calculateReading } from './readings.js';
import { initLoadMap } from './load-map.js';
import { folderSources, offlineDirectory, formatBytes, sourceRoles } from './offline-copies.js';
import { initDiagnosticsUI } from './diagnostics-ui.js';
import { createLoadSession, requestSignal } from './load-session.js';
import { listOfflineCopies } from './prepared-cache.js?v=19';
import { createUserNotifications } from './user-notifications.js';
import { initUserNoteEditor } from './user-note-editor.js';
import { initAccountUI } from './account-ui.js';
import { initAdminUI } from './admin-ui.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const number = n => new Intl.NumberFormat('ru-RU').format(n);
const recordsText = n => `${number(n)} ${n % 100 >= 11 && n % 100 <= 14 ? 'записей' : n % 10 === 1 ? 'запись' : n % 10 >= 2 && n % 10 <= 4 ? 'записи' : 'записей'}`;
const subscribersWord = n => n % 100 >= 11 && n % 100 <= 14 ? 'абонентов' : n % 10 === 1 ? 'абонент' : n % 10 >= 2 && n % 10 <= 4 ? 'абонента' : 'абонентов';
const ratioLine = record => `<div class="reading-inline"><div class="transformer-ratio"><span>Коэф ТТ =</span> <strong>${esc(record.fields.transformerRatio || '—')}</strong></div><div class="reading-calculator" data-previous="${esc(record.fields.receipt || '')}" data-ratio="${esc(record.fields.transformerRatio || '')}"><input type="text" inputmode="decimal" autocomplete="off" aria-label="Фактические показания ПУ ${esc(record.fields.meter || '')}" placeholder="Факт. показания"><output hidden aria-live="polite"></output><button type="button" data-reading-action aria-label="Рассчитать объём">${icon('check')}</button></div></div><p class="reading-note" role="status" hidden></p><p class="reading-formula" hidden></p>`;
const pointText = fields => [fields.point || fields.pointNumber, fields.pointName].filter(Boolean).join(' · ') || '—';
const pointLine = record => `<div class="quick-point"><span class="number-label">Точка учёта</span><strong>${esc(pointText(record.fields))}</strong></div>`;
const initial = window.ABONENT_CONFIG || {};
let config = { ...initial }, proxy = false, folders = [], selectedFolder = null, selectedFile = null;
let accountUI=null,authFetchInstalled=false;
function watchAuthentication(){
  if(authFetchInstalled||!config.auth?.enabled)return;authFetchInstalled=true;
  const original=globalThis.fetch.bind(globalThis);
  globalThis.fetch=async(...args)=>{
    const response=await original(...args),url=new URL(typeof args[0]==='string'||args[0] instanceof URL?args[0]:args[0].url,location.href);
    if(response.status===401&&url.origin===location.origin&&url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/api/auth/'))window.dispatchEvent(new Event('abonent-auth-required'));
    return response;
  };
}
let resFolders = [], selectedRes = null, resState = 'idle';
let sourceState = 'loading', diskState = 'checking', directoryState = 'loading', folderRead = null;
let consumptionFile = null, consumptionState = 'idle', consumptionError = '', registryState = 'idle', busyText = '';
let incomingFile = null, incomingState = 'idle', incomingError = '', monthlyWorker = null, monthlyId = 0;
const monthlyRequests = new Map();
const journalRoles = ['instant', 'events'];
const journalSources = Object.fromEntries(journalRoles.map(role => [role, { file: null, state: 'idle', error: '', info: null }]));
let exporting = false, exportSession = null;
let summary = null, pending = null, currentSource = null, isDemo = false, busy = false, operation = 0;
let results = [], resultTotal = 0, submitted = false, searchVersion = 0, worker, requestId = 0, prefs = {};
let folderItems = [], filesState = 'idle', filesError = '', registryError = '', consumptionInfo = null, incomingInfo = null;
let directoryOffline = false;
let shellReady = false;
let offlineChoices = [], offlineSource = '', offlineListVersion = 0;
let offlineAvailabilityVersion = 0;
let usingOfflineCopy = false;
let tpChoices = [], tpSelection = null, tpMeters = [], tpVersion = 0, tpBusy = false, recordVersion = 0;
let recordContext = { parent: null, variants: [] };
let tpViewKey = '', tpPickerQuery = '', tpPickerScroll = 0, tpFilterTimer = null;
const dialogControls = new Map();
const requests = new Map();
const loads = createLoadSession();
try { prefs = JSON.parse(localStorage.getItem('abonent.preferences.v1') || '{}'); } catch { /* Preferences are optional. */ }
const sourceFiles = initSourceFiles($('#source-files'), { onRead: useSourceFile, onRefresh: refreshResFiles, readOnly:()=>Boolean(config.sochi) });
function savePrefs() { try { localStorage.setItem('abonent.preferences.v1', JSON.stringify(prefs)); } catch { /* Private browsing can disable storage. */ } }
function createWorkbookWorker() { return new Worker(new URL('./worker.js?v=19', import.meta.url)); }
function getWorker() {
  if (!worker) {
    worker = createWorkbookWorker();
    worker.onmessage = ({ data }) => { const p = requests.get(data.id); if (!p) return; clearTimeout(p.timer); requests.delete(data.id); if(data.status===401)window.dispatchEvent(new Event('abonent-auth-required'));data.error ? p.reject(Object.assign(new Error(data.error),{status:data.status,code:data.code})) : p.resolve(data.result); };
    worker.onerror = () => { resetWorker(new Error('Не удалось запустить обработку Excel. Перезагрузите страницу.')); };
  }
  return worker;
}
function resetWorker(error = new Error('Операция отменена.')) {
  worker?.terminate(); worker = null;
  for (const p of requests.values()) { clearTimeout(p.timer); p.reject(error); }
  requests.clear();
}
function rpc(action, payload = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    const w = getWorker(), id = ++requestId;
    const timer = setTimeout(() => resetWorker(new Error('Чтение реестра заняло слишком много времени. Попробуйте файл меньшего размера.')),
      action === 'loadPreparedRegistry' ? 300000 : 120000);
    requests.set(id, { resolve, reject, timer });
    w.postMessage({ id, action, payload }, transfer);
  });
}
function resetMonthly(error = new Error('Операция отменена.')) {
  monthlyWorker?.terminate(); monthlyWorker = null;
  for (const p of monthlyRequests.values()) { clearTimeout(p.timer); p.reject(error); }
  monthlyRequests.clear();
}
function monthlyRPC(action, payload = {}, transfer = [], onProgress = () => {}) {
  if (!monthlyWorker) {
    monthlyWorker = createWorkbookWorker();
    monthlyWorker.onmessage = ({ data }) => { const p=monthlyRequests.get(data.id); if (!p) return; if (data.progress) { p.onProgress(data.progress); return; } clearTimeout(p.timer); monthlyRequests.delete(data.id);if(data.status===401)window.dispatchEvent(new Event('abonent-auth-required')); data.error ? p.reject(Object.assign(new Error(data.error),{status:data.status,code:data.code})) : p.resolve(data.result); };
    monthlyWorker.onerror = () => { resetMonthly(new Error('Не удалось обработать файл потребления. Повторите загрузку.')); consumptionState='error'; renderIndicators(); };
  }
  return new Promise((resolve,reject) => {
    const id=++monthlyId, timer=['exportAnomalies','exportAnomalyPart'].includes(action) ? null : setTimeout(() => { resetMonthly(new Error('Расчёт занял слишком много времени. Попробуйте меньшую выгрузку.')); consumptionState='error'; renderIndicators(); },
      ['loadPreparedMonthly','checkPreparedIncoming','loadPreparedJournal'].includes(action) ? 300000 : 120000);
    monthlyRequests.set(id,{resolve,reject,timer,action,role:payload.role,onProgress}); monthlyWorker.postMessage({id,action,payload},transfer);
  });
}
function cancelJournalLoads(roles, error = new Error('Чтение журнала остановлено.')) {
  monthlyWorker?.postMessage({ id: 0, action: 'cancelJournalLoads', payload: { roles } });
  for (const [id, request] of monthlyRequests) if (['loadPreparedJournal', 'loadJournal', 'clearAnalysisJournal'].includes(request.action)) {
    clearTimeout(request.timer); monthlyRequests.delete(id); request.reject(error);
  }
}
function incomingRPC(action, payload, transfer = [], signal = loads.signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const w = createWorkbookWorker();
    const finish = (error, result) => { clearTimeout(timer); signal.removeEventListener('abort', cancel); w.terminate(); error ? reject(error) : resolve(result); };
    const cancel = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error('Чтение приёма заняло слишком много времени. Повторите позже.')), 300000);
    signal.addEventListener('abort', cancel, { once: true });
    w.onmessage = ({ data }) => {if(data.status===401)window.dispatchEvent(new Event('abonent-auth-required'));finish(data.error ? Object.assign(new Error(data.error),{status:data.status,code:data.code}) : null, data.result);};
    w.onerror = () => finish(new Error('Не удалось прочитать приём.'));
    w.postMessage({ id: 1, action, payload }, transfer);
  });
}
function stopLoading() {
  loads.cancel(); folderRead = null; operation++;
  const text = 'Загрузка остановлена. Выберите другую РЭС или повторите загрузку.';
  if (!summary || registryState === 'checking') { resetWorker(); pending = null; $('#mapping-section').hidden = true; }
  if (consumptionState === 'checking') { resetMonthly(); analysisUI.reset(); consumptionState = 'error'; consumptionError = text; }
  if (incomingState === 'checking') { incomingState = 'error'; incomingError = text; }
  const stoppedJournals = journalRoles.filter(role => journalSources[role].state === 'checking');
  if (stoppedJournals.length) cancelJournalLoads(stoppedJournals);
  for (const role of stoppedJournals) { journalSources[role].state = 'error'; journalSources[role].error = text; }
  if (registryState === 'checking') { registryState = summary ? 'ready' : 'error'; registryError = text; }
  if (filesState === 'loading') { filesState = 'error'; filesError = text; }
  if (resState === 'loading') resState = 'error';
  if (directoryState === 'loading') directoryState = folders.length ? 'ready' : 'error';
  if (sourceState === 'loading') sourceState = rootUrl() ? 'ready' : 'error';
  setBusy(false); renderFolders(); renderResFolders(); message('#settings-message', text); toast('Загрузка остановлена');
}
function message(target, value, loading = false) { const el = $(target); el.textContent = value; el.hidden = !value; el.classList.toggle('loading', loading); }
function toast(value) { $('#toast').textContent = value; $('#toast').hidden = false; setTimeout(() => { $('#toast').hidden = true; }, 3000); }
function setBusy(value, text = '') {
  busy = value; busyText = text;
  for (const sel of ['#confirm-mapping', '#local-file', '#search-submit', '#tp-open', '#local-monthly']) $(sel).disabled = value;
  $('#read-folders').disabled = value || sourceState === 'loading' || directoryState === 'loading';
  $('#district-button').disabled = Boolean(config.sochi);
  $('#res-button').disabled = !selectedFolder;
  if (text || !value) message('#settings-message', text, value);
  updateSource(); renderIndicators(); renderResults();
  if (!value) refreshOfflineAvailability();
}
function openDialog(id) {
  for (const dialog of document.querySelectorAll('dialog[open]')) if (dialog.id !== id) dialog.close();
  const dialog = $('#' + id);
  if (!dialog.open) dialog.showModal();
}
function showSettings() { renderIndicators(); analysisUI.settingsTab('connection'); openDialog('settings-dialog'); }
function showEnterprises() {
  if(config.sochi){showRes();return;}
  openDialog('enterprise-dialog'); renderFolders();
  if (sourceState !== 'loading' && directoryState !== 'ready' && !busy) readFolders();
}
function showRes() {
  if (!selectedFolder) { showEnterprises(); return; }
  openDialog('res-dialog'); renderResFolders();
  if (resState === 'error' && !busy) openFolder(selectedFolder, { choose: true });
}
function rootUrl() {const key=clean(config.publicUrl),id=accountUI?.user?.id;return config.sochi&&id&&!key.endsWith('@'+id)?key+'@'+id:key;}
function offlineRoot() { return rootUrl() || prefs.root || ''; }
function renderOfflineAvailability(copies, error = false) {
  const count = copies.filter(copy => copy.files.some(file => file.role === 'registry')).length;
  const button = $('#offline-open');
  button.dataset.state = count ? 'on' : 'off';
  button.dataset.copyCount = String(count);
  button.title = error ? 'Не удалось прочитать сохранённые РЭС' : count ? `На телефоне: ${count} РЭС. Выбрать сохранённую копию` : 'На телефоне пока нет реестров для работы без интернета';
  button.setAttribute('aria-label', 'Выбрать РЭС, сохранённую на телефоне. ' + button.title);
}
async function refreshOfflineAvailability() {
  const version = ++offlineAvailabilityVersion, source = offlineRoot();
  try {
    const copies = await listOfflineCopies(source);
    if (version === offlineAvailabilityVersion && source === offlineRoot()) renderOfflineAvailability(copies);
  } catch {
    if (version === offlineAvailabilityVersion && source === offlineRoot()) renderOfflineAvailability([], true);
  }
}
async function showOfflineCopies() {
  const version = ++offlineListVersion, source = offlineRoot();
  openDialog('offline-dialog');
  const list = $('#offline-list');
  offlineChoices = []; offlineSource = source;
  list.setAttribute('aria-busy', 'true');
  list.innerHTML = '<div class="enterprise-loading" role="status"><span class="loading-indicator" aria-hidden="true"></span><span>Читаем сохранённые РЭС…</span></div>';
  try {
    const copies = await listOfflineCopies(source);
    if (version !== offlineListVersion || !$('#offline-dialog').open || source !== offlineRoot()) return;
    renderOfflineAvailability(copies);
    offlineChoices = copies.sort((a, b) => a.resPath.localeCompare(b.resPath, 'ru'));
    const enterprises = offlineDirectory(copies, '/') || [];
    list.innerHTML = copies.length ? copies.map((copy, i) => {
      const enterprise = enterprises.find(folder => copy.resPath.startsWith(folder.path + '/'));
      const res = offlineDirectory(copies, enterprise?.path)?.find(folder => folder.path === copy.resPath);
      const ready = copy.files.some(file => file.role === 'registry');
      const selected = source === rootUrl() && selectedRes?.path === copy.resPath;
      const parts = sourceRoles.filter(([role]) => copy.files.some(file => file.role === role)).map(([, label]) => label).join(' · ');
      return `<button type="button" class="choice-item ${selected ? 'selected' : ''}" data-offline-res="${i}" aria-pressed="${selected}" ${ready ? '' : 'disabled'}><span><strong>${esc(res?.name || copy.resPath.split('/').at(-1))}</strong><small>${esc(enterprise?.name || '')} · ${formatBytes(copy.bytes)}</small><small>${esc(parts)}${ready ? '' : ' · Для поиска ещё нужен реестр'}</small></span><i class="choice-dot" aria-hidden="true"></i></button>`;
    }).join('') : '<div class="enterprise-empty"><p>На телефоне пока нет сохранённых РЭС.</p><p class="hint">Со связью откройте «Карту загрузки» и нажмите «Скачать на телефон» возле нужной РЭС.</p></div>';
  } catch (error) {
    if (version === offlineListVersion && $('#offline-dialog').open) list.innerHTML = `<div class="enterprise-empty"><p>Не удалось прочитать сохранённые РЭС.</p><p class="hint">${esc(error.message)}</p></div>`;
  } finally { if (version === offlineListVersion) list.setAttribute('aria-busy', 'false'); }
}
async function selectOfflineRes(i) {
  const copy = offlineChoices[i], source = offlineSource;
  if (!copy?.files.some(file => file.role === 'registry') || source !== offlineRoot()) return;
  const savedDirectory = path => {
    try { const items = JSON.parse(localStorage.getItem('abonent.folder.v1:' + source + ':' + path) || 'null'); if (Array.isArray(items)) return items.filter(item => item.type === 'dir'); } catch {}
    return offlineDirectory(offlineChoices, path) || [];
  };
  const enterprisePath = copy.resPath.slice(0, copy.resPath.lastIndexOf('/')) || '/';
  folders = savedDirectory('/');
  selectedFolder = folders.find(folder => folder.path === enterprisePath) || { type:'dir', path:enterprisePath, name:enterprisePath.split('/').filter(Boolean).at(-1) || enterprisePath };
  if (!folders.some(folder => folder.path === enterprisePath)) folders.push(selectedFolder);
  resFolders = savedDirectory(enterprisePath);
  const res = resFolders.find(folder => folder.path === copy.resPath) || { type:'dir', path:copy.resPath, name:copy.resPath.split('/').at(-1) };
  if (!resFolders.some(folder => folder.path === res.path)) resFolders.push(res);
  proxy = true; config = { ...config, publicUrl:source, prepared:true };
  sourceState = 'ready'; directoryState = 'ready'; directoryOffline = true; resState = 'ready'; diskState = 'disconnected'; folderRead = null;
  $('#offline-dialog').close(); renderFolders(); renderSourceState();
  await openRes(res, { offlineCopy:copy });
}
function renderIndicators() {
  notesUI.update(summary, busy);
  userNotes.changeContext();
  const canClear=Boolean((accountUI?.isAdmin??true) && selectedRes && proxy && config.prepared && !isDemo && currentSource?.type !== 'local');
  $('#current-res-notifications').hidden=!canClear;
  $('#current-res-notifications-name').textContent=selectedRes?.name || '';
  $('#clear-res-notifications').disabled=!canClear || !navigator.onLine;
  document.querySelectorAll('[data-stop-loading]').forEach(button => { button.hidden = !(busy || sourceState === 'loading' || directoryState === 'loading'); });
  const offline = $('#offline-readiness');
  offline.hidden = !selectedRes || !config.prepared;
  if (!offline.hidden) {
    const ready = shellReady && summary?.cached && (!consumptionFile || consumptionInfo?.cached) && (!incomingFile || incomingInfo?.cached) && journalRoles.every(role => !journalSources[role].file || journalSources[role].info?.cached);
    offline.dataset.ready = String(Boolean(ready));
    offline.textContent = ready ? `Данные ${selectedRes.name} сохранены на телефоне · доступны без интернета` :
      'Офлайн-копия ещё не готова. Загрузите данные или нажмите «Скачать на телефон» в карте загрузки.';
  }
  const cachedOffline = summary?.offline || consumptionInfo?.offline || incomingInfo?.offline || journalRoles.some(role => journalSources[role].info?.offline);
  const baseState = sourceState === 'loading' ? 'checking' : !config.prepared ? (proxy ? 'off' : 'idle') : !navigator.onLine || cachedOffline ? 'off' : config.databaseConnected ? 'on' : 'off';
  const baseText = baseState === 'checking' ? 'Проверяем подключение к базе…' : !config.prepared ? 'База не подключена · доступен прежний режим Excel' : cachedOffline ? 'Открыты сохранённые данные с телефона' : baseState === 'on' ? 'Подготовленные данные базы доступны' : !navigator.onLine ? 'База недоступна · открыты сохранённые данные' : 'Нет связи с базой данных';
  const registryText = registryState === 'ready' || summary ? 'Реестр готов к поиску' : registryState === 'checking' ? busyText || 'Проверяем реестр…' : pending ? 'Подтвердите столбцы в настройках' : registryError || (registryState === 'missing' ? 'Файл реестра не найден' : registryState === 'error' ? 'Реестр не загружен' : 'Сначала выберите РЭС');
  const consumptionText = consumptionState === 'ready' ? 'Готов к анализу: ' + (consumptionFile?.name || 'Демонстрация') : consumptionState === 'checking' ? `Читаем «${consumptionFile?.name || CONSUMPTION_NAME}»…` : consumptionState === 'missing' ? `Файл «${CONSUMPTION_NAME}» не найден` : consumptionState === 'error' ? consumptionError || 'Не удалось прочитать файл потребления' : 'Сначала выберите РЭС';
  const incomingText = incomingState === 'ready' ? 'Прочитан: ' + incomingFile.name + ' · баланс ожидает формат' : incomingState === 'checking' ? 'Читаем файл приёма…' : incomingState === 'missing' ? `Файл «${INCOMING_NAME}» не найден` : incomingState === 'error' ? incomingError || 'Не удалось прочитать приём' : 'Сначала выберите РЭС';
  for (const [name, state, label] of [
    ['base', baseState, baseText],
    ['registry', registryState === 'ready' ? 'on' : registryState === 'checking' ? 'checking' : registryState === 'idle' ? 'idle' : 'off', registryText],
    ['incoming', incomingState === 'ready' ? 'on' : incomingState === 'checking' ? 'checking' : incomingState === 'idle' ? 'idle' : 'off', incomingText],
    ['consumption', consumptionState === 'ready' ? 'on' : consumptionState === 'checking' ? 'checking' : consumptionState === 'idle' ? 'idle' : 'off', consumptionText],
  ]) {
    const indicator = $('#' + name + '-indicator');
    indicator.dataset.state = state; indicator.title = label;
    indicator.setAttribute('aria-label', `${{ base:'Чтение базы',registry:'Реестр',consumption:'Потребление',incoming:'Приём' }[name]}: ${label}`);
  }
  $('#base-detail').textContent = baseText;
  $('#enterprise-detail').textContent = selectedFolder?.name || 'Не выбрано';
  $('#res-detail').textContent = selectedRes?.name || 'Не выбрана';
  $('#contour-open').disabled = busy || consumptionState !== 'ready';
  const exportButton = $('#anomaly-export');
  const pendingJournals = journalRoles.some(role => journalSources[role].file && journalSources[role].state === 'checking');
  const canExport = Boolean(selectedRes && summary && consumptionState === 'ready' && !isDemo && !pendingJournals);
  exportButton.disabled = !canExport || busy || exporting;
  exportButton.dataset.state = exporting || pendingJournals ? 'checking' : canExport ? 'on' : selectedRes ? 'off' : 'idle';
  exportButton.title = exporting ? 'Готовим Excel-отчёт…' : pendingJournals ? 'Для отчёта ждём завершения чтения журналов' : canExport ? `Выгрузить аномалии: ${selectedRes.name}` : selectedRes ? 'Для отчёта загрузите реестр и потребление выбранной РЭС' : 'Сначала выберите РЭС';
  exportButton.setAttribute('aria-label', 'Excel-отчёт по аномалиям: ' + exportButton.title);
  $('#tp-analyze').disabled = busy || consumptionState !== 'ready';
  const analysisButton = $('#consumer-analyze');
  if (analysisButton) { analysisButton.disabled = consumptionState !== 'ready' || !activeRecord?.fields.account; $('#analysis-availability').textContent = consumptionState === 'ready' ? 'Все строки ЛС + ТУ суммируются по месяцам. Анализируем общий объём точки.' : consumptionText; }
  sourceFiles.render({ res: selectedRes, items: folderItems, listState: filesState, listError: filesError, busy: busy || directoryState === 'loading' || sourceState === 'loading', sources: {
    registry: { file: currentSource || selectedFile, saved: selectedRes && prefs.fileChoices?.registry, expected: REGISTRY_NAME, state: summary ? 'ready' : registryState, meta: summary ? recordsText(summary.count) : '', message: registryText },
    consumption: { file: consumptionFile, saved: selectedRes && prefs.fileChoices?.consumption, expected: CONSUMPTION_NAME, state: consumptionState, meta: consumptionInfo ? `${recordsText(consumptionInfo.rowCount)} · ${consumptionInfo.months.length} мес.` : '', message: consumptionState === 'ready' ? 'Готов к анализу' : consumptionText },
    incoming: { file: incomingFile, saved: selectedRes && prefs.fileChoices?.incoming, expected: INCOMING_NAME, state: incomingState, meta: incomingInfo ? `Заполненных листов: ${incomingInfo.sheets}` : '', message: incomingState === 'ready' ? 'Файл прочитан · расчёт баланса подключим позже' : incomingText },
    ...Object.fromEntries(journalRoles.map(role => {
      const source = journalSources[role], label = role === 'instant' ? 'Журнал 31' : 'Журнал 46';
      return [role, { file: source.file, saved: selectedRes && prefs.fileChoices?.[role], expected: role === 'instant' ? INSTANT_NAME : EVENTS_NAME, state: source.state,
        meta: source.info ? `${source.info.meterCount} ПУ · строк принято: ${source.info.stats?.accepted ?? source.info.stats?.rows ?? 0}` : '',
        message: source.state === 'ready' ? label + ' подключён к анализу' + (source.info.warnings?.length ? ' · есть замечания к данным' : '') : source.state === 'checking' ? 'Читаем ' + label.toLowerCase() + '…' : source.state === 'missing' ? 'Дополнительный журнал не найден; анализ потребления доступен' : source.error || 'Дополнительный источник для анализа' }];
    }))
  } });
}
function renderSourceState() {
  const text = sourceState === 'loading' ? 'Проверяем базу…' : sourceState === 'error' ? 'Нет связи с сервером. Повторите попытку.' : sourceState === 'missing' ? 'База ещё не готова. Обратитесь к администратору.' : '';
  message('#source-setup-message', text);
  $('#read-folders').disabled = busy || sourceState === 'loading' || directoryState === 'loading';
  renderIndicators(); renderFolders();
}
async function readConfiguration(signal = loads.signal) {
  sourceState = 'loading'; diskState = 'checking'; renderSourceState();
  try {
    const response = await fetch(new URL('./api/config', location.href), { signal: requestSignal(signal, 10000), cache: 'no-store' });
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
      const remote = await response.json();
      if (!loads.current(signal)) return;
      if (remote.proxy !== true) throw new Error('Неизвестный ответ сервера.');
      proxy = true; config = { ...initial, ...remote, publicUrl: remote.publicUrl || '' };
      watchAuthentication();
      try { localStorage.setItem('abonent.server.v1', JSON.stringify({ publicUrl: config.publicUrl, prepared: config.prepared,auth:config.auth,sochi:config.sochi,localUploads:config.localUploads,databaseConnected:config.databaseConnected })); } catch {}
    } else if (response.status === 404 || response.ok) {
      if (!loads.current(signal)) return;
      proxy = false; config = { ...initial };
    } else throw new Error('Настройки сервера недоступны.');
    sourceState = rootUrl() ? 'ready' : 'missing';
    if (rootUrl()) validateRoot(rootUrl());
  } catch {
    if (!loads.current(signal)) return;
    try {
      const saved = JSON.parse(localStorage.getItem('abonent.server.v1') || 'null');
      if(saved?.auth)config.auth=saved.auth;
      if (saved?.publicUrl && (prefs.root === saved.publicUrl || prefs.root?.startsWith(saved.publicUrl+'@')) && saved.prepared) {
        proxy = true; config = { ...initial, ...saved }; sourceState = 'ready'; directoryOffline = true;
      } else sourceState = 'error';
    } catch { sourceState = 'error'; }
  }
  if (!loads.current(signal)) return;
  if (sourceState !== 'ready') { diskState = 'disconnected'; directoryState = 'error'; consumptionFile = null; consumptionState = selectedRes ? 'error' : 'idle'; registryState = selectedRes ? 'error' : 'idle'; }
  renderSourceState();
  refreshOfflineAvailability();
}
function validateRoot(value) {
  if(config.sochi&&value.startsWith('sochi:local:v1'))return value;
  try { const u = new URL(value); if (u.protocol === 'https:' && !u.username && !u.password && !u.port && ['disk.yandex.ru', 'disk.yandex.com', 'disk.yandex.net', 'disk.360.yandex.ru', 'yadi.sk'].includes(u.hostname) && /^\/(d|i)\/[\w-]+\/?$/.test(u.pathname)) return `${u.origin}${u.pathname}`; } catch {}
  throw new Error('Адрес общей папки настроен некорректно. Обратитесь к администратору приложения.');
}
async function apiRequest(action, path = '/', offset = 0, legacy = false, signal = loads.signal) {
  if (proxy && !navigator.onLine) throw new Error('Нет подключения к сети.');
  const base = config.apiBase || (proxy ? new URL('./api/', location.href).href : 'https://cloud-api.yandex.net/v1/disk/public/');
  if(config.sochi && action!=='resources')throw new Error('Исходные файлы загружаются только администратором.');
  const directory = action === 'resources' && (config.sochi || (proxy && config.prepared && config.databaseConnected && !legacy));
  const endpoint = directory ? 'directory' : proxy || config.apiBase ? action : action === 'download' ? 'resources/download' : 'resources';
  const url = new URL(endpoint, base.endsWith('/') ? base : base + '/');
  if (!proxy && !config.apiBase) url.searchParams.set('public_key', validateRoot(rootUrl()));
  url.searchParams.set('path', path);
  if (action === 'resources') { url.searchParams.set('offset', offset); url.searchParams.set('limit', 100); url.searchParams.set('sort', 'name'); }
  let response;
  try { response = await fetch(url, { signal: requestSignal(signal, action === 'download' ? 90000 : 25000), credentials: 'same-origin' }); }
  catch { signal.throwIfAborted(); throw new Error(config.sochi ? 'Нет ответа от базы данных. Проверьте соединение.' : proxy ? 'Нет ответа от Яндекс Диска. Проверьте соединение и повторите.' : 'Браузер не смог получить файл с Яндекс Диска.'); }
  signal.throwIfAborted();
  if (!config.sochi && directory && [404,502,503].includes(response.status)) return apiRequest(action,path,offset,true,signal);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const text = { 404: 'Папка не найдена. Проверьте ссылку и доступ.', 403: 'Доступ к файлу ограничен. Разрешите скачивание по ссылке.', 429: 'Слишком много запросов к Диску. Повторите позже.', 413: 'Файл превышает 40 МБ.' };
    throw Object.assign(new Error(body.error && !/^[A-Za-z]+Error$/.test(body.error) ? body.error : text[response.status] || 'Не удалось получить данные Яндекс Диска.'),{status:response.status,code:body.code});
  }
  return response;
}
async function listFolder(path, legacy = false, signal = loads.signal) {
  const key = 'abonent.folder.v1:' + rootUrl() + ':' + path;
  try {
    let all = [], offset = 0;
    while (true) {
      const data = await (await apiRequest('resources', path, offset, legacy, signal)).json();
      signal.throwIfAborted();
      if (data.type !== 'dir') throw new Error('Не удалось прочитать каталог: по выбранному пути находится файл.');
      const part = data._embedded?.items || []; all.push(...part); offset += part.length;
      if (!part.length || offset >= (data._embedded?.total ?? offset)) break;
      if (offset > 10000) throw new Error('В папке слишком много файлов. Разделите её на папки предприятий.');
    }
    directoryOffline = false;
    try { localStorage.setItem(key, JSON.stringify(all)); } catch {}
    return all;
  } catch (error) {
    signal.throwIfAborted();
    if([401,403].includes(error.status)||error.code==='res_changed')throw error;
    let saved; try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
    const copies = config.prepared ? await listOfflineCopies(rootUrl()).catch(() => []) : [];
    signal.throwIfAborted();
    const local = offlineDirectory(copies, path);
    if (!Array.isArray(saved) && !local) throw error;
    directoryOffline = true;
    return [...new Map([...(Array.isArray(saved) ? saved : []), ...(local || [])].map(item => [item.path, item])).values()];
  }
}
function renderFolders() {
  const list = $('#folder-list');
  if (!folders.length && (sourceState === 'loading' || directoryState === 'loading')) {
    list.setAttribute('aria-busy', 'true');
    list.innerHTML = '<div class="enterprise-loading" role="status"><span class="loading-indicator" aria-hidden="true"></span><span>Загружаем предприятия…</span><div class="loading-bar" aria-hidden="true"></div></div>';
    return;
  }
  list.setAttribute('aria-busy', 'false');
  if (!folders.length && (sourceState !== 'ready' || directoryState === 'error')) {
    list.innerHTML = '<div class="enterprise-empty"><p>Не удалось загрузить список предприятий.</p><button type="button" class="secondary" data-open-settings>Проверить подключение</button></div>';
    return;
  }
  list.innerHTML = folders.length ? folders.map((f, i) => `<button type="button" class="choice-item ${selectedFolder?.path === f.path ? 'selected' : ''}" data-folder="${i}" aria-pressed="${selectedFolder?.path === f.path}" ><span>${esc(f.name)}</span><i class="choice-dot" aria-hidden="true"></i></button>`).join('') : '<div class="enterprise-empty"><p>Предприятия пока не найдены.</p></div>';
}
async function readFolders(signal) {
  if (folderRead) return folderRead;
  if (busy) return false;
  signal ||= loads.start();
  const task = (async () => {
    if (sourceState !== 'ready') { await readConfiguration(signal); if (!loads.current(signal) || sourceState !== 'ready') return false; }
    directoryState = 'loading'; diskState = 'checking'; renderSourceState();
    try {
      const root = validateRoot(rootUrl());
      if (prefs.root !== root) { folders = []; selectedFolder = null; resFolders = []; resState = 'idle'; clearResSelection(); prefs = { root }; savePrefs(); }
      const items = await listFolder('/', false, signal);
      if (!loads.current(signal)) return false;
      folders = items.filter(f => f.type === 'dir').sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      directoryState = 'ready'; diskState = directoryOffline ? 'disconnected' : 'connected';
      if (!selectedRes) { consumptionFile = null; consumptionState = 'idle'; registryState = 'idle'; }
      return true;
    } catch (error) {
      if (!loads.current(signal)) return false;
      directoryState = 'error'; diskState = 'disconnected';
      message('#settings-message', error.message);
      return false;
    } finally { if (loads.current(signal)) renderSourceState(); }
  })();
  folderRead = task;
  try { return await task; } finally { if (folderRead === task) folderRead = null; }
}
function clearResSelection() {
  selectedRes = null; selectedFile = null; consumptionFile = null; consumptionState = 'idle'; consumptionError = ''; registryState = 'idle';
  clearDataset(); renderIndicators();
}
function renderResFolders() {
  $('#res-enterprise').textContent = selectedFolder?.name || '';
  const list = $('#res-list');
  list.setAttribute('aria-busy', String(resState === 'loading'));
  if (resState === 'loading' && !resFolders.length) {
    list.innerHTML = '<div class="enterprise-loading" role="status"><span class="loading-indicator" aria-hidden="true"></span><span>Загружаем РЭС…</span><div class="loading-bar" aria-hidden="true"></div></div>'; return;
  }
  if (resState === 'error' && !resFolders.length) {
    list.innerHTML = '<div class="enterprise-empty"><p>Не удалось загрузить список РЭС.</p><button type="button" class="secondary" data-open-settings>Проверить подключение</button></div>'; return;
  }
  list.innerHTML = resFolders.length ? resFolders.map((f, i) => `<button type="button" class="choice-item ${selectedRes?.path === f.path ? 'selected' : ''}" data-res="${i}" aria-pressed="${selectedRes?.path === f.path}" ><span>${esc(f.name)}</span><i class="choice-dot" aria-hidden="true"></i></button>`).join('') : '<div class="enterprise-empty"><p>В этом предприятии пока нет папок РЭС.</p></div>';
}
async function refreshSources() {
  if (busy || folderRead) return;
  const signal = loads.start();
  message('#settings-message', '');
  await readConfiguration(signal);
  if (!loads.current(signal) || sourceState !== 'ready' || !await readFolders(signal) || !loads.current(signal)) return;
  const folder = folders.find(f => f.path === (selectedFolder?.path || prefs.folder?.path));
  if (folder) await openFolder(folder, { restore: true });
  else if (selectedFolder || prefs.folder) {
    selectedFolder = null; resFolders = []; resState = 'idle'; clearResSelection();
    prefs = { root: rootUrl() }; savePrefs(); updateSource(); renderIndicators();
    message('#settings-message', 'Выбранное предприятие больше не найдено. Выберите другое на главном экране.');
  }
}
async function selectFolder(i) {
  if (!folders[i]) return;
  await openFolder(folders[i], { choose: true });
}
async function openFolder(folder, { restore = false, choose = false } = {}) {
  const signal = loads.start(); folderRead = null;
  if (directoryState === 'loading') directoryState = folders.length ? 'ready' : 'error';
  const savedRes = restore && prefs.root === rootUrl() && prefs.folder?.path === folder.path ? prefs.res : null;
  selectedFolder = folder; resFolders = []; resState = 'loading'; clearResSelection();
  if (!savedRes) prefs = { root: rootUrl() };
  prefs.folder = { name: folder.name, path: folder.path }; savePrefs();
  if (choose) openDialog('res-dialog');
  renderFolders(); renderResFolders();
  try {
    setBusy(true, 'Читаем папки РЭС…');
    const items = await listFolder(folder.path, false, signal);
    if (!loads.current(signal)) return;
    resFolders = items.filter(f => f.type === 'dir').sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    resState = 'ready'; diskState = directoryOffline ? 'disconnected' : 'connected';
  } catch (error) {
    if (!loads.current(signal)) return;
    resState = 'error'; diskState = 'disconnected'; setBusy(false);
    message('#settings-message', error.message); renderResFolders(); return;
  }
  setBusy(false); renderResFolders();
  const restored = savedRes && resFolders.find(f => f.path === savedRes.path);
  if (restored) await openRes(restored);
  else if (savedRes) {
    prefs = { root: rootUrl(), folder: prefs.folder }; savePrefs();
    message('#settings-message', 'Выбранная РЭС больше не найдена. Выберите другую РЭС.');
    toast('Выбранная РЭС больше не найдена');
  }
}
async function selectRes(i) {
  if (!resFolders[i]) return;
  $('#res-dialog').close(); await openRes(resFolders[i]);
}
async function refreshResFiles() {
  if (busy || folderRead || !selectedRes) return;
  await openRes(selectedRes, { keepSettings: true });
}
async function useSourceFile(role, path) {
  if (config.sochi || busy || folderRead || !selectedRes || filesState !== 'ready' || !sourceRoleKeys.includes(role)) return;
  const choices = { ...prefs.fileChoices };
  if (path === null) {
    delete choices[role]; prefs.fileChoices = choices; savePrefs();
    await refreshResFiles(); return;
  }
  const file = folderItems.find(item => item.type === 'file' && item.path === path && isExcelFile(item.name));
  if (!file) { message('#settings-message', 'Выберите Excel из списка файлов этой РЭС.'); return; }
  choices[role] = { path: file.path, name: file.name }; prefs.fileChoices = choices; savePrefs();
  if (role === 'registry') { await refreshResFiles(); return; }
  const signal = loads.start();
  if (role === 'consumption') { consumptionFile = file; await readConsumptionFile(signal, usingOfflineCopy); }
  else if (role === 'incoming') { incomingFile = file; await readIncomingFile(signal, usingOfflineCopy); }
  else { journalSources[role].file = file; await readJournalFile(role, signal, usingOfflineCopy); }
  const state = role === 'consumption' ? consumptionState : role === 'incoming' ? incomingState : journalSources[role].state;
  if (loads.current(signal) && state === 'ready') toast('Файл прочитан: ' + file.name);
}
async function openRes(res, { keepSettings = false, offlineCopy = null } = {}) {
  if (!selectedFolder) return;
  const signal = loads.start();
  clearResSelection(); selectedRes = res;
  usingOfflineCopy = Boolean(offlineCopy);
  consumptionState = 'checking'; incomingState = 'checking'; registryState = 'checking';
  if (prefs.res?.path !== res.path) prefs = { root: rootUrl(), folder: { name: selectedFolder.name, path: selectedFolder.path } };
  prefs.res = { name: res.name, path: res.path }; savePrefs(); renderResFolders();
  try {
    setBusy(true, 'Читаем файлы РЭС…');
    filesState = 'loading'; renderIndicators();
    const offlineOnly = Boolean(offlineCopy);
    let items = offlineOnly ? offlineCopy.files.map(file => ({ type:'file', path:file.path, name:file.path.split('/').at(-1) })) : await listFolder(res.path, false, signal);
    if (!loads.current(signal)) return;
    if (!config.sochi && !offlineOnly && proxy && config.prepared && Object.values(prefs.fileChoices || {}).some(choice => choice?.path && !items.some(item => item.path === choice.path))) {
      items = await listFolder(res.path, true, signal);
      if (!loads.current(signal)) return;
    }
    folderItems = items.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    let choices = config.sochi ? {} : prefs.fileChoices;
    if ((offlineOnly || directoryOffline) && config.prepared) {
      const copy = offlineCopy || (await listOfflineCopies(rootUrl()).catch(() => [])).find(item => item.resPath === res.path);
      if (!loads.current(signal)) return;
      const savedChoices = Object.fromEntries((copy?.files || []).map(file => [file.role, { path:file.path }]));
      choices = offlineOnly ? savedChoices : config.sochi ? savedChoices : { ...savedChoices, ...prefs.fileChoices };
      if (offlineOnly) { prefs.fileChoices = savedChoices; savePrefs(); }
    }
    filesState = 'ready'; diskState = directoryOffline ? 'disconnected' : 'connected';
    consumptionFile = findSource(folderItems, 'consumption', choices); consumptionState = consumptionFile ? 'checking' : 'missing';
    selectedFile = findSource(folderItems, 'registry', choices);
    incomingFile = findSource(folderItems, 'incoming', choices); incomingState = incomingFile ? 'checking' : 'missing';
    for (const role of journalRoles) {
      const source = journalSources[role]; source.file = findSource(folderItems, role, choices); source.state = source.file ? 'checking' : 'missing';
    }
  } catch (error) {
    if (!loads.current(signal)) return;
    filesState = 'error'; filesError = error.message;
    diskState = 'disconnected'; consumptionState = 'error'; incomingState = 'error'; registryState = 'error';
    setBusy(false); message('#settings-message', error.message); showSettings(); return;
  }
  setBusy(false);
  if(config.sochi && !offlineCopy) {
    await readSochiSummary({keepSettings,signal});
    return;
  }
  if (selectedFile) await downloadFile({ keepSettings, signal, offlineOnly:Boolean(offlineCopy) });
  else {
    registryState = 'missing'; renderIndicators();
    message('#settings-message', 'Реестр не найден. Выберите файл вручную в разделе «Просмотр файлов».'); showSettings();
  }
  if (loads.current(signal) && consumptionFile) await readConsumptionFile(signal, Boolean(offlineCopy), false);
  if (loads.current(signal) && incomingFile) await readIncomingFile(signal, Boolean(offlineCopy));
  if (loads.current(signal)) await readSelectedJournals(signal, Boolean(offlineCopy));
}
let serverReportReady = '';
async function registryRequest(action,payload={},transfer=[]){
  const serverActions=['summary','search','record','tps','tpMeters','notes','mapNotes','notificationRecord'];
  if(config.sochi && navigator.onLine && !usingOfflineCopy && serverActions.includes(action)){
    if(!selectedRes)throw new Error('Выберите РЭС.');
    const response=await fetch(new URL('./api/registry',location.href),{
      method:'POST',credentials:'same-origin',cache:'no-store',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({resPath:selectedRes.path,action,payload}),
      signal:AbortSignal.timeout(120000),
    });
    const data=await response.json();
    if(!response.ok)throw Object.assign(new Error(data.error||'Не удалось прочитать реестр.'),{status:response.status,code:data.code});
    return data.result;
  }
  return rpc(action,payload,transfer);
}
async function readSochiSummary({keepSettings=false,signal=loads.signal}={}){
  const current=selectedRes;
  serverReportReady='';
  try{
    setBusy(true,'Получаем данные выбранной РЭС из базы…');
    if(selectedFile){
      summary=await registryRequest('summary');
      if(!loads.current(signal)||selectedRes!==current)return;
      registryState='ready'; registryError=''; pending=null;
      currentSource={type:'disk',name:selectedFile.name,folder:selectedFolder.name,res:current.name,
        root:rootUrl(),folderInfo:selectedFolder,resInfo:current,fileInfo:selectedFile,keepSettings};
      const saved=await listOfflineCopies(rootUrl()).catch(()=>[]);
      const copy=saved.find(item=>item.resPath===current.path);
      if(copy&&summary)summary.cached=copy.files.some(file=>file.role==='registry'&&file.path===selectedFile.path);
    }else {summary=null;registryState='missing';}
    if(consumptionFile){
      try {
        const info=await sochiAnalysisRequest('analysisSummary',{});
        if(!loads.current(signal)||selectedRes!==current)return;
        consumptionInfo=info;consumptionState='ready';consumptionError='';
      }catch(error){consumptionState='error';consumptionError=error.message;}
    }else consumptionState='missing';
    if(incomingFile){incomingInfo={sheets:1};incomingState='ready';}
    else incomingState='missing';
    for(const role of journalRoles){
      const item=journalSources[role];
      item.state=item.file?'ready':'missing';
      item.info=item.file?{meterCount:0,stats:{},warnings:[]}:null;
    }
    setBusy(false);renderResults();
    if(!keepSettings&&summary)$('#settings-dialog').close();
  }catch(error){
    if(!loads.current(signal)||selectedRes!==current)return;
    registryState='error';registryError=error.message;summary=null;
    setBusy(false);message('#settings-message',error.message);showSettings();
  }
}
async function ensureSochiReportData(){
  if(!config.sochi||usingOfflineCopy||!navigator.onLine||!selectedRes)return;
  if(serverReportReady===selectedRes.path)return;
  if(!selectedFile||!consumptionFile)throw new Error('Для отчёта нужен реестр и потребление этой РЭС.');
  const res=selectedRes,files={registry:selectedFile,consumption:consumptionFile,...Object.fromEntries(journalRoles.map(role=>[role,journalSources[role].file]))};
  setBusy(true,'Получаем исходные данные для Excel-отчёта…');
  try{
    await rpc('loadPreparedRegistry',{source:rootUrl(),path:files.registry.path,role:'registry'});
    if(res!==selectedRes)throw new Error('РЭС изменилась.');
    const records=await rpc('analysisRecords');
    await monthlyRPC('loadPreparedMonthly',{source:rootUrl(),path:files.consumption.path,role:'consumption',records});
    for(const role of journalRoles){
      if(files[role]?.path)await monthlyRPC('loadPreparedJournal',{source:rootUrl(),path:files[role].path,role});
    }
    if(res!==selectedRes)throw new Error('РЭС изменилась.');
    serverReportReady=res.path;
  }finally{setBusy(false);}
}
async function fetchWorkbook(file, signal = loads.signal) {
  if (file.size > (config.maxFileMB || 40) * 1048576) throw new Error('Файл больше 40 МБ.');
  const latest = await (await apiRequest('resources', file.path, 0, false, signal)).json();
  signal.throwIfAborted();
  if (latest.type !== 'file') throw new Error('Файл больше не найден. Обновите файлы РЭС.');
  file = { ...file, ...latest };
  if (file.size > (config.maxFileMB || 40) * 1048576) throw new Error('Файл больше 40 МБ.');
  let response = await apiRequest('download', file.path, 0, false, signal);
  if (!proxy && !config.apiBase) {
    const { href } = await response.json();
    signal.throwIfAborted();
    const url = new URL(href);
    if (url.protocol !== 'https:' || !['yandex.ru','yandex.net','yandex.com','yandexdisk.com'].some(h => url.hostname === h || url.hostname.endsWith('.' + h))) throw new Error('Неподдерживаемый адрес скачивания.');
    try { response = await fetch(href, { signal: requestSignal(signal, 90000) }); }
    catch { signal.throwIfAborted(); throw new Error('Браузер заблокировал скачивание с Диска. Откройте Excel с устройства или используйте версию на Амвере.'); }
    if (!response.ok) throw new Error('Не удалось скачать Excel. Проверьте доступ по ссылке.');
  }
  const buffer = await readBoundedBuffer(response, (config.maxFileMB || 40) * 1048576, file.size);
  signal.throwIfAborted(); return { file, buffer };
}
async function downloadFile({ keepSettings = false, signal = loads.signal, offlineOnly = false } = {}) {
  if (busy || !selectedFile || !selectedFolder || !selectedRes || !loads.current(signal)) return;
  const folder = selectedFolder, res = selectedRes, selected = selectedFile;
  try {
    registryState = 'checking'; registryError = ''; setBusy(true, 'Загружаем реестр…');
    if (proxy && config.prepared && (config.sochi || offlineOnly || !customMappingSaved()) && selected.path) {
      try {
        const listedIncoming = incomingFile;
        clearDataset(true); incomingFile = listedIncoming; incomingState = listedIncoming ? 'checking' : 'missing';
        const data = await rpc('loadPreparedRegistry', { source: rootUrl(), path: selected.path, role: 'registry', offlineOnly });
        if (!loads.current(signal)) return;
        currentSource = { type: 'disk', name: selected.name, folder: folder.name, res: res.name,
          root: rootUrl(), folderInfo: folder, resInfo: res, fileInfo: selected, keepSettings };
        summary = data; registryState = 'ready'; pending = null;
        updateSource(); setBusy(false); renderResults();
        if (!keepSettings) $('#settings-dialog').close();
        toast(data.offline ? 'Реестр открыт с телефона · офлайн' : `Реестр готов: ${recordsText(data.count)}`);
        return;
      } catch (error) {
        if (!loads.current(signal)) return;
        if ([401,403].includes(error.status) || error.code==='res_changed')throw error;
        if (config.sochi || offlineOnly || (selected.size || 0) > 8 * 1048576 || error.message.startsWith('MEMORY_LIMIT:'))
          throw new Error(error.message.replace(/^MEMORY_LIMIT:\s*/, ''));
      }
    }
    if(config.sochi)throw new Error('Реестр загружает в базу администратор.');
    const { file, buffer } = await fetchWorkbook(selected, signal);
    if (!loads.current(signal)) return;
    selectedFile = file;
    await loadBuffer(buffer, { name: file.name, folder: folder.name, res: res.name, modified: file.modified, type: 'disk', root: rootUrl(), folderInfo: folder, resInfo: res, fileInfo: file, keepSettings }, signal);
  } catch (error) {
    if (!loads.current(signal)) return;
    registryState = 'error'; registryError = error.message; setBusy(false); message('#settings-message', error.message); showSettings();
  }
}
async function loadMonthlyBuffer(buffer) {
  const op = operation, records = await rpc('analysisRecords');
  if (op !== operation) throw new Error('Рабочая область изменилась.');
  return monthlyRPC('loadMonthly', { buffer, records }, [buffer]);
}
async function readIncomingFile(signal = loads.signal, offlineOnly = false) {
  if (!loads.current(signal)) return;
  const op=operation, file=incomingFile;
  incomingState='checking'; incomingError=''; incomingInfo=null; setBusy(true, 'Читаем файл приёма…');
  try {
    if (proxy && config.prepared && file.path) {
      try {
        const info = await incomingRPC('checkPreparedIncoming', { source: rootUrl(), path: file.path, role: 'incoming', offlineOnly }, [], signal);
        if (op !== operation || incomingFile !== file) return;
        incomingInfo = info; incomingState = 'ready'; setBusy(false); return;
      } catch (error) {
        if (!loads.current(signal) || op !== operation) return;
        if ([401,403].includes(error.status) || error.code==='res_changed')throw error;
        if (config.sochi || offlineOnly || (file.size || 0) > 8 * 1048576 || error.message.startsWith('MEMORY_LIMIT:'))
          throw new Error(error.message.replace(/^MEMORY_LIMIT:\s*/, ''));
        // A small incompatible workbook can still use local Excel reading.
      }
    }
    if(config.sochi)throw new Error('Исходный Excel доступен только администратору.');
    const { buffer, file: latest } = await fetchWorkbook(file, signal);
    if (!loads.current(signal) || op !== operation) return;
    Object.assign(file, latest);
    if (op!==operation || incomingFile!==file) return;
    const info = await incomingRPC('checkIncoming',{buffer},[buffer],signal);
    if (op!==operation || incomingFile!==file) return;
    incomingInfo=info; incomingState='ready';
  } catch(error) { if(op!==operation || incomingFile!==file)return;incomingState='error';incomingError=error.message; }
  if (op===operation) setBusy(false);
}
async function readConsumptionFile(signal = loads.signal, offlineOnly = false, loadJournals = true) {
  if (!loads.current(signal)) return;
  const op = operation, file = consumptionFile;
  consumptionState = 'checking'; consumptionError = ''; consumptionInfo = null; resetMonthly(); analysisUI.reset(); setBusy(true, 'Читаем файл потребления…');
  try {
    if (proxy && config.prepared && file.path) {
      try {
        const records = await rpc('analysisRecords');
        if (!loads.current(signal) || op !== operation) return;
        const info = await monthlyRPC('loadPreparedMonthly', { source: rootUrl(), path: file.path, role: 'consumption', records, offlineOnly });
        if (op !== operation || consumptionFile !== file) return;
        consumptionInfo = info; consumptionState = 'ready'; setBusy(false); return;
      } catch (error) {
        if (!loads.current(signal) || op !== operation) return;
        if ([401,403].includes(error.status) || error.code==='res_changed')throw error;
        if (config.sochi || offlineOnly || (file.size || 0) > 8 * 1048576 || error.message.startsWith('MEMORY_LIMIT:'))
          throw new Error(error.message.replace(/^MEMORY_LIMIT:\s*/, ''));
        // A small incompatible workbook can still use local Excel reading.
      }
    }
    if(config.sochi)throw new Error('Исходный Excel доступен только администратору.');
    const { buffer, file: latest } = await fetchWorkbook(file, signal);
    if (!loads.current(signal) || op !== operation) return;
    Object.assign(file, latest);
    if (op !== operation || consumptionFile !== file) return;
    const info = await loadMonthlyBuffer(buffer);
    if (op !== operation || consumptionFile !== file) return;
    consumptionInfo = info; consumptionState = 'ready';
  } catch (error) {
    if (op !== operation || consumptionFile !== file) return;
    consumptionState = 'error'; consumptionError = error.message;
  } finally {
    if (loads.current(signal) && op === operation && loadJournals && consumptionState === 'ready') await readSelectedJournals(signal, offlineOnly);
  }
  if (op === operation) setBusy(false);
}
async function readJournalFile(role, signal = loads.signal, offlineOnly = false) {
  const source = journalSources[role], file = source.file, op = operation;
  if (!file || !loads.current(signal)) return;
  source.state = 'checking'; source.error = ''; source.info = null;
  analysisUI.reset(); setBusy(true, `Читаем журнал ${role === 'instant' ? '31' : '46'}…`);
  try {
    await monthlyRPC('clearAnalysisJournal', { role });
    if (!loads.current(signal) || op !== operation || source.file !== file) return;
    let info;
    if (proxy && config.prepared && file.path) {
      info = await monthlyRPC('loadPreparedJournal', { source: rootUrl(), path: file.path, role, offlineOnly });
    } else {
      if(config.sochi)throw new Error('Журнал из базы не загружен.');
    const { buffer, file: latest } = await fetchWorkbook(file, signal);
      if (!loads.current(signal) || op !== operation || source.file !== file) return;
      Object.assign(file, latest);
      info = await monthlyRPC('loadJournal', { buffer, role }, [buffer]);
    }
    if (!loads.current(signal) || op !== operation || source.file !== file) return;
    source.info = info; source.state = 'ready';
  } catch (error) {
    if (!loads.current(signal) || op !== operation || source.file !== file) return;
    source.state = 'error'; source.error = error.message.replace(/^MEMORY_LIMIT:\s*/, '');
  } finally { if (loads.current(signal) && op === operation) setBusy(false); }
}
async function readSelectedJournals(signal = loads.signal, offlineOnly = usingOfflineCopy) {
  for (const role of journalRoles) {
    if (!loads.current(signal)) return;
    if (journalSources[role].file) await readJournalFile(role, signal, offlineOnly);
  }
  if (loads.current(signal)) renderIndicators();
}
function reportProgress(progress) {
  const phase = progress.phase === 'analysis' ? 'Анализируем потребителей' : progress.phase === 'parts' ? 'Распределяем свидетельства по файлам' : 'Готовим Excel-файл';
  $('#report-status').textContent = `${phase} · ${progress.done} / ${progress.total}`;
  $('#report-progress').hidden = false;
  $('#report-progress').value = progress.total ? Math.round(progress.done * 100 / progress.total) : 0;
}
async function downloadReportPart(index) {
  const session = exportSession;
  if (!session || exporting || session.op !== operation || session.res !== selectedRes) return;
  exporting = true; renderIndicators();
  $('#report-parts').querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const { buffer } = await monthlyRPC('exportAnomalyPart', { token: session.token, index }, [], reportProgress);
    if (exportSession !== session || session.op !== operation || session.res !== selectedRes) return;
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const href = URL.createObjectURL(blob), link = document.createElement('a');
    const suffix = session.parts.length > 1 ? `_часть_${String(index + 1).padStart(3, '0')}_из_${session.parts.length}` : '';
    link.href = href; link.download = `${session.filename}${suffix}.xlsx`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(href), 60000);
    $('#report-status').textContent = `Часть ${index + 1} из ${session.parts.length} готова к сохранению.`;
    const button = $(`[data-report-part="${index}"]`); if (button) button.textContent = 'Скачать ещё раз';
    toast(`Excel готов · часть ${index + 1} из ${session.parts.length}`);
  } catch (error) { if (session.op === operation) { $('#report-status').textContent = error.message; toast(error.message); } }
  finally { exporting = false; $('#report-progress').hidden = true; $('#report-parts').querySelectorAll('button').forEach(button => { button.disabled = false; }); renderIndicators(); }
}
async function exportAnomalies() {
  if (!selectedRes || !summary || consumptionState !== 'ready' || busy || exporting) return;
  try{await ensureSochiReportData();}catch(error){toast(error.message);return;}
  const op = operation, res = selectedRes;
  exporting = true; exportSession = null; renderIndicators();
  $('#report-subtitle').textContent = res.name; $('#report-parts').replaceChildren();
  reportProgress({ phase: 'analysis', done: 0, total: consumptionInfo?.accountCount || 0 });
  openDialog('report-dialog');
  try {
    const files = { registry: selectedFile, consumption: consumptionFile, incoming: incomingFile, ...Object.fromEntries(journalRoles.map(role => [role, journalSources[role].file])) };
    const generatedAt = new Date().toISOString();
    const { token, parts, count } = await monthlyRPC('exportAnomalies', { settings: analysisUI.getSettings(), context: {
      res: { name: res.name, path: res.path }, source: rootUrl(), sourceMode: usingOfflineCopy ? 'offline' : 'online', files,
      generatedAt,
      journalStates: Object.fromEntries(journalRoles.map(role => [role, { state: journalSources[role].state, error: journalSources[role].error }]))
    } }, [], reportProgress);
    if (op !== operation || selectedRes !== res) return;
    exportSession = { op, res, token, parts, filename: `Аномалии_${res.name.replace(/[\\/:*?"<>|]/g, '_')}_${new Date(generatedAt).toLocaleDateString('sv-SE')}` };
    $('#report-parts').innerHTML = parts.map(part => `<div class="report-part"><div><strong>Часть ${part.index + 1} из ${parts.length}</strong><br><span>Карточек: ${part.count}</span></div><button type="button" class="secondary" data-report-part="${part.index}">Скачать Excel</button></div>`).join('');
    $('#report-status').textContent = count ? `Отобрано потребителей: ${count}. Файлов: ${parts.length}. ${parts.length > 1 ? 'Скачайте нужные части отдельными кнопками.' : ''}` : 'Жёлтых и красных карточек с баллами нет. Доступна сводка анализа.';
    exporting = false;
    if (parts.length === 1) await downloadReportPart(0);
  } catch (error) { if (op === operation) { $('#report-status').textContent = error.message; toast(error.message); } }
  finally { exporting = false; $('#report-progress').hidden = true; renderIndicators(); }
}
function clearDataset(keepDirectory = false) {
  exportSession = null;
  notesUI.reset();
  userNoteEditor.reset();
  for (const source of Object.values(journalSources)) {
    source.info = null; source.error = ''; if (!keepDirectory) source.file = null;
    source.state = source.file ? 'checking' : 'idle';
  }
  operation++; consumptionInfo = null; incomingInfo = null; registryError = ''; resetMonthly(); analysisUI.reset(); incomingFile=null; incomingState='idle'; incomingError=''; if (keepDirectory) { if (consumptionFile) consumptionState='checking'; } else { consumptionFile=null; consumptionState='idle'; consumptionError=''; } searchVersion++; resetWorker(); summary = null; pending = null; currentSource = null; isDemo = false; submitted = false; results = []; resultTotal = 0;
  tpVersion++; recordVersion++; tpChoices = []; tpSelection = null; tpMeters = []; tpBusy = false; if (!keepDirectory) { folderItems = []; filesState = 'idle'; filesError = ''; }
  tpViewKey = ''; tpPickerQuery = ''; tpPickerScroll = 0; clearTimeout(tpFilterTimer);
  for (const id of ['tp-dialog', 'search-results-dialog', 'record-dialog']) $('#' + id).close();
  $('#search-modal-results').replaceChildren(); $('#tp-meters').replaceChildren(); $('#tp-list').replaceChildren(); $('#record-body').replaceChildren();
  $('#mapping-section').hidden = true; $('#search-input').value = ''; $('#clear-query').hidden = true;
  updateSource(); renderResults();
}
async function loadBuffer(buffer, source, signal = loads.signal) {
  if (!loads.current(signal)) return;
  const listedIncoming = incomingFile;
  clearDataset(source.type === 'disk'); if (source.type === 'disk') { incomingFile=listedIncoming; incomingState=listedIncoming?'checking':'missing'; }
  const op = operation;
  setBusy(true, 'Читаем Excel и определяем столбцы…');
  const data = await rpc('load', { buffer, file: source.name }, [buffer]);
  if (operation !== op) return;
  pending = { ...data, source };
  if (source.type === 'disk' && prefs.mappingSignature === signature(data) && prefs.folder?.path === source.folderInfo.path && prefs.res?.path === source.resInfo.path && prefs.root === source.root) {
    await confirmMapping(prefs.overrides || {}, true, signal);
  } else if (source.type === 'disk' && !data.skipped.length && data.sheets.every(s => !s.layout.flattened && s.layout.mapping.meter !== undefined && s.layout.mapping.account !== undefined)) {
    const overrides = Object.fromEntries(data.sheets.map(s => [s.sheet, { meter: s.layout.mapping.meter, account: s.layout.mapping.account }]));
    await confirmMapping(overrides, true, signal);
  } else { if (source.type === 'disk') registryState = 'error'; renderMapping(); setBusy(false); renderResults(); showSettings(); $('#mapping-section').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
}
function signature(data) { return JSON.stringify(data.sheets.map(s => [s.sheet, s.layout.labels])); }
function customMappingSaved() {
  if (!prefs.overrides || !prefs.mappingSignature) return false;
  try {
    return JSON.parse(prefs.mappingSignature).some(([sheet, labels]) =>
      ['meter','account'].some(key => {
        const expected = labels.findIndex(label => fieldKey(label) === key);
        const chosen = prefs.overrides[sheet]?.[key];
        return Number.isInteger(chosen) && chosen !== expected;
      }));
  } catch { return true; }
}
function renderMapping() {
  $('#mapping-section').hidden = false;
  $('#mapping-fields').innerHTML = pending.sheets.map((s, i) => `<div class="map-sheet"><h4>${esc(s.sheet)}</h4>${['meter', 'account'].map(key => `<div class="map-row"><label for="map-${i}-${key}">${key === 'meter' ? 'Номер ПУ' : 'Лицевой счёт'}</label><select id="map-${i}-${key}" data-map-sheet="${i}" data-map-key="${key}"><option value="-1">Нет такого столбца</option>${s.layout.labels.map((label, c) => `<option value="${c}" ${s.layout.mapping[key] === c ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select><div class="map-preview" id="sample-${i}-${key}"></div></div>`).join('')}</div>`).join('');
  updateMapPreview();
  const warnings = [...pending.skipped.map(s => `Лист «${s.sheet}» пропущен: ${s.error}`), ...pending.sheets.filter(s => s.layout.flattened).map(s => `Лист «${s.sheet}»: восстановлена двухстрочная шапка. Проверьте примеры номеров.`)];
  $('#mapping-warning').textContent = warnings.join(' '); $('#mapping-warning').hidden = !warnings.length;
}
function updateMapPreview() {
  document.querySelectorAll('[data-map-sheet]').forEach(select => {
    const { mapSheet: i, mapKey: key } = select.dataset, c = Number(select.value);
    $(`#sample-${i}-${key}`).textContent = c < 0 ? 'Поле не будет участвовать в поиске' : 'Примеры: ' + pending.sheets[i].sample.map(r => r[c] || '—').join(' · ');
  });
}
async function confirmMapping(savedOverrides, automatic = false, signal = loads.signal) {
  if (!pending || busy && !automatic || !loads.current(signal)) return;
  const op = operation, mapping = pending;
  try {
    const overrides = savedOverrides || Object.fromEntries(pending.sheets.map((s, i) => [s.sheet, { meter: Number($(`#map-${i}-meter`).value), account: Number($(`#map-${i}-account`).value) }]));
    for (const v of Object.values(overrides)) if (v.meter >= 0 && v.meter === v.account) throw new Error('Номер ПУ и лицевой счёт должны быть в разных столбцах.');
    for (const v of Object.values(overrides)) if (v.meter < 0 && v.account < 0) throw new Error('Выберите хотя бы один столбец: номер ПУ или лицевой счёт.');
    if (mapping.source.type === 'disk') registryState = 'checking';
    setBusy(true, 'Готовим поиск…');
    const data = await rpc('remap', { overrides });
    if (op !== operation || !loads.current(signal)) return;
    if (consumptionState === 'ready') {
      const records = await rpc('analysisRecords');
      if (op !== operation || !loads.current(signal)) return;
      await monthlyRPC('updateAnalysisRegistry', { records });
    }
    if (op !== operation || !loads.current(signal)) return;
    await rpc('releaseSource');
    if (op !== operation || !loads.current(signal)) return;
    currentSource = mapping.source; summary = data;
    if (currentSource.type === 'disk') {
      prefs = { fileChoices: prefs.fileChoices, root: currentSource.root, folder: { name: currentSource.folderInfo.name, path: currentSource.folderInfo.path }, res: { name: currentSource.resInfo.name, path: currentSource.resInfo.path }, file: { name: currentSource.fileInfo.name, path: currentSource.fileInfo.path }, mappingSignature: signature(pending), overrides };
      savePrefs();
    }
    registryState = currentSource.type === 'disk' ? 'ready' : 'idle';
    pending = null; $('#mapping-section').hidden = true; setBusy(false); updateSource(); renderResults();
    if (!currentSource.keepSettings) $('#settings-dialog').close(); toast(`Реестр готов: ${recordsText(summary.count)}`);
    if (data.skipped.length) message('#form-message', `Пропущено листов: ${data.skipped.length}. ${data.skipped.map(s => s.sheet + ': ' + s.error).join(' ')}`);
  } catch (error) { if (op !== operation || !loads.current(signal)) return; if (pending?.source.type === 'disk') registryState = 'error'; setBusy(false); message('#settings-message', error.message); showSettings(); }
}
async function startDemo() {
  if (config.sochi || busy) return;
  const signal = loads.start();
  try {
    clearDataset(); selectedFolder = null; selectedRes = null; resFolders = []; resState = 'idle'; selectedFile = null; consumptionFile = null; consumptionState = 'idle'; registryState = 'idle'; setBusy(true, 'Открываем пример…');
    const data = await rpc('demo', demo);
    if (!loads.current(signal)) return;
    summary = data; isDemo = true;
    consumptionFile = { name: 'ПО по месячно · пример' }; consumptionState='checking';
    const records = await rpc('analysisRecords');
    if (!loads.current(signal)) return;
    await monthlyRPC('demoMonthly', { parsed: demoMonthly, records });
    if (!loads.current(signal)) return;
    consumptionState='ready';
    currentSource = { name: 'Демонстрационный реестр', folder: 'Сочинские ЭС · пример', res: 'Дагомысский РЭС · пример', type: 'demo' };
    updateSource(); renderResults(); $('#search-input').focus();
  } catch (error) { if (loads.current(signal)) message('#form-message', error.message); }
  finally { if (loads.current(signal)) setBusy(false); }
}
function updateSource() {
  $('#district-label').textContent = config.sochi ? 'Сочинское предприятие электрических сетей' : currentSource?.folder || selectedFolder?.name || 'Выберите предприятие';
  $('#res-label').textContent = currentSource?.res || selectedRes?.name || (selectedFolder ? 'Выберите РЭС' : 'Сначала выберите предприятие');
  $('#res-button').disabled = !selectedFolder;
  $('#district-button').disabled=Boolean(config.sochi);
  $('#demo-banner').hidden = !isDemo; $('#example-queries').hidden = !isDemo;
  document.querySelectorAll('[name="field"]').forEach(input => {
    const available = !summary || input.value === 'address' || summary.sheets.some(s => s.layout.mapping[input.value] !== undefined);
    input.disabled = !available;
    if (!available && input.checked) { const first = summary.sheets.some(s => s.layout.mapping.meter !== undefined) ? 'meter' : 'account'; $(`[name="field"][value="${first}"]`).checked = true; updateSearchMode(); }
  });
}
function field() { return $('[name="field"]:checked').value; }
function updateSearchMode() {
  const type = field();
  const labels = { meter: ['Номер прибора учёта', 'Введите номер счётчика'], account: ['Номер лицевого счёта', 'Введите лицевой счёт'], address: ['Адрес точки учёта', 'Населённый пункт, улица, дом'] };
  $('#search-label').textContent = labels[type][0]; $('#search-input').placeholder = labels[type][1];
  $('#match-hint').textContent = type === 'address' ? 'По всем словам адреса' : 'Можно ввести номер целиком или его часть';
}
function emptyState(title, text, type = 'search', actions = '') { return `<div class="empty-state"><div class="empty-mark">${icon(type)}</div><h3>${title}</h3><p>${text}</p>${actions ? `<div class="empty-actions">${actions}</div>` : ''}</div>`; }
function renderResults() {
  $('#show-more').hidden = true; $('#results-count').textContent = ''; $('#results-title').textContent = submitted ? 'Найденные абоненты' : 'Результаты поиска';
  if (!summary && busy) { $('#results').innerHTML = emptyState('Загружаем реестр', busyText || 'Подготавливаем поиск…', 'file'); return; }
  if (!summary) {
    const target = pending || selectedRes ? 'settings' : selectedFolder ? 'res' : 'enterprises';
    const title = pending ? 'Проверьте столбцы реестра' : selectedRes ? 'Реестр не подключён' : selectedFolder ? 'Выберите РЭС' : 'Выберите предприятие';
    const text = pending ? 'Подтвердите номера ПУ и лицевых счетов в настройках.' : selectedRes ? 'Проверьте файлы выбранной РЭС в настройках.' : selectedFolder ? 'Выберите район электрических сетей. Файлы загрузятся из его папки.' : 'Выберите предприятие, затем РЭС. Реестр загрузится автоматически.';
    $('#results').innerHTML = emptyState(title, text, 'folder', `<button class="secondary" data-open-${target}>${target === 'settings' ? 'Открыть настройки' : target === 'res' ? 'Выбрать РЭС' : 'Выбрать предприятие'}</button>` + (pending || config.sochi ? '' : '<button class="text-button" id="start-demo">Посмотреть пример</button>'));
    return;
  }
  if (!submitted) { $('#results').innerHTML = emptyState('Можно искать', `В реестре ${recordsText(summary.count)}. Введите номер ПУ, лицевой счёт или адрес.`, 'search'); return; }
  $('#results-count').textContent = recordsText(resultTotal);
  if (!results.length) { $('#results').innerHTML = emptyState('Совпадений нет', field() === 'address' ? 'Попробуйте указать только улицу и номер дома.' : 'Проверьте выбранную РЭС или введите более короткий фрагмент номера.'); return; }
  const cards = results.map(r => `<article class="result-card"><div class="result-top"><h3 class="result-name">${esc(r.fields.name || 'Абонент без наименования')}</h3>${r.fields.status ? `<span class="status ${/откл/i.test(r.fields.status) ? 'off' : ''}">${esc(r.fields.status)}</span>` : ''}</div><p class="result-address">${icon('pin')}<span>${esc(r.address || 'Адрес не указан в реестре')}</span></p><div class="result-numbers"><div><div class="number-label">НОМЕР ПУ</div><div class="number-value">${esc(r.fields.meter || '—')}</div></div><div><div class="number-label">ЛИЦЕВОЙ СЧЁТ</div><div class="number-value">${esc(r.fields.account || '—')}</div></div>${pointLine(r)}${ratioLine(r)}</div><div class="result-bottom"><span>${esc(r.fields.tp || r.sheet)} · строка ${r.row}</span><button class="record-open" data-record="${esc(r.id)}">Все данные</button></div></article>`).join('');
  $('#results').innerHTML = resultTotal === 1 ? cards : emptyState(`Найдено: ${recordsText(resultTotal)}`, 'Совпадения доступны в списке. Нажмите «Найти», чтобы открыть его снова.', 'file');
  $('#search-modal-results').innerHTML = cards;
  $('#search-modal-meta').textContent = `${recordsText(resultTotal)} · «${clean($('#search-input').value)}»`;
  $('#show-more').hidden = results.length >= resultTotal;
}
async function doSearch(more = false) {
  const query = clean($('#search-input').value);
  if (!summary) { message('#form-message', pending ? 'Подтвердите столбцы реестра в настройках.' : 'Сначала подключите реестр в настройках.'); return; }
  if (!query) { message('#form-message', 'Введите номер или адрес для поиска.'); $('#search-input').focus(); return; }
  const version = ++searchVersion;
  $('#search-submit').disabled = true; $('#show-more').disabled = true; message('#form-message', '');
  try {
    const found = await registryRequest('search', { query, field: field(), partial: true, offset: more ? results.length : 0, limit: 30 });
    if (version !== searchVersion) return;
    results = more ? [...results, ...found.records] : found.records; resultTotal = found.total; submitted = true; renderResults();
    if (!more) {
      $('#search-input').blur();
      if (found.total > 1) { openDialog('search-results-dialog'); $('#search-results-dialog .dialog-body').scrollTop = 0; }
      else { $('#search-results-dialog').close(); if (window.innerWidth < 701) $('.results-column').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }
    return found;
  } catch (error) { message('#form-message', error.message); }
  finally { $('#search-submit').disabled = false; $('#show-more').disabled = false; }
}
function renderTPChoices() {
  const query = norm($('#tp-filter').value);
  const choices = tpChoices.filter(tp => norm(tp.name).includes(query));
  $('#tp-list').innerHTML = choices.length ? choices.map(tp => `<button type="button" class="choice-item tp-choice" data-tp="${esc(tp.key)}"><span>${esc(tp.name)}</span><span class="tp-count">${number(tp.total)} ПУ</span></button>`).join('') : '<p class="hint">ТП не найдены.</p>';
}
function showTPPicker() {
  clearTimeout(tpFilterTimer); tpVersion++; tpBusy = false; tpSelection = null; tpMeters = []; tpViewKey = '';
  $('#tp-filter').value = tpPickerQuery;
  $('#tp-filter').placeholder = 'Найти ТП в списке'; $('#tp-filter-label').textContent = 'Найти ТП в списке';
  $('#tp-title').textContent = 'Реестр ТП'; $('#tp-meta').textContent = `В реестре: ${number(tpChoices.length)} ТП`;
  $('#tp-back').hidden = true; $('#tp-picker').hidden = false; $('#tp-register').hidden = true;
  message('#tp-message', ''); renderTPChoices(); $('#tp-body').scrollTop = tpPickerScroll;
}
function prepareTPReturn() {
  const dialog = $('#tp-dialog'), surface = dialog.querySelector('.dialog-surface');
  const preview = surface.cloneNode(true);
  preview.className = 'dialog-surface swipe-underlay'; preview.style.transform = '';
  preview.querySelector('#tp-back').hidden = true;
  preview.querySelector('#tp-title').textContent = 'Реестр ТП';
  preview.querySelector('#tp-meta').textContent = `В реестре: ${number(tpChoices.length)} ТП`;
  preview.querySelector('#tp-picker').hidden = false; preview.querySelector('#tp-register').hidden = true;
  preview.querySelector('#tp-filter').value = tpPickerQuery; preview.querySelector('#tp-filter').placeholder = 'Найти ТП в списке';
  preview.querySelector('#tp-message').hidden = true;
  preview.querySelector('[data-scroll-top]').hidden = tpPickerScroll < 260;
  preview.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
  preview.inert = true; preview.setAttribute('aria-hidden', 'true');
  dialog.prepend(preview); preview.querySelector('.dialog-body').scrollTop = tpPickerScroll;
  dialog.classList.add('has-swipe-underlay');
  return () => { preview.remove(); dialog.classList.remove('has-swipe-underlay'); };
}
async function openTPs() {
  if (!summary || busy) { message('#form-message', 'Сначала подключите реестр предприятия.'); return; }
  openDialog('tp-dialog'); tpPickerQuery = ''; tpPickerScroll = 0; showTPPicker();
  const version = tpVersion, op = operation;
  $('#tp-list').innerHTML = '<div class="loading-row"><span class="loading-indicator"></span>Читаем список ТП…</div>';
  try {
    const choices = await registryRequest('tps');
    if (version !== tpVersion || op !== operation) return;
    tpChoices = choices; showTPPicker();
    if (!choices.length) message('#tp-message', 'В реестре нет заполненных значений в столбце «ТП».');
  } catch (error) { if (version === tpVersion) message('#tp-message', error.message); }
}
function renderTPMeters() {
  $('#tp-title').textContent = tpSelection.name;
  const count = tpSelection.totalInTP;
  $('#tp-meta').innerHTML = `<strong>${number(count)}</strong> ${subscribersWord(count)} · по уникальным ПУ${clean($('#tp-filter').value) ? `<span class="tp-filter-count">Найдено по запросу: ${number(tpSelection.total)} ПУ</span>` : ''}`;
  const unique = values => [...new Set(values.filter(Boolean))].join(' · ') || '—';
  $('#tp-meters').innerHTML = tpMeters.map((m, i) => `<button type="button" class="meter-item" data-tp-meter="${i}"><span class="meter-item-head"><span class="meter-number"><span class="number-label">Номер ПУ</span><strong>${esc(m.meter)}</strong></span><span class="meter-open-label">Открыть</span></span><span class="meter-details"><span><span class="number-label">Лицевой счёт</span><strong>${esc(unique(m.variants.map(v => v.account)))}</strong></span><span><span class="number-label">Точка учёта</span><strong>${esc(unique(m.variants.map(pointText)))}</strong></span></span><span class="meter-subscriber">${esc(unique(m.variants.map(v => v.name)))}</span>${m.variants.length > 1 ? `<span class="meter-duplicates">${recordsText(m.variants.length)} исходного реестра</span>` : ''}</button>`).join('');
  $('#tp-more').hidden = tpMeters.length >= tpSelection.total;
  $('#tp-missing').hidden = !tpSelection.missingMeters;
  $('#tp-missing').textContent = `Без номера ПУ: ${recordsText(tpSelection.missingMeters)}. Они не входят в количество абонентов по ПУ; их можно найти по ЛС.`;
  if (!tpSelection.total) $('#tp-meters').innerHTML = `<p class="hint">${clean($('#tp-filter').value) ? 'Совпадений нет. Попробуйте другой номер или часть названия.' : 'У этой ТП нет строк с заполненным номером ПУ.'}</p>`;
}
async function selectTP(key, more = false) {
  if (!summary || more && tpBusy) return;
  clearTimeout(tpFilterTimer);
  if (key !== tpViewKey) {
    tpPickerQuery = $('#tp-filter').value; tpPickerScroll = $('#tp-body').scrollTop;
    tpViewKey = key; $('#tp-filter').value = '';
    $('#tp-filter').placeholder = 'ПУ, ЛС или точка учёта'; $('#tp-filter-label').textContent = 'Найти ПУ, ЛС или точку учёта в этой ТП';
    $('#tp-filter').blur();
  }
  const query = clean($('#tp-filter').value);
  const version = ++tpVersion, op = operation; tpBusy = true; $('#tp-more').disabled = true;
  if (!more) {
    tpMeters = []; $('#tp-picker').hidden = true; $('#tp-register').hidden = false; $('#tp-back').hidden = false;
    $('#tp-title').textContent = tpChoices.find(tp => tp.key === key)?.name || 'Реестр ПУ'; $('#tp-meta').textContent = 'Загружаем…';
    $('#tp-meters').innerHTML = '<div class="loading-row">Готовим список ПУ…</div>'; $('#tp-more').hidden = true; $('#tp-missing').hidden = true; $('#tp-body').scrollTop = 0;
  }
  message('#tp-message', '');
  try {
    const found = await registryRequest('tpMeters', { key, query, offset: more ? tpMeters.length : 0, limit: 100 });
    if (version !== tpVersion || op !== operation) return;
    tpSelection = found; tpMeters = more ? [...tpMeters, ...found.meters] : found.meters;
    renderTPMeters();
  } catch (error) { if (version === tpVersion) message('#tp-message', error.message); }
  finally { if (version === tpVersion) { tpBusy = false; $('#tp-more').disabled = false; } }
}
function renderRecordSections(record) {
  const groups = groupRecordFields(record.labels, record.values);
  const render = empty => groups.map(group => {
    const fields = group.fields.filter(field => Boolean(field.value) !== empty);
    if (!fields.length) return '';
    return `<section class="record-section" data-tone="${group.key}"><h3>${esc(group.title)}</h3><dl>${fields.map(field => `<div class="detail-row"><dt title="${esc(field.label)}">${esc(field.displayLabel)}</dt><dd>${esc(field.value || '—')}</dd></div>`).join('')}</dl></section>`;
  }).join('');
  const emptyCount = groups.flatMap(group => group.fields).filter(field => !field.value).length;
  return `<div class="record-sections">${render(false)}</div>${emptyCount ? `<details class="empty-fields"><summary>Пустые поля (${emptyCount})</summary><div class="record-sections">${render(true)}</div></details>` : ''}`;
}
let activeRecord = null;
async function openRecord(id, context = { parent: null, variants: [] }) {
  const version = ++recordVersion, op = operation;
  try {
    const r = await registryRequest('record', { id });
    if (version !== recordVersion || op !== operation || context.parent && !$('#' + context.parent).open) return;
    activeRecord = r; recordContext = context;
    $('#record-body').innerHTML = `<div class="record-intro"><h3>${esc(r.fields.name || 'Абонент')}</h3><div class="record-address"><p>${esc(r.address || 'Адрес не указан')}</p><div class="record-actions" data-no-swipe><button type="button" class="record-map-button" data-mark-consumer aria-label="Отметить потребителя на карте и добавить комментарий" title="Отметить на карте">${icon('pin')}</button><button type="button" class="record-map-button record-analysis-button" id="consumer-analyze" ${consumptionState !== 'ready' || !r.fields.account ? 'disabled' : ''} aria-label="Провести анализ потребления" aria-describedby="analysis-availability" title="Провести анализ потребления">${icon('chart')}</button></div></div><p class="sr-only" id="analysis-availability">${consumptionState === 'ready' ? 'Анализ потребления выбранной точки учёта.' : 'Для анализа загрузите файл потребления в папку РЭС.'}</p></div><div class="record-main-numbers"><div class="quick-metric" data-tone="meter"><div class="number-label">Номер ПУ</div><div class="number-value">${esc(r.fields.meter || '—')}</div></div><div class="quick-metric" data-tone="account"><div class="number-label">Лицевой счёт</div><div class="number-value">${esc(r.fields.account || '—')}</div></div>${ratioLine(r)}</div>${renderRecordSections(r)}<div class="record-source">${esc(r.file)}<br>Лист «${esc(r.sheet)}», строка ${r.row}${isDemo ? '<br>Демонстрационные данные' : ''}</div><button class="secondary copy-record" id="copy-record">${icon('copy')}Скопировать данные</button>`;
    $('#record-body .record-main-numbers').insertAdjacentHTML('beforeend', pointLine(r));
    if (context.variants.length > 1) {
      $('#record-body').insertAdjacentHTML('afterbegin', `<div class="record-variants"><label for="record-variant">Строки этого ПУ в реестре: ${context.variants.length}</label><select id="record-variant">${context.variants.map(v => `<option value="${esc(v.id)}" ${v.id === id ? 'selected' : ''}>${esc([pointText(v), 'ЛС ' + (v.account || '—'), v.sheet + ', строка ' + v.row].join(' · '))}</option>`).join('')}</select></div>`);
    }
    $('#record-back').hidden = !context.parent;
    $('#record-back').setAttribute('aria-label', context.parent === 'tp-dialog' ? 'К списку ПУ' : context.parent === 'notes-dialog' ? 'К примечаниям' : 'К результатам');
    if (context.parent) { if (!$('#record-dialog').open) $('#record-dialog').showModal(); }
    else openDialog('record-dialog');
    $('#record-body').scrollTop = 0;
  } catch (error) { message('#form-message', error.message); }
}
function notificationContext() {
  const local=currentSource?.type==='local';
  const endpoint=proxy && config.prepared ? new URL('./api/user-notifications',location.href).href : null;
  return {source:isDemo?'demo':local?'local:'+currentSource.name:offlineRoot(),
    resPath:isDemo?'/Пример/Демонстрация':local?'/Устройство/'+currentSource.name:selectedRes?.path || '',
    shared:Boolean(endpoint && selectedRes && !isDemo && !local),endpoint,autoSync:!usingOfflineCopy&&(!accountUI?.enabled||Boolean(accountUI.user))};
}
function mapContext() {return {
  scope:JSON.stringify([currentSource?.type,rootUrl(),selectedRes?.path || currentSource?.res || '',currentSource?.fileInfo?.path || currentSource?.name || '']),
  provider:config.maps?.geocoder || 'photon.komoot.io',
  endpoint:proxy ? new URL('./api/map-geocode',location.href).href : null,
  shared:notificationContext().shared,
};}
const userNotes=createUserNotifications({context:notificationContext});
const userNoteEditor=initUserNoteEditor({context:mapContext,save:(...args)=>userNotes.add(...args),onSaved:()=>toast('Отметка сохранена. Статус отправки — в уведомлениях.')});
async function openUserNote(note) {
  const op=operation;
  try {
    const found=await registryRequest('notificationRecord',{fields:note.fields});
    if(op!==operation || !$('#notes-dialog').open)return;
    await openRecord(found.id,{parent:'notes-dialog',variants:found.variants});
  }catch(error){toast(error.message);}
}
async function deleteUserNote(note) {
  if(!note || note.type!=='user')return;
  const shared=notificationContext().shared;
  if(!window.confirm(`Удалить пользовательскую отметку «${note.note.slice(0,100)}»?${shared?' Удаление распространится на всех сотрудников этого РЭС при наличии связи.':''}`))return;
  try{await userNotes.remove(note.id);toast('Удаление отметки сохранено.');}catch(error){toast(error.message);}
}
async function clearNotifications(resPath,name,source=rootUrl()) {
  if(source!==rootUrl()||!accountUI.isAdmin)return false;
  if(!window.confirm(`Очистить все пользовательские уведомления «${name}» у всех сотрудников? Примечания из реестра сохранятся.`))return false;
  await userNotes.clear(resPath,source);toast('Пользовательские уведомления РЭС очищены.');return true;
}
const notesUI=initNotesUI({request:registryRequest,openDialog,openRecord,openUserNote,deleteUserNote,mapContext,
  refreshUserNotes:fresh=>fresh?userNotes.sync({...notificationContext(),autoSync:true}):userNotes.refresh(),
});
userNotes.subscribe(data=>notesUI.setUserNotes(data));
const loadMap = initLoadMap(rootUrl, {
  canClearNotifications:()=>accountUI?.isAdmin??true,
  onClearNotifications:(source,folder)=>clearNotifications(folder.res_path,folder.res_name,source),
  getFiles(folder) {
    if(folder.load_blocked)return [];
    const files = folderSources(folder);
    if (folder.res_path !== selectedRes?.path || filesState !== 'ready') return files;
    return sourceRoleKeys.flatMap(role => {
      const file = { registry: selectedFile, consumption: consumptionFile, incoming: incomingFile, ...Object.fromEntries(journalRoles.map(role => [role, journalSources[role].file])) }[role];
      return file?.path ? [{ ...file, role }] : files.filter(item => item.role === role);
    });
  },
  beforeDelete(source, resPath) { if (source === rootUrl() && resPath === selectedRes?.path && busy) stopLoading(); },
  async onCopiesChanged(source, resPath, action) {
    if (source !== rootUrl()) return;
    await refreshOfflineAvailability();
    if (source !== rootUrl() || resPath !== selectedRes?.path) return;
    const copy = action === 'delete' ? null : (await listOfflineCopies(source)).find(item => item.resPath === resPath);
    if (source !== rootUrl() || resPath !== selectedRes?.path) return;
    for (const [role, file, info] of [['registry', selectedFile, summary], ['consumption', consumptionFile, consumptionInfo], ['incoming', incomingFile, incomingInfo], ...journalRoles.map(role => [role, journalSources[role].file, journalSources[role].info])]) {
      if (info) info.cached = Boolean(copy?.files.some(saved => saved.role === role && saved.path === file?.path && saved.revision === info.revision));
    }
    renderIndicators();
  },
});
const diagnosticsUI = initDiagnosticsUI({ openDialog, showSettings, context: () => ({
  sourceState, registryState, registryError, filesState, filesError, selectedRes: selectedRes?.name,
  selectedFile: selectedFile?.name, pending: Boolean(pending), offline: !navigator.onLine, serverMode: proxy,
}) });
accountUI=initAccountUI({canRefresh:()=>!usingOfflineCopy,onChange:({enabled,user})=>{if(enabled&&!user){if(busy)stopLoading();loads.start();clearDataset();adminUI.reset();}renderIndicators();},onLogout:()=>{adminUI.reset();clearDataset();}});
const adminUI=initAdminUI({account:()=>accountUI.user,onDatabaseChanged:()=>{if(busy)stopLoading();void loadMap.refresh();directoryState='idle';folderRead=null;}});
async function sochiAnalysisRequest(action,payload={},transfer=[],onProgress=()=>{}){
  if(config.sochi&&navigator.onLine&&!usingOfflineCopy&&action==='exportAnomalies')await ensureSochiReportData();
  if(config.sochi && navigator.onLine && !usingOfflineCopy && ['analysisConsumer','analysisTP','analysisTPs','analysisSummary'].includes(action)){
    if(!selectedRes)throw new Error('Выберите РЭС.');
    const response=await fetch(new URL('./api/analysis',location.href),{
      method:'POST',credentials:'same-origin',cache:'no-store',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({resPath:selectedRes.path,action,account:payload.account,tp:payload.tp,point:payload.point}),
      signal:AbortSignal.timeout(120000),
    });
    const data=await response.json();
    if(!response.ok)throw Object.assign(new Error(data.error||'Анализ недоступен.'),{status:response.status,code:data.code});
    return data.result;
  }
  return monthlyRPC(action,payload,transfer,onProgress);
}
async function sochiSettings(){
  if(!config.sochi||!navigator.onLine)return null;
  const response=await fetch(new URL('./api/analysis-settings',location.href),{credentials:'same-origin',cache:'no-store'});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Не удалось получить настройки базы.');
  return data.settings;
}
async function saveSochiSettings(settings){
  if(!config.sochi)return;
  if(!accountUI?.isAdmin)throw new Error('Только администратор может менять расчёты.');
  const response=await fetch(new URL('./api/admin/analysis-settings',location.href),{
    method:'POST',credentials:'same-origin',cache:'no-store',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({settings}),
  });
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Не удалось сохранить настройки.');
}
const analysisUI = initAnalysisUI({
  request:sochiAnalysisRequest, isReady:()=>consumptionState==='ready',
  getIncoming:()=>({ready:incomingState==='ready',name:incomingFile?.name}),
  showConnection:showSettings,onMapOpen:loadMap.refresh,onAdminOpen:adminUI.refresh,
  canTune:()=>!config.sochi||Boolean(accountUI?.isAdmin),
  loadSettings:sochiSettings,saveSettings:saveSochiSettings,
});
$('#record-body').addEventListener('click', e => {
  if(e.target.closest('[data-mark-consumer]') && activeRecord){void userNoteEditor.open(activeRecord);return;}
  if (e.target.closest('#consumer-analyze') && activeRecord) analysisUI.openConsumer(activeRecord.fields.account, { point: activeRecord.fields.point, pointNumber: activeRecord.fields.pointNumber, pointName: activeRecord.fields.pointName });
});
$('#clear-res-notifications').addEventListener('click',async()=>{
  if(!selectedRes)return;const button=$('#clear-res-notifications');button.disabled=true;
  try{await clearNotifications(selectedRes.path,selectedRes.name);}catch(error){toast(error.message);}finally{button.disabled=!navigator.onLine;}
});
$('#contour-open').addEventListener('click', analysisUI.openTPs);
$('#tp-analyze').addEventListener('click', () => { if (tpSelection) analysisUI.openTP(tpSelection.name); });
$('#analysis-back').addEventListener('click', () => dialogControls.get('analysis-dialog').goBack());
function applyReading(box) {
  const parent=box.parentElement.parentElement, note=parent.querySelector('.reading-note'), formula=parent.querySelector('.reading-formula'), input=box.querySelector('input'), output=box.querySelector('output'), button=box.querySelector('button');
  note.hidden=true; formula.hidden=true;
  if (box.dataset.calculated==='true') { delete box.dataset.calculated; output.hidden=true;output.textContent='';input.hidden=false;input.value='';button.innerHTML=icon('check');button.setAttribute('aria-label','Рассчитать объём');input.focus();return; }
  try { const result=calculateReading(input.value,box.dataset.previous,box.dataset.ratio), fmt=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:6}).format(n);output.textContent=fmt(result.volume)+' кВт·ч';output.hidden=false;input.hidden=true;box.dataset.calculated='true';button.innerHTML=icon('close');button.setAttribute('aria-label','Очистить расчёт');formula.textContent=`(${fmt(result.actual)} − ${fmt(result.previous)}) × ${fmt(result.ratio)}`;formula.hidden=false;if(result.negative){note.textContent='Отрицательный объём. Проверьте показания и возможное переполнение счётчика.';note.hidden=false;} }
  catch(error){note.textContent=error.message;note.hidden=false;input.focus();}
}
document.addEventListener('click',e=>{const button=e.target.closest('[data-reading-action]');if(button)applyReading(button.closest('.reading-calculator'));});
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.closest('.reading-calculator')){e.preventDefault();applyReading(e.target.closest('.reading-calculator'));}});
$('#settings-open').addEventListener('click', showSettings); $('#district-button').addEventListener('click', showEnterprises); $('#res-button').addEventListener('click', showRes);
$('#offline-open').addEventListener('click', showOfflineCopies);
$('#anomaly-export').addEventListener('click', exportAnomalies);
$('#report-parts').addEventListener('click', event => {
  const button = event.target.closest('[data-report-part]');
  if (button) downloadReportPart(Number(button.dataset.reportPart));
});
$('#report-dialog').addEventListener('close', () => {
  exportSession = null;
  monthlyWorker?.postMessage({ id: 0, action: 'clearAnomalyReport', payload: {} });
});
$('#offline-list').addEventListener('click', e => { const button = e.target.closest('[data-offline-res]'); if (button && !button.disabled) selectOfflineRes(Number(button.dataset.offlineRes)); });
document.addEventListener('click', e => {
  const indicator = e.target.closest('#base-indicator, #registry-indicator');
  if (indicator?.dataset.state === 'off') { diagnosticsUI.open(indicator.id === 'base-indicator' ? 'base' : 'registry'); return; }
  if (e.target.closest('[data-stop-loading]')) stopLoading();
  if (e.target.closest('[data-open-settings]')) showSettings();
  if (e.target.closest('[data-open-enterprises]')) showEnterprises();
  if (e.target.closest('[data-open-res]')) showRes();
});
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => dialogControls.get(button.closest('dialog').id).dismiss()));
document.querySelectorAll('dialog').forEach(dialog => {
  if(dialog.id==='login-dialog')return;
  const controls = attachDialogSwipe(dialog, { close: () => dialog.close(), back: () => dialog.id === 'analysis-dialog' ? analysisUI.back() : dialog.id === 'tp-dialog' ? showTPPicker() : dialog.close(), canGoBack: () => dialog.id === 'analysis-dialog' ? analysisUI.canGoBack() : dialog.id === 'tp-dialog' ? Boolean(tpViewKey) : dialog.id === 'record-dialog' && Boolean(recordContext.parent && $('#' + recordContext.parent).open), prepareBack: dialog.id === 'tp-dialog' ? prepareTPReturn : null });
  dialogControls.set(dialog.id, controls);
  dialog.addEventListener('cancel', e => { e.preventDefault(); controls.dismiss(); });
  dialog.addEventListener('click', e => { if (e.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) controls.dismiss(); });
  const top = dialog.querySelector('[data-scroll-top]'), body = dialog.querySelector('.dialog-body');
  if (top) {
    body.addEventListener('scroll', () => { top.hidden = body.scrollTop < 260; }, { passive: true });
    top.addEventListener('click', () => body.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }));
    dialog.addEventListener('close', () => { top.hidden = true; });
  }
});
$('#record-dialog').addEventListener('close', () => { recordVersion++; activeRecord = null; });
$('#tp-dialog').addEventListener('close', () => { clearTimeout(tpFilterTimer); tpVersion++; tpBusy = false; });
$('#record-back').addEventListener('click', () => dialogControls.get('record-dialog').goBack());
$('#record-body').addEventListener('change', e => { if (e.target.id === 'record-variant') openRecord(e.target.value, recordContext); });
$('#tp-open').addEventListener('click', openTPs);
$('#tp-back').addEventListener('click', () => dialogControls.get('tp-dialog').goBack());
$('#tp-filter').addEventListener('input', () => {
  clearTimeout(tpFilterTimer);
  if (!tpViewKey) { tpPickerQuery = $('#tp-filter').value; tpPickerScroll = 0; $('#tp-body').scrollTop = 0; renderTPChoices(); }
  else { tpVersion++; tpFilterTimer = setTimeout(() => selectTP(tpViewKey), 160); }
});
$('#tp-list').addEventListener('click', e => { const b = e.target.closest('[data-tp]'); if (b) selectTP(b.dataset.tp); });
$('#tp-more').addEventListener('click', () => selectTP(tpSelection.key, true));
$('#tp-meters').addEventListener('click', e => { const b = e.target.closest('[data-tp-meter]'); if (!b) return; const meter = tpMeters[Number(b.dataset.tpMeter)]; openRecord(meter.variants[0].id, { parent: 'tp-dialog', variants: meter.variants }); });
$('#read-folders').addEventListener('click', refreshSources);
$('#folder-list').addEventListener('click', e => { const button = e.target.closest('[data-folder]'); if (button) selectFolder(Number(button.dataset.folder)); });
$('#res-list').addEventListener('click', e => { const button = e.target.closest('[data-res]'); if (button) selectRes(Number(button.dataset.res)); });
$('#confirm-mapping').addEventListener('click', () => confirmMapping());
$('#mapping-fields').addEventListener('change', updateMapPreview);
$('#local-file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file || config.sochi) return;
  const signal = loads.start();
  try {
    if (!isRegistryFile(file.name)) throw new Error(`Для поиска выберите файл «${REGISTRY_NAME}».`);
    if (file.size > (config.maxFileMB || 40) * 1048576) throw new Error('Реестр больше 40 МБ.');
    clearResSelection(); selectedFolder = null; resFolders = []; resState = 'idle';
    setBusy(true, 'Открываем файл с устройства…');
    const buffer = await file.arrayBuffer();
    if (!loads.current(signal)) return;
    await loadBuffer(buffer, { name: file.name, folder: 'Файл на устройстве', type: 'local', modified: file.lastModified }, signal);
  } catch (error) { if (loads.current(signal)) { setBusy(false); message('#settings-message', error.message); } }
  finally { e.target.value = ''; }
});
$('#local-monthly').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file || config.sochi) return;
  const signal = loads.start(), op = operation;
  try {
    if (!summary) throw new Error('Сначала откройте реестр и подтвердите его столбцы.');
    if (!isConsumptionFile(file.name)) throw new Error(`Выберите «${CONSUMPTION_NAME}».`);
    if (file.size > (config.maxFileMB || 40) * 1048576) throw new Error('Файл больше 40 МБ.');
    resetMonthly(); analysisUI.reset(); setBusy(true, 'Читаем файл потребления…');
    consumptionFile = { name: file.name }; consumptionState = 'checking'; consumptionInfo = null; renderIndicators();
    const buffer = await file.arrayBuffer();
    if (!loads.current(signal) || op !== operation) return;
    const info = await loadMonthlyBuffer(buffer);
    if (!loads.current(signal) || op !== operation) return;
    consumptionInfo = info; consumptionState = 'ready';
    await readSelectedJournals(signal, usingOfflineCopy);
    if (loads.current(signal) && op === operation) message('#settings-message', 'Потребление готово к анализу.');
  } catch (error) { if (loads.current(signal) && op === operation) { consumptionState = 'error'; consumptionError = error.message; message('#settings-message', error.message); } }
  finally { if (loads.current(signal) && op === operation) { setBusy(false); renderIndicators(); } e.target.value = ''; }
});
$('#search-form').addEventListener('submit', e => { e.preventDefault(); doSearch(); });
$('#search-input').addEventListener('input', () => { $('#clear-query').hidden = !$('#search-input').value; submitted = false; searchVersion++; renderResults(); message('#form-message', ''); });
$('#clear-query').addEventListener('click', () => { $('#search-input').value = ''; $('#search-input').dispatchEvent(new Event('input')); $('#search-input').focus(); });
document.querySelectorAll('[name="field"]').forEach(input => input.addEventListener('change', () => { updateSearchMode(); submitted = false; results = []; searchVersion++; renderResults(); }));
$('#show-more').addEventListener('click', () => doSearch(true));
$('#demo-exit').addEventListener('click', () => clearDataset());
$('#results').addEventListener('click', e => { if (e.target.closest('#start-demo')) startDemo(); const button = e.target.closest('[data-record]'); if (button) openRecord(button.dataset.record); });
$('#search-modal-results').addEventListener('click', e => { const button = e.target.closest('[data-record]'); if (button) openRecord(button.dataset.record, { parent: 'search-results-dialog', variants: [] }); });
$('#example-queries').addEventListener('click', e => { const b = e.target.closest('[data-query]'); if (!b) return; $(`[name="field"][value="${b.dataset.field}"]`).checked = true; updateSearchMode(); $('#search-input').value = b.dataset.query; $('#clear-query').hidden = false; doSearch(); });
$('#record-body').addEventListener('click', async e => { if (!e.target.closest('#copy-record') || !activeRecord) return; try { await navigator.clipboard.writeText(activeRecord.labels.map((label, i) => `${label}: ${activeRecord.values[i] || '—'}`).join('\n')); toast('Данные скопированы'); } catch { toast('Браузер не разрешил копирование. Выделите текст карточки.'); } });

renderResults(); renderIndicators(); renderFolders();
refreshOfflineAvailability();
window.addEventListener('focus', refreshOfflineAvailability);
window.addEventListener('pageshow', refreshOfflineAvailability);
if ('serviceWorker' in navigator) {
  let controlled = Boolean(navigator.serviceWorker.controller), refreshed = false;
  navigator.serviceWorker.addEventListener?.('controllerchange', () => {
    if (!controlled) { controlled = true; return; }
    if (!refreshed) { refreshed = true; location.reload(); }
  });
}
const startupSignal = loads.signal;
await readConfiguration(startupSignal);
await accountUI.start(config.auth);
await analysisUI.refreshSettings();
if (proxy && config.prepared && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js', { updateViaCache:'none' }).catch(() => navigator.serviceWorker.getRegistration()).then(registration => {
    if (registration?.update) registration.update().catch(() => {});
    return registration && navigator.serviceWorker.ready;
  }).then(registration => {
    if (!registration) return;
    shellReady = true; renderIndicators();
  }).catch(() => { /* Online mode remains available. */ });
}
if (loads.current(startupSignal) && sourceState === 'ready' && await readFolders(startupSignal) && loads.current(startupSignal)) {
  const savedFolder = config.sochi ? folders[0] : folders.find(f => f.path === prefs.folder?.path);
  if (savedFolder) await openFolder(savedFolder, { restore: true });
}
window.addEventListener('offline', () => {
  diskState = 'disconnected'; renderIndicators();
});
window.addEventListener('online',()=>{renderIndicators();void userNotes.syncAll();});
window.addEventListener('focus',()=>{if(!busy)void userNotes.syncAll();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void userNotes.syncAll();});
const notificationsTimer=setInterval(()=>{if(document.visibilityState==='visible' && !busy && navigator.onLine)void userNotes.syncAll();},30000);
notificationsTimer?.unref?.();
window.addEventListener('pagehide',event=>{if(!event.persisted)clearInterval(notificationsTimer);});

// Optional browser standard; uses exactly the same UI actions and current working area.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  try {
    Promise.resolve(document.modelContext.registerTool({
      name: 'search_subscribers', title: 'Найти абонента',
      description: 'Search the loaded subscriber registry and show results in the current interface. Requires a loaded registry.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, field: { type: 'string', enum: ['meter', 'account', 'address'] } }, required: ['query', 'field'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input) {
        if (!input || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 200 || !['meter','account','address'].includes(input.field)) throw new Error('Некорректный запрос.');
        if (!summary) throw new Error('Реестр не подключён.');
        $(`[name="field"][value="${input.field}"]`).checked = true; $('#search-input').value = input.query; updateSearchMode();
        const found = await doSearch(); if (!found) throw new Error('Поиск не выполнен.');
        return { total: found.total, records: found.records.map(r => ({ id: r.id, name: r.fields.name, meter: r.fields.meter, account: r.fields.account, address: r.address })) };
      },
    }, { signal: lifecycle.signal })).catch(() => {});
    window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  } catch { /* Browsers without WebMCP use the regular interface. */ }
}
