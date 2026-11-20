// A Soul of today's client paired again by its owner (Engine v2 R18, #2821): R18's `pairFormer` against the real
// directory (`directoryd` with the sign-in for test worlds), its account store holding X11's import of the Soul. The
// contract is the one `client/test/compat/frozen-world.mjs` stands in for: a request names the Soul's `former` id and
// its `world`; the owner's approval pairs the Soul X11 brought over for that former id, and only for its own account;
// the poll answers `{token, grant, former}`. Run from v2/ after `cargo build -p directoryd --locked`.

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pairFormer, upgradeHome } from '../upgrade/upgrade.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = process.env.DIRECTORYD ?? join(v2, 'target/debug/directoryd');
const scratch = join(v2,'..','.local','former-upgrade');mkdirSync(scratch,{recursive:true});
const dir = mkdtempSync(join(scratch, 'souls-r18-dir-'));
const store = join(dir, 'accounts.sqlite'), tokens = join(dir, 'gateway-tokens.txt');
const procs = new Set();
after(() => { for (const p of procs) p.kill(); rmSync(dir, { recursive: true, force: true }); });

/** directoryd on its own store, as the switch-over runs it: its origin and a stop that waits for its exit. */
async function directoryd({storePath=store,tokensPath=tokens,pairingPath=join(dir,'pairing.sqlite')}={}) {
  const p = spawn(bin, ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1', '--store', storePath, '--test-sign-in',
    '--pairing', pairingPath, '--gateway-tokens', tokensPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.add(p);
  const origin = await new Promise((ok, fail) => {
    let out = '';
    const take = (d) => { out += d; const m = /listening on (\S+)\n/.exec(out); if (m) ok(`http://${m[1]}`); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('exit', (c) => fail(new Error(`directoryd ended (${c}): ${out}`)));
  });
  const stop = () => new Promise((ok) => { p.removeAllListeners('exit'); p.on('exit', ok); p.kill(); procs.delete(p); });
  return { origin, stop };
}

const post = async (origin, path, body) => {
  const r = await fetch(new URL(path, origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('R18: the real directory pairs a former Soul as the Soul X11 brought over, for its owner only', async () => {
  // Two people sign in once, so the store knows their accounts; then, with directoryd stopped, X11 writes its import.
  let d = await directoryd();
  for (const person of ['Ada owner', 'Someone else']) assert.equal((await post(d.origin, '/v1/account/souls', { test_person: person })).status, 200);
  await d.stop();
  const db = new DatabaseSync(store);
  const account = (subject) => db.prepare('SELECT account_id FROM provider_accounts_v1 WHERE subject = ?').get(subject).account_id;
  const scope = randomBytes(16).toString('hex');
  // X11's private tables, in its shape (v2/tools/import-accounts/src/lib.rs), and its row for Ada.
  db.exec(`CREATE TABLE IF NOT EXISTS imported_souls_v1(world TEXT NOT NULL, old_soul TEXT NOT NULL, soul TEXT NOT NULL UNIQUE,
      PRIMARY KEY(world, old_soul));
    CREATE TABLE IF NOT EXISTS souls_v1(soul TEXT PRIMARY KEY, account_id TEXT NOT NULL
      REFERENCES provider_accounts_v1(account_id), name TEXT NOT NULL, description TEXT NOT NULL, family TEXT NOT NULL,
      preset TEXT NOT NULL, look TEXT NOT NULL);`);
  db.prepare('INSERT INTO imported_souls_v1(world, old_soul, soul) VALUES (?, ?, ?)').run('eden', 's_ada', `${scope}:0`);
  db.prepare('INSERT INTO souls_v1 VALUES (?, ?, ?, ?, ?, ?, ?)').run(`${scope}:0`, account('Ada owner'), 'Ada', '', 'eden:humanoid', 'default', 'ab'.repeat(32));
  db.close();
  d = await directoryd();

  // The request is checked: a former Soul names its world, and names nothing else.
  const ask = { secret_hash: 'cd'.repeat(32), device: 'studio laptop', label: 'test agent', scope: 'soul' };
  assert.deepEqual((await post(d.origin, '/v1/pair/request', { ...ask, former: 's_ada' })).body, { refused: 'world' });
  assert.deepEqual((await post(d.origin, '/v1/pair/request', { ...ask, former: 's_ada', world: 'eden', new: true })).body, { refused: 'request' });
  assert.deepEqual((await post(d.origin, '/v1/pair/request', { ...ask, former: '../x', world: 'eden' })).body, { refused: 'former' });

  // R18's client, as `souls.mjs upgrade` runs it; the owner approves from the card, signed in.
  const cards = [];
  const approve = (person) => async ({ code }) => {
    cards.push((await post(d.origin, '/v1/pair/show', { code, test_person: person })).body);
    return post(d.origin, '/v1/pair/approve', { code, confirm: true, test_person: person });
  };
  const run = (former, person) => {
    let approved;
    return pairFormer({
      directory: d.origin, world: 'eden', former, device: 'studio laptop', label: 'test agent',
      onAsk: (a) => { approved = approve(person)(a); },
      sleep: async (ms) => { await approved; await new Promise((r) => setTimeout(r, ms)); },
    }).then((got) => ({ got }), (e) => ({ refused: e.code }));
  };
  const [ada, other, nobody] = await Promise.all([run('s_ada', 'Ada owner'), run('s_ada', 'Someone else'), run('s_nobody', 'Ada owner')]);

  // The owner's approval: the Soul X11 brought over, its token, and the former id said back.
  const grant = `soul-${scope}-0`;
  assert.equal(ada.got?.grant, grant, JSON.stringify(ada));
  assert.equal(ada.got.former, 's_ada');
  assert.match(ada.got.token, new RegExp(`^${grant}\\.[0-9a-f]{64}$`));
  const hash = createHash('sha256').update(ada.got.token).digest('hex');
  assert.ok(readFileSync(tokens, 'utf8').split('\n').includes(`${grant} ${hash}`), 'the gateway knows the new token');
  assert.ok(cards.some((c) => c.former === 's_ada' && c.soul === null), 'the card names the former Soul');
  const listed = (await post(d.origin, '/v1/account/souls', { test_person: 'Ada owner' })).body.souls;
  assert.deepEqual(listed.map((s) => [s.soul, s.device, s.world]), [[grant, 'studio laptop', 'eden']]);
  // Another account, or a former id X11 did not bring over: refused by name, and no Soul is made.
  assert.deepEqual([other, nobody], [{ refused: 'unknown-soul' }, { refused: 'unknown-soul' }]);
  assert.deepEqual((await post(d.origin, '/v1/account/souls', { test_person: 'Someone else' })).body.souls, []);
  await d.stop();
});


test('R18c: actual importer and directory preserve a former Soul across distinct world names', async (t) => {
  const base=join(dir,'real-import'), backup=join(base,'backup'), out=join(base,'out');mkdirSync(join(backup,'worlds'),{recursive:true});
  const owner='acct_00000000-0000-4000-8000-00000000000a', stranger='acct_00000000-0000-4000-8000-00000000000b';
  const worldId='world-internal-7', slug='public-eden', alias='my-eden';
  // Existing import-accounts/tests/owned.rs backup shape: synthetic source rows, never imported-map fabrication.
  for(const [name,rows] of [['accounts.sqlite',[[owner,'Ada owner'],[stranger,'Someone else']]],['forks-accounts.sqlite',[]]]){
    const db=new DatabaseSync(join(backup,name));db.exec('CREATE TABLE provider_accounts_v1(account_id TEXT PRIMARY KEY,issuer TEXT,subject TEXT,created_at INTEGER)');
    for(const [id,subject]of rows)db.prepare('INSERT INTO provider_accounts_v1 VALUES (?, ?, ?, 0)').run(id,'test:local',subject);db.close();
  }
  writeFileSync(join(backup,'worlds.json'),JSON.stringify([{slug,owner}]));
  const old=new DatabaseSync(join(backup,'worlds',slug+'.db'));
  old.exec('CREATE TABLE worlds(id TEXT PRIMARY KEY); CREATE TABLE snapshots(world_id TEXT,tick INTEGER,snapshot TEXT); CREATE TABLE souls(id TEXT,world_id TEXT,owner TEXT,entity_id TEXT,name TEXT,description TEXT,retired_at INTEGER,created_at INTEGER)');
  old.prepare('INSERT INTO worlds VALUES (?)').run(worldId);
  old.prepare('INSERT INTO souls VALUES (?, ?, ?, ?, ?, ?, NULL, 0)').run('s_ada',worldId,owner,'s_ada','Ada','kept identity');old.close();
  const importer=process.env.IMPORT_ACCOUNTS??join(v2,'target/debug/import-accounts');
  await new Promise((ok,fail)=>{
    const p=spawn(importer,[backup,'--out',out,'--json'],{stdio:['ignore','pipe','pipe']});procs.add(p);let stdout='',stderr='';
    p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.once('error',fail);
    p.once('exit',code=>{procs.delete(p);if(code!==0)return fail(Error('actual importer failed: '+stderr));try{assert.equal(JSON.parse(stdout).clean,true);ok();}catch(e){fail(e);}});
  });
  const imported=new DatabaseSync(join(out,'accounts.sqlite'));
  const mapped=imported.prepare('SELECT soul FROM imported_souls_v1 WHERE world=? AND old_soul=?').get(worldId,'s_ada').soul;
  const before=imported.prepare('SELECT COUNT(*) AS n FROM souls_v1').get().n;imported.close();
  let d=await directoryd({storePath:join(out,'accounts.sqlite'),tokensPath:join(base,'gateway-tokens'),pairingPath:join(base,'pairing.sqlite')});t.after(async()=>{if(d)await d.stop();});
  const url=d.origin+'/w/'+slug;
  const home=join(base,'.souls');mkdirSync(join(home,'souls','s_ada'),{recursive:true});
  writeFileSync(join(home,'config.json'),JSON.stringify({worlds:{[alias]:{url,worldId}},souls:{s_ada:{state:'active',world:alias}}}));
  writeFileSync(join(home,'credentials.json'),JSON.stringify({souls:{s_ada:{[alias]:{token:'sim_synthetic'}}}}),{mode:0o600});
  writeFileSync(join(home,'souls','s_ada','memory.txt'),'the original memory');
  const approve=person=>({code})=>post(d.origin,'/v1/pair/approve',{code,confirm:true,test_person:person});
  const crossing=async(person,world,former='s_ada')=>{
    let approved;
    return pairFormer({directory:d.origin,world,former,device:'fixture device',label:'R18c',onAsk:a=>{approved=approve(person)(a);},sleep:async(ms)=>{await approved;await new Promise(r=>setTimeout(r,ms));}}).then(got=>({got}),e=>({refused:e.code}));
  };
  assert.deepEqual(await crossing('Someone else',worldId),{refused:'unknown-soul'});
  assert.deepEqual(await crossing('Ada owner','another-world'),{refused:'unknown-soul'});
  assert.deepEqual(await crossing('Ada owner',worldId,'s_absent'),{refused:'unknown-soul'});
  let approved;
  // This isolated identity fixture has no public proxy; gateway connectivity is covered by R18d's served journey.
  const get=async(at,options)=>{assert.equal(at,url+'/v1/bootstrap');const {signal,...security}=options;assert.ok(signal instanceof AbortSignal);assert.deepEqual(security,{redirect:'error',credentials:'omit',cache:'no-store'});return Response.json({world:slug,directory:'/',gateway:'/w/'+slug+'/v2/ws'});};
  const upgraded=await upgradeHome({home,get,device:'fixture device',onAsk:a=>{approved=approve('Ada owner')(a);},sleep:async(ms)=>{await approved;await new Promise(r=>setTimeout(r,ms));}});
  const grant='soul-'+mapped.replace(':','-'),id='s_'+mapped.replace(':','-');
  assert.deepEqual(upgraded.souls,[{formerly:'s_ada',soul:id}]);
  assert.equal(readFileSync(join(home,'souls',id,'memory.txt'),'utf8'),'the original memory');
  const config=JSON.parse(readFileSync(join(home,'config.json')));assert.deepEqual(Object.keys(config.worlds),[alias]);assert.equal(config.worlds[alias].worldId,worldId);
  const listed=(await post(d.origin,'/v1/account/souls',{test_person:'Ada owner'})).body.souls;
  assert.deepEqual(listed.map(s=>[s.soul,s.device,s.world]),[[grant,'fixture device',worldId]]);
  assert.deepEqual((await post(d.origin,'/v1/account/souls',{test_person:'Someone else'})).body.souls,[]);
  await d.stop();d=null;
  const check=new DatabaseSync(join(out,'accounts.sqlite'));assert.equal(check.prepare('SELECT COUNT(*) AS n FROM souls_v1').get().n,before,'no replacement Soul minted');check.close();
});
