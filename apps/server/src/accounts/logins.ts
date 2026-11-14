// #2243 (wire contract account-grant/1, #2242): an account grant lets one home act for one account. It is issued by the
// same approve-and-poll discipline as a Soul approval (store.ts): the agent starts a request with a secret only it holds,
// the signed-in person approves it, the agent polls. Requests live in the world's database (the window that approves
// them is a world page); grants live in the site's shared account registry when there is one, so one login is valid in
// every world of that site, and in the world's own database otherwise. Only sha256(token) is ever stored.
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AccountStoreError,WINDOW_CODE} from './store.ts';

/** A database and its outer transaction (BEGIN IMMEDIATE, or a savepoint inside an open one). */
export type LoginsDb={db:DatabaseSync;tx<T>(operation:()=>T):T};
export type RequestKind='login'|'retire';
/** `expired` is kept only for requests that lapsed before #2258: a request now stays open until it is answered. */
export type RequestStatus='pending'|'ready'|'cancelled'|'expired';
/** Who ended a cancelled request: the person (`refused`), its agent (`cancelled`), or the same agent's newer one (`replaced`). */
export type RequestEnded='refused'|'cancelled'|'replaced';
export type RequestDTO={id:string;kind:RequestKind;status:RequestStatus;agentLabel:string;device:{name:string};soul:{id:string;name:string}|null;confirm:string;createdAt:number;inWindow:boolean;ended?:RequestEnded};
export type AccountGrant={id:string;accountId:string;agentLabel:string;device:{id:string;name:string};createdAt:number;lastUsedAt:number|null};
export type LoginInput={agentLabel:string;device:{id:string;name:string};idempotencyKey:string;pollSecret:string;forCode?:string};
type RequestRow={id:string;world_id:string;kind:RequestKind;status:RequestStatus;agent_label:string;device_id:string;device_name:string;soul_id:string|null;target_account_id:string|null;account_id:string|null;grant_id:string|null;nonce:string;poll_hash:string;idempotency_hash:string;input_hash:string;created_at:number;expires_at:number;ended_by:RequestEnded|null};
type GrantRow={id:string;account_id:string;agent_label:string;device_id:string;device_name:string;token_hash:string|null;created_at:number;issued_at:number|null;last_used_at:number|null;revoked_at:number|null;revoked_reason:string|null};
// #2258: a request has no expiry. expires_at stays in the table for older rows and is written as "never".
const CODE_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',LAST_USED_STEP_MS=30_000,NEVER=Number.MAX_SAFE_INTEGER;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const nonce=(prefix:string)=>prefix+randomBytes(16).toString('hex');
function fail(code:string,message:string):never{throw new AccountStoreError(code,message);}
function text(value:unknown,field:string,min=1,max=128):string{if(typeof value!=='string'||value.length<min||value.length>max||value.includes('\0'))fail('invalid',`Invalid ${field}`);return value;}
const validSecret=(raw:unknown):raw is string=>typeof raw==='string'&&/^[A-Za-z0-9_-]{43}$/.test(raw)&&Buffer.from(raw,'base64url').toString('base64url')===raw;
const hashMatches=(raw:unknown,hash:string)=>validSecret(raw)&&/^[a-f0-9]{64}$/.test(hash)&&timingSafeEqual(Buffer.from(sha(raw),'hex'),Buffer.from(hash,'hex'));
/** The registry file is written by several world processes: its writes take the lock first, as AccountRegistry.bind does. */
export function sharedLoginsDb(db:DatabaseSync):LoginsDb{
 return {db,tx<T>(operation:()=>T):T{if(db.isTransaction)return operation();db.exec('BEGIN IMMEDIATE');try{const out=operation();db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}};
}

export class AccountLogins {
 readonly world:LoginsDb;readonly grants:LoginsDb;readonly worldId:string;
 private now:()=>number;private soulName:(id:string)=>string|null;
 constructor(world:LoginsDb,grants:LoginsDb,worldId:string,options:{now?:()=>number;soulName?:(id:string)=>string|null}={}){
  this.world=world;this.grants=grants;this.worldId=text(worldId,'worldId');this.now=options.now??Date.now;this.soulName=options.soulName??(()=>null);
  this.world.tx(()=>this.world.db.exec(`
   CREATE TABLE IF NOT EXISTS account_requests_v1 (
    id TEXT PRIMARY KEY, world_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('login','retire')),
    status TEXT NOT NULL CHECK(status IN ('pending','ready','cancelled','expired')),
    agent_label TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT NOT NULL, soul_id TEXT, target_account_id TEXT,
    account_id TEXT, grant_id TEXT, nonce TEXT NOT NULL, poll_hash TEXT NOT NULL, idempotency_hash TEXT NOT NULL,
    input_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, UNIQUE(world_id,idempotency_hash)
   );
   CREATE INDEX IF NOT EXISTS account_requests_target_v1 ON account_requests_v1(world_id,target_account_id,status);`));
  this.world.tx(()=>{if(!(this.world.db.prepare('PRAGMA table_info(account_requests_v1)').all() as {name:string}[]).some(c=>c.name==='ended_by'))this.world.db.exec('ALTER TABLE account_requests_v1 ADD COLUMN ended_by TEXT');});
  this.grants.tx(()=>this.grants.db.exec(`
   CREATE TABLE IF NOT EXISTS account_agent_logins_v1 (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, agent_label TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT NOT NULL,
    token_hash TEXT UNIQUE, created_at INTEGER NOT NULL, issued_at INTEGER, last_used_at INTEGER, revoked_at INTEGER, revoked_reason TEXT
   );
   CREATE INDEX IF NOT EXISTS account_agent_logins_account_v1 ON account_agent_logins_v1(account_id);`));
 }
 private time(){const now=this.now();if(!Number.isSafeInteger(now)||now<0)fail('invalid-clock','Invalid account clock');return now;}
 private row(id:string){text(id,'request');return this.world.db.prepare('SELECT * FROM account_requests_v1 WHERE world_id=? AND id=?').get(this.worldId,id) as RequestRow|undefined;}
 private required(id:string){return this.row(id)??fail('not-found','Request not found');}
 /** Four characters of the window-code alphabet from sha256(request id): the agent prints it, the card shows it. */
 static confirm(id:string){return [...createHash('sha256').update(id).digest().subarray(0,4)].map(b=>CODE_ALPHABET[b%CODE_ALPHABET.length]).join('');}
 private dto(row:RequestRow):RequestDTO{
  return {id:row.id,kind:row.kind,status:row.status,agentLabel:row.agent_label,device:{name:row.device_name},soul:row.soul_id?{id:row.soul_id,name:this.soulName(row.soul_id)??row.soul_id}:null,confirm:AccountLogins.confirm(row.id),createdAt:row.created_at,inWindow:!!row.target_account_id,...(row.status==='cancelled'&&row.ended_by?{ended:row.ended_by}:{})};
 }
 private codeAccount(code:unknown){
  if(typeof code!=='string'||!WINDOW_CODE.test(code))return null;
  return (this.world.db.prepare('SELECT account_id FROM account_window_codes_v1 WHERE world_id=? AND code=? AND expires_at>?').get(this.worldId,code,this.time()) as {account_id:string}|undefined)?.account_id??null;
 }
 private begin(kind:RequestKind,fields:{agentLabel:string;deviceId:string;deviceName:string;soulId:string|null;target:string|null},idempotencyKey:string,pollSecret:string,inputHash:string){
  const idempotencyHash=sha(text(idempotencyKey,'idempotency key',16,256));
  if(!validSecret(pollSecret))fail('invalid','Invalid request poll credential');
  return this.world.tx(()=>{
   const previous=this.world.db.prepare('SELECT * FROM account_requests_v1 WHERE world_id=? AND idempotency_hash=?').get(this.worldId,idempotencyHash) as RequestRow|undefined;
   if(previous){
    if(!hashMatches(pollSecret,previous.poll_hash))fail('poll-secret','Request retry credential invalid');
    if(previous.input_hash!==inputHash)fail('idempotency-conflict','Request retry changed its request');
    return this.dto(previous);
   }
   const id=nonce('aq_'),now=this.time();
   // A newer request from the same agent (device) replaces its open one: a login, or a retire of the same Soul.
   this.world.db.prepare("UPDATE account_requests_v1 SET status='cancelled',ended_by='replaced' WHERE world_id=? AND kind=? AND device_id=? AND soul_id IS ? AND status='pending'").run(this.worldId,kind,fields.deviceId,fields.soulId);
   this.world.db.prepare("INSERT INTO account_requests_v1(id,world_id,kind,status,agent_label,device_id,device_name,soul_id,target_account_id,nonce,poll_hash,idempotency_hash,input_hash,created_at,expires_at) VALUES (?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?)")
    .run(id,this.worldId,kind,fields.agentLabel,fields.deviceId,fields.deviceName,fields.soulId,fields.target,nonce('an_'),sha(pollSecret),idempotencyHash,inputHash,now,NEVER);
   return this.dto(this.required(id));
  });
 }
 /** A login with a live window code is addressed to that code's account; without one, whoever is signed in may approve it. */
 startLogin(input:LoginInput):RequestDTO{
  const agentLabel=text(input.agentLabel,'agent label',1,120),deviceId=text(input.device?.id,'device id',36,36),deviceName=text(input.device?.name,'device name',1,60);
  if(!/^dev_[a-f0-9]{32}$/.test(deviceId))fail('invalid','Invalid device id');
  return this.begin('login',{agentLabel,deviceId,deviceName,soulId:null,target:this.codeAccount(input.forCode)},input.idempotencyKey,input.pollSecret,sha(JSON.stringify(['login',agentLabel,deviceId,deviceName])));
 }
 /** A retire is only ever a request: addressed to the grant's account, and done only by that person's approve. */
 startRetire(grant:AccountGrant,soulId:string,input:{idempotencyKey:string;pollSecret:string}):RequestDTO{
  text(soulId,'Soul');
  return this.begin('retire',{agentLabel:grant.agentLabel,deviceId:grant.device.id,deviceName:grant.device.name,soulId,target:grant.accountId},input.idempotencyKey,input.pollSecret,sha(JSON.stringify(['retire',grant.id,soulId])));
 }
 private addressed(row:RequestRow,accountId:string){
  if(row.target_account_id&&row.target_account_id!==accountId)fail('forbidden','This request is for another account');
  if(row.account_id&&row.account_id!==accountId)fail('forbidden','This request belongs to another account');
 }
 view(id:string,accountId?:string):RequestDTO{return this.world.tx(()=>{const row=this.required(id);if(accountId!==undefined)this.addressed(row,accountId);return this.dto(row);});}
 kind(id:string){return this.required(id).kind;}
 /** Pending requests addressed to this account, newest first, at most five. */
 waiting(accountId:string):RequestDTO[]{
  return this.world.tx(()=>(this.world.db.prepare("SELECT * FROM account_requests_v1 WHERE world_id=? AND target_account_id=? AND status='pending' ORDER BY created_at DESC,rowid DESC LIMIT 5").all(this.worldId,accountId) as RequestRow[]).map(row=>this.dto(row)));
 }
 /** One live grant per account and device: approving a login for a device that has one revokes the older (`replaced`). */
 approveLogin(accountId:string,id:string):RequestDTO{
  text(accountId,'account',1,256);
  return this.world.tx(()=>{
   const row=this.required(id);this.addressed(row,accountId);
   if(row.kind!=='login')fail('invalid','Not a login request');
   if(row.status!=='pending')return this.dto(row);
   const grantId=nonce('ag_'),now=this.time();
   this.grants.tx(()=>{
    this.grants.db.prepare("UPDATE account_agent_logins_v1 SET revoked_at=?,revoked_reason='replaced' WHERE account_id=? AND device_id=? AND revoked_at IS NULL").run(now,accountId,row.device_id);
    this.grants.db.prepare('INSERT INTO account_agent_logins_v1(id,account_id,agent_label,device_id,device_name,created_at) VALUES (?,?,?,?,?,?)').run(grantId,accountId,row.agent_label,row.device_id,row.device_name,now);
   });
   this.world.db.prepare("UPDATE account_requests_v1 SET status='ready',account_id=?,grant_id=? WHERE world_id=? AND id=? AND status='pending'").run(accountId,grantId,this.worldId,id);
   return this.dto(this.required(id));
  });
 }
 /** `retire` performs the world's retire (it re-checks the Soul); the request becomes ready only if it returns. */
 approveRetire(accountId:string,id:string,retire:(soulId:string)=>void):RequestDTO{
  const row=this.world.tx(()=>{const row=this.required(id);this.addressed(row,accountId);if(row.kind!=='retire')fail('invalid','Not a retire request');return row;});
  if(row.status!=='pending')return this.dto(row);
  retire(row.soul_id!);
  return this.world.tx(()=>{this.world.db.prepare("UPDATE account_requests_v1 SET status='ready',account_id=? WHERE world_id=? AND id=? AND status='pending'").run(accountId,this.worldId,id);return this.dto(this.required(id));});
 }
 /** The agent cancels with its secret; a person refuses with their session (a request addressed elsewhere is not theirs). */
 cancel(accountId:string|null,id:string,pollSecret?:string):RequestDTO{
  return this.world.tx(()=>{
   const current=this.required(id);
   if(pollSecret!==undefined){if(!hashMatches(pollSecret,current.poll_hash))fail('poll-secret','Request credential invalid');}
   else if(accountId===null)fail('identity','Verified account identity required');
   else this.addressed(current,accountId);
   if(current.status==='cancelled'||current.status==='expired')return this.dto(current);
   if(current.status!=='pending')fail('cannot-cancel','The request was approved; cancelling cannot undo it');
   this.world.db.prepare("UPDATE account_requests_v1 SET status='cancelled',ended_by=? WHERE world_id=? AND id=? AND status='pending'").run(pollSecret!==undefined?'cancelled':'refused',this.worldId,id);
   return this.dto(this.required(id));
  });
 }
 private grantRow(id:string){return this.grants.db.prepare('SELECT * FROM account_agent_logins_v1 WHERE id=?').get(id) as GrantRow|undefined;}
 /** A ready login returns the same derived token on every poll until its grant ends; then the request alone. */
 poll(id:string,pollSecret:string):{request:RequestDTO;account?:{id:string};grant?:{id:string;createdAt:number};token?:string}{
  return this.world.tx(()=>{
   const existing=this.row(id);
   if(!existing||!hashMatches(pollSecret,existing.poll_hash))fail('poll-secret','Request credential invalid');
   const row=existing;
   const request=this.dto(row);
   if(row.kind!=='login'||row.status!=='ready'||!row.grant_id||!row.account_id)return {request};
   const grant=this.grantRow(row.grant_id);
   if(!grant||grant.revoked_at!==null||grant.account_id!==row.account_id)return {request};
   const token='sacct_'+createHmac('sha256',pollSecret).update(JSON.stringify(['soul-account-grant/1',grant.id,row.nonce])).digest('base64url'),hash=sha(token);
   if(grant.token_hash&&grant.token_hash!==hash)fail('grant-conflict','Account grant integrity changed');
   if(!grant.token_hash)this.grants.tx(()=>this.grants.db.prepare('UPDATE account_agent_logins_v1 SET token_hash=?,issued_at=? WHERE id=? AND token_hash IS NULL AND revoked_at IS NULL').run(hash,this.time(),grant.id));
   return {request,account:{id:grant.account_id},grant:{id:grant.id,createdAt:grant.created_at},token};
  });
 }
 private grant(row:GrantRow):AccountGrant{return {id:row.id,accountId:row.account_id,agentLabel:row.agent_label,device:{id:row.device_id,name:row.device_name},createdAt:row.created_at,lastUsedAt:row.last_used_at};}
 /** `null`: never issued here (or not an account token); `revoked`: issued and ended, with why. */
 resolve(token:string|undefined|null):{grant:AccountGrant}|{revoked:string}|null{
  if(typeof token!=='string'||token.length>256||!token.startsWith('sacct_'))return null;
  const row=this.grants.db.prepare('SELECT * FROM account_agent_logins_v1 WHERE token_hash=?').get(sha(token)) as GrantRow|undefined;
  if(!row)return null;
  if(row.revoked_at!==null)return {revoked:row.revoked_reason??'revoked'};
  const now=this.time();
  if(row.last_used_at===null||row.last_used_at<=now-LAST_USED_STEP_MS){this.grants.tx(()=>this.grants.db.prepare('UPDATE account_agent_logins_v1 SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<=?)').run(now,row.id,now-LAST_USED_STEP_MS));row.last_used_at=now;}
  return {grant:this.grant(row)};
 }
 private end(grantId:string,accountId:string|null,reason:string){
  return this.grants.tx(()=>{
   const row=this.grantRow(text(grantId,'grant'));
   if(!row||(accountId!==null&&row.account_id!==accountId))fail('not-found','No such agent');
   this.grants.db.prepare('UPDATE account_agent_logins_v1 SET revoked_at=?,revoked_reason=? WHERE id=? AND revoked_at IS NULL').run(this.time(),reason,row.id);
  });
 }
 /** The grant stops working; Soul tokens it minted keep working. */
 logout(grantId:string){this.end(grantId,null,'logout');}
 revokeAgent(accountId:string,grantId:string){this.end(grantId,accountId,'revoked');}
 /** This account's live grants, for "Connected agents". */
 agents(accountId:string){
  return (this.grants.db.prepare('SELECT * FROM account_agent_logins_v1 WHERE account_id=? AND revoked_at IS NULL ORDER BY created_at DESC').all(accountId) as GrantRow[]).map(row=>({id:row.id,agentLabel:row.agent_label,device:{name:row.device_name},createdAt:row.created_at,lastUsedAt:row.last_used_at}));
 }
}
