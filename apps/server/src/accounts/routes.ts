import type {Hono,Context} from 'hono';
import {z} from 'zod';
import {ApiError} from '../souls.ts';
import type {Auth} from '../auth.ts';
import {AccountStoreError,type ApprovalDTO} from './store.ts';
import type {WorldAccounts} from './service.ts';

const startSchema=z.object({agentLabel:z.string().min(1).max(120),name:z.string().min(2).max(32).optional(),description:z.string().max(1200).optional(),idempotencyKey:z.string().min(16).max(256),pollSecret:z.string().regex(/^[A-Za-z0-9_-]{43}$/),soulId:z.string().regex(/^s_[a-zA-Z0-9_-]+$/).optional(),for:z.string().max(16).optional(),existing:z.literal(true).optional()}).strict();
const codeSchema=z.object({for:z.string().max(16)}).strict();
const UNKNOWN_CODE='That window code is unknown or has expired. Ask your person for the one on their open page.';
const pollSchema=z.object({approvalId:z.string().regex(/^ap_[a-f0-9]{32}$/),pollSecret:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
/** #1274: a name as a person might retype it. The world's own check folds ASCII case only, and a second Soul is what this prevents. */
const foldName=(name:string)=>name.trim().normalize('NFC').toLowerCase();
export function mountAccountRoutes(app:Hono,deps:{accounts:WorldAccounts;auth:Auth;baseOf:(c:Context)=>string;limit:(c:Context,key:string,max:number,ms:number)=>void;control?:(soulId:string)=>{held:boolean;state:string;since:number|null}|null}){
 const {accounts,auth}=deps;
 const verified=async(c:Context)=>{const account=await auth.accountFromToken(c.req.header('authorization')?.replace(/^Bearer\s+/i,''));if(!account)throw new ApiError(401,'account-signin-required','Sign in with Google or email.');accounts.verifySession(account.identity);return account;};
 const json=async(c:Context)=>{try{return await c.req.json();}catch{throw new ApiError(400,'invalid','Body must be JSON.');}};
 const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)throw new ApiError(400,'invalid','Approval request format is invalid.');return result.data;};
 const wrap=async(c:Context,run:()=>unknown|Promise<unknown>)=>{c.header('Cache-Control','no-store');try{return c.json(await run());}catch(error){if(error instanceof AccountStoreError)throw new ApiError(error.code==='not-found'?404:error.code==='forbidden'?403:error.code==='identity'||error.code==='poll-secret'?401:error.code==='invalid'?400:409,error.code,error.message);throw error;}};
 const heldSouls=(ids:string[])=>ids.flatMap(id=>{const s=accounts.host.db.soul(id);return s&&s.world_id===accounts.host.worldId&&s.retired_at===null?[s]:[];});
 const world=(c:Context)=>({id:accounts.host.worldId,name:accounts.souls.cfg.worldKey,url:deps.baseOf(c)});
 // Lane PUX: what the person's card shows: the Soul's profile picture once the Soul exists (a reconnect, or after creation)
 const shown=(a:ApprovalDTO)=>({...a,photo:a.soulId?accounts.host.profilePhoto(a.soulId)?.url??null:null});
 app.post('/v1/agent/approval/start',c=>wrap(c,async()=>{deps.limit(c,'account-start',6,60000);const p=parse(startSchema,await json(c)),{soulId:named,for:forCode,name,existing,...input}=p,asked=name?.trim();
  // #1274: a name this window's account already holds is that Soul, asked for again from a new folder: reconnect it. A
  // second Soul would strand the first. Only that account's code gets here, so anyone else still sees name-taken. A retry
  // stays the request it was: the key decides, not what the name means by now.
  const retry=accounts.store.retryOf(input.idempotencyKey),held=!named&&asked&&!retry?heldSouls(accounts.store.codeSouls(forCode)??[]):[];
  const soulId=named??retry?.repairSoulId??(held.find(s=>s.name===asked)??held.find(s=>foldName(s.name)===foldName(asked!)))?.id;
  // Lane PAIR-INWINDOW (Gene's review #2): a reconnect names its Soul by ID only. The request carries the Soul's REAL current
  // name (the card's title; the agent's guess is ignored), so a pressed Approve never fails on a name.
  const soul=soulId?accounts.host.db.soul(soulId):undefined;
  if(soulId&&(!soul||soul.world_id!==accounts.host.worldId||soul.retired_at!==null))throw new ApiError(404,'soul-not-found',`No Soul ${soulId} lives in this world. Check the ID on the Soul's card (Copy start prompt).`);
  if(!soulId&&!asked)throw new ApiError(400,'invalid','A new Soul needs a name.');
  if(existing&&!soulId){if(accounts.store.codeSouls(forCode)===null)throw new ApiError(404,'code-unknown',UNKNOWN_CODE);throw new ApiError(404,'soul-not-found',`The account behind this code holds no Soul called ${asked} in this world.`);}
  // #1875: a reconnect says whether someone holds the Soul now (read before this request), so a client can step back.
  const control=soulId&&deps.control?deps.control(soulId):null;
  const approval=soulId?accounts.store.startRepairRequest(soulId,{...input,name:soul!.name,forCode}):accounts.store.start({...input,name:asked!,forCode});
  // delivery 'window': the person's open, signed-in world page shows the request (lane PUX); the link stays as a backup
  return {approval,...(control?{control}:{}),world:world(c),approvalURL:`${deps.baseOf(c)}/#approve/${approval.id}`,delivery:approval.inWindow?'window':'link',intervalSeconds:3};}));
 // #1274: what a person gets back with a new folder: the Souls their open window's account holds here, ids and names only.
 app.post('/v1/agent/approval/souls',c=>wrap(c,async()=>{deps.limit(c,'account-souls',6,60000);const p=parse(codeSchema,await json(c)),ids=accounts.store.codeSouls(p.for);if(!ids)throw new ApiError(404,'code-unknown',UNKNOWN_CODE);
  return {souls:heldSouls(ids).map(s=>{const control=deps.control?.(s.id);return {id:s.id,name:s.name,...(control?{control}:{})};})};}));
 app.post('/v1/agent/approval/poll',c=>wrap(c,async()=>{deps.limit(c,'account-poll',60,60000);const p=parse(pollSchema,await json(c));return {...accounts.poll(p.approvalId,p.pollSecret),world:world(c)};}));
 app.post('/v1/agent/approval/cancel',c=>wrap(c,async()=>{const p=parse(pollSchema,await json(c));return {approval:accounts.store.cancel(null,p.approvalId,p.pollSecret),world:world(c)};}));
 app.get('/v1/account/approvals/:id',c=>wrap(c,async()=>{const {identity}=await verified(c);return {approval:shown(accounts.view(identity,c.req.param('id'))),world:world(c)};}));
 // Lane PUX: the signed-in page's window code (for its person's agent), and the requests addressed to it that wait
 app.post('/v1/account/window-code',c=>wrap(c,async()=>{const {identity}=await verified(c);deps.limit(c,'account-window-code',20,60000);return accounts.store.windowCode(identity);}));
 app.get('/v1/account/approvals',c=>wrap(c,async()=>{const {identity}=await verified(c);return {approvals:accounts.store.waiting(identity).map(shown)};}));
 app.post('/v1/account/approvals/:id/renew',c=>wrap(c,async()=>{const {identity}=await verified(c);deps.limit(c,'account-renew',10,60000);return {approval:shown(accounts.store.renew(identity,c.req.param('id'))),world:world(c)};}));
 app.post('/v1/account/approvals/:id/approve',c=>wrap(c,async()=>{const {identity}=await verified(c);deps.limit(c,'account-approve',10,60000);return {approval:shown(await accounts.approveSettled(identity,c.req.param('id'))),world:world(c)};}));
 app.post('/v1/account/approvals/:id/cancel',c=>wrap(c,async()=>{const {identity}=await verified(c);return {approval:shown(accounts.store.cancel(identity,c.req.param('id'))),world:world(c)};}));
 app.post('/v1/account/souls/:id/revoke',c=>wrap(c,async()=>{const {identity}=await verified(c),row=accounts.host.db.soul(c.req.param('id'));if(!row||!accounts.owns(identity.id,row))throw new ApiError(403,'forbidden','Not your Soul.');accounts.revoke(identity,row.id);return {ok:true,soulId:row.id};}));
}
