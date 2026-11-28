#!/usr/bin/env node
// Safari on a real iPhone, over USB, through Apple's own safaridriver (WebDriver): open an address, send touch input,
// take screenshots. The phone needs Settings > Apps > Safari > Advanced > Remote Automation on, and to be unlocked and
// trusted by this Mac; safaridriver ships with macOS. Nothing here is a simulator or an emulated viewport.
//
// A local world's page is served on 127.0.0.1 only, so `privateDoor` puts a plain forwarder for it on one of this
// machine's private addresses (the LAN's or a tailnet's), which the phone can reach. It refuses any public address.
//
//   node tools/proof/drivers/phone-safari.mjs --page http://127.0.0.1:<port>/w/<world>/?<view> --out <folder>
//        [--address <private address of this machine>] [--shots 6] [--every 2000] [--drag]
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SAFARIDRIVER = '/System/Cryptexes/App/usr/bin/safaridriver';
/** The session a real iPhone's Safari is asked for (never the simulator). */
export const capabilities = () => ({ capabilities: { alwaysMatch: { browserName: 'safari', platformName: 'iOS', 'safari:useSimulator': false } } });
/** One finger down at the first point, through the rest over `ms`, then up: WebDriver's touch pointer. */
export function touchPath(points, ms = 600) {
  if (points.length < 1 || points.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) throw Error('phone.touch-points');
  const step = Math.round(ms / Math.max(1, points.length - 1)), at = ([x, y], duration) => ({ type: 'pointerMove', duration, x: Math.round(x), y: Math.round(y), origin: 'viewport' });
  return { actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: [at(points[0], 0), { type: 'pointerDown', button: 0 }, ...points.slice(1).map(p => at(p, step)), { type: 'pause', duration: 60 }, { type: 'pointerUp', button: 0 }] }] };
}
/** RFC 1918, link-local, loopback and the shared range tailnets use; nothing else may carry a local world's page. */
export function privateAddress(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}
/** This machine's private IPv4 addresses that are not loopback, the LAN's first. */
export const privateAddresses = (nets = networkInterfaces()) => Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal && privateAddress(n.address)).map(n => n.address)
  .sort((a, b) => Number(a.startsWith('100.')) - Number(b.startsWith('100.')));
/** Forwards `address:port` to the local page's own origin, as that origin (its Host), until closed. → {origin, close()} */
export async function privateDoor(target, address, port = 0) {
  if (!privateAddress(address) || address.startsWith('127.')) throw Error('phone.door-address-not-private');
  const to = new URL(target);
  if (to.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(to.hostname)) throw Error('phone.door-target-not-local');
  const server = createServer((req, res) => {
    const out = request({ host: to.hostname, port: to.port, method: req.method, path: req.url, headers: { ...req.headers, host: to.host } }, back => { res.writeHead(back.statusCode ?? 502, back.headers); back.pipe(res); });
    out.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(out);
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, address, ok); });
  return { origin: `http://${address}:${server.address().port}`, close: () => new Promise(ok => { server.closeAllConnections?.(); server.close(ok); }) };
}
/** A WebDriver session on the phone's Safari. `driver`: a running safaridriver's address. */
export async function phoneSafari({ driver = 'http://127.0.0.1:4723', ask = fetch } = {}) {
  const call = async (method, path, body) => {
    const r = await ask(driver + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), j = await r.json().catch(() => ({}));
    if (r.status >= 400 || j.value?.error) throw Error(`phone.${j.value?.error ?? r.status}: ${j.value?.message ?? ''}`.trim());
    return j.value;
  };
  const made = await call('POST', '/session', capabilities()), at = '/session/' + made.sessionId;
  return {
    device: { type: made.capabilities?.['safari:deviceType'] ?? null, os: made.capabilities?.['safari:platformVersion'] ?? null, browser: made.capabilities?.browserVersion ?? null },
    /** How long a page may take to load before `open` fails (ms); Safari's own default is five minutes. */
    loadWithin: ms => call('POST', at + '/timeouts', { pageLoad: ms }),
    open: url => call('POST', at + '/url', { url }),
    evaluate: (script, args = []) => call('POST', at + '/execute/sync', { script, args }),
    touch: (points, ms) => call('POST', at + '/actions', touchPath(points, ms)),
    async screenshot(file) { const png = Buffer.from(await call('GET', at + '/screenshot'), 'base64'); writeFileSync(file, png, { mode: 0o600 }); return png.length; },
    close: () => call('DELETE', at).catch(() => {}),
  };
}
/** Starts safaridriver on `port`; the caller stops the child. */
export async function startSafaridriver(port = 4723, bin = SAFARIDRIVER) {
  const child = spawn(bin, ['-p', String(port)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { if (await fetch(`http://127.0.0.1:${port}/status`).then(r => r.ok, () => false)) return child; await new Promise(r => setTimeout(r, 100)); }
  child.kill(); throw Error('phone.safaridriver-not-ready');
}

async function main(argv) {
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] ?? true : d; };
  const page = new URL(opt('page')), out = opt('out'), shots = Number(opt('shots', 6)), every = Number(opt('every', 2000));
  const address = opt('address', privateAddresses()[0]); if (!address) throw Error('phone.no-private-address');
  mkdirSync(out, { recursive: true });
  const door = await privateDoor(page.origin, address), driver = await startSafaridriver();
  let phone;
  try {
    phone = await phoneSafari();
    await phone.open(door.origin + page.pathname + page.search);
    const view = await phone.evaluate('return { width: innerWidth, height: innerHeight, ratio: devicePixelRatio, touch: navigator.maxTouchPoints, agent: navigator.userAgent.replace(/\\(.*?\\)/, "()") }');
    writeFileSync(join(out, 'phone.json'), JSON.stringify({ device: phone.device, view }, null, 1));
    for (let i = 1; i <= shots; i++) {
      await new Promise(r => setTimeout(r, every));
      if (opt('drag') && i === 2) await phone.touch([[view.width * .5, view.height * .55], [view.width * .6, view.height * .55], [view.width * .7, view.height * .57]], 500);
      await phone.screenshot(join(out, `phone-${String(i).padStart(2, '0')}.png`));
    }
  } finally { await phone?.close(); driver.kill(); await door.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
