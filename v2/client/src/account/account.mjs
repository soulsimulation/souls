// W15: computer account connections. Tokens and pending poll credentials never leave credentials.json.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIALS, Refused } from '../home/home.mjs';
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
