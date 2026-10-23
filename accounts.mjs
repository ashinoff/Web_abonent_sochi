import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const derive=promisify(scrypt),options={N:32768,r:8,p:3,maxmem:64*1048576};
let running=0;const waiting=[];
async function bounded(work) {
  if(running>=2){if(waiting.length>=24)throw fault('Слишком много запросов входа. Повторите позже.',429);await new Promise(resolve=>waiting.push(resolve));}
  else running++;
  try{return await work();}finally{const next=waiting.shift();if(next)next();else running--;}
}
export const fault=(message,status=400,code='invalid_request')=>Object.assign(new Error(message),{status,code});
export function accountLogin(value){
  if(typeof value!=='string')throw fault('Укажите логин.');
  const login=value.trim().normalize('NFKC').toLowerCase();
  if(!/^[\p{L}\p{N}._@-]{3,64}$/u.test(login))throw fault('Логин: 3–64 буквы, цифры или символы . _ @ -');
  return login;
}
export function accountPassword(value){
  if(typeof value!=='string'||value.length<10||value.length>128)throw fault('Пароль должен содержать от 10 до 128 символов.');
  return value;
}
export function accountName(value){
  if(typeof value!=='string'||!value.trim()||value.length>200)throw fault('Укажите ФИО до 200 символов.');
  return value.trim();
}
export const roles=new Set(['user','admin','superadmin']);
export const publicAccount=user=>user&&({id:user.id,name:user.full_name,login:user.login,role:user.role,active:user.active,bootstrap:Boolean(user.is_bootstrap),createdAt:user.created_at,resPaths:Array.isArray(user.res_paths)?user.res_paths:[]});
export function canManage(actor,targetRole){return actor?.role==='superadmin'||actor?.role==='admin'&&targetRole==='user';}
export function assertManager(actor,target){if(!canManage(actor,target?.role)||target?.is_bootstrap)throw fault('Недостаточно прав для этой учётной записи.',403,'forbidden');}
export async function hashPassword(password){
  const salt=randomBytes(16);const key=await bounded(()=>derive(password,salt,64,options));
  return `scrypt:32768:8:3:${salt.toString('base64url')}:${key.toString('base64url')}`;
}
const dummy='scrypt:32768:8:3:'+Buffer.alloc(16,17).toString('base64url')+':'+Buffer.alloc(64).toString('base64url');
export async function verifyPassword(password,hash=dummy){
  const parts=String(hash).split(':');if(parts.length!==6||parts.slice(0,4).join(':')!=='scrypt:32768:8:3')return false;
  const salt=Buffer.from(parts[4],'base64url'),expected=Buffer.from(parts[5],'base64url');
  if(salt.length!==16||expected.length!==64)return false;
  const actual=await bounded(()=>derive(password,salt,64,options));return timingSafeEqual(actual,expected);
}
export const sessionHash=value=>createHash('sha256').update(value).digest('hex');
export function superAdminConfig(env){
  if(!env.SUPER_ADMIN_LOGIN&&!env.SUPER_ADMIN_PASSWORD)return null;
  if(!env.SUPER_ADMIN_LOGIN||!env.SUPER_ADMIN_PASSWORD)throw fault('SUPER_ADMIN_LOGIN и SUPER_ADMIN_PASSWORD нужно задать вместе.',503,'auth_config');
  return {login:accountLogin(env.SUPER_ADMIN_LOGIN),password:accountPassword(env.SUPER_ADMIN_PASSWORD),name:accountName(env.SUPER_ADMIN_NAME||'Суперадминистратор')};
}

export const accountSchema=`CREATE TABLE IF NOT EXISTS abonent_accounts (
  id uuid PRIMARY KEY, login text NOT NULL UNIQUE, full_name text NOT NULL, password_hash text NOT NULL,
  role text NOT NULL CHECK(role IN ('user','admin','superadmin')), active boolean NOT NULL DEFAULT true,
  res_paths text[] NOT NULL DEFAULT '{}',
  is_bootstrap boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE abonent_accounts ADD COLUMN IF NOT EXISTS res_paths text[] NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX IF NOT EXISTS abonent_one_bootstrap ON abonent_accounts(is_bootstrap) WHERE is_bootstrap;
CREATE TABLE IF NOT EXISTS abonent_sessions (
  token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES abonent_accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS abonent_session_expiry ON abonent_sessions(expires_at);`;
