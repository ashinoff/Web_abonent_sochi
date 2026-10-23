import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as XLSX from '@e965/xlsx';
import { buildSochiTemplate } from '../sochi-template.mjs';
import { prepareWorkbook } from '../prepared-workbook.mjs';
import { writeRegistryXLSX } from '../registry-stream.mjs';
import { readFile } from 'node:fs/promises';
import { readEventJournalXLSX } from '../journal-stream.mjs';
import { writeIncomingXLSX } from '../incoming-stream.mjs';
import { SOCHI_ROLES } from '../public/sochi-config.js';

test('All five XLSX templates match the real Sochi import parsers', async t => {
  const folder = await mkdtemp(join(tmpdir(),'sochi-template-test-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  for (const role of Object.keys(SOCHI_ROLES)) {
    await t.test(role, async () => {
      const { filename, buffer } = buildSochiTemplate(role,2026);
      assert.ok(filename.endsWith('.xlsx'));
      assert.equal(buffer[0], 0x50);
      assert.equal(buffer[1], 0x4b);
      const workbook = XLSX.read(buffer,{type:'buffer'});
      assert.equal(workbook.SheetNames.length, 1,'do not add parseable instruction sheets');
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{header:1});
      assert.equal(rows.length,2,'headers + one explicitly documented example row');
      assert.ok(rows[0].length>=3);
      assert.equal(rows[1][0].startsWith('0') || role==='incoming',true,'IDs are text when present');
      const data = prepareWorkbook(buffer,role,filename);
      assert.equal(data.role,role);
      if (role==='registry') {
        assert.equal(data.sheets?.length,1);
        const source=join(folder,'registry.xlsx'),output=join(folder,'registry.json');
        await writeFile(source,buffer);
        await writeRegistryXLSX(source,output,filename);
        const streamed=JSON.parse(await readFile(output,'utf8'));
        assert.equal(streamed.sheets.length,1);
      } else if (role==='consumption') {
        assert.ok(data.rows?.length || data.packs?.length || data.blocks?.length || JSON.stringify(data).includes('00000001001'));
      } else if (role==='incoming') {
        assert.equal(data.schema,'meter-monthly-v1');
        assert.equal(data.rows.length,1);
        assert.equal(data.months.length,69);
        assert.equal(data.rows[0][0],'000012345678');
        assert.equal(data.rows[0][7][0],1200);
        assert.equal(data.rows[0][7][68],1450);
        const source=join(folder,'incoming.xlsx'),output=join(folder,'incoming.json');
        await writeFile(source,buffer);
        const streamed=await writeIncomingXLSX(source,output);
        assert.equal(streamed.rows,1);
        assert.deepEqual(JSON.parse(await readFile(output,'utf8')),data);
      } else if (role==='instant') {
        assert.equal(data.stats.accepted,1);
        assert.equal(data.stats.meters,1);
      } else if (role==='events') {
        assert.equal(data.stats.accepted,1);
        const source=join(folder,'events.xlsx');
        await writeFile(source,buffer);
        const streamed=await readEventJournalXLSX(source);
        assert.equal(streamed.stats.accepted,1);
      }
    });
  }
  assert.throws(()=>buildSochiTemplate('undefined'),/Неизвестный тип/);
});
