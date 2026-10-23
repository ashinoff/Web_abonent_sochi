import { randomUUID } from 'node:crypto';
import { hashPassword,verifyPassword,assertManager,fault } from './accounts.mjs';

const bootstrapId='00000000-0000-4000-8000-000000000001';
export function createAccountStore(pool,ready){
  async function tx(work){await ready();const client=await pool.connect();try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});if(error.code==='23505')throw fault('Этот логин уже занят.',409,'login_exists');throw error;}finally{client.release();}}
  const fields='id,login,full_name,role,active,is_bootstrap,created_at,res_paths';
  return {
    async ensureBootstrap(config){
      await ready();const {rows:[prior]}=await pool.query('SELECT * FROM abonent_accounts WHERE id=$1',[bootstrapId]);
      let hash=prior&&await verifyPassword(config.password,prior.password_hash)?prior.password_hash:await hashPassword(config.password);
      return tx(async client=>{
        await client.query(`INSERT INTO abonent_accounts(id,login,full_name,password_hash,role,is_bootstrap) VALUES($1,$2,$3,$4,'superadmin',true) ON CONFLICT(id) DO NOTHING`,[bootstrapId,config.login,config.name,hash]);
        const {rows:[current]}=await client.query('SELECT * FROM abonent_accounts WHERE id=$1 FOR UPDATE',[bootstrapId]);
        if(current.password_hash!==hash&&await verifyPassword(config.password,current.password_hash))hash=current.password_hash;
        if(current.password_hash!==hash||current.login!==config.login)await client.query('DELETE FROM abonent_sessions WHERE account_id=$1',[bootstrapId]);
        await client.query(`UPDATE abonent_accounts SET login=$2,full_name=$3,password_hash=$4,role='superadmin',active=true,is_bootstrap=true WHERE id=$1`,[bootstrapId,config.login,config.name,hash]);
      });
    },
    async findAccount(login){await ready();return(await pool.query('SELECT * FROM abonent_accounts WHERE login=$1',[login])).rows[0]||null;},
    async listAccounts(actor){await ready();return(await pool.query(`SELECT ${fields} FROM abonent_accounts WHERE $1='superadmin' OR role='user' ORDER BY role,full_name,login`,[actor.role])).rows;},
    async saveAccount(actor,id,data){
      const hash=data.password?await hashPassword(data.password):null;
      return tx(async client=>{
        const {rows:locked}=await client.query('SELECT * FROM abonent_accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[actor.id,...(id?[id]:[])]]);
        const manager=locked.find(user=>user.id===actor.id);
        if(!manager?.active||!['admin','superadmin'].includes(manager.role))throw fault('Недостаточно прав.',403,'forbidden');
        let current;if(id){current=locked.find(user=>user.id===id);if(!current)throw fault('Учётная запись не найдена.',404);assertManager(manager,current);}
        const role=data.role||current?.role||'user';assertManager(manager,{role});
        if(!id&&!hash)throw fault('Для новой учётной записи нужен пароль.');
        if(id===actor.id&&(role!==current.role||data.active===false))throw fault('Нельзя отключить себя или изменить свою роль.',409);
        const values=[id||randomUUID(),data.login||current?.login,data.name||current?.full_name,hash||current?.password_hash,role,data.active??current?.active??true,data.resPaths??current?.res_paths??[]];
        const {rows:[saved]}=await client.query(`INSERT INTO abonent_accounts(id,login,full_name,password_hash,role,active,res_paths) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(id) DO UPDATE SET login=EXCLUDED.login,full_name=EXCLUDED.full_name,password_hash=EXCLUDED.password_hash,role=EXCLUDED.role,active=EXCLUDED.active,res_paths=EXCLUDED.res_paths RETURNING ${fields}`,values);
        if(current&&(hash||current.role!==role||current.login!==saved.login||!saved.active||JSON.stringify(current.res_paths)!==JSON.stringify(saved.res_paths)))await client.query('DELETE FROM abonent_sessions WHERE account_id=$1',[id]);
        return saved;
      });
    },
    deleteAccount:(actor,id)=>tx(async client=>{
      const {rows:locked}=await client.query('SELECT * FROM abonent_accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[actor.id,id]]);
      const manager=locked.find(user=>user.id===actor.id);
      if(!manager?.active||!['admin','superadmin'].includes(manager.role))throw fault('Недостаточно прав.',403,'forbidden');
      if(id===actor.id)throw fault('Нельзя удалить собственную учётную запись.',409);
      const user=locked.find(user=>user.id===id);
      if(!user)throw fault('Учётная запись не найдена.',404);assertManager(manager,user);
      await client.query('DELETE FROM abonent_accounts WHERE id=$1',[id]);
    }),
    createSession:(accountId,hash,expires,passwordHash)=>tx(async client=>{const user=(await client.query('SELECT * FROM abonent_accounts WHERE id=$1 FOR UPDATE',[accountId])).rows[0];if(!user?.active||user.password_hash!==passwordHash)throw fault('Учётная запись изменена. Повторите вход.',401,'auth_required');await client.query('DELETE FROM abonent_sessions WHERE expires_at<=now()');await client.query('INSERT INTO abonent_sessions(token_hash,account_id,expires_at) VALUES($1,$2,$3)',[hash,accountId,expires]);}),
    async session(hash){await ready();return(await pool.query(`SELECT a.*,s.expires_at FROM abonent_sessions s JOIN abonent_accounts a ON a.id=s.account_id WHERE token_hash=$1 AND expires_at>now() AND a.active`,[hash])).rows[0]||null;},
    async revokeSession(hash){await ready();await pool.query('DELETE FROM abonent_sessions WHERE token_hash=$1',[hash]);},
  };
}
