import pg from 'pg';
import { SOCHI_SOURCE, SOCHI_ENTERPRISE, SOCHI_ENTERPRISE_PATH, SOCHI_RES_NAMES, SOCHI_RES_PATHS } from './public/sochi-config.js';
import { normalizeSettings } from './public/analysis-settings.js';
import { notificationSchema, createNotificationStore } from './notification-store.mjs';
import { accountSchema } from './accounts.mjs';
import { createAccountStore } from './account-store.mjs';
import { adminSchema,createAdminStore,resScope,assertPolicy } from './admin-store.mjs';

const names = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
export function createPreparedStore(env = process.env,{pool:providedPool}={}) {
  if (!names.some(name => env[name])) return null;
  const missing = names.filter(name => !env[name]);
  const port = Number(env.DB_PORT);
  const pool = missing.length || !Number.isInteger(port) || port < 1 || port > 65535 ? null : providedPool||new pg.Pool({
    host: env.DB_HOST, port, database: env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD,
    max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, ssl: false,
  });
  // An idle connection can disappear when the database restarts. Without an
  // error listener pg.Pool would terminate the whole application.
  pool?.on('error', error => console.error(`DB error: ${error.message}`));
  let initialized;
  async function ready() {
    if (missing.length) throw new Error(`Отсутствуют переменные: ${missing.join(', ')}`);
    if (!pool) throw new Error('DB_PORT должен быть числом от 1 до 65535.');
    initialized ||= pool.query(`CREATE TABLE IF NOT EXISTS abonent_snapshots (
      source text NOT NULL, path text NOT NULL, role text NOT NULL, revision text NOT NULL,
      data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (source, path, role)
    )`).then(() => pool.query(`ALTER TABLE abonent_snapshots ADD COLUMN IF NOT EXISTS payload_json json`))
    .then(() => pool.query(`CREATE TABLE IF NOT EXISTS abonent_folder_status (
      source text NOT NULL, res_path text NOT NULL, enterprise_path text NOT NULL,
      enterprise_name text NOT NULL, res_name text NOT NULL,
      statuses jsonb NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (source, res_path)
    )`)).then(() => pool.query(notificationSchema)).then(()=>pool.query(accountSchema)).then(()=>pool.query(adminSchema))
    .then(async()=>{
      if(env.SOCHI_APP!=='1')return;
      await pool.query("CREATE TABLE IF NOT EXISTS abonent_sochi_analysis_settings (source text PRIMARY KEY, settings jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now(), updated_by text)");
      for(const name of SOCHI_RES_NAMES) {
        await pool.query("INSERT INTO abonent_folder_status (source,res_path,enterprise_path,enterprise_name,res_name,statuses) VALUES ($1,$2,$3,$4,$5,'{}'::jsonb) ON CONFLICT (source,res_path) DO NOTHING",
          [SOCHI_SOURCE,SOCHI_ENTERPRISE_PATH+'/'+name,SOCHI_ENTERPRISE_PATH,SOCHI_ENTERPRISE,name]);
      }
    }).catch(error => { initialized = null; throw error; });
    await initialized;
  }
  const admin=createAdminStore(pool,ready);
  async function writeRaw(source, path, role, revision, json,expected) {
    await ready();
    // Packages are read whole; SQL never searches their contents. JSON retains
    // the prepared text without building millions of JSONB nodes on a small DB.
    // The nullable column leaves all existing snapshots readable without a rewrite.
    await admin.policyTransaction(async client=>{
    assertPolicy(await admin.lockPolicy(client,source,resScope(path)),expected);
    await client.query(`INSERT INTO abonent_snapshots (source,path,role,revision,data,payload_json) VALUES ($1,$2,$3,$4,'null'::jsonb,$5::json)
      ON CONFLICT (source,path,role) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data,payload_json=EXCLUDED.payload_json,updated_at=now()`,
    [source, path, role, revision, json]);
    });
  }
  return {
    ...createNotificationStore(pool,ready),
    ...createAccountStore(pool,ready),
    ...admin,
    snapshotStorage: 'json',
    ready,
    async get(source, path, role) {
      await ready();
      const { rows } = await pool.query('SELECT revision, COALESCE(payload_json::text, data::text) AS json, updated_at FROM abonent_snapshots WHERE source=$1 AND path=$2 AND role=$3', [source, path, role]);
      if (!rows[0]) return null;
      const { json, ...entry } = rows[0];
      return { ...entry, data: JSON.parse(json) };
    },
    async getJson(source, path, role) {
      await ready();
      const { rows } = await pool.query('SELECT revision, COALESCE(payload_json::text, data::text) AS json, updated_at FROM abonent_snapshots WHERE source=$1 AND path=$2 AND role=$3', [source, path, role]);
      return rows[0] || null;
    },
    async getRevision(source, path, role) {
      await ready();
      const { rows } = await pool.query('SELECT revision FROM abonent_snapshots WHERE source=$1 AND path=$2 AND role=$3', [source, path, role]);
      return rows[0]?.revision || null;
    },
    async getMeta(source, path, role) {
      await ready();
      const { rows } = await pool.query('SELECT revision, updated_at FROM abonent_snapshots WHERE source=$1 AND path=$2 AND role=$3', [source, path, role]);
      return rows[0] || null;
    },
    async put(source, path, role, revision, data,expected) {
      await writeRaw(source, path, role, revision, JSON.stringify(data),expected);
    },
    putRaw: writeRaw,
    async putFolder(source, folder, statuses,expected) {
      await ready();
      return admin.policyTransaction(async client=>{
      const policy=await admin.lockPolicy(client,source,folder.path);
      if(expected&&(expected.generation!==policy.generation||expected.globalGeneration!==policy.globalGeneration))return false;
      if(policy.blocked)statuses=Object.fromEntries(Object.entries(statuses).map(([role,status])=>[role,{...status,state:'blocked'}]));
      await client.query(`INSERT INTO abonent_folder_status
        (source,res_path,enterprise_path,enterprise_name,res_name,statuses)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (source,res_path) DO UPDATE SET enterprise_path=EXCLUDED.enterprise_path,
        enterprise_name=EXCLUDED.enterprise_name,res_name=EXCLUDED.res_name,
        statuses=EXCLUDED.statuses,checked_at=now()`,
      [source, folder.path, folder.enterprisePath, folder.enterpriseName, folder.name, statuses]);
      return true;
      });
    },
    async markFile(source, path, role, state, updatedAt,expected) {
      await ready();
      await admin.policyTransaction(async client=>{
      assertPolicy(await admin.lockPolicy(client,source,resScope(path)),expected);
      await client.query(`UPDATE abonent_folder_status
        SET statuses=jsonb_set(statuses, ARRAY[$3], (statuses -> $3) || $4::jsonb), checked_at=now()
        WHERE source=$1 AND statuses -> $3 ->> 'path'=$2`,
      [source, path, role, JSON.stringify({ state, updatedAt })]);
      });
    },
    async listFolders(source) {
      await ready();
      const { rows } = await pool.query(`SELECT f.enterprise_path,f.enterprise_name,f.res_path,f.res_name,f.statuses,f.checked_at,
        COALESCE(p.blocked,false) AS local_blocked,COALESCE(g.blocked,false) AS global_blocked,
        COALESCE(p.blocked,false) OR COALESCE(g.blocked,false) AS load_blocked
        FROM abonent_folder_status f LEFT JOIN abonent_load_policy p ON p.source=f.source AND p.res_path=f.res_path
        LEFT JOIN abonent_load_policy g ON g.source=f.source AND g.res_path='/'
        WHERE f.source=$1 ORDER BY f.enterprise_name,f.res_name`, [source]);
      return rows;
    },
    async pruneFolders(source, paths) {
      await ready();
      await pool.query('DELETE FROM abonent_folder_status WHERE source=$1 AND NOT (res_path = ANY($2::text[]))', [source, paths]);
    },
    async saveSochiUpload(source, {resPath,role,path,filename,size,revision,json,actor,warnings=[]}) {
      await ready();
      if(source!==SOCHI_SOURCE||!SOCHI_RES_PATHS.includes(resPath)||!path.startsWith(resPath+'/'))throw new Error('Некорректный РЭС.');
      const stamp=new Date().toISOString();
      return admin.policyTransaction(async client=>{
        assertPolicy(await admin.lockPolicy(client,source,resPath));
        // A replacement is atomic: a failed conversion cannot remove the last good version.
        await client.query("DELETE FROM abonent_snapshots WHERE source=$1 AND role=$2 AND left(path,length($3)+1)=$3||'/'",[source,role,resPath]);
        await client.query("INSERT INTO abonent_snapshots (source,path,role,revision,data,payload_json) VALUES ($1,$2,$3,$4,'null'::jsonb,$5::json)",[source,path,role,revision,json]);
        const status={state:'ready',file:filename,path,size,modified:stamp,updatedAt:stamp,
          ...(warnings.length?{warnings:warnings.slice(0,20)}:{})};
        const changed=await client.query("UPDATE abonent_folder_status SET statuses=jsonb_set(statuses,ARRAY[$3],$4::jsonb,true),checked_at=now() WHERE source=$1 AND res_path=$2",
          [source,resPath,role,JSON.stringify(status)]);
        if(!changed.rowCount)throw new Error('РЭС отсутствует в базе.');
        await client.query("INSERT INTO abonent_admin_events (source,res_path,category,code,message,actor) VALUES($1,$2,'upload','file_uploaded',$3,$4)",
          [source,resPath,'Загружен '+filename+' ('+role+').',actor]);
        return status;
      });
    },
    async getSochiAnalysisSettings(source) {
      await ready();
      const {rows}=await pool.query('SELECT settings FROM abonent_sochi_analysis_settings WHERE source=$1',[source]);
      return normalizeSettings(rows[0]?.settings||{});
    },
    async saveSochiAnalysisSettings(source,settings,actor) {
      await ready();
      const normalized=normalizeSettings(settings);
      await pool.query("INSERT INTO abonent_sochi_analysis_settings(source,settings,updated_by) VALUES($1,$2,$3) ON CONFLICT(source) DO UPDATE SET settings=EXCLUDED.settings,updated_by=EXCLUDED.updated_by,updated_at=now()",
        [source,JSON.stringify(normalized),actor]);
      return normalized;
    },
    close: () => pool?.end(),
  };
}
