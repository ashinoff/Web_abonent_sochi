import { formatEnergy } from './energy-format.js';

const html=value=>String(value??'').replace(/[&<>"']/g,ch=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
})[ch]);
const monthNames=['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
const monthLabel=({y,m})=>monthNames[m]+' '+y;
const n=value=>value==null?'—':formatEnergy(value);
const pct=value=>value==null?'—':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(value)+'%';

function statusText(status){
  return {
    high:'Выше порога',negative:'Отрицательный',
    ok:'В пределах',outside:'Нет периода',
    incomplete:'Неполные данные', 'zero-intake':'Нулевой приём',
  }[status]||status;
}
function unavailable(balance){
  const message={
    'not-loaded':'Для баланса загрузите помесячный файл «Приём» выбранного РЭС.',
    legacy:'Файл «Приём» загружен в прежнем формате без месяцев. Загрузите помесячную выгрузку по ПУ и ТП.',
    'no-tp':'ТП не найдена в файле «Приём». Проверьте наименование ТП в обоих источниках.',
    'no-consumption':'ТП найдена в «Приёме», но отсутствует в ПО. Баланс не может быть рассчитан без полезного отпуска.',
    'no-overlap':'Месячные периоды «Приёма» и ПО не пересекаются. Проверьте даты в обеих выгрузках.',
    incomplete:'По этой ТП нет ни одного месяца, где полностью заполнены и «Приём», и ПО.',
    invalid:'Даты в месячных данных «Приёма» некорректны или повторяются.',
  }[balance.status]||balance.message||'Помесячные данные для баланса пока недоступны.';
  return '<section class="tp-balance-panel" data-balance-state="unavailable">'+
    '<div class="tp-balance-heading"><span class="tp-balance-kicker">ТЕХНИЧЕСКИЙ БАЛАНС ТП</span>'+
    '<h3>Приём − полезный отпуск</h3></div>'+
    '<p class="tp-balance-unavailable">'+html(message)+'</p>'+
    '<p class="hint">Нельзя считать отсутствие данных нулевым потреблением или нулевым небалансом.</p></section>';
}

// Renders independently so the same calculation is shown to administrators
// and users without running calculations or fetching raw Excel in the browser.
export function renderTpBalance(balance){
  if(!balance||balance.status!=='ready'){
    return unavailable(balance||{status:'not-loaded'});
  }
  const tone=balance.pct<0?'negative':balance.pct>balance.threshold?'high':'normal';
  const metrics=[
    ['Приём','кВт·ч',balance.totalIntake],
    ['Полезный отпуск','кВт·ч',balance.totalOutgoing],
    ['Небаланс','кВт·ч',balance.imbalance],
    ['Небаланс','%',balance.pct],
  ].map(([label,unit,value])=>'<div><span>'+html(label)+'</span><strong>'+
    (unit==='%'?html(pct(value)):html(n(value)))+'</strong><small>'+html(unit==='%'?'от приёма':unit)+'</small></div>').join('');
  const header='<thead><tr><th scope="col">Месяц</th><th scope="col">Приём, кВт·ч</th>'+
    '<th scope="col">ПО, кВт·ч</th><th scope="col">Небаланс, кВт·ч</th>'+
    '<th scope="col">Небаланс, %</th><th scope="col">Статус</th></tr></thead>';
  const rows=[...balance.months].reverse().map(row=>
    '<tr data-balance-month="'+html(row.status)+'">'+
      '<th scope="row">'+html(monthLabel(row))+'</th>'+
      '<td>'+html(n(row.intake))+'</td><td>'+html(n(row.outgoing))+'</td>'+
      '<td>'+html(n(row.imbalance))+'</td><td>'+html(pct(row.pct))+'</td>'+
      '<td><span class="tp-balance-month-status">'+html(statusText(row.status))+'</span></td>'+
    '</tr>').join('');
  const problems=balance.warnings?.length
    ?'<details class="tp-balance-warnings"><summary>Замечания к данным ('+balance.warnings.length+')</summary>'+
      balance.warnings.map(w=>'<p>'+html(w)+'</p>').join('')+'</details>':'';
  return '<section class="tp-balance-panel" data-balance-state="'+tone+'">'+
    '<div class="tp-balance-heading"><span class="tp-balance-kicker">ТЕХНИЧЕСКИЙ БАЛАНС ТП</span>'+
      '<h3>Приём − полезный отпуск</h3><p>Сопоставлено '+balance.comparedMonths+
      ' из '+balance.totalMonths+' месяцев · вводных ПУ: '+balance.intakeMeterCount+'</p></div>'+
    '<div class="tp-balance-summary">'+metrics+'</div>'+
    '<p class="tp-balance-threshold">Порог положительного небаланса: <strong>'+html(pct(balance.threshold))+'</strong>.'+
      ' Выше порога: '+balance.elevated+' мес.; отрицательный небаланс: '+balance.negative+' мес.'+
      ' Результат по всему периоду рассчитан только по '+balance.comparedMonths+' сопоставимым месяцам.</p>'+
    '<div class="tp-balance-months" data-no-swipe role="region" aria-label="Помесячный баланс ТП" tabindex="0">'+
      '<table class="tp-balance-table">'+header+'<tbody>'+rows+'</tbody></table></div>'+
    problems+
    '<p class="tp-balance-note">Небаланс = приём − полезный отпуск; доля = небаланс / приём × 100%.'+
    ' Месяцы с пропусками не включены в суммы. Это разница источников, а не автоматически подтверждённые технические или коммерческие потери.</p>'+
    '</section>';
}
