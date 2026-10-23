const version = 'abonent-shell-sochi-2026-10-23-v5';
const shell = ['./','./index.html','./styles.css','./config.js','./app.js','./worker.js',
  './sochi-config.js','./account-ui.js','./admin-ui.js','./user-notifications.js','./user-note-editor.js','./map-library.js','./map-routes.js',
  './journals.js','./journal-analysis.js','./journal-correlation.js','./journal-peer-context.js','./anomaly-report.js','./journal-ui.css','./analysis-observations.js',
  './journal-report.js','./journal-report-data.js','./journal-report-ui.js',
  './core.js','./monthly.js','./analysis-service.js','./analysis-engine.js','./analysis-settings.js',
  './energy-format.js','./analysis-tuning.js','./analysis-ui.js','./analysis-help.js','./diagnostics-ui.js','./analysis-chart.js','./chart-years.js','./demo.js',
  './download-buffer.js','./gestures.js','./notes-ui.js','./notes-map-ui.js','./notes-map-data.js','./readings.js','./record-sections.js',
  './source-files.js','./source.js','./workbook-check.js','./prepared-data.js','./prepared-cache.js','./preparation-policy.js','./load-map.js','./load-session.js','./offline-copies.js',
  './vendor/xlsx.full.min.js','./vendor/leaflet/leaflet.js','./vendor/leaflet/leaflet.css','./favicon.svg','./rosseti-logo.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(version).then(cache => cache.addAll(shell.map(url => new Request(new URL(url, self.location.href), { cache:'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('abonent-shell-') && key !== version).map(key => caches.delete(key)))), self.clients.claim()]));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  // HTML and modules always come from the same complete shell version.
  // Registration checks the network for updates; controllerchange refreshes the page.
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.open(version).then(async cache =>
      await cache.match(event.request, { ignoreSearch:true }) || await cache.match('./index.html') || fetch(event.request)));
  } else {
    event.respondWith(caches.open(version).then(cache => cache.match(event.request, { ignoreSearch:true })).then(saved => saved || fetch(event.request)));
  }
});
