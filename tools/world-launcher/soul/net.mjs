// net.mjs: how the client reaches a world, directly or through the proxy its environment names (HTTPS_PROXY, HTTP_PROXY
// and NO_PROXY, either case). Node 18+ and no dependency: Node's own `proxyEnv` where the runtime has it, otherwise CONNECT
// through the proxy and TLS to the world over that tunnel. Every request stays HTTP/1.1 on a kept-alive agent.
// A proxy's address and credentials are never said: an error on the way through one names its code only.
//
// Edit this file, then run `node tools/world-launcher/soul/inline.mjs`: worlds serve eden.mjs as one file, so this module
// lives inside it as a generated block.

import { request as httpRequest, Agent as HttpAgent } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Readable } from "node:stream";

const pick = (env, name) => env[name] || env[name.toUpperCase()] || "";
/** Hosts that never go through a proxy, whatever NO_PROXY says. */
export const ALWAYS_DIRECT = ["localhost", "127.0.0.1", "::1"];

/** NO_PROXY: `*`, a host, or `.domain` / `domain` (it and every host under it), each with an optional `:port`. */
export function bypassed(url, env = process.env) {
  const u = new URL(url), host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (ALWAYS_DIRECT.includes(host)) return true;
  for (const entry of pick(env, "no_proxy").toLowerCase().split(/[\s,]+/)) {
    if (entry === "*") return true;
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
    if (!m || (m[2] && m[2] !== port)) continue;
    const name = m[1].replace(/^\[|\]$/g, "").replace(/^\*?\./, "");
    if (name && (host === name || host.endsWith(`.${name}`))) return true;
  }
  return false;
}
/** The proxy a request to `url` goes through, as a URL, or null when it goes direct. */
export function proxyFor(url, env = process.env) {
  const u = new URL(url), named = pick(env, u.protocol === "https:" ? "https_proxy" : "http_proxy");
  if (!named || bypassed(u, env)) return null;
  try { const p = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(named) ? named : `http://${named}`); return p.protocol === "http:" || p.protocol === "https:" ? p : null; }
  catch { return null; }
}
/** The environment variable that names the proxy for `url`, for a message: the name, never its value. */
export const proxyVariable = (url) => (new URL(url).protocol === "https:" ? "HTTPS_PROXY" : "HTTP_PROXY");

/** Node's own proxy support (`proxyEnv` on an Agent: Node 24.5 and later). Elsewhere the tunnel below does the same. */
export const NATIVE_PROXY = (() => {
  try { const a = new HttpsAgent({ proxyEnv: { HTTPS_PROXY: "http://127.0.0.1:9" } }); return Object.getOwnPropertySymbols(a).some((s) => s.description === "kProxyConfig" && !!a[s]); }
  catch { return false; }
})();
const native = () => NATIVE_PROXY && process.env.EDEN_PROXY_TUNNEL !== "1";   // tests force the tunnel on a runtime that has proxyEnv

const authOf = (p) => (p.username || p.password ? `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64")}` : null);
const tunnelRefused = (status) => Object.assign(new Error(status ? `the proxy refused the tunnel (${status})` : "the proxy did not answer the tunnel in HTTP"), { code: "ERR_PROXY_TUNNEL", status });

/** HTTPS through a proxy without Node's proxyEnv: CONNECT host:port, then TLS to the world (its own servername) inside it.
 *  The agent keeps the tunnelled sockets alive like any other. */
