import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { prepareUploadedXlsx } from './prepared-service.mjs';
import { fault } from './accounts.mjs';

const zipHeader = Buffer.from([0x50,0x4b,0x03,0x04]);
const xlsHeader = Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);
const maxUploadBytes = 80 * 1048576;

// Keep raw personal data in a temporary file only while a single administrator
// uploads and the bounded Excel parser works. The repository is never involved.
export async function receiveSochiWorkbook(req, { role, filename }) {
  if (!/^[^\\/\x00-\x1f]{1,180}\.xlsx?$/i.test(filename || '')) {
    throw fault('Выберите файл Excel XLS или XLSX с корректным именем.',400,'invalid_file');
  }
  if (req.headers['content-type'] !== 'application/octet-stream' ||
      req.headers['x-sochi-upload'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site') {
    throw fault('Загрузка разрешена только с этого сайта.',415,'invalid_upload');
  }
  if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
    throw fault('Запрещён запрос из другого источника.',403,'forbidden');
  }
  const expectedSize = Number(req.headers['content-length']);
  if (expectedSize > maxUploadBytes) throw fault('Excel превышает лимит 80 МБ.',413,'file_too_large');
  const directory = await mkdtemp(join(tmpdir(),'sochi-upload-'));
  const path = join(directory,'workbook');
  const output = join(directory,'package.json');
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(req, new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > maxUploadBytes) { callback(fault('Excel превышает лимит 80 МБ.',413,'file_too_large')); return; }
        hash.update(chunk);
        callback(null,chunk);
      },
    }), createWriteStream(path,{flags:'wx'}));
    if (!size) throw fault('Файл пустой.',400,'empty_file');
    const handle = await open(path,'r');
    const signature = Buffer.alloc(8);
    try { await handle.read(signature,0,8,0); } finally { await handle.close(); }
    if (!signature.subarray(0,4).equals(zipHeader) && !signature.equals(xlsHeader)) {
      throw fault('Формат файла не похож на XLS или XLSX.',400,'invalid_file');
    }
    const json = await prepareUploadedXlsx(path,output,role,filename);
    return { size, revision: role + ':sochi-v1:' + hash.digest('hex'), json };
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
}
