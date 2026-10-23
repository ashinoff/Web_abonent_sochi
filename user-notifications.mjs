import { validLocation } from './public/notes-map-data.js';

const fail = (message, status = 400, code = 'invalid_notification') => Object.assign(new Error(message), { status, code });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = new Set(['meter','account','point','pointNumber','pointName','name','tp','locality','street','house','building']);
export function notificationRes(value) {
  if (typeof value !== 'string' || value.length > 1024 || !/^\/[^/]+\/[^/]+$/.test(value) || value.includes('\0') || value.split('/').some(p => p === '.' || p === '..'))
    throw fail('Выберите корректный РЭС.');
  return value;
}
export function notificationGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw fail('Обновите уведомления РЭС перед изменением.');
  return value;
}
export function notificationId(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw fail('Некорректный номер уведомления.');
  return value.toLowerCase();
}
export function validateNotification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['id','fields','address','note','location'].includes(k))) throw fail('Некорректное уведомление.');
  const id = notificationId(value.id);
  if (!value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)) throw fail('Нет данных потребителя.');
  const record = {};
  for (const [key, item] of Object.entries(value.fields)) {
    if (!fields.has(key) || typeof item !== 'string' || item.length > 300) throw fail('Некорректные данные потребителя.');
    if (item.trim()) record[key] = item.trim();
  }
  if (!record.meter && !record.account) throw fail('Для отметки нужен номер ПУ или лицевого счёта.');
  if (typeof value.address !== 'string' || value.address.length > 700) throw fail('Адрес слишком длинный.');
  if (typeof value.note !== 'string' || !value.note.trim() || value.note.length > 2000) throw fail('Напишите комментарий до 2000 символов.');
  if (!validLocation(value.location)) throw fail('Укажите место потребителя на карте.');
  return { id, fields:record, address:value.address.trim(), note:value.note.trim(), type:'user',
    location:{ lat:value.location.lat, lon:value.location.lon, precision:'manual' } };
}

export function createNotificationsHandler({ source, store, sendJson,canClear=()=>true,canAccess=()=>true }) {
  return async (req, res, url) => {
    if (!['GET','POST','DELETE'].includes(req.method)) { sendJson(res,405,{ error:'Метод не поддерживается.' }); return; }
    if (!source || !store?.listUserNotifications) { sendJson(res,503,{ error:'Общие уведомления доступны после подключения базы и источника РЭС.' }); return; }
    try {
      let body;
      if (req.method !== 'GET') {
        if (req.headers['sec-fetch-site'] === 'cross-site' || !String(req.headers['content-type'] || '').startsWith('application/json')) throw fail('Требуется запрос JSON с этого сайта.',415);
        const chunks = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length; if (bytes > 32768) throw fail('Уведомление слишком большое.',413);
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Некорректный JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['resPath','generation','notification','id'].includes(k))) throw fail('Некорректный запрос.');
      }
      const path = notificationRes(req.method === 'GET' ? url.searchParams.get('res') : body.resPath);
      if(!canAccess(req,path))throw fail('РЭС не входит в вашу зону доступа.',403,'res_forbidden');
      await store.assertLoadAllowed?.(source,path);
      // Scope and source are server-controlled; no caller can select another Disk.
      if (!(await store.listFolders(source)).some(folder => folder.res_path === path)) throw fail('Этот РЭС отсутствует в карте базы.',404,'res_not_found');
      let data;
      if (req.method === 'GET') data = await store.listUserNotifications(source,path);
      else {
        const generation = notificationGeneration(body.generation);
        if (req.method === 'POST') data = await store.addUserNotification(source,path,generation,validateNotification(body.notification));
        else if (body.id !== undefined) data = await store.deleteUserNotification(source,path,generation,notificationId(body.id));
        else {if(!canClear(req))throw fail('Требуются права администратора для очистки всех уведомлений.',403,'forbidden');data = await store.clearUserNotifications(source,path,generation);}
      }
      sendJson(res,200,data);
    } catch (error) {
      if (!error.status) throw error;
      sendJson(res,error.status,{ error:error.message, code:error.code });
    }
  };
}
