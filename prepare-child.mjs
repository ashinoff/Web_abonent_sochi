import { open, readFile, writeFile } from 'node:fs/promises';
import { sourceRoleKeys } from './public/source.js';

try {
  const [, , path, output, role, filename] = process.argv;
  if (!path || !output || !sourceRoleKeys.includes(role)) throw new Error('Некорректный запрос подготовки.');
  let prepared, written = false;
  if (['events', 'registry', 'consumption'].includes(role) && !/\.xlsb$/i.test(filename || '')) {
    const file = await open(path, 'r'), signature = Buffer.alloc(4);
    try { await file.read(signature, 0, 4, 0); } finally { await file.close(); }
    if (signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      if (role === 'registry') {
        const { writeRegistryXLSX } = await import('./registry-stream.mjs');
        const warnings=await writeRegistryXLSX(path, output, filename);
        if(warnings.length)await writeFile(output+'.warnings.json',JSON.stringify(warnings));
        written = true;
      } else if (role === 'consumption') {
        const { writeMonthlyXLSX } = await import('./monthly-stream.mjs');
        const { warnings } = await writeMonthlyXLSX(path, output);
        if(warnings.length)await writeFile(output+'.warnings.json',JSON.stringify(warnings));
        written = true;
      } else {
        const { readEventJournalXLSX } = await import('./journal-stream.mjs');
        prepared = await readEventJournalXLSX(path);
      }
    }
  }
  if (!prepared && !written) {
    const { prepareWorkbook } = await import('./prepared-workbook.mjs');
    prepared = prepareWorkbook(await readFile(path), role, filename);
  }
  if (prepared) {
    await writeFile(output, JSON.stringify(prepared));
    if(prepared.warnings?.length)await writeFile(output+'.warnings.json',JSON.stringify(prepared.warnings));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
