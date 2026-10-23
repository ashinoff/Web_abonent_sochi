import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Amvera launches the isolated Sochi server, not the legacy Yandex server', async () => {
  const config = await readFile(new URL('../amvera.yml', import.meta.url), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const server = await readFile(new URL('../sochi-server.mjs', import.meta.url), 'utf8');

  const declaredEntrypoints = [...config.matchAll(/^\s*scriptName:\s*([^#\r\n]+?)\s*$/gm)].map(match => match[1].trim());
  assert.deepEqual(declaredEntrypoints, ['sochi-server.mjs']);
  assert.equal(pkg.scripts.start, 'node sochi-server.mjs');
  assert.match(server, /export function createSochiServer\(/);
  assert.doesNotMatch(config, /^\s*scriptName:\s*server\.mjs\s*$/m);
});
