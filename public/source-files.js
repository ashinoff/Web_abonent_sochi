import { isExcelFile } from './source.js';

const roles = { registry: 'Реестр', consumption: 'Потребление', incoming: 'Приём', instant: 'Журнал 31 · Мгновенные значения', events: 'Журнал 46 · События' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('ru-RU') : '';
const size = value => Number.isFinite(value) ? (value < 1048576 ? Math.max(1, Math.round(value / 1024)) + ' КБ' : (value / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' МБ') : '';
const fileMeta = file => [size(file?.size), file?.modified && date(file.modified) ? 'Файл от ' + date(file.modified) : ''].filter(Boolean).join(' · ');

export function initSourceFiles(root, { onRead, onRefresh, readOnly = () => false }) {
  root.innerHTML = `<div class="source-files-heading"><h3>Просмотр файлов</h3><button type="button" class="icon-button" id="refresh-files" aria-label="Обновить файлы РЭС"><svg aria-hidden="true"><use href="#i-refresh"/></svg></button></div><p class="hint" id="files-location"></p><p class="hint" id="files-list-status" role="status"></p><div class="source-file-cards">${Object.entries(roles).map(([role, title]) => `<article class="source-file" data-source-card="${role}"><div class="source-file-heading"><h4>${title}</h4><button type="button" class="secondary choose-source" data-choose-source="${role}" aria-expanded="false" aria-controls="manual-${role}" aria-label="${title}: выбрать файл вручную">Выбрать вручную</button></div><strong class="source-file-name"></strong><p class="source-file-meta"></p><p class="source-file-status" role="status"></p><div class="manual-source" id="manual-${role}" hidden><label for="file-${role}">Excel из папки РЭС</label><select id="file-${role}" data-file-role="${role}"></select><div class="manual-source-actions"><button type="button" class="secondary" data-load-source="${role}">Прочитать</button><button type="button" class="text-button" data-auto-source="${role}">Выбирать автоматически</button></div></div></article>`).join('')}</div><details class="folder-contents"><summary>Содержимое папки <span id="folder-items-count">0</span></summary><ul id="folder-items"></ul></details>`;
  let scope = null;
  let locked = false;
  root.addEventListener('click', e => {
    const choose = e.target.closest('[data-choose-source]');
    if (choose && !readOnly()) {
      const panel = root.querySelector('#manual-' + choose.dataset.chooseSource);
      panel.hidden = !panel.hidden; choose.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) panel.querySelector('select').focus({ preventScroll: true });
    }
    const read = e.target.closest('[data-load-source]'), automatic = e.target.closest('[data-auto-source]');
    if (read && !readOnly()) onRead(read.dataset.loadSource, root.querySelector('#file-' + read.dataset.loadSource).value);
    if (automatic && !readOnly()) onRead(automatic.dataset.autoSource, null);
    if (e.target.closest('#refresh-files')) onRefresh();
  });
  root.addEventListener('change', e => {
    if (e.target.matches('[data-file-role]')) root.querySelector(`[data-load-source="${e.target.dataset.fileRole}"]`).disabled = locked || !e.target.value;
  });
  return {
    render({ res, items, listState, listError, busy, sources }) {
      locked = busy || listState === 'loading';
      root.dataset.readonly = String(readOnly());
      const changed = scope !== res?.path; scope = res?.path;
      root.querySelector('#files-location').textContent = res ? 'Папка: ' + res.name : 'Сначала выберите предприятие и РЭС.';
      root.querySelector('#refresh-files').disabled = locked || !res;
      const listing = root.querySelector('#files-list-status');
      listing.textContent = listState === 'loading' ? 'Читаем содержимое папки…' : listState === 'error' ? listError + ' Нажмите обновление, чтобы повторить.' : '';
      listing.hidden = !listing.textContent;
      root.setAttribute('aria-busy', String(listState === 'loading'));
      const books = items.filter(f => f.type === 'file' && isExcelFile(f.name));
      const options = `<option value="">${books.length ? 'Выберите файл' : 'Нет доступных XLS / XLSX'}</option>` + books.map(f => `<option value="${esc(f.path)}">${esc(f.name)}</option>`).join('');
      for (const role of Object.keys(roles)) {
        const source = sources[role] || { state: 'idle', expected: roles[role], message: 'Дополнительный журнал ещё не загружен.' }, card = root.querySelector(`[data-source-card="${role}"]`);
        card.dataset.state = source.state;
        card.querySelector('.source-file-name').textContent = source.file?.name || source.saved?.name || source.expected;
        card.querySelector('.source-file-meta').textContent = [source.meta, fileMeta(source.file), source.saved ? 'Выбран вручную' : 'Автоматический выбор'].filter(Boolean).join(' · ');
        const optional = ['instant', 'events'].includes(role), failed = source.state === 'error' || !optional && source.state === 'missing';
        const retryHint = readOnly() ? 'Администратор обновляет файлы в базе.' : source.state === 'error' && source.file ? 'Повторите чтение файла из папки РЭС.' : 'Выберите файл вручную или повторите чтение.';
        card.querySelector('.source-file-status').textContent = [source.saved && !source.file && source.state === 'missing' ? 'Выбранный файл больше не найден в папке.' : source.message, failed && res ? retryHint : ''].filter(Boolean).join(' ');
        const select = card.querySelector('select'), choose = card.querySelector('[data-choose-source]'), panel = card.querySelector('.manual-source');
        const value = changed ? source.file?.path || '' : select.value || source.file?.path || '';
        if (select.dataset.options !== options) { select.innerHTML = options; select.dataset.options = options; }
        select.value = value; select.disabled = locked || !books.length;
        choose.disabled = readOnly() || locked || !res || listState !== 'ready'; choose.hidden = readOnly();
        card.querySelector('[data-load-source]').disabled = readOnly() || locked || !select.value;
        const auto = card.querySelector('[data-auto-source]'); auto.hidden = !source.saved; auto.disabled = locked || !res || listState !== 'ready';
        if (changed || readOnly()) { panel.hidden = true; choose.setAttribute('aria-expanded', 'false'); }
        if (!readOnly() && failed && res && listState === 'ready') { panel.hidden = false; choose.setAttribute('aria-expanded', 'true'); }
      }
      root.querySelector('#folder-items-count').textContent = String(items.length);
      root.querySelector('#folder-items').innerHTML = items.length ? items.map(f => `<li><strong>${esc(f.name)}</strong><span>${f.type === 'dir' ? 'Подпапка' : esc(fileMeta(f)) || 'Файл'}${f.type === 'file' && !isExcelFile(f.name) ? ' · не используется' : ''}</span></li>`).join('') : `<li>${res ? listState === 'ready' ? 'Папка пуста' : 'Список файлов ещё не получен' : 'РЭС не выбрана'}</li>`;
    }
  };
}
