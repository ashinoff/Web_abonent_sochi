import { unpackRegistry, unpackMonthly } from './public/prepared-data.js';
import { indexMonthly } from './public/monthly.js';
import { createAnalysisService } from './public/analysis-service.js';
import { normalizeEventPack } from './public/journals.js';
import { normalizeSettings } from './public/analysis-settings.js';
import { fault } from './accounts.mjs';

export function createSochiAnalytics({store,source,registry=null}) {
  const cache = new Map();
  const pending = new Map();
  async function build(resPath) {
    const folder = (await store.listFolders(source)).find(item => item.res_path === resPath);
    if (!folder) throw fault('РЭС не найден.',404,'res_not_found');
    const statuses = folder.statuses || {};
    const consumption = statuses.consumption;
    if (!consumption?.path) throw fault('Администратор ещё не загрузил файл ПО для этой РЭС.',404,'no_consumption');
    const roles = ['registry','consumption','instant','events'];
    const versions = await Promise.all(roles.map(async role => statuses[role]?.path
      ? (await store.getMeta(source,statuses[role].path,role))?.revision || null : null));
    const signature = JSON.stringify([resPath,versions]);
    if (cache.get(resPath)?.signature === signature) return cache.get(resPath).service;
    if (pending.has(signature)) return pending.get(signature);
    const task = (async () => {
      const read = async role => {
        if (!statuses[role]?.path) return null;
        const item = await store.getJson(source,statuses[role].path,role);
        return item ? JSON.parse(item.json) : null;
      };
      const monthly = await read('consumption');
      if (!monthly) throw fault('Пакет ПО отсутствует в базе.',404,'no_consumption');
      const registryPack = registry ? null : await read('registry');
      const records = registry ? await registry.analysisRecords(resPath) : registryPack ? unpackRegistry(registryPack).flatMap(sheet => sheet.records) : [];
      const instant = await read('instant');
      const events = await read('events');
      const service = createAnalysisService(indexMonthly(unpackMonthly(monthly)),records,{
        instant:instant || null,events:events ? normalizeEventPack(events) : null,
      });
      cache.delete(resPath);
      cache.set(resPath,{signature,service});
      // Keep the server bounded: older RES are rebuilt from PostgreSQL as needed.
      while (cache.size > 2) cache.delete(cache.keys().next().value);
      return service;
    })().finally(()=>pending.delete(signature));
    pending.set(signature,task);
    return task;
  }
  return {
    invalidate(resPath) { cache.delete(resPath); },
    async query({resPath,action,account,tp,point}) {
      if (!['analysisConsumer','analysisTP','analysisTPs','analysisSummary'].includes(action)) {
        throw fault('Неизвестный запрос анализа.',400,'invalid_analysis');
      }
      const service = await build(resPath);
      if (action === 'analysisSummary') return service.summary;
      if (action === 'analysisTPs') return service.tps();
      const settings = normalizeSettings(await store.getSochiAnalysisSettings(source));
      if (action === 'analysisTP') {
        if (typeof tp !== 'string' || tp.length > 200) throw fault('Укажите контур ТП.');
        return service.contour(tp,settings);
      }
      if (typeof account !== 'string' || account.length > 200) throw fault('Укажите лицевой счёт.');
      if (tp != null && (typeof tp !== 'string' || tp.length > 200)) throw fault('Некорректный контур ТП.');
      if (point != null && (typeof point !== 'object' || Array.isArray(point))) throw fault('Некорректная точка учёта.');
      return service.consumer(account,settings,tp || null,point || null);
    }
  };
}
