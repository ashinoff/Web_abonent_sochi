import * as XLSX from '@e965/xlsx';
import { SOCHI_ROLES } from './public/sochi-config.js';

// These headers are intentionally kept in step with core.js, monthly.js and
// journals.js. Integration tests parse every exported template with the same
// workbook readers that handle administrator uploads.
const currentYear = () => new Date().getUTCFullYear();

const templates = {
  registry: year => ({
    name: 'Расширенный список',
    headers: ['Номер счетчика', 'ЛС', 'Наименование договора', 'Адрес', 'ТП', 'ТУ', 'Номер ТУ', 'Номер ТУСТЕК',
      'Коэф ТТ', 'Показания с квитанции', 'Примечание'],
    example: ['000012345678', '00000001001', 'Пример абонента (удалить строку)', 'г. Сочи, ул. Примерная, 1',
      'ТП-100', 'Точка учёта № 1', '01', '0001001', '1', '12345', 'Пример, замените строку своими данными'],
    text: [0,1,6,7],
  }),
  consumption: year => ({
    name: 'ПО',
    headers: ['ЛС/Номер договора', 'Номер ТУ СТЕК', 'Номер ТУ', 'ТУ', 'ТП',
      'Январь ' + year, 'Февраль ' + year, 'Март ' + year, 'Всего по периоду'],
    example: ['00000001001', '0001001', '01', 'Точка учёта № 1', 'ТП-100', 1200, 980, 1050, 3230],
    text: [0,1,2],
  }),
  incoming: year => ({
    name: 'Приём',
    headers: ['ТП', 'Номер счетчика', 'Дата приёма', 'Начальные показания', 'Конечные показания', 'Объём, кВт·ч', 'Примечание'],
    example: ['ТП-100', '000012345678', year + '-10-23', 12000, 13200, 1200, 'Пример, замените строку'],
    text: [1],
  }),
  instant: year => ({
    name: '31. Мгновенные значения',
    headers: ['Серийный', 'Время',
      'Активная мощность, сумма фаз, кВт', 'Активная мощность, фаза 1, кВт',
      'Активная мощность, фаза 2, кВт', 'Активная мощность, фаза 3, кВт',
      'Реактивная мощность, сумма фаз, кВАр',
      'Напряжение на фазе 1, В', 'Напряжение на фазе 2, В', 'Напряжение на фазе 3, В',
      'Ток в фазе 1, А', 'Ток в фазе 2, А', 'Ток в фазе 3, А',
      'Ток в нулевом проводе, А',
      'Коэффициент мощности по фазе 1', 'Коэффициент мощности по фазе 2',
      'Коэффициент мощности по фазе 3', 'Частота, Гц'],
    example: ['000012345678', year + '-10-23 12:00:00',
      5.4, 1.8, 1.7, 1.9, 0.9, 230, 229, 231, 8.2, 7.9, 8.5, 0.7, 0.96, 0.95, 0.97, 50],
    text: [0,1],
  }),
  events: year => ({
    // The streaming reader for journal 46 accepts exactly 3 columns in the
    // compact format. Extra columns would make the template impossible to import.
    name: '46. События по точкам учёта',
    headers: ['Серийный', 'Дата и время', 'Дополнительная информация'],
    example: ['000012345678', year + '-10-23 12:00:00', 'Вскрытый элемент устройства "Клеммная крышка"'],
    text: [0,1],
  }),
};

export function buildSochiTemplate(role, year = currentYear()) {
  if (!Object.hasOwn(SOCHI_ROLES, role) || !Object.hasOwn(templates, role))
    throw new Error('Неизвестный тип шаблона Excel.');
  if (!Number.isInteger(year) || year < 2020 || year > 2100)
    throw new Error('Некорректный год шаблона.');
  const { name, headers, example, text } = templates[role](year);
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers, example]);
  // Keep meter numbers and account IDs as text, including leading zeros.
  for (const index of text) {
    const cell = sheet[XLSX.utils.encode_cell({r:1,c:index})];
    if (cell) { cell.t = 's'; cell.v = String(cell.v); cell.z = '@'; }
  }
  sheet['!cols'] = headers.map((header, col) => ({
    wch: Math.max(16, Math.min(46, header.length + (col < 2 ? 8 : 2))),
  }));
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:0,c:0},e:{r:1,c:headers.length-1}}) };
  XLSX.utils.book_append_sheet(book, sheet, name.slice(0, 31));
  const bytes = XLSX.write(book, { type:'buffer', bookType:'xlsx', compression:true });
  return {
    filename: 'Шаблон_' + name.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/\s+/g, '_') + '.xlsx',
    buffer: Buffer.from(bytes),
  };
}
