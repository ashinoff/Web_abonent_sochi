export const SOCHI_SOURCE = 'sochi:local:v1';
export const SOCHI_ENTERPRISE = 'Сочинское предприятие электрических сетей';
export const SOCHI_ENTERPRISE_PATH = '/' + SOCHI_ENTERPRISE;
export const SOCHI_RES_NAMES = Object.freeze([
  'Адлерский РЭС',
  'Краснополянский РЭС',
  'Хостинский РЭС',
  'Сочинский РЭС',
  'Дагомысский РЭС',
  'Лазаревский РЭС',
  'Туапсинский РЭС',
]);
export const SOCHI_RES_PATHS = Object.freeze(SOCHI_RES_NAMES.map(name => SOCHI_ENTERPRISE_PATH + '/' + name));
export const SOCHI_ROLES = Object.freeze({
  registry: 'Расширенный список',
  consumption: 'ПО',
  incoming: 'Приём',
  instant: '31. Мгновенные значения',
  events: '46. События по точкам учёта',
});
export function sochiScope(path) {
  return typeof path === 'string' ? SOCHI_RES_PATHS.find(res => path === res || path.startsWith(res + '/')) || null : null;
}
export function canAccessRes(account, path) {
  const scope = sochiScope(path);
  return Boolean(scope && (['admin','superadmin'].includes(account?.role) || account?.res_paths?.includes(scope) || account?.resPaths?.includes(scope)));
}
export function accessibleResPaths(account) {
  return SOCHI_RES_PATHS.filter(path => canAccessRes(account,path));
}
export function canonicalSochiPath(resPath, role, extension = '.xlsx') {
  if (!SOCHI_RES_PATHS.includes(resPath) || !Object.hasOwn(SOCHI_ROLES,role) || !['.xls','.xlsx'].includes(extension)) {
    throw new Error('Некорректный РЭС или тип Excel.');
  }
  return resPath + '/' + SOCHI_ROLES[role] + extension;
}
