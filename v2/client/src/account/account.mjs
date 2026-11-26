// W15: computer account connections. Tokens and pending poll credentials never leave credentials.json.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { request } from '../daemon/client.mjs';
import { CREDENTIALS, Refused, runtimeOf } from '../home/home.mjs';
import { pairAddress } from '../pair/address.mjs';
import { localId } from '../pair/pair.mjs';
import { writeGuide } from '../home/guide.mjs';

const ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
const fail = (code, detail) => { throw new Refused(code, detail); };
function read(home, name) {
  const path = join(home, name);
  try {
    if (name === CREDENTIALS && (statSync(path).mode & 0o777) !== 0o600) fail('credentials-too-open', 'credentials.json must be mode 600');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    if (e instanceof Refused) throw e;
    fail('home-unreadable', `${name} cannot be read`);
  }
}
function put(home, name, value) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, name), temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(temp, 0o600); renameSync(temp, file);
}
const option = (args, flag) => { const k = args.indexOf(flag); return k < 0 ? undefined : args[k + 1]; };
const has = (args, flag) => args.includes(flag);
const urlArg = (args) => args.find((s) => /^https?:\/\//.test(s));
const random = () => randomBytes(32).toString('base64url');
export async function addressOf(url, get = fetch) {
  let at; try { at = new URL(url); } catch { fail('account-world', 'name the world URL'); }
  const local = at.protocol === 'http:' && (at.hostname === 'localhost' || at.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(at.hostname));
  if ((at.protocol !== 'https:' && !local) || at.username || at.password) fail('account-not-https', 'account approval needs HTTPS or explicit HTTP loopback');
  return { ...(await pairAddress(at.href, get)), url: at.href };
}
async function post(address, path, body, token, send = fetch) {
  try {
    const r = await send(new URL(path, address.directory), {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    });
    const b = await r.json();
    if (!r.ok || b.refused) throw Object.assign(new Refused(b.refused ?? 'account-refused', b.device ? `connected to ${b.device}; use --move only to replace it` : 'account request refused'), { device: b.device });
    return b;
  } catch (e) {
    if (e instanceof Refused) throw e;
    fail('account-unavailable', 'account directory is unavailable; credentials are unchanged');
  }
}
function aliasOf(config, explicit) {
  const alias = explicit ?? config.activeAccount;
  if (!alias || !config.accounts?.[alias]) fail('account-not-connected', 'login first, or choose --as from accounts');
  return alias;
}
export function connectedAccounts(home) {
  const c = read(home, 'config.json'), creds = read(home, CREDENTIALS);
  return { ok: true, accounts: Object.entries(c.accounts ?? {}).filter(([alias]) => typeof creds.accounts?.[alias]?.token === 'string')
    .map(([alias, a]) => ({ alias, account: a.accountId, origin: a.origin, active: alias === c.activeAccount })) };
}
async function connection(home, explicit, { get = fetch } = {}) {
  const c = read(home, 'config.json'), alias = aliasOf(c, explicit), meta = c.accounts[alias];
  const token = read(home, CREDENTIALS).accounts?.[alias]?.token;
  if (typeof token !== 'string') fail('account-not-connected', 'this account has no connection; login again');
  const address = await addressOf(meta.url, get);
  if (address.directory !== meta.origin) fail('account-origin-changed', 'the stored account origin changed');
  return { alias, meta, token, address };
}
export async function login(home, args, { send = fetch, get = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let c = read(home, 'config.json'), creds = read(home, CREDENTIALS);
  const alias = option(args, '--as') ?? c.activeAccount ?? 'main';
  if (!ALIAS.test(alias)) fail('account-alias', 'choose a short account alias');
  let pending = creds.pendingLogins?.[alias];
  const supplied = urlArg(args);
  if (!pending && c.accounts?.[alias] && creds.accounts?.[alias]?.token && !has(args, '--again')) return { ok: true, connected: true, alias, then: 'list --account, adopt <name>, or pair <world URL>' };
  const address = await addressOf(supplied ?? pending?.url ?? c.accounts?.[alias]?.url, get);
  if (pending && pending.origin !== address.directory) fail('account-origin-changed', 'resume the pending login at its original origin');
  if (!c.device) { c.device = { id: `dev_${randomBytes(16).toString('hex')}`, name: option(args, '--device') ?? 'this computer' }; put(home, 'config.json', c); }
  if (!pending) {
    const label = option(args, '--label') ?? 'Souls agent';
    if (![...label].length || [...label].length > 120 || /[\x00-\x1f\x7f]/.test(label) || [...c.device.name].length > 60) fail('account-name', 'choose a device name up to 60 characters and an agent label up to 120');
    pending = { url: address.url, origin: address.directory, pollSecret: random(), idempotencyKey: random(), label, device: c.device };
    creds.pendingLogins = { ...creds.pendingLogins, [alias]: pending }; put(home, CREDENTIALS, creds);
  }
  if (!pending.requestId) {
    const asked = await post(address, '/v1/agent/account/login', { agentLabel: pending.label, device: pending.device, pollSecret: pending.pollSecret, idempotencyKey: pending.idempotencyKey }, null, send);
    const link = new URL(asked.approvalURL);
    if (link.origin !== address.directory || link.pathname !== '/pair' || link.searchParams.get('request') !== asked.request?.id) fail('account-approval-url', 'the directory returned an invalid approval link');
    pending = { ...pending, requestId: asked.request.id, approvalURL: link.href, code: asked.request.confirm, interval: asked.intervalSeconds ?? 3 };
    creds = read(home, CREDENTIALS); creds.pendingLogins = { ...creds.pendingLogins, [alias]: pending }; put(home, CREDENTIALS, creds);
  }
  if (has(args, '--cancel')) {
    await post(address, '/v1/agent/account/requests/cancel', { requestId: pending.requestId, pollSecret: pending.pollSecret }, null, send);
    delete creds.pendingLogins[alias]; put(home, CREDENTIALS, creds);
    return { ok: true, cancelled: true, alias };
  }
  if (!has(args, '--wait')) return { ok: true, step: 'approve-account', alias, link: pending.approvalURL, code: pending.code, then: 'Approve only if you started this, then run login --wait.' };
  for (;;) {
    const answer = await post(address, '/v1/agent/account/requests/poll', { requestId: pending.requestId, pollSecret: pending.pollSecret }, null, send);
    if (answer.request?.status === 'cancelled') { delete creds.pendingLogins[alias]; put(home, CREDENTIALS, creds); fail('account-login-cancelled', 'the account request ended'); }
    if (answer.request?.status === 'ready') {
      if (typeof answer.token !== 'string' || !answer.token.startsWith('sacct_') || typeof answer.account?.id !== 'string') fail('account-login-ended', 'this approval has ended; login --again');
      // A metadata alias never silently changes its account. A second account needs its own explicit alias.
      if (c.accounts?.[alias]?.accountId && c.accounts[alias].accountId !== answer.account.id) fail('account-alias-in-use', 'choose a new --as alias for this account');
      creds = read(home, CREDENTIALS); creds.accounts = { ...creds.accounts, [alias]: { token: answer.token } }; delete creds.pendingLogins[alias]; put(home, CREDENTIALS, creds);
      c = read(home, 'config.json'); c.accounts = { ...c.accounts, [alias]: { origin: address.directory, url: address.url, accountId: answer.account.id } }; c.activeAccount = alias; put(home, 'config.json', c);
      return { ok: true, connected: true, alias, then: 'list --account; adopt <name>; pair <world URL>' };
    }
    await sleep(pending.interval * 1000);
  }
}
export async function accountList(home, explicit, io = {}) {
  const a = await connection(home, explicit, io), b = await post(a.address, '/v1/agent/account', {}, a.token, io.send);
  if (b.account?.id !== a.meta.accountId) fail('account-mismatch', 'this account connection no longer matches');
  return { ok: true, alias: a.alias, souls: b.souls };
}
export async function accountPair(home, named, url, { as, move = false, fresh = false, send = fetch, get = fetch } = {}) {
  const c = read(home, 'config.json');
  const tag = Object.values(c.souls ?? {}).find((s) => s.id === named || s.name?.toLowerCase() === named?.toLowerCase())?.account;
  if (tag && as && tag !== as) fail('account-mismatch', 'this Soul belongs to a different connected account');
  const a = await connection(home, tag ?? as, { get });
  const listed = await post(a.address, '/v1/agent/account', {}, a.token, send);
  if (listed.account?.id !== a.meta.accountId) fail('account-mismatch', 'the connection account changed');
  let row;
  if (!fresh) {
    const grant = named?.startsWith('s_') ? `soul-${named.slice(2)}` : named;
    const matches = (listed.souls ?? []).filter((s) => s.id === grant || s.name?.toLowerCase() === named?.toLowerCase());
    if (matches.length !== 1) fail(matches.length ? 'which-soul' : 'not-yours', 'choose exactly one Soul from list --account');
    [row] = matches;
  }
  const address = await addressOf(url ?? a.meta.url, get);
  if (address.directory !== a.meta.origin) fail('account-origin-mismatch', 'this account connection cannot be sent to another origin');
  if (c.worlds?.[address.world]?.url && new URL(c.worlds[address.world].url).origin !== address.directory) fail('world-conflict', 'this home world key already names another origin');
  if (row?.world && row.world !== address.world) fail('soul-in-another-world', 'name the Soul’s exact world URL');
  const input = JSON.stringify([a.alias, address.world, fresh ? null : row.id, fresh, move]);
  let privateState = read(home, CREDENTIALS);
  let pending = privateState.pendingAccountPair;
  if (pending?.input !== input) {
    pending = { input, idempotencyKey: random() };
    privateState.pendingAccountPair = pending; put(home, CREDENTIALS, privateState);
  }
  const b = await post(address, '/v1/agent/account/pair', { world: address.world, ...(fresh ? { new: true } : { soul: row.id }), move, idempotencyKey: pending.idempotencyKey }, a.token, send);
  if (!/^soul-[0-9a-f]{32}-\d+$/.test(b.grant) || typeof b.token !== 'string' || !b.token.startsWith(`${b.grant}.`)) fail('pair-answer', 'invalid Soul credential answer');
  const soul = localId(b.grant), creds = read(home, CREDENTIALS), config = read(home, 'config.json');
  creds.souls = { ...creds.souls, [soul]: { ...creds.souls?.[soul], [address.world]: { token: b.token } } }; put(home, CREDENTIALS, creds);
  config.worlds = { ...config.worlds, [address.world]: { ...config.worlds?.[address.world], url: address.url, gateway: address.gateway } };
  config.souls = { ...config.souls, [soul]: { ...config.souls?.[soul], id: soul, account: a.alias, world: address.world, ...(row?.name ? { name: row.name } : {}) } }; put(home, 'config.json', config);
  privateState = read(home, CREDENTIALS); if (privateState.pendingAccountPair?.idempotencyKey === pending.idempotencyKey) delete privateState.pendingAccountPair; put(home, CREDENTIALS, privateState);
  let guide; try { guide = writeGuide(home); } catch { guide = { failed: 'guide unavailable; credentials are paired' }; }
  return { ok: true, paired: true, soul, alias: a.alias, guide, memoryTransferred: false, say: 'Credentials are on this computer. Existing memory here is unchanged; use export/import to move memory from another computer.' };
}
export const hasAccount = (home) => connectedAccounts(home).accounts.length > 0;

// #3707: the agent's own profile, retire and revoke, as today's client has them.
const grantOf = (soul) => (soul.startsWith('s_') ? `soul-${soul.slice(2)}` : soul);
const PICTURE_MOST = 262_144;
/** A Soul this home holds a token for: its token and the directory it was paired at. */
function seatOf(home, soul) {
  const worlds = read(home, CREDENTIALS).souls?.[soul] ?? {}, config = read(home, 'config.json');
  const key = Object.keys(worlds).find((k) => typeof worlds[k]?.token === 'string');
  if (!key) return null;
  let directory; try { directory = new URL(config.worlds?.[key]?.url).origin; } catch { fail('soul-world-unknown', 'this home does not know where the Soul was paired; adopt it again'); }
  return { token: worlds[key].token, address: { directory }, world: key };
}
/** A Soul of the connected account, by its local id, grant or name: its row in `list --account`. */
async function accountSoul(home, named, as, io) {
  const a = await connection(home, as, io), listed = await post(a.address, '/v1/agent/account', {}, a.token, io.send);
  if (listed.account?.id !== a.meta.accountId) fail('account-mismatch', 'this account connection no longer matches');
  const rows = (listed.souls ?? []).filter((s) => s.id === grantOf(named) || s.name?.toLowerCase() === String(named).toLowerCase());
  if (rows.length > 1) fail('which-soul', 'choose exactly one Soul from list --account, by its id');
  return { a, row: rows[0] ?? null };
}
/** `profile` | `profile name "<Name>"` | `profile description "<text>"` | `profile photo <file.png|.jpg>|auto`. */
export async function soulProfile(home, soul, args, io = {}) {
  const seat = seatOf(home, soul);
  if (!seat) fail('not-paired', 'this Soul has no token here; adopt it first');
  const [field, ...rest] = args, value = rest.join(' ').trim(), body = { token: seat.token };
  if (field !== undefined) {
    if (!['name', 'description', 'photo'].includes(field) || !value) fail('profile-usage', 'profile | profile name "Name" | profile description "Text" | profile photo <file.png|file.jpg|auto>');
    if (field === 'photo' && value === 'auto') body.picture = null;
    else if (field === 'photo') {
      const file = resolve(value);
      let st; try { st = lstatSync(file); } catch { fail('profile-photo', 'no such file'); }
      if (!st.isFile() || st.size > PICTURE_MOST || !/\.(png|jpe?g)$/i.test(file)) fail('profile-photo', 'profile photo takes a local PNG or JPEG of at most 256 KiB, max 512×512');
      body.picture = readFileSync(file).toString('base64url');
    } else body[field] = value;
  }
  const b = await post(seat.address, '/v1/pair/profile', body, null, io.send);
  // The home knows the Soul by its new name too (list, and a retire by name).
  if (body.name && b.profile?.name) { const c = read(home, 'config.json'); c.souls = { ...c.souls, [soul]: { ...c.souls?.[soul], id: soul, name: b.profile.name } }; put(home, 'config.json', c); }
  return { ok: true, soul, profile: { name: b.profile?.name ?? null, description: b.profile?.description ?? null, photo: b.profile?.picture ?? 'auto', retireAsked: !!b.profile?.retire_asked } };
}
/** Where the owner confirms a retire (0.137): the Soul's card on its world's page, signed in (there is no separate
 *  Souls page). `#soul/<id>` opens that card. */
const confirmAt = (directory, world, soul) => (directory && world ? `${directory}/w/${encodeURIComponent(world)}/${soul ? `#soul/${soul}` : ''}` : null);
/** `retire <name|id>` asks; the owner's click on the Soul's card decides. `retire wait` waits a minute for that click. */
export async function soulRetire(home, soul, named, { as, ...io } = {}) {
  const seat = soul ? seatOf(home, soul) : null;
  let grant, page;
  if (seat) { grant = (await post(seat.address, '/v1/pair/retire', { token: seat.token }, null, io.send), grantOf(soul)); page = confirmAt(seat.address.directory, seat.world, soul); }
  else {
    const { a, row } = await accountSoul(home, named, as, io);
    if (!row) fail('not-yours', 'choose a Soul from list --account');
    await post(a.address, '/v1/agent/account/retire', { soul: row.id }, a.token, io.send);
    grant = row.id;
    let origin = null; try { origin = new URL(a.address.directory).origin; } catch { origin = null; }
    page = confirmAt(origin, row.world, null);
  }
  const c = read(home, 'config.json'); c.pendingRetire = { soul: soul ?? null, grant, account: seat ? null : aliasOf(c, as) }; put(home, 'config.json', c);
  return { ok: true, retire: 'asked', soul: soul ?? grant, ...(page ? { page } : {}),
    next: `Ask your person to open ${page ?? "the Soul's world page"} signed in, click the Soul and press Retire for good on its card. Nothing is retired until they do. Then: retire wait` };
}
export async function soulRetireWait(home, { within = 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...io } = {}) {
  const p = read(home, 'config.json').pendingRetire;
  if (!p) fail('no-retire', 'no retire waits here; ask for one: retire <name>');
  const clear = (c = read(home, 'config.json')) => { delete c.pendingRetire; put(home, 'config.json', c); };
  for (const until = Date.now() + within; ;) {
    let state;
    if (p.account) {
      const { row } = await accountSoul(home, p.grant, p.account, io);
      state = !row ? 'retired' : row.retireAsked ? 'pending' : 'kept';
    } else {
      const seat = seatOf(home, p.soul);
      try { state = seat ? ((await post(seat.address, '/v1/pair/profile', { token: seat.token }, null, io.send)).profile?.retire_asked ? 'pending' : 'kept') : 'retired'; } catch (e) { if (e.code !== 'unknown-token') throw e; state = 'retired'; }
    }
    if (state === 'retired') {
      const creds = read(home, CREDENTIALS);
      if (p.soul && creds.souls?.[p.soul]) { delete creds.souls[p.soul]; put(home, CREDENTIALS, creds); }
      const c = read(home, 'config.json');
      if (p.soul) c.souls = { ...c.souls, [p.soul]: { ...c.souls?.[p.soul], retiredAt: new Date().toISOString() } };
      clear(c);
      // First day (26 Nov): its daemon stops and the folder's guide stops listing it, so nothing of it keeps running
      // (a plain `quit` no longer finds a retired Soul) and the next chat is not told it lives here.
      if (p.soul) await request(runtimeOf(home, p.soul).socket, { op: 'stop' }).catch(() => {});
      try { writeGuide(home); } catch { /* the guide is a convenience; the retire is done */ }
      return { ok: true, retire: 'done', soul: p.soul ?? p.grant, retired: true, ...(p.soul ? { here: 'its token is gone and its client stopped; its memory stays here' } : {}) };
    }
    // The owner's Keep on its card clears the ask (directory `/v1/account/souls/keep`).
    if (state === 'kept') { clear(); return { ok: true, retire: 'kept', soul: p.soul ?? p.grant, retired: false, why: 'Your person kept it. Nothing changed.' }; }
    if (Date.now() > until) return { ok: true, retire: 'pending', soul: p.soul ?? p.grant, next: 'retire wait' };
    await sleep(3000);
  }
}
/** `revoke <name|id>`: the Soul's agent is disconnected wherever it runs. If this home held it, it stays here unpaired. */
export async function soulRevoke(home, named, { as, ...io } = {}) {
  const { a, row } = await accountSoul(home, named, as, io);
  if (!row) fail('not-yours', 'choose a Soul from list --account');
  await post(a.address, '/v1/agent/account/revoke', { soul: row.id }, a.token, io.send);
  const id = `s_${row.id.slice('soul-'.length)}`, creds = read(home, CREDENTIALS), held = !!creds.souls?.[id];
  if (held) {
    await request(runtimeOf(home, id).socket, { op: 'stop' }).catch(() => {});
    delete creds.souls[id]; put(home, CREDENTIALS, creds);
    try { writeGuide(home); } catch { /* as retire's */ }
  }
  return { ok: true, revoked: true, soul: { id: row.id, name: row.name ?? null }, account: a.alias, ...(held ? { here: 'unpaired; its memory stays here' } : {}), next: `adopt ${row.name ?? row.id}   (brings it back here)` };
}
export async function accountCommand(home, command, args = [], io = {}) {
  if (command === 'login') return login(home, args, io);
  if (command === 'accounts') {
    const use = option(args, '--use');
    if (use) { const c = read(home, 'config.json'); aliasOf(c, use); if (!read(home, CREDENTIALS).accounts?.[use]?.token) fail('account-not-connected', 'login first'); c.activeAccount = use; put(home, 'config.json', c); }
    return connectedAccounts(home);
  }
  const a = await connection(home, option(args, '--as'), io);
  try { await post(a.address, '/v1/agent/account/logout', {}, a.token, io.send); } catch (e) { if (!['account.revoked', 'account.unknown'].includes(e.code)) throw e; }
  const creds = read(home, CREDENTIALS); delete creds.accounts[a.alias]; put(home, CREDENTIALS, creds);
  const c = read(home, 'config.json'); delete c.accounts[a.alias]; if (c.activeAccount === a.alias) delete c.activeAccount; put(home, 'config.json', c);
  return { ok: true, loggedOut: true, alias: a.alias, soulsUnchanged: true };
}