class TunnelAgent extends HttpsAgent {
  constructor(proxy, options) { super(options); this.proxy = proxy; }
  createConnection(options, done) {
    const p = this.proxy, secure = p.protocol === "https:", port = Number(p.port) || (secure ? 443 : 80), auth = authOf(p);
    const host = String(options.host ?? "localhost"), target = `${host.includes(":") ? `[${host}]` : host}:${options.port || 443}`;
    const raw = secure ? tlsConnect({ host: p.hostname, port, servername: isIP(p.hostname) ? undefined : p.hostname }) : netConnect({ host: p.hostname, port });
    let head = Buffer.alloc(0), settled = false;
    const fail = (e) => { if (settled) return; settled = true; raw.destroy(); done(e); };
    raw.setTimeout(30_000, () => fail(Object.assign(new Error("the proxy did not answer"), { code: "ETIMEDOUT" })));
    raw.on("error", fail);
    raw.once(secure ? "secureConnect" : "connect", () => raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`));
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) { if (head.length > 16_384) fail(tunnelRefused(0)); return; }
      raw.removeListener("data", onData); raw.pause(); raw.setTimeout(0);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString("latin1"))?.[1] ?? 0);
      if (status !== 200) { fail(tunnelRefused(status)); return; }
      if (head.length > end + 4) raw.unshift(head.subarray(end + 4));
      settled = true; raw.removeListener("error", fail);
      done(null, tlsConnect({ ...options, socket: raw, servername: options.servername || (isIP(host) ? undefined : host) }));
    };
    raw.on("data", onData);
    return undefined;
  }
}

const DIRECT = { "http:": new HttpAgent({ keepAlive: true }), "https:": new HttpsAgent({ keepAlive: true }) };
const AGENTS = new Map();
function agentFor(u, proxy) {
  if (!proxy) return DIRECT[u.protocol];
  const key = `${u.protocol} ${native() ? "native" : "tunnel"} ${proxy.href}`;
  if (!AGENTS.has(key)) {
    const keepAlive = true;
    AGENTS.set(key, native() ? new (u.protocol === "https:" ? HttpsAgent : HttpAgent)({ keepAlive, proxyEnv: { HTTPS_PROXY: proxy.href, HTTP_PROXY: proxy.href } })
      : u.protocol === "https:" ? new TunnelAgent(proxy, { keepAlive }) : new (proxy.protocol === "https:" ? HttpsAgent : HttpAgent)({ keepAlive }));
  }
  return AGENTS.get(key);
}

/** Codes that mean the proxy (or the world through it) could not be reached at all: asking again soon does not help. */
export const CANNOT_REACH = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ERR_PROXY_TUNNEL", "ERR_PROXY_INVALID_CONFIG"]);
/** An error on the way through a proxy, said by its code only. An abort or a timeout is passed on as it is. */
export function throughProxy(e) {
  if (!e || e.proxied || e.name === "AbortError" || e.name === "TimeoutError") return e;
  const code = String(e.code ?? e.cause?.code ?? "ERR_PROXY"), status = Number(e.status ?? e.statusCode) || 0;
  // a tunnel the proxy refused for policy or credentials will be refused again; a 5xx from it may be a world restarting
  const cannotReach = CANNOT_REACH.has(code) && !(code === "ERR_PROXY_TUNNEL" && status >= 500);
  return Object.assign(new Error(`could not reach the world through the proxy (${code}${status ? ` ${status}` : ""})`), { code, proxied: true, cannotReach });
}

/** One HTTP/1.1 request, like http.request(url, options, onResponse), direct or through the proxy the environment names for
 *  `url`. `req.proxied` says which; an error on a proxied request goes through throughProxy. */
export function send(url, options, onResponse) {
  const u = new URL(url), proxy = proxyFor(u);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`unsupported protocol ${u.protocol}`);
  const agent = agentFor(u, proxy);
  let req;
  if (proxy && u.protocol === "http:" && !native()) {
    // plain HTTP through a proxy: the request goes to the proxy, in absolute form
    const auth = authOf(proxy), to = new URL(u.href); to.username = ""; to.password = "";
    req = (proxy.protocol === "https:" ? httpsRequest : httpRequest)({ protocol: proxy.protocol, hostname: proxy.hostname, port: proxy.port || undefined, path: to.href, method: options.method, agent,
      headers: { host: u.host, ...options.headers, ...(auth ? { "proxy-authorization": auth } : {}) } }, onResponse);
  } else req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, { ...options, agent }, onResponse);
  req.proxied = !!proxy;
  return req;
}

/** fetch, through the proxy when the environment names one for the URL; otherwise the runtime's own fetch, untouched.
 *  The proxied answer is a real Response with a streamed body, so an event stream reads the same either way. */
export function netFetch(input, init) { return fetchVia(input, init, 0); }
async function fetchVia(input, init, hops) {
  if (!proxyFor(typeof input === "string" || input instanceof URL ? String(input) : input.url)) return globalThis.fetch(input, init);
  const rq = new Request(input, init), signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const body = rq.body ? Buffer.from(await rq.arrayBuffer()) : null, headers = Object.fromEntries(rq.headers);
  delete headers["accept-encoding"];   // the answer comes as it is, so nothing here has to undo a compression
  if (body) headers["content-length"] = String(body.length);
  const res = await new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const req = send(rq.url, { method: rq.method, headers }, resolve);
    const onAbort = () => req.destroy(signal.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (e) => { signal?.removeEventListener("abort", onAbort); reject(throughProxy(e)); });
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    req.end(body ?? undefined);
  });
  const status = res.statusCode ?? 0;
  if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && rq.redirect !== "manual") {
    res.resume();
    if (rq.redirect === "error" || hops >= 20) throw new TypeError("fetch failed", { cause: new Error(rq.redirect === "error" ? "unexpected redirect" : "redirect count exceeded") });
    const toGet = status === 303 || ((status === 301 || status === 302) && rq.method === "POST");
    return fetchVia(new URL(res.headers.location, rq.url).href, { method: toGet ? "GET" : rq.method, headers: rq.headers, body: toGet ? undefined : body ?? undefined, redirect: rq.redirect, signal }, hops + 1);
  }
  const h = new Headers();
  for (let i = 0; i < res.rawHeaders.length; i += 2) { try { h.append(res.rawHeaders[i], res.rawHeaders[i + 1]); } catch { /* a header fetch would not carry */ } }
  const empty = rq.method === "HEAD" || status === 204 || status === 205 || status === 304;
  if (empty) res.resume();
  return new Response(empty ? null : Readable.toWeb(res), { status, statusText: res.statusMessage, headers: h });
}
