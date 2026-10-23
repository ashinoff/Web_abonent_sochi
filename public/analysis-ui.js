import { ALG_META, BOOST_DEFS, buildTune, fmt, ymLabel } from './analysis-engine.js';
import { TUNE_ORDER, TUNE_HINT, LEVEL_NAMES } from './analysis-tuning.js';
import { defaultSettings, normalizeSettings } from './analysis-settings.js';
import { SECTION_HELP, ALGORITHM_HELP } from './analysis-help.js';
import { mountChart, journalCaseTitle, journalCaseMonths, journalCaseDetailHTML } from './analysis-chart.js';
import { INSTANT_METRICS } from './journals.js';
import { instantFindingLines } from './journal-report-data.js';
import { initJournalReportUI } from './journal-report-ui.js';
import { formatEnergy, formatEnergyText, observeReadingEnergy } from './energy-format.js';
import { flagObservation as flagDescription } from './analysis-observations.js';
const $ = s => document.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const zone = { red:'Высокий приоритет', amber:'Наблюдение', green:'Без выраженных признаков', dead:'Нулевой ряд', unknown:'Недостаточно данных' };
const storageKey = 'abonent.analysis.v1';
const recommendations = {
  S1:'Сопоставьте начало роста с вводом объекта, заменой прибора и историей контрольных снятий.',
  S2:'Сверьте всплески с датами контрольных снятий и корректировок. Сравните повторные контрольные показания.',
  S3:'Сверьте дату падения с отключениями, изменением нагрузки, заменой ПУ и журналом событий.',
  'S3б':'Проверьте документы, отключения и корректировки внутри провала и при восстановлении расхода.',
  S4:'Уточните фактическое использование объекта и изменение режима его работы.',
  S5:'Сопоставьте нулевые месяцы с отключениями и фактической работой объекта.',
  S6:'Проверьте повторение передаваемых значений и работу счётного механизма по контрольному снятию.',
  S7:'Сверьте переданные округлённые объёмы с контрольными показаниями и расчётным способом начисления.',
  S8:'Уточните сопоставимость потребителей: назначение объекта, режим работы и сезонность.',
  S9:'Проверьте сезонный режим объекта и наличие электрического отопления.',
  S10:'Сверьте разрешённую мощность, фактическую нагрузку и схему присоединения.',
  S11:'Сопоставьте периоды расхождений с данными технического учёта и журналами событий.',
  S12:'Поднимите документы по разовому объёму: контрольное снятие, перерасчёт или доначисление.',
  S13:'Сверьте устойчивый рост с заменой ПУ, проверкой, вводом оборудования и расширением деятельности.',
  S14:'Сопоставьте многолетнее снижение с историей работы объекта и изменениями его нагрузки.',
  D1:'Проверьте журнал событий ПУ, отключения и присутствие нагрузки в нулевые сутки.',
  D2:'Сверьте даты суточного провала с ремонтами, отключениями и режимом работы объекта.',
  D3:'Сопоставьте суточные профили потребителя и технического учёта.',
};
function flagPoints(flag) {
  if (!flag.source) return `+${esc(flag.pts)}`;
  if (flag.pts > 0) return `+${esc(flag.pts)} доп.`;
  return flag.supportingEvidence || flag.source === 'correlation' && flag.caseId ? 'Учтено' : flag.conditional ? 'Условно' : 'Справочно';
}
function journalFlagNote(flag) {
  return flag.pts > 0 ? 'Признак для проверки' : flag.supportingEvidence || flag.source === 'correlation' && flag.caseId ? 'Подтверждающее наблюдение · баллы учтены в совокупности' : flag.conditional ? 'Условное наблюдение' : 'Справочное наблюдение';
}
const journalDate = value => String(value || '').replace(/^(\d{4})-(\d{2})-(\d{2})T?/, '$3.$2.$1 ').trim();
function journalPriority(result) {
  const priority = { high: 'red', check: 'amber' }[result.journalPriority] || result.journalPriority;
  return priority && ['red', 'amber'].includes(priority) ? `<span class="priority-chip journal-priority" data-zone="${priority}">Журналы: ${priority === 'red' ? 'высокий приоритет' : 'проверить'}${Number.isFinite(result.journalScore) ? ' · ' + result.journalScore + ' баллов' : ''}</span>` : '';
}
function journalCoverage(result) {
  const journal = result.journal; if (!journal?.coverage) return '';
  const rows = [['instant', 'Журнал 31 · параметры'], ['events', 'Журнал 46 · события']].map(([key, title]) => {
    const source = journal.coverage[key];
    if (!source?.loaded) return `<div class="journal-source" data-state="missing"><strong>${title}</strong><p>Не загружен. Признаки этого журнала не проверены.</p></div>`;
    const unmatched = journal.unmatched?.[key];
    const eventCounts = key==='events' && Number.isFinite(source.totalRegistrations) ? `<p>По выбранным ПУ: ${esc(source.matchedGroups ?? 0)} месячных групп · ${esc(source.matchedRegistrations ?? 0)} регистраций. В целом по РЭС: ${esc(source.totalGroups ?? 0)} групп · ${esc(source.totalRegistrations)} регистраций.</p><p>Повторяющиеся записи объединены по ПУ, месяцу и набору категорий. Число регистраций не равно числу независимых вскрытий.</p>` : '';
    return `<div class="journal-source" data-state="${source.matchedMeters ? 'ready' : 'missing'}"><strong>${title}</strong><p>Записи найдены для ${esc(source.matchedMeters ?? 0)} выбранных ПУ. В журнале РЭС: ${esc(source.totalMeters ?? 0)} ПУ${source.first && source.last ? ` · ${esc(journalDate(source.first))} — ${esc(journalDate(source.last))}` : ''}.</p>${eventCounts}${!source.matchedMeters ? '<p>По выбранной точке нет однозначно сопоставленных записей этого журнала.</p>' : ''}${unmatched?.meters ? `<p>В целом по РЭС не сопоставлено: ${esc(unmatched.meters)} ПУ.</p>${(unmatched.reasons || []).map(item => `<p class="journal-source-warning">${esc(item.reason)} · ${esc(item.meters)} ПУ</p>`).join('')}` : ''}${(source.warnings || []).map(warning => `<p class="journal-source-warning">${esc(warning)}</p>`).join('')}</div>`;
  });
  const selectedCounts = Number.isFinite(journal.eventGroupCount) ? ` · 46: ${esc(journal.eventGroupCount)} групп / ${esc(journal.eventRegistrationCount ?? 0)} регистраций` : '';
  const outside = Number.isFinite(journal.outsidePeriodRegistrations) ? journal.outsidePeriodRegistrations ? `<p>За пределами периода потребления в журнале 46: ${esc(journal.outsidePeriodRegistrations)} регистраций. Количество регистраций по месяцам доступно в отчёте по журналам; исходные записи — в журнале 46.</p>` : '' : journal.outsidePeriod ? `<p>Записей журналов вне периода месячного потребления: ${esc(journal.outsidePeriod)}. Сводки доступны в Excel-отчёте.</p>` : '';
  const outsideElectrical = Number.isFinite(journal.outsidePeriodRegistrations) && Number.isFinite(journal.outsidePeriod) ? Math.max(0,journal.outsidePeriod-journal.outsidePeriodRegistrations) : 0;
  return `<details class="analysis-data-notes journal-coverage"><summary>Данные журналов и сопоставление${selectedCounts}</summary>${rows.join('')}${outside}${outsideElectrical ? `<p>Сохранённых отметок измерений журнала 31 вне периода потребления: ${esc(outsideElectrical)}. На график они не переносятся.</p>` : ''}${journal.displayTruncated ? '<p>На график передана часть меток. В отчёте по журналам — сводки событий 46, признаки 31 и основные замечания к потреблению. Подробные исходные записи — в журналах.</p>' : ''}<p>Месячный анализ и журналы имеют отдельные баллы. Оценка отклонения рассчитывается по месячному потреблению.</p><p>События сопоставляются по серийному номеру ПУ и своему календарному месяцу. Дополнительные признаки требуют проверки по журналу, схеме учёта и фактической нагрузке.</p></details>`;
}
function journalMetrics(result) {
  const readings = result.journal?.latestMetrics || []; if (!readings.length) return '';
  const count = result.journal.latestMetricCount ?? readings.length;
  return `<details class="analysis-data-notes journal-metrics"><summary>Последние электрические параметры · ${esc(count)} ПУ</summary>${readings.slice(0, 6).map(reading => {
    const values = Array.isArray(reading.values) ? Object.fromEntries((reading.fields || []).map((key,i) => [key,reading.values[i]])) : reading.values || {};
    const scaleNote = reading.coefficientMode === 'unscaled' ? 'Значения приведены без коэффициентов трансформации. Их мощность напрямую не сравнивается с месячным объёмом.' : 'Учёт коэффициентов трансформации в журнале не установлен. Мощность напрямую не сравнивается с месячным объёмом.';
    return `<section><h4>ПУ ${esc(reading.serial)} · ${reading.at ? esc(journalDate(reading.at)) : 'дата измерения не указана'}</h4><dl>${INSTANT_METRICS.filter(metric => Number.isFinite(values[metric.key])).map(metric => `<div><dt>${esc(metric.title)}</dt><dd>${esc(fmt(values[metric.key], 3))}${metric.unit ? ' ' + esc(metric.unit) : ''}</dd></div>`).join('')}</dl><p>${scaleNote}</p></section>`;
  }).join('')}${count > 6 ? '<p>На экране показаны 6 ПУ. Полные исходные параметры доступны в журнале 31.</p>' : ''}</details>`;
}
function electricalFindings(result) {
  const flags = (result.flags || []).filter(flag => flag.source === 'instant');
  if (!result.journal?.coverage?.instant?.loaded) return '';
  return `<section class="analysis-block electrical-findings"><div class="section-heading"><h3>Журнал 31 · мгновенные значения</h3><span>${flags.length} признаков</span></div><p class="hint">Проверяем напряжения и токи фаз, ток нейтрали, обратную мощность, согласованность P/Q/S и углов U–I. Профильные min/среднее/max рассматриваются за период отчёта.</p>${flags.map(flag => `<details class="electrical-finding"><summary>${esc(flag.title)} <small>ПУ ${esc(flag.serial)}${flag.conditional ? ' · условный признак' : flag.informational ? ' · справочно' : ''}</small></summary>${instantFindingLines(flag).slice(1).map(line => `<p>${esc(line)}</p>`).join('')}</details>`).join('') || (result.journal.coverage.instant.matchedMeters ? '<p class="hint">По сопоставленным измерениям включённые проверки признаков не выявили.</p>' : '<p class="hint">По выбранной ТУ нет однозначно сопоставленных записей журнала 31. Проверки параметров недоступны.</p>')}<p class="hint">В отдельном Excel-отчёте по журналам приведены параметры, комментарии и замечания к потреблению собственной ТУ.</p></section>`;
}
function journalCases(result) {
  const journal = result.journal; if (!Array.isArray(journal?.cases)) return '';
  const cases = journal.cases, count = journal.caseCount ?? cases.length, limit = 8;
  return `<section class="analysis-block journal-cases"><div class="section-heading"><h3>Совокупность признаков</h3><span>${esc(count)}</span></div><p class="hint">Измерения и события объединяются по одному ПУ. Потребление сопоставляется с его ЛС + ТУ. Приоритет помогает выбрать очередность проверки.</p>${cases.slice(0,limit).map(item=>{
    const entries = journalCaseMonths(item), shown = entries.length>4 ? [entries[0],...entries.slice(-3)] : entries;
    return `<article class="journal-case" data-priority="${item.priority==='high' ? 'high' : 'check'}"><div class="case-heading"><h4>${esc(journalCaseTitle(item))}</h4><span class="case-meter">ПУ ${esc(item.serial)}</span></div><span class="priority-chip" data-zone="${item.priority==='high' ? 'red' : 'amber'}">${item.priority==='high' ? 'Высокий приоритет проверки' : 'Проверить'}</span>${item.detail ? `<p class="case-conclusion">${esc(formatEnergyText(item.detail))}</p>` : ''}<details class="case-month-analysis" ${entries.length===1 ? 'open' : ''}><summary>Сравнение потребления и исходные записи${entries.some(entry=>entry.month) ? ` · месяцев: ${entries.length}` : ''}</summary>${shown.map(entry=>`<div class="case-period">${journalCaseDetailHTML(item,entry)}</div>`).join('')}${entries.length>shown.length ? `<p class="case-limit">Показано ${shown.length} из ${entries.length} месяцев: начало и последние месяцы. Выберите месяц на графике для подробного сопоставления. Основные признаки можно выгрузить в отчёте по журналам.</p>` : ''}</details>${item.recommendation ? `<p class="case-recommendation">${esc(item.recommendation)}</p>` : ''}</article>`;
  }).join('') || '<p class="hint">Совокупности по доступным данным не сформированы. Проверьте охват журналов и даты измерений.</p>'}${count>Math.min(limit,cases.length) || journal.casesTruncated ? `<p class="case-limit">Показано ${Math.min(limit,cases.length)} из ${esc(count)} совокупностей. Основные причины — в отчёте по журналам; исходные записи — в журналах 31 и 46.</p>` : ''}</section>`;
}
export function initAnalysisUI({ request, isReady, getIncoming, showConnection, onMapOpen, onAdminOpen, canTune=()=>true, loadSettings=async()=>null, saveSettings=async()=>{} }) {
  let settings; try { settings = normalizeSettings(JSON.parse(localStorage.getItem(storageKey) || '{}')); } catch { settings = normalizeSettings(); }
  let version=0, view=null, stack=[], tpChoices=[], parent=null;
  let syncTimer=null;
  const save = () => {
    if(!canTune())return;
    try{localStorage.setItem(storageKey,JSON.stringify(settings));}catch{}
    clearTimeout(syncTimer);
    if($('#analysis-settings-saved'))$('#analysis-settings-saved').textContent='Сохраняем правила в базе…';
    syncTimer=setTimeout(()=>{
      Promise.resolve(saveSettings(normalizeSettings(settings))).then(()=>{
        if($('#analysis-settings-saved'))$('#analysis-settings-saved').textContent='Настройки сохранены в базе. Новый расчёт использует эти параметры.';
      }).catch(error=>{
        if($('#analysis-settings-saved'))$('#analysis-settings-saved').textContent='Ошибка сохранения в базе: '+error.message;
      });
    },450);
  };
  const journalReportUI = initJournalReportUI({ request, isReady, getSettings: () => normalizeSettings(settings) });
  for (const selector of ['#results', '#search-modal-results', '#record-body']) observeReadingEnergy($(selector));
  const mobileLayout = $('#analysis-body').ownerDocument.defaultView.matchMedia('(max-width: 700px)');
  let chartAnchor = null;
  function placeConsumerChart() {
    if (view?.type !== 'consumer' || !view.data) return;
    const body = $('#analysis-body'), chart = $('#analysis-chart');
    if (!chart) return;
    if (mobileLayout.matches) { if (body.firstElementChild !== chart) body.prepend(chart); }
    else if (chartAnchor?.parentElement === body && chart.nextElementSibling !== chartAnchor) body.insertBefore(chart, chartAnchor);
  }
  mobileLayout.addEventListener('change', placeConsumerChart);
  function settingsTab(name) {
    document.querySelectorAll('[data-settings-tab]').forEach(b => { const active=b.dataset.settingsTab===name; b.setAttribute('aria-selected',active); b.tabIndex=active?0:-1; });
    for(const tab of document.querySelectorAll('[data-settings-tab]'))document.getElementById(tab.getAttribute('aria-controls')).hidden=tab.dataset.settingsTab!==name;
    $('#settings-dialog .dialog-body').scrollTop=0;
    if (name === 'load-map') onMapOpen?.();
    if (name === 'admin') onAdminOpen?.();
  }
  document.querySelectorAll('[data-settings-tab]').forEach(b => {
    b.addEventListener('click', () => settingsTab(b.dataset.settingsTab));
    b.addEventListener('keydown', e => { if (['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) { e.preventDefault(); const tabs=[...document.querySelectorAll('[data-settings-tab]')].filter(tab=>!tab.hidden).map(tab=>tab.dataset.settingsTab), index=tabs.indexOf(b.dataset.settingsTab); const next=e.key==='Home'?tabs[0]:e.key==='End'?tabs.at(-1):tabs[Math.max(0,Math.min(tabs.length-1,index+(e.key==='ArrowRight'?1:-1)))]; settingsTab(next); document.querySelector(`[data-settings-tab="${next}"]`).focus(); } });
  });
  function help(copy, label, kind = '') {
    const paragraphs = Array.isArray(copy) ? copy : [copy];
    return `<details class="analysis-help ${kind}"><summary aria-label="Как работает ${esc(label)}" title="Как работает ${esc(label)}">?</summary><div class="analysis-help-copy">${paragraphs.map(part => `<p>${esc(part)}</p>`).join('')}</div></details>`;
  }
  function analysisSection(id, title, body) {
    return `<section class="setting-section analysis-settings-section analysis-settings-${id}"><h3>${title}</h3>${help(SECTION_HELP[id], title, 'analysis-section-help')}${body}</section>`;
  }
  function renderSettings() {
    const method = `<p class="hint">Из карточки ПУ — история выбранной связки ЛС + ТУ. Групповые признаки основной модели применяются в контуре ТП. Общий спад других ЛС этой ТП дополнительно рассматривается при сопоставлении журналов. Расчётные оценки помогают выбрать объекты для проверки.</p>
      <label class="analysis-setting">Формат потребления<select data-setting="gran"><option value="auto" ${settings.gran==='auto'?'selected':''}>Определять автоматически</option><option value="month" ${settings.gran==='month'?'selected':''}>По месяцам</option><option disabled>По суткам — нужен суточный источник</option></select></label>
      <label class="analysis-setting">Зоны приоритета<select data-setting="zone"><option value="score" ${settings.zone==='score'?'selected':''}>По сумме баллов</option><option value="loss" ${settings.zone==='loss'?'selected':''}>По оценке объёма, кВт·ч</option></select></label>
      <div class="settings-pair">${[['red','Красная зона, баллы',30,70],['amber','Жёлтая зона, баллы',10,40],['lossRed','Красная зона, кВт·ч',1,1e9],['lossAmber','Жёлтая зона, кВт·ч',1,1e9]].map(([key,label,min,max])=>`<label class="analysis-setting">${label}<input type="number" data-setting="${key}" value="${settings[key]}" min="${min}" max="${max}" step="1"></label>`).join('')}</div><p class="hint">Жёлтый порог в баллах минимум на 5 ниже красного. Настройки применяются при следующем открытии анализа.</p>`;
    const signs = `<p class="hint">Мягче — больше срабатываний и выше вес. Строже — меньше срабатываний и ниже вес. Суточные признаки требуют суточной выгрузки; S11 и D3 — технического учёта.</p>
      ${TUNE_ORDER.map(key=>{const p=buildTune(settings.levels)[key], meta=ALG_META[key]; return `<div class="tuning-row ${settings.algOff[key]?'tuning-off':''}" data-tuning-row="${key}"><label class="tuning-switch"><input type="checkbox" data-algorithm="${key}" ${!settings.algOff[key]?'checked':''}><span><small>${meta.code}${['zeroAlive','peers','season','imb','dzero','dsync'].includes(key)?' · контур ТП':''}${key.startsWith('d')?' · сутки':''}</small><strong>${esc(meta.title)}</strong></span></label>${help(ALGORITHM_HELP[key], `${meta.code} ${meta.title}`, 'analysis-row-help')}<label class="tuning-range"><span data-level-label>${LEVEL_NAMES[p.level]}</span><input aria-label="Чувствительность ${esc(meta.title)}" type="range" min="-2" max="2" step="1" value="${p.level}" data-level="${key}" ${settings.algOff[key]?'disabled':''}></label><p class="hint" data-tune-hint>${esc(TUNE_HINT[key](p))} · вес ×${p.ptsF}</p></div>`;}).join('')}`;
    const boosts = `<p class="hint">Добавляется к баллам при выполнении условия. Тип потребителя учитывается, только если его можно определить из наименования.</p>${BOOST_DEFS.map(b=>`<label class="boost-option"><input type="checkbox" data-boost="${b.id}" ${settings.boosts[b.id]?'checked':''}><span>${esc(b.label)}</span><small>+${b.pts}</small></label>`).join('')}`;
    const balance = `<label class="analysis-setting">Допустимая доля потерь, %<input type="number" min="0" max="50" step="0.1" value="${settings.balPct}" data-setting="balPct"></label><p class="hint">Порог сохранён для будущих сценариев. При наличии строк отпуска баланс ТП показывается отдельно; этот порог пока не меняет его расчёт.</p>`;
    $('#analysis-settings').innerHTML = analysisSection('method', 'Методика анализа', method) + analysisSection('signs', 'Признаки и чувствительность', signs) + analysisSection('boosts', 'Дополнительный приоритет', boosts) + analysisSection('balance', 'Будущий баланс ТП', balance) + `<button type="button" class="secondary full-width" id="analysis-reset">Вернуть стандартные настройки</button><p class="hint" id="analysis-settings-saved" role="status">Настройки методики хранятся в общей базе PostgreSQL.</p>`;
    if(!canTune()){
      $('#analysis-settings').querySelectorAll('input,select,button#analysis-reset').forEach(control=>{control.disabled=true;});
      $('#analysis-settings-saved').textContent='Только администратор может изменить правила и пороги расчётов.';
    }
  }
  $('#analysis-settings').addEventListener('input', e => {
    if(!canTune())return;
    const key=e.target.dataset.level; if (!key) return;
    settings.levels[key]=Number(e.target.value); const p=buildTune(settings.levels)[key], row=e.target.closest('.tuning-row');
    row.querySelector('[data-level-label]').textContent=LEVEL_NAMES[p.level]; row.querySelector('[data-tune-hint]').textContent=TUNE_HINT[key](p)+' · вес ×'+p.ptsF; save();
  });
  $('#analysis-settings').addEventListener('change', e => {
    if(!canTune())return;
    const {setting,algorithm,boost}=e.target.dataset;
    if (setting) { settings[setting]=['zone','gran'].includes(setting)?e.target.value:Number(e.target.value); settings=normalizeSettings(settings); document.querySelectorAll('[data-setting]').forEach(el=>el.value=settings[el.dataset.setting]); }
    if (algorithm) { settings.algOff[algorithm]=!e.target.checked; const row=e.target.closest('.tuning-row'); row.classList.toggle('tuning-off',!e.target.checked); row.querySelector('[data-level]').disabled=!e.target.checked; }
    if (boost) settings.boosts[boost]=e.target.checked;
    save(); $('#analysis-settings-saved').textContent='Сохранено. Новый расчёт использует эти настройки.';
  });
  $('#analysis-settings').addEventListener('click',e=>{if(canTune()&&e.target.closest('#analysis-reset')){settings=normalizeSettings(defaultSettings());save();renderSettings();}});
  function notices(data, result=null) {
    const notes=[...data.warnings];
    if (result?.meter.incomplete) notes.push(`Месяцев с неполными данными: ${result.meter.incomplete}. Их сумма и сравнения не рассчитываются.`);
    if (result?.meter.negative) notes.push('Есть отрицательные корректировки. Они показаны на графике, но исключены из поиска признаков.');
    return notes.length?`<details class="analysis-data-notes"><summary>Проверка данных · ${notes.length}</summary>${notes.map(n=>`<p>${esc(n)}</p>`).join('')}</details>`:'';
  }
  function metrics(items) { return `<div class="analysis-metrics">${items.map(([label,value,unit])=>`<div><span>${label}</span><strong>${esc(value)}${unit?`<small>${unit}</small>`:''}</strong></div>`).join('')}</div>`; }
  function consumerHTML(data) {
    const r=data.result, m=r.meter;
    const recs=[...new Set(r.flags.map(f=>f.recommendation || recommendations[f.code]).filter(Boolean))];
    if (r.cls==='dead') recs.push('Уточните статус подключения и фактическую работу объекта. Сверьте отсутствие объёмов с контрольными показаниями.');
    if (r.cls==='unknown') recs.push('Проверьте заполнение всех точек ЛС по месяцам и повторите анализ после корректировки выгрузки.');
    if (!recs.length) recs.push('Продолжайте плановые контрольные снятия и сопоставление истории потребления.');
    if (r.flags.length && r.cls!=='green') recs.push('При выездной проверке сверить схему учёта, пломбы, журнал событий и фактическую нагрузку.');
    return `<div class="analysis-intro"><span class="analysis-kicker">${data.individual?'ИНДИВИДУАЛЬНЫЙ АНАЛИЗ':'АНАЛИЗ В КОНТУРЕ ТП'}</span><h3>${esc(m.name)}</h3><p>ЛС ${esc(m.account)} · точек: ${m.pointCount} · строк: ${m.rowCount}</p><span class="priority-chip" data-zone="${r.cls}">${zone[r.cls]}${r.score!=null?' · '+r.score+' баллов':''}</span>${journalPriority(r)}</div><p class="scope-note">${esc(data.scope)}. ${data.individual?'В основной модели ПО групповые признаки не используются. Общий спад ТП рассматривается отдельно как контекст сопоставления.':'Групповые признаки сравнивают только потребителей выбранного контура.'}</p>${metrics([['Полезный отпуск',formatEnergy(r.total),'кВт·ч'],['Оценка отклонения',formatEnergy(r.lossKwh),'кВт·ч'],['Базовый уровень',formatEnergy(r.baseline),'кВт·ч/мес.'],['Период',String(data.months.length),'месяцев']])}<p class="model-note">Оценка отклонения — ориентир алгоритма для проверки, не фактический небаланс и не объём к доначислению.${r.capClippedKwh?' Применён предел исходной модели по мощности.':''}</p>${notices(data,r)}${electricalFindings(r)}${journalCoverage(r)}${journalMetrics(r)}${journalCases(r)}<section class="analysis-chart-card" id="analysis-chart"></section><section class="analysis-block"><div class="section-heading"><h3>Возникшие флаги</h3><span>${r.flags.length}</span></div>${r.flags.length?r.flags.map(f=>`<article class="flag-card${f.source ? ' journal-flag' : ''}"><div><span class="flag-code">${esc(f.code)}</span><h4>${esc(f.title)}</h4><span class="flag-points">${flagPoints(f)}</span></div><p>${esc(flagDescription(f))}</p>${f.source ? `<small>${esc(journalFlagNote(f))}</small>` : f.weak ? '<small>Слабый признак</small>' : ''}${f.source ? `<small>${f.source === 'instant' ? 'Журнал 31' : f.source === 'events' ? 'Журнал 46' : 'Сопоставление с потреблением'}${f.count != null ? ' · записей: ' + esc(f.count) : ''}</small>` : ''}</article>`).join(''):`<p class="hint">${r.cls==='dead'?'Ряд практически нулевой — выделен в отдельный класс.':r.cls==='unknown'?'Для оценки не хватает данных.':'По включённым правилам выраженных признаков не обнаружено.'}</p>`}${r.boosts?.length?`<p class="hint">Дополнительный приоритет: ${r.boosts.map(b=>`${esc(b.label)} (+${b.pts})`).join(', ')}.</p>`:''}</section><section class="analysis-block recommendations"><h3>Рекомендации</h3><ol>${recs.map(t=>`<li>${esc(t)}</li>`).join('')}</ol></section><details class="analysis-data-notes"><summary>Источник и расчёт</summary><p>Выбранный файл потребления. Все строки ${data.selectedPoint?'одной связки ЛС + ТУ':'ЛС в выбранном контуре'} складываются по месяцам. График, флаги и рекомендации строятся по суммарному ряду; коэффициент ТТ повторно не применяется. Итоговый столбец не входит в ряд. ${m.power!=null?'Сопоставленная мощность точек: '+fmt(m.power)+' кВт.':'Мощность всех точек не сопоставлена; правила по мощности пропущены.'}</p><p>Сравнение с техническим учётом пока недоступно.${data.individual?' Групповые S5, S8, S9, S11 и суточные признаки здесь не применяются.':''}</p><p>${m.sources.slice(0,30).map(esc).join(', ')}${m.sources.length>30?'…':''}</p></details>`;
  }
  function bridge() {
    const incoming=getIncoming();
    return `<section class="incoming-bridge" data-state="${incoming.ready?'ready':'missing'}"><div><i class="status-light"></i><h3>Приём по техническому учёту</h3></div><p>${incoming.ready?'Файл «'+esc(incoming.name)+'» прочитан.':'Ожидается файл «прием.xls» или «прием.xlsx» в папке РЭС.'} Сопоставление вводов и периодов подключим на следующем этапе. Баланс и потери пока не рассчитываются.</p><button type="button" class="secondary" data-connection-settings>Настройки подключения</button></section>`;
  }
  function contourHTML(data) {
    const flagged=data.results.filter(r=>r.flags.length), high=data.counts.red, watch=data.counts.amber;
    return `<div class="analysis-intro"><span class="analysis-kicker">КОНТУР ТРАНСФОРМАТОРНОЙ ПОДСТАНЦИИ</span><h3>${esc(data.tp)}</h3><p>ЛС: ${data.results.length} · точек: ${data.pointCount} · ПУ в реестре: ${data.meterCount}</p></div>${metrics([['Полезный отпуск',formatEnergy(data.total),'кВт·ч'],['Полные месяцы',`${data.completeMonths} / ${data.months.length}`,''],['Высокий приоритет',String(high),'ЛС'],['Наблюдение',String(watch),'ЛС']])}<p class="scope-note">В расчёт включены только строки этой ТП из файла потребления. ЛС с несколькими ПУ считается один раз. ${data.completeMonths<data.months.length?'Сумма показана только за полностью заполненные месяцы.':''}</p>${notices(data)}<section class="analysis-chart-card" id="analysis-chart"></section>${bridge()}<section class="analysis-block"><div class="section-heading"><h3>Флаги контура</h3><span>${data.flags.length}</span></div>${data.flags.length?data.flags.map(f=>`<div class="contour-flag"><span class="flag-code">${esc(f.code)}</span><span>${esc(f.title)}</span><strong>${f.count} ЛС</strong></div>`).join(''):'<p class="hint">По включённым правилам выраженных признаков не обнаружено.</p>'}</section><section class="analysis-block recommendations"><h3>Рекомендации по контуру</h3><ol><li>${high?`Начните проверку с ${high} ЛС высокого приоритета.`:watch?`Сопоставьте документы и показания по ${watch} ЛС в наблюдении.`:'Продолжайте плановый контроль потребителей контура.'}</li>${data.flags.slice(0,4).map(f=>f.recommendation || recommendations[f.code]).filter(Boolean).map(text=>`<li>${esc(text)}</li>`).join('')}<li>Подключите согласованную выгрузку технического учёта для расчёта баланса за те же месяцы.</li></ol></section><section class="analysis-block"><div class="section-heading"><h3>Потребители контура</h3><span>${data.results.length}</span></div><p class="hint">${flagged.length} ЛС с флагами. Нажмите строку для подробного анализа в контуре ТП.</p><label class="sr-only" for="analysis-consumer-filter">ЛС или наименование в контуре</label><input type="search" class="analysis-filter" id="analysis-consumer-filter" placeholder="ЛС или наименование"><div id="analysis-consumer-list"></div><button type="button" id="analysis-more" class="secondary full-width" hidden>Показать ещё</button></section>`;
  }
  function renderView(savedScroll=0) {
    if (!view?.data) return;
    const data=view.data; $('#analysis-title').textContent=view.type==='consumer'?'Анализ потребления':'Анализ контура ТП';
    $('#analysis-subtitle').textContent=`${ymLabel(data.months[0])} — ${ymLabel(data.months.at(-1))}`;
    $('#analysis-body').innerHTML=view.type==='consumer'?consumerHTML(data):contourHTML(data);
    chartAnchor = $('#analysis-chart')?.nextElementSibling;
    placeConsumerChart();
    if (view.type==='consumer') { const r=data.result; mountChart($('#analysis-chart'), { months:data.months,values:r.meter.values,group:data.individual?null:r.groupMedByMonth,baseline:r.baseline,shift:r.shiftIdx,events:r.journal?.events || [],cases:r.journal?.cases || [] }); }
    else {
      mountChart($('#analysis-chart'),{months:data.months,values:data.values,title:'Полезный отпуск контура'});
      let count=50;
      const paint=()=>{const q=$('#analysis-consumer-filter').value.trim().toLocaleLowerCase('ru'),rows=data.results.filter(r=>(r.meter.account+' '+r.meter.name).toLocaleLowerCase('ru').includes(q));$('#analysis-consumer-list').innerHTML=rows.slice(0,count).map(r=>`<button type="button" class="analysis-consumer" data-analysis-account="${esc(r.meter.account)}"><span><strong>ЛС ${esc(r.meter.account)}</strong><small>${esc(r.meter.name)}</small></span><span><b class="priority-chip" data-zone="${r.cls}">${r.score==null?'—':r.score}</b><small>${r.flags.length} флагов</small></span></button>`).join('')||'<p class="hint">Совпадений нет.</p>';$('#analysis-more').hidden=count>=rows.length;};
      $('#analysis-consumer-filter').addEventListener('input',()=>{count=50;paint();});$('#analysis-more').addEventListener('click',()=>{count+=50;paint();});paint();
    }
    $('#analysis-body').scrollTop=savedScroll;
  }
  async function open(type, target, tp=null, nested=false, point=null) {
    if (!isReady()) { showConnection(); return; }
    if (nested && view) stack.push({...view,scroll:$('#analysis-body').scrollTop}); else stack=[];
    const n=++version; view={type,target,tp,point,data:null};
    parent=type==='consumer'&&!nested&&$('#record-dialog').open?'record-dialog':$('#analysis-picker-dialog').open?'analysis-picker-dialog':$('#tp-dialog').open?'tp-dialog':parent;
    $('#analysis-back').hidden=!(nested||parent&&$('#'+parent).open);
    $('#analysis-title').textContent=type==='consumer'?'Анализ потребления':'Анализ контура ТП';$('#analysis-subtitle').textContent='';
    $('#analysis-body').innerHTML='<div class="analysis-loading" role="status"><span class="loading-indicator"></span><h3>Анализируем потребление…</h3><p>Проверяем динамику и выбранные признаки</p></div>';
    if (!$('#analysis-dialog').open) $('#analysis-dialog').showModal();
    try {
      const data=await request(type==='consumer'?'analysisConsumer':'analysisTP',{account:target,tp:type==='tp'?target:tp,point,settings});
      if (n!==version||!$('#analysis-dialog').open) return; view.data=data; renderView();
    } catch(error) { if(n===version) $('#analysis-body').innerHTML=`<div class="analysis-empty"><h3>Анализ пока недоступен</h3><p>${esc(error.message)}</p><button type="button" class="secondary" data-connection-settings>Настройки подключения</button></div>`; }
  }
  async function openTPs() {
    if (!isReady()) { showConnection(); return; }
    const n=++version; tpChoices=[]; $('#analysis-tp-filter').value='';$('#analysis-tp-list').innerHTML='<div class="loading-row">Читаем контуры ТП…</div>';
    $('#analysis-picker-dialog').showModal();
    try { const found=await request('analysisTPs'); if(n!==version)return;tpChoices=found;paintTPs(); }
    catch(error){if(n===version)$('#analysis-tp-list').textContent=error.message;}
  }
  function paintTPs(){const q=$('#analysis-tp-filter').value.toLocaleLowerCase('ru').trim();$('#analysis-tp-list').innerHTML=tpChoices.filter(t=>t.name.toLocaleLowerCase('ru').includes(q)).map(t=>`<button class="choice-item" type="button" data-analysis-tp="${esc(t.name)}"><span>${esc(t.name)}</span><span class="tp-count">${t.accounts} ЛС</span></button>`).join('')||'<p class="hint">ТП не найдены в файле потребления.</p>';}
  $('#analysis-tp-filter').addEventListener('input',paintTPs);
  $('#analysis-tp-list').addEventListener('click',e=>{const b=e.target.closest('[data-analysis-tp]');if(b)open('tp',b.dataset.analysisTp);});
  $('#analysis-body').addEventListener('click',e=>{const b=e.target.closest('[data-analysis-account]');if(b)open('consumer',b.dataset.analysisAccount,view.data.tp,true);if(e.target.closest('[data-connection-settings]'))showConnection();});
  $('#analysis-dialog').addEventListener('close',()=>{version++;view=null;stack=[];parent=null;$('#analysis-body').replaceChildren();});
  $('#analysis-picker-dialog').addEventListener('close',()=>{if(!$('#analysis-dialog').open)version++;});
  renderSettings();
  return { settingsTab,
    async refreshSettings(){
      try {
        const loaded=await loadSettings();
        if(loaded){
          settings=normalizeSettings(loaded);
          try{localStorage.setItem(storageKey,JSON.stringify(settings));}catch{}
        }
        renderSettings();
      }catch(error){
        renderSettings();
        if($('#analysis-settings-saved'))$('#analysis-settings-saved').textContent='Используются сохранённые параметры. '+error.message;
      }
    },
    openConsumer:(account,point)=>open('consumer',account,null,false,point), openTP:tp=>open('tp',tp), openTPs,
    getSettings:()=>normalizeSettings(settings),
    canGoBack:()=>stack.length>0||Boolean(parent&&$('#'+parent).open),
    back(){if(stack.length){view=stack.pop();renderView(view.scroll);}else $('#analysis-dialog').close();},
    reset(){journalReportUI.reset();version++;view=null;stack=[];parent=null;tpChoices=[];$('#analysis-dialog').close();$('#analysis-picker-dialog').close();$('#analysis-body').replaceChildren();$('#analysis-tp-list').replaceChildren();},
  };
}
