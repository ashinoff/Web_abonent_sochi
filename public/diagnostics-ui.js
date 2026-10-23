const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const databaseProblems = {
  not_configured: ['Параметры PostgreSQL не заданы', 'В переменных приложения Amvera задайте все пять DB_HOST, DB_PORT, DB_NAME, DB_USER и DB_PASSWORD. Затем перезапустите приложение.'],
  incomplete_config: ['Заданы не все параметры PostgreSQL', 'Проверьте наличие всех пяти DB_* в переменных именно приложения, а не только в настройках базы. Значения и пароль здесь не показываются.'],
  invalid_port: ['Некорректный порт базы', 'Проверьте DB_PORT: требуется число от 1 до 65535. Для внутреннего PostgreSQL обычно используют порт, указанный в его настройках.'],
  authentication: ['База отклонила вход', 'Сверьте DB_USER и DB_PASSWORD с пользователем базы. После изменения секрета перезапустите приложение.'],
  database_missing: ['Указанная база не найдена', 'Сверьте DB_NAME с именем созданной базы PostgreSQL.'],
  permission: ['Не хватает прав на таблицы', 'Проверьте права DB_USER на создание таблиц и запись в выбранную базу.'],
  host: ['Адрес базы не найден', 'Проверьте DB_HOST: нужен внутренний адрес базы Amvera в том же регионе, без https:// и без номера порта.'],
  network: ['Нет соединения с PostgreSQL', 'Проверьте, что база запущена, приложение и база размещены в совместимой внутренней сети, а DB_HOST и DB_PORT указаны верно.'],
  connection_limit: ['Исчерпан лимит соединений', 'Проверьте состояние базы и количество подключений. Приложение использует небольшой пул до двух соединений на экземпляр.'],
  unavailable: ['База не ответила', 'Откройте журнал приложения Amvera и найдите строку «DB error: ...». Проверьте статус PostgreSQL и переменные DB_*; пароль никому не отправляйте.'],
};
const sourceProblems = {
  not_configured: ['Ссылка на общую папку не задана', 'Добавьте YANDEX_PUBLIC_URL в переменные приложения Amvera: публичную ссылку на корневую папку вида https://disk.yandex.ru/d/ключ. База хранит подготовленные данные, но серверу всё ещё нужна эта ссылка для обновления. Перезапустите приложение.'],
  invalid_url: ['Неверный формат ссылки на общую папку', 'Проверьте YANDEX_PUBLIC_URL: нужна публичная ссылка на корневую папку Яндекс Диска, без пути к файлу и без лишних параметров. Перезапустите приложение.'],
};
const syncProblems = {
  not_found: 'Публичная папка больше не найдена. Проверьте ссылку YANDEX_PUBLIC_URL и доступность папки.',
  access_denied: 'Яндекс Диск отказал в доступе. Проверьте, что ссылка публичная и скачивание разрешено.',
  rate_limited: 'Яндекс Диск ограничил запросы. Дождитесь следующей проверки или повторите позже.',
  unavailable: 'Сервер не смог прочитать Яндекс Диск. Проверьте доступность публичной папки и журнал «Обновление данных» в Amvera.',
};
function card(title, state, description, remedy) {
  return `<section class="diagnostic-card" data-state="${esc(state)}"><div class="diagnostic-card-title"><i aria-hidden="true"></i><h3>${esc(title)}</h3></div><p>${esc(description)}</p>${remedy ? `<div class="diagnostic-advice"><strong>Что сделать</strong><p>${esc(remedy)}</p></div>` : ''}</section>`;
}
function registryCards(context) {
  const items = [];
  if (context.offline) items.push(card('Нет сети на устройстве', 'waiting', 'Сейчас серверная проверка с телефона недоступна.', 'Подключитесь к сети либо используйте уже сохранённый на устройстве реестр.'));
  if (!context.selectedRes) items.push(card('РЭС не выбрана', 'waiting', 'Для реестра сначала нужно выбрать предприятие и РЭС.', 'Откройте выбор сети на главном экране.'));
  else if (context.filesState === 'error') items.push(card(`Файлы ${context.selectedRes}`, 'error', context.filesError || 'Не удалось получить список файлов РЭС.', 'После восстановления источника и базы нажмите «Проверить подключение и обновить» в настройках.'));
  else if (context.registryState === 'missing' || context.filesState === 'ready' && !context.selectedFile) items.push(card(`Реестр ${context.selectedRes} не найден`, 'error', 'В выбранной РЭС не обнаружен «Расширенный список.xls» или «Расширенный список.xlsx».', 'Проверьте имя файла в РЭС. Если файл называется иначе, выберите его вручную в настройках.'));
  else if (context.pending) items.push(card('Нужно подтвердить столбцы', 'waiting', 'Файл прочитан, но автоматическое распознавание шапки требует проверки.', 'Откройте настройки и подтвердите соответствие столбцов.'));
  else if (context.registryState === 'error') items.push(card(`Реестр ${context.selectedRes} не загрузился`, 'error', context.registryError || 'Ошибка чтения файла.', 'Проверьте файл и его формат в настройках. При нестабильной сети можно открыть Excel с устройства.'));
  return items;
}
export function diagnosticsHTML(data, context, kind) {
  const items = [];
  const source = data.source || {}, db = data.database || {}, catalog = data.catalog || {}, sync = data.sync || {};
  if (source.state === 'configured') items.push(data.sochi
    ? card('Загрузка Excel администратором', 'ok', 'В Сочи файлы загружаются с компьютера и сохраняются в PostgreSQL. Яндекс Диск не используется.', '')
    : card('Источник обновления', 'ok', 'Ссылка на общую папку задана на сервере. Это подтверждает настройку ссылки, но не результат последней проверки.', ''));
  else {
    const [title, remedy] = sourceProblems[source.issue] || sourceProblems.not_configured;
    items.push(card(title, 'error', 'Сервер не может получить дерево предприятий и РЭС; запрос /api/resources в этом случае возвращает 503.', remedy));
  }
  if (db.state === 'connected') items.push(card('PostgreSQL подключён', 'ok', 'Сервер смог подключиться к базе и проверить её таблицы.', ''));
  else {
    const [title, remedy] = databaseProblems[db.issue] || databaseProblems.unavailable;
    items.push(card(title, 'error', 'Серверная база сейчас недоступна. Подготовленные пакеты из неё не выдаются.', remedy));
  }
  if (db.state === 'connected' && source.state === 'configured') {
    if (catalog.state === 'ready') items.push(card('Карта базы заполнена', 'ok', `Проверено РЭС: ${catalog.resCount || 0}; предприятий: ${catalog.enterpriseCount || 0}.`, ''));
    else items.push(card('Карта базы пока пуста', 'waiting', 'Подключение к PostgreSQL есть, но сервер ещё не сохранил ни одной РЭС.', data.sochi
      ? 'Проверьте, что новая база Сочи создана и администратор загрузил исходные Excel.'
      : sync.state === 'error' ? (syncProblems[sync.issue] || syncProblems.unavailable) : 'Дождитесь первой фоновой проверки папок после запуска приложения. Если она долго не завершается, проверьте журнал «Обновление данных» в Amvera.'));
  }
  if (sync.state === 'running') items.push(card('Обновление выполняется', 'waiting', 'Сервер проверяет файлы и готовит данные. Большая книга Excel может обрабатываться несколько минут.', 'Нажмите «Проверить снова» чуть позже.'));
  if (sync.state === 'error' && catalog.state !== 'empty') items.push(card('Обновление не завершилось', 'error', syncProblems[sync.issue] || syncProblems.unavailable, 'Последняя сохранённая версия остаётся в базе, если она была подготовлена ранее.'));
  if (kind === 'registry') items.push(...registryCards(context));
  return `<p class="diagnostic-intro">${kind === 'base' ? 'Проверка базы и источника данных' : 'Проверка базы, источника и выбранного реестра'}. Состояние обновлено при открытии окна.</p>${items.join('')}<p class="diagnostic-footnote">В этом окне нет паролей, адреса базы и содержимого реестров. Точная серверная ошибка подключения записана в журнале Amvera.</p>`;
}
export function initDiagnosticsUI({ openDialog, showSettings, context }) {
  const body = $('#diagnostics-body'), title = $('#diagnostics-title'), refresh = $('#diagnostics-refresh');
  let kind = 'base', requestId = 0;
  async function check() {
    const id = ++requestId;
    refresh.disabled = true;
    body.innerHTML = '<div class="loading-row" role="status">Проверяем сервер и базу…</div>';
    if (!context().serverMode) {
      body.innerHTML = `<p class="diagnostic-intro">Сайт открыт в режиме без сервера. Файлы читаются в браузере.</p>${registryCards(context()).join('')}`;
      refresh.disabled = false;
      return;
    }
    try {
      const response = await fetch(new URL('./api/diagnostics', location.href), { cache:'no-store', signal:AbortSignal.timeout(15000) });
      if (!response.ok) {
        const gateway = response.status === 503 && !response.headers.get('content-type')?.includes('application/json');
        throw new Error(gateway ? 'Шлюз Amvera ответил 503: само приложение сейчас недоступно. Проверьте статус запуска и журнал приложения.' : response.status === 404 ? 'Сервер ещё не обновлён до версии с диагностикой.' : `Проверка недоступна (HTTP ${response.status}).`);
      }
      const data = await response.json();
      if (id === requestId && $('#diagnostics-dialog').open) body.innerHTML = diagnosticsHTML(data, context(), kind);
    } catch (error) {
      if (id === requestId && $('#diagnostics-dialog').open) body.innerHTML = card('Не удалось получить диагностику', 'error', error.message, 'Проверьте сеть и откройте настройки. Если остальные запросы тоже возвращают 503, посмотрите журнал приложения Amvera.');
    } finally { if (id === requestId) refresh.disabled = false; }
  }
  refresh.addEventListener('click', check);
  $('#diagnostics-settings').addEventListener('click', showSettings);
  return { open(value) { kind = value; title.textContent = value === 'base' ? 'Проверка базы' : 'Проверка реестра'; openDialog('diagnostics-dialog'); check(); } };
}
