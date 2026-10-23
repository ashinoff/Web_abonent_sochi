import { analyze, setTune, setZoneMode, setBoosts, setAlgOff } from './analysis-engine.js';
import { normalizeSettings } from './analysis-settings.js';
import { idKey } from './core.js';
import { createTpBalances } from './tp-balance.js';
import { numeric, tpKey, strictSum, pointKey, accountPointKey, samePoint, selectPointRows } from './monthly.js';
import { createJournalAnalysis } from './journal-analysis.js';
import { flagObservation } from './analysis-observations.js';
import { createJournalPeerContext } from './journal-peer-context.js';

const MONTHLY_RECOMMENDATIONS = {
  S1: 'Сверить начало роста с вводом объекта, заменой ПУ и контрольными снятиями.',
  S2: 'Сверить всплески с контрольными снятиями и корректировками начислений.',
  S3: 'Сверить дату падения с отключениями, нагрузкой, заменой ПУ и журналом событий.',
  'S3б': 'Проверить отключения, корректировки и режим объекта внутри провала и при восстановлении.',
  S4: 'Уточнить фактическое использование объекта и изменение нагрузки.',
  S5: 'Сопоставить нулевые месяцы с отключениями и фактической работой объекта.',
  S6: 'Проверить повторение передаваемых значений по контрольным показаниям.',
  S7: 'Сверить округлённые объёмы с контрольными показаниями и способом начисления.',
  S8: 'Уточнить сопоставимость потребителей и режимов их работы.',
  S9: 'Проверить сезонный режим объекта и электрическое отопление.',
  S10: 'Сверить разрешённую мощность, фактическую нагрузку и схему присоединения.',
  S11: 'Сопоставить расхождения с техническим учётом и журналами событий.',
  S12: 'Проверить документы по разовому объёму: снятие, перерасчёт, доначисление.',
  S13: 'Сверить рост с заменой ПУ, проверкой, вводом оборудования и расширением деятельности.',
  S14: 'Сопоставить снижение с историей работы объекта и изменением его нагрузки.',
};
export const monthlyRecommendation = flag => flag.recommendation || MONTHLY_RECOMMENDATIONS[flag.code] || '';

export function createAnalysisService(model, records = [], journals = {}, incomingPack = null) {
  const tpBalances=createTpBalances(incomingPack);
  const journalAnalysis = createJournalAnalysis(model, records, journals);
  const annotateJournalContext = journalAnalysis ? createJournalPeerContext(model) : null;
  const byAccount = new Map();
  for (const record of records) {
    const key = idKey(record.fields.account); if (!key) continue;
    if (!byAccount.has(key)) byAccount.set(key, []); byAccount.get(key).push(record);
  }
  const registryFor = rows => {
    const keys = new Set(rows.flatMap(r => [r.accountKey, idKey(r.alias)]).filter(k => k && model.aliases.get(k)?.size === 1));
    return [...new Set([...keys].flatMap(k => byAccount.get(k) || []))];
  };
  const meterRows = new WeakMap();
  function meter(rows, key) {
    const account = rows[0].account, knownTPs = [...new Map(rows.filter(r => r.tp).map(r => [tpKey(r.tp), r.tp])).values()];
    const registry = registryFor(rows), points = new Map(rows.filter(pointKey).map(row => [accountPointKey(row), row]));
    // Power only belongs to this volume when every reported point is matched.
    const pointPowers = new Map(); let power = null;
    for (const [key, row] of points) {
      const matches = registry.filter(r => samePoint(row, r.fields));
      // A missing TU label must not map one monthly point to several registry TUs.
      if (new Set(matches.map(r => pointKey(r.fields))).size !== 1) continue;
      const powers = matches.map(r => numeric(r.fields.power));
      if (powers.every(p => p != null && p > 0)) pointPowers.set(key, new Set(powers));
    }
    if (points.size && rows.every(pointKey) && [...points.keys()].every(p => pointPowers.get(p)?.size === 1)) power = [...points.keys()].reduce((s, p) => s + [...pointPowers.get(p)][0], 0);
    const name = rows[0].name || registry[0]?.fields.name || 'Потребитель';
    // JS \b is ASCII-only: explicit Cyrillic boundary below.
    const kind = /^(ооо|ао|пао|оао|зао|ип|тсн|тсж|снт|муп|гуп|фгуп|нко)(?:\s|[«"'])/i.test(name) ? 'ul' : /^(гражданин|гражданка|физическое лицо)(?:\s|$)/i.test(name) ? 'fl' : null;
    const matchedRegistry = registry.filter(r => rows.some(row => samePoint(row, r.fields)));
    const usedMeters = matchedRegistry.map(r => idKey(r.fields.meter)).filter(Boolean);
    const unique = values => [...new Set(values.filter(Boolean))];
    const result = { id: key, account, name, tp: knownTPs.length === 1 ? 'tp:' + tpKey(knownTPs[0]) : 'all:multi', tpNames: knownTPs, values: strictSum(rows, model.months.length), power, ctype: kind, voltage: null, dup: new Set(usedMeters).size < usedMeters.length, pointCount: points.size, rowCount: rows.length, sources: rows.map(r => r.source), incomplete: model.months.filter((_, i) => rows.some(r => r.values[i] == null)).length, negative: rows.some(r => r.values.some(v => v != null && v < 0)),
      serials: unique(matchedRegistry.map(r => r.fields.meter)), address: unique(matchedRegistry.map(r => r.address || r.fields.address)).join('; '),
      points: unique(rows.map(r => [r.pointName, r.pointNumber && '№ ' + r.pointNumber, r.point && 'СТЕК ' + r.point].filter(Boolean).join(' · '))),
      registrySources: unique(matchedRegistry.map(r => [r.file, r.sheet, r.row && 'строка ' + r.row].filter(Boolean).join(' · '))) };
    meterRows.set(result, rows); return result;
  }
  const tpRows = new Map();
  for (const row of model.rows) if (row.tp) {
    const key = tpKey(row.tp); if (!tpRows.has(key)) tpRows.set(key, { name: row.tp, rows: [], accounts: new Map() });
    const group = tpRows.get(key); group.rows.push(row);
    if (!group.accounts.has(row.accountKey)) group.accounts.set(row.accountKey, []); group.accounts.get(row.accountKey).push(row);
  }
  let cache = new Map(), settingsKey = '';
  function run(scope, settings, selectedMeters = null) {
    const config = normalizeSettings(settings), signature = JSON.stringify(config);
    if (signature !== settingsKey) { cache.clear(); settingsKey = signature; }
    if (cache.has(scope)) return cache.get(scope);
    setTune(config.levels, config); setZoneMode(config.zone, config.lossRed, config.lossAmber); setBoosts(config.boosts); setAlgOff(scope.startsWith('contour:') ? config.algOff : { ...config.algOff, zeroAlive: true, peers: true, season: true, imb: true, dzero: true, dsync: true });
    // Loading a report builds indexes only. Aggregate the requested account or
    // contour on demand, instead of materialising every series twice up front.
    const meters = selectedMeters || (scope.startsWith('contour:')
      ? [...tpRows.get(scope.slice(8)).accounts].map(([key, rows]) => meter(rows, `${scope.slice(8)}|${key}`))
      : [meter(model.accounts.get(scope.slice(9)), scope.slice(9))]);
    // Negative adjustments are not evidence of a stopped meter; mark them unknown
    // to the detector, but retain the original values in the chart and totals.
    const engineMeters = meters.map(m => ({ ...m, values: m.values.map(v => v != null && v < 0 ? null : v) }));
    const result = analyze({ meters: engineMeters, months: model.months, supplyRows: [], gran: 'month' }, null);
    const raw = new Map(meters.map(m => [m.id, m]));
    for (const r of result.results) {
      r.meter = raw.get(r.meter.id);
      r.total = r.meter.values.some(v => v != null) ? r.meter.values.reduce((s, v) => s + (v ?? 0), 0) : null;
      if (!r.meter.values.some(v => v != null && v >= 0)) { r.cls = 'unknown'; r.flags = []; r.lossKwh = null; r.score = null; }
      if (journalAnalysis) {
        const rows = meterRows.get(r.meter);
        journalAnalysis.supplement(r, rows);
        for (const item of r.journal?.cases || []) annotateJournalContext(item, rows);
      }
    }
    // A few large contours must not fill a mobile tab with cached histories.
    if (result.results.length <= 1000) {
      while (cache.size >= 8 || [...cache.values()].reduce((n, item) => n + item.results.length, 0) + result.results.length > 1000) cache.delete(cache.keys().next().value);
      cache.set(scope, result);
    }
    return result;
  }
  function resolveAccount(value) {
    const key = idKey(value), choices = model.aliases.get(key);
    if (!choices?.size) throw new Error(`ЛС ${value} не найден в файле потребления. Проверьте номер договора и выбранную РЭС.`);
    if (choices.size > 1) throw new Error('Этот номер СТЕК соответствует нескольким договорам. Уточните основной ЛС в исходной выгрузке.');
    return [...choices][0];
  }
  const metadata = { months: model.months, warnings: model.warnings, rowCount: model.rows.length, accountCount: model.accounts.size, missingTP: model.rows.filter(r => !r.tp).length,
    balanceSource:{status:tpBalances.status,...tpBalances.summary},
    ...(journalAnalysis ? { journalCoverage: journalAnalysis.coverage() } : {}) };
  function* generateReport(settings, compact = false) {
    const rows = [], counts = { accounts: model.accounts.size, selected: 0, red: 0, amber: 0, green: 0, dead: 0, unknown: 0, journalCheck: 0, journalHigh: 0 };
    let consumption = 0, incompleteTotal = false, lossKwh = 0;
    let done = 0;
    for (const [account] of model.accounts) {
      if (done++ % 100 === 0) yield { phase: 'analysis', done: done - 1, total: model.accounts.size };
      const result = run('consumer:' + account, settings).results[0], m = result.meter;
      counts[result.cls]++; if (result.journalPriority === 'check') counts.journalCheck++; if (result.journalPriority === 'high') counts.journalHigh++;
      if (result.total == null || m.incomplete) incompleteTotal = true;
      if (result.total != null) consumption += result.total;
      lossKwh += result.lossKwh || 0;
      if (!['red', 'amber'].includes(result.cls) || !(result.score > 0)) continue;
      if (compact) {
        // The field report needs grouped flags, not chart series, measurements,
        // dated examples or a second copy of every correlation case.
        const flags = result.flags.map(flag => ({ code: flag.code, title: flag.title, source: flag.source, pts: flag.pts, supportingEvidence: flag.supportingEvidence,
          detail: flag.source === 'events' ? '' : flag.source === 'instant' ? String(flag.detail || '').split(' Наблюдений:')[0] : flag.detail,
          serial: flag.serial, count: flag.count, first: flag.first, last: flag.last, month: flag.month, months: flag.source === 'correlation' ? flag.months : undefined,
          conditional: flag.conditional, informational: flag.informational }));
        const journalCoverage = result.journal && Object.fromEntries(['instant', 'events'].map(role => [role, {
          loaded: result.journal.coverage[role].loaded, matchedMeters: result.journal.coverage[role].matchedMeters,
        }]));
        rows.push({ account: m.account, serials: m.serials, journalCoverage, result: { cls: result.cls, score: result.score,
          monthlyScore: result.monthlyScore, journalScore: result.journalScore, journalPriority: result.journalPriority,
          meter: { id: m.id, account: m.account, pointCount: m.pointCount }, flags } });
        continue;
      }
      const substantive = result.flags.filter(flag => flag.source == null || flag.pts > 0 || flag.supportingEvidence === true);
      const reasons = substantive.map(flag => `${flag.title}: ${flagObservation(flag)}`);
      if (result.cls === 'dead') reasons.push('Все известные месячные объёмы не превышают 3 кВт·ч; проверить, действует ли договор и не было ли отключения.');
      if (result.cls === 'unknown') reasons.push('Нет неотрицательных числовых объёмов; для анализа недостаточно данных.');
      if (m.incomplete) reasons.push(`Неполные месяцы: ${m.incomplete}; отсутствующие объёмы не принимались за ноль.`);
      if (m.negative) reasons.push('Присутствуют отрицательные корректировки; они сохранены в сумме и графике и исключены из поиска остановки ПУ.');
      const recommendations = [...new Set(substantive.map(monthlyRecommendation).filter(Boolean))];
      if (result.cls === 'unknown' || m.incomplete) recommendations.push('Проверить исходную выгрузку и восстановить отсутствующие месячные объёмы всех ТУ.');
      if (result.cls === 'dead') recommendations.push('Уточнить статус договора, отключения и фактическую работу объекта; сверить контрольные показания.');
      if (m.negative) recommendations.push('Сверить отрицательные корректировки с документами перерасчёта и проверить исходные месячные объёмы.');
      if (!recommendations.length) recommendations.push('Проверить исходные объёмы, режим работы потребителя, сведения об отключениях, заменах ПУ и акты проверок.');
      rows.push({ result, account: m.account, name: m.name, address: m.address, serials: m.serials, points: m.points, tpNames: m.tpNames, scope: 'ЛС, все ТУ', reasons, recommendations });
    }
    const priority = result => result.cls === 'red' || result.journalPriority === 'high' ? 0
      : result.cls === 'amber' || result.journalPriority === 'check' ? 1
      : result.cls === 'dead' ? 2 : result.cls === 'unknown' ? 3 : 4;
    rows.sort((a, b) => priority(a.result) - priority(b.result)
      || (b.result.journalScore || 0) - (a.result.journalScore || 0)
      || (b.result.monthlyScore ?? b.result.score ?? 0) - (a.result.monthlyScore ?? a.result.score ?? 0)
      || (b.result.lossKwh || 0) - (a.result.lossKwh || 0)
      || String(a.account).localeCompare(String(b.account), 'ru', { numeric: true }));
    counts.selected = rows.length;
    const selected = new Set(rows.map(row => row.result.meter.id));
    const caseDetails = compact ? [] : journalAnalysis?.reportCases?.(selected, new Map(rows.map(row => [row.result.meter.id, row.result]))) || [];
    for (const item of caseDetails) annotateJournalContext(item, model.accounts.get(item.account) || []);
    counts.journalCases = caseDetails.length;
    counts.combinedCases = caseDetails.filter(item => item.scenario === 'combined').length;
    counts.caseMonths = caseDetails.reduce((total, item) => total + (item.months?.length || 1), 0);
    return { ...metadata, months: model.months, rows, counts, settings: normalizeSettings(settings), scope: 'Жёлтые и красные ЛС с баллами; все ТУ — индивидуальные алгоритмы потребления',
      coverage: journalAnalysis?.coverage() || { instant: { loaded: false, totalMeters: 0, matchedMeters: 0, first: null, last: null, warnings: [] }, events: { loaded: false, totalMeters: 0, matchedMeters: 0, first: null, last: null, warnings: [] }, monthlyFirst: model.months.length ? `${model.months[0].y}-${String(model.months[0].m + 1).padStart(2, '0')}` : null, monthlyLast: model.months.length ? `${model.months.at(-1).y}-${String(model.months.at(-1).m + 1).padStart(2, '0')}` : null },
      unmatched: journalAnalysis?.unmatched || { instant: { meters: 0, rows: 0, reasons: [] }, events: { meters: 0, rows: 0, reasons: [] } },
      events: compact ? [] : journalAnalysis?.reportEvents(selected) || [], metrics: compact ? [] : journalAnalysis?.reportMetrics(selected) || [], caseDetails, totals: { consumption: incompleteTotal ? null : consumption, observedConsumption: consumption, lossKwh } };
  }
  function* generateJournalReport(settings) {
    const rows = []; let done = 0;
    const coverage = journalAnalysis?.coverage();
    if (!coverage?.instant.loaded && !coverage?.events.loaded) throw new Error('Для отчёта загрузите журнал 31 или 46 выбранной РЭС.');
    for (const item of journalAnalysis.flaggedMeters()) {
      if (done++ % 50 === 0) yield { phase: 'analysis', done: done - 1, total: coverage.instant.totalMeters + coverage.events.totalMeters };
      let consumption = null;
      if (item.binding) {
        // A different TU on the same account must not supply this PU's flags.
        const result = this.consumer(item.binding.account, settings, null, item.binding.fields).result;
        const flags = result.flags.filter(flag => !flag.source || flag.source === 'correlation' && idKey(flag.serial) === idKey(item.serial) && flag.pts > 0);
        const cases = journalAnalysis.casesForSerial(idKey(item.serial));
        const comparisonSummary = flag => {
          const match = cases.find(item => item.id === flag.caseId); if (!match) return undefined;
          annotateJournalContext(match, model.accounts.get(item.binding.account));
          const magnitude = period => Math.max(-Infinity, ...Object.values(period.comparisons || {}).filter(value => value.available && value.eligible).map(value => value.exactDropPercent ?? value.dropPercent));
          const period = [...match.months].sort((a, b) => magnitude(b) - magnitude(a))[0];
          return { months: match.months.map(item => item.month).filter(Boolean), month: period.month, value: period.value,
            comparisons: Object.fromEntries(Object.entries(period.comparisons).map(([key, value]) => [key, { available: value.available, value: value.value, dropPercent: value.dropPercent, reason: value.reason }])),
            temporalRelation: period.temporalRelation, seasonalAlternative: period.seasonalAlternative,
            preExistingReason: period.preExistingDecline?.reason, commonDecline: period.peerContext?.commonDecline ? period.peerContext.detail : '' };
        };
        consumption = { account: result.meter.account, point: [item.binding.fields.pointName, item.binding.fields.pointNumber && '№ ' + item.binding.fields.pointNumber, item.binding.fields.point && 'СТЕК ' + item.binding.fields.point].filter(Boolean).join(' · '),
          cls: result.cls, score: result.score, incomplete: result.meter.incomplete, negative: result.meter.negative,
          flags: flags.map(flag => {
            const comparison = flag.source === 'correlation' ? comparisonSummary(flag) : undefined;
            return { code: flag.code, title: flag.title, detail: comparison ? '' : flagObservation(flag), source: flag.source,
              ...(comparison ? { comparison } : { month: flag.month, months: flag.months }) };
          }) };
      }
      // The prepared pack already bounds examples; do not retain bindings,
      // source rows, chart series or the raw J-column in the new report.
      const { binding, ...finding } = item;
      rows.push({ ...finding, consumption });
    }
    rows.sort((a, b) => (a.consumption?.cls === 'red' ? 0 : 1) - (b.consumption?.cls === 'red' ? 0 : 1)
      || (b.consumption?.score || 0) - (a.consumption?.score || 0) || a.serial.localeCompare(b.serial, 'ru', { numeric: true }));
    return { rows, coverage, counts: { selected: rows.length }, scope: 'ПУ с флагами журналов 31 или 46; потребление собственной ЛС + ТУ' };
  }
  return {
    summary: metadata,
    tps: () => {
      const listed=[...tpRows].map(([key,g])=>({
        key,name:g.name,accounts:g.accounts.size,
        incoming:tpBalances.hasTP(g.name),
      }));
      // Visible but unmatched intake TPs matter: they cannot be silently
      // treated as balanced, because no consumption contour matches them.
      for(const intake of tpBalances.tpList()){
        const key=tpKey(intake.name);
        if(!tpRows.has(key))listed.push({
          key,name:intake.name,accounts:0,incoming:true,incomingOnly:true,
        });
      }
      return listed.sort((a,b)=>a.name.localeCompare(b.name,'ru',{numeric:true}));
    },
    consumer(account, settings, tp = null, point = null) {
      const key = resolveAccount(account), group = tp ? tpRows.get(tpKey(tp)) : null;
      if (tp && !group?.accounts.has(key)) throw new Error('Этот ЛС отсутствует в выбранном контуре ТП.');
      if (point && !tp) {
        const rows = selectPointRows(model.accounts.get(key), point);
        const id = JSON.stringify([key, pointKey(rows[0])]), result = run('point:' + id, settings, [meter(rows, id)]);
        const label = [rows[0].pointName, rows[0].pointNumber && '№ ' + rows[0].pointNumber, rows[0].point && 'СТЕК ' + rows[0].point].filter(Boolean).join(' · ');
        return { ...metadata, result: result.results[0], scope: 'ЛС + ТУ: ' + label, tp: null, individual: true, selectedPoint: true, groupFallback: result.groupFallback, typeSplit: result.typeSplit };
      }
      const result = run(tp ? 'contour:' + tpKey(tp) : 'consumer:' + key, settings);
      const r = result.results.find(r => r.meter.id === (tp ? `${tpKey(tp)}|${key}` : key));
      return { ...metadata, result: r, scope: tp ? `ЛС в контуре ${group.name}` : 'Все точки ЛС в выбранной РЭС', tp, individual: !tp, groupFallback: result.groupFallback, typeSplit: result.typeSplit };
    },
    contour(tp, settings) {
      const key = tpKey(tp), group = tpRows.get(key);
      if(!group&&!tpBalances.hasTP(tp))
        throw new Error(`ТП ${tp} не найдена ни в файле ПО, ни в файле «Приём» выбранной РЭС.`);
      const results=group
        ?run('contour:'+key,settings).results.filter(r=>r.meter.tp==='tp:'+key):[];
      const values=group?strictSum(group.rows,model.months.length):Array(model.months.length).fill(null);
      const flags=new Map();
      for(const r of results)for(const f of r.flags){
        const old=flags.get(f.code)||{code:f.code,title:f.title,count:0};
        old.count++;flags.set(f.code,old);
      }
      const registryMeters=new Set(records.filter(r=>tpKey(r.fields.tp)===key)
        .map(r=>idKey(r.fields.meter)).filter(Boolean));
      const config=normalizeSettings(settings);
      const balance=tpBalances.compare(tp,model.months,values,{
        threshold:config.balPct,hasConsumption:Boolean(group),
      });
      return {...metadata,tp:group?.name||tp,values,
        total:values.some(v=>v!=null)?values.reduce((s,v)=>s+(v??0),0):null,
        completeMonths:values.filter(v=>v!=null).length,
        rowCount:group?.rows.length||0,
        pointCount:group?new Set(group.rows.map(accountPointKey).filter(Boolean)).size:0,
        meterCount:registryMeters.size,results,flags:[...flags.values()],
        // Preserve the previous incoming field for other clients. The richer
        // balance object is source of truth for the TP analysis screen.
        incoming:{status:balance.status,values:balance.values},
        balance,counts:Object.fromEntries(['red','amber','green','dead','unknown']
          .map(k=>[k,results.filter(r=>r.cls===k).length])),
      };
    },
    report(settings) {
      const iterator = generateReport(settings); let step;
      do { step = iterator.next(); } while (!step.done);
      return step.value;
    },
    async reportAsync(settings, { onProgress = () => {}, assertCurrent = () => {}, compact = false } = {}) {
      const iterator = generateReport(normalizeSettings(settings), compact);
      for (;;) {
        assertCurrent();
        const step = iterator.next();
        if (step.done) return step.value;
        onProgress(step.value);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    },
    async journalReportAsync(settings, { onProgress = () => {}, assertCurrent = () => {} } = {}) {
      const iterator = generateJournalReport.call(this, normalizeSettings(settings));
      for (;;) {
        assertCurrent();
        const step = iterator.next();
        if (step.done) return step.value;
        onProgress(step.value);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    },
  };
}
