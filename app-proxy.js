'use strict';
// app-proxy — one shared HTTP(S)/SOCKS proxy with per-app selection.
// Lets the user route individual music services (Spotify, YouTube Music,
// Deezer, SoundCloud) through a proxy where they're geo-blocked, while
// everything else connects directly. Master `enabled` switch kills all of it.
//
// Two transport mechanisms are provided because the codebase has two kinds
// of outbound callers:
//   - global fetch() callers   -> undici ProxyAgent attached as `dispatcher`
//   - http/https.request callers -> CONNECT-tunneling Agent attached as `agent`
// applyToOptions attaches BOTH keys; each caller type simply picks its own.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');

const PROXY_CONFIG_FILE = path.join(__dirname, 'data', 'app-proxy.json');

// EN-FORK: itunes and archive are opt-in here. They reach the network without a
// proxy, so they stay off by default and the user only enables them if their
// network needs it.
const PROXY_APPS = ['spotify', 'ytmusic', 'deezer', 'soundcloud', 'itunes', 'archive'];
const PROXY_PROTOCOLS = ['http', 'https', 'socks5'];

// ---------------------------------------------------------------------------
// EN-FORK: a dead proxy must not be able to switch off a working source.
//
// Measured on the user's own machine: proxy 192.168.1.99:10808 stopped
// answering (TCP connect timed out) while archive.org answered DIRECT in
// 1362ms, itunes.apple.com in 1046ms and lrclib.net in 565ms. Because
// itunes/archive were still ticked in the saved config, every request to the
// only two full-length sources on the network hung until it timed out. The
// archive search caught the failure, reported zero results, and the UI fell
// back to previews — the whole "every song is a 30-second preview" report, plus
// a dead login modal and empty lyrics, from one stopped proxy.
//
// So the two keyless sources are allowed to bypass a proxy that is not
// answering. They need no proxy to begin with (that is the point of them), and
// a direct route is always available for them. The proxied streaming services
// keep the strict behaviour: a user who deliberately routed Spotify through a
// proxy must not have it silently bypassed, because a blocked region fails
// direct too.
// ---------------------------------------------------------------------------
const KEYLESS_DIRECT_FALLBACK_APPS = ['itunes', 'archive'];

// How long a failed proxy is assumed dead before it is tried again, and how
// long a successful one is trusted before re-probing. Long enough that a
// restarted local proxy is picked up without a manual save, short enough that a
// proxy that comes back mid-session starts being used again on its own.
const PROXY_UNREACHABLE_TTL_MS = 60 * 1000;
const PROXY_PROBE_TTL_MS = 5 * 60 * 1000;
const PROXY_PROBE_TIMEOUT_MS = 2500;

let proxyHostState = null; // { key, reachable, checkedAt }

const DEFAULT_CONFIG = {
  enabled: false,
  protocol: 'http',
  host: '',
  port: 0,
  username: '',
  password: '',
  apps: { spotify: true, ytmusic: true, deezer: true, soundcloud: true, itunes: false, archive: false },
};

let cachedConfig = null;

function loadConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    const raw = JSON.parse(fs.readFileSync(PROXY_CONFIG_FILE, 'utf8'));
    cachedConfig = normalizeConfig(raw);
  } catch (_) {
    cachedConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  return cachedConfig;
}

function normalizeApps(rawApps) {
  const apps = {};
  for (const app of PROXY_APPS) {
    apps[app] = !!(rawApps && typeof rawApps === 'object' && rawApps[app] === true);
  }
  return apps;
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const protocol = String(src.protocol || DEFAULT_CONFIG.protocol).toLowerCase().trim();
  const port = Math.floor(Number(src.port) || 0);
  return {
    enabled: src.enabled === true,
    protocol: PROXY_PROTOCOLS.includes(protocol) ? protocol : 'http',
    host: String(src.host || '').trim(),
    port: port >= 1 && port <= 65535 ? port : 0,
    username: String(src.username || '').trim(),
    password: String(src.password || ''),
    apps: normalizeApps(src.apps),
  };
}

function saveConfig(input) {
  const base = loadConfig();
  let src = typeof input === 'object' && input !== null ? Object.assign({}, input) : {};
  // Password omitted/blank => keep the stored one (UI masks it as ********).
  if (src.password === undefined || src.password === '') src.password = base.password;
  const next = normalizeConfig(Object.assign({}, base, src));
  if (next.host && /\s/.test(next.host)) throw new Error('Proxy host must not contain spaces');
  if (!next.host) next.enabled = false;
  if (next.enabled && !next.port) throw new Error('Proxy port must be between 1 and 65535');
  fs.mkdirSync(path.dirname(PROXY_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(PROXY_CONFIG_FILE, JSON.stringify(next, null, 2));
  cachedConfig = next;
  agentsCache.clear();
  undiciAgentCache = null;
  // A save means the user just changed the endpoint; the old verdict was about
  // the previous host and must not be carried across.
  proxyHostState = null;
  startProxyHostProbe(next);
  return next;
}

function clearConfig() {
  try { fs.unlinkSync(PROXY_CONFIG_FILE); } catch (_) {}
  cachedConfig = null;
  agentsCache.clear();
  undiciAgentCache = null;
  proxyHostState = null;
}

function isSelectedFor(config, appName) {
  return !!(config.enabled && config.host && config.port && appName && config.apps[appName]);
}

function proxyKey(config) {
  return `${config.protocol}|${config.host}|${config.port}`;
}

function markProxyHostUnreachable(config) {
  if (!config || !config.host) return false;
  const key = proxyKey(config);
  const same = proxyHostState && proxyHostState.key === key;
  // Never let a stale result for a DIFFERENT host decide about this one.
  if (same && !proxyHostState.reachable && Date.now() - proxyHostState.checkedAt < PROXY_UNREACHABLE_TTL_MS) return true;
  proxyHostState = { key, reachable: false, checkedAt: Date.now() };
  // The tunnel agent was built for a host that is no longer answering; drop it
  // so a later probe that succeeds starts from a clean connection.
  agentsCache.clear();
  return true;
}

function markProxyHostReachable(config) {
  if (!config || !config.host) return false;
  const key = proxyKey(config);
  const wasDown = proxyHostState && proxyHostState.key === key && !proxyHostState.reachable;
  proxyHostState = { key, reachable: true, checkedAt: Date.now() };
  if (wasDown) { agentsCache.clear(); undiciAgentCache = null; }
  return true;
}

// True only when a probe against THIS host/port has recently failed. Unknown
// is not unreachable: a proxy that has never been probed is still assumed good,
// so the user's explicit selection is honoured until there is evidence against.
function proxyHostIsUnreachable(config) {
  if (!config || !config.host || !config.port) return false;
  if (!proxyHostState || proxyHostState.key !== proxyKey(config)) return false;
  if (proxyHostState.reachable) return false;
  return Date.now() - proxyHostState.checkedAt < PROXY_UNREACHABLE_TTL_MS;
}

let proxyProbeInFlight = false;
// A TCP connect to the proxy's own port: no tunnel, no target host, no DNS for
// anything but the proxy. The fastest way to learn the proxy process is alive,
// which is the difference between "the proxy is running" and "nobody is
// listening on 192.168.1.99:10808" — the exact distinction that cost the
// user every full-length source.
function probeProxyHost(config) {
  if (!config || !config.host || !config.port || proxyProbeInFlight) return Promise.resolve(null);
  if (proxyHostState && proxyHostState.key === proxyKey(config) &&
      Date.now() - proxyHostState.checkedAt < PROXY_PROBE_TTL_MS) {
    return Promise.resolve(proxyHostState);
  }
  proxyProbeInFlight = true;
  return new Promise((resolve) => {
    let settled = false;
    const done = (reachable) => {
      if (settled) return;
      settled = true;
      proxyProbeInFlight = false;
      if (reachable) markProxyHostReachable(config); else markProxyHostUnreachable(config);
      resolve(proxyHostState);
    };
    let socket;
    try {
      socket = require('net').connect({ host: config.host, port: config.port });
    } catch (_) {
      done(false);
      return;
    }
    const timer = setTimeout(() => { try { socket.destroy(); } catch (_) {} done(false); }, PROXY_PROBE_TIMEOUT_MS);
    socket.once('connect', () => { clearTimeout(timer); try { socket.destroy(); } catch (_) {} done(true); });
    socket.once('error', () => { clearTimeout(timer); try { socket.destroy(); } catch (_) {} done(false); });
  }).catch(() => { proxyProbeInFlight = false; return null; });
}

function startProxyHostProbe(config) {
  // Fire and forget: applyToOptions is synchronous and callers must never wait
  // on a probe. The result is read by the NEXT request, so the cost of a dead
  // proxy is one request, not every request.
  probeProxyHost(config).catch(() => {});
}

function proxyAuthority(config) {
  return `${config.host}:${config.port}`;
}

function proxyAuthHeader(config) {
  if (!config.username) return null;
  const cred = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  return `Basic ${cred}`;
}

// ---------------------------------------------------------------------------
// CONNECT-tunneling agent for http/https.request callers.
// Standard HTTPS-over-HTTP-proxy pattern: open a socket to the proxy, issue
// CONNECT host:port, then upgrade the socket to TLS toward the target.
// ---------------------------------------------------------------------------

class ProxyConnectAgent extends https.Agent {
  constructor(config) {
    super({ keepAlive: true });
    this.__proxyConfig = config;
  }

  createConnection(options, callback) {
    const config = this.__proxyConfig;
    const targetHost = options.host;
    const targetPort = Number(options.port) || 443;
    let done = false;
    const finish = (err, socket) => {
      if (done) return;
      done = true;
      // Any failure to reach the proxy is evidence the proxy is not answering.
      // The fetch() path has no equivalent hook (undici owns its own sockets),
      // so this agent failing is the only signal the keyless fallback gets.
      if (err) markProxyHostUnreachable(config);
      else markProxyHostReachable(config);
      callback(err, socket);
    };

    const connectOptions = {
      method: 'CONNECT',
      host: config.host,
      port: config.port,
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}`, 'Proxy-Connection': 'keep-alive' },
      timeout: 10000,
      setHost: false,
    };
    const authHeader = proxyAuthHeader(config);
    if (authHeader) connectOptions.headers['Proxy-Authorization'] = authHeader;

    const establish = (baseSocket) => {
      const upgraded = (config.protocol === 'https')
        ? tls.connect({
          socket: baseSocket,
          servername: config.host,
          rejectUnauthorized: true,
        })
        : baseSocket;
      if (upgraded !== baseSocket) upgraded.once('secureConnect', () => issueConnect(upgraded));
      else issueConnect(upgraded);

      function issueConnect(socket) {
        socket.write(
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          (authHeader ? `Proxy-Authorization: ${authHeader}\r\n` : '') +
          '\r\n'
        );
        let headerBuf = Buffer.alloc(0);
        const onData = (chunk) => {
          headerBuf = Buffer.concat([headerBuf, chunk]);
          const idx = headerBuf.indexOf('\r\n\r\n');
          if (idx === -1) {
            if (headerBuf.length > 16 * 1024) { cleanup(); finish(new Error('Proxy CONNECT response too large')); }
            return;
          }
          cleanup();
          const statusLine = headerBuf.slice(0, headerBuf.indexOf('\r\n')).toString('latin1');
          const statusCode = Number((statusLine.split(' ')[1] || '0'));
          const rest = headerBuf.slice(idx + 4); // leftover bytes (should be none pre-TLS)
          if (statusCode !== 200) {
            finish(new Error(`Proxy CONNECT failed (${statusCode})`));
            try { socket.destroy(); } catch (_) {}
            return;
          }
          const tlsSocket = tls.connect({
            socket,
            servername: targetHost,
            rejectUnauthorized: true,
          });
          tlsSocket.once('secureConnect', () => {
            if (rest && rest.length) tlsSocket.unshift(rest);
            finish(null, tlsSocket);
          });
          tlsSocket.once('error', (e) => finish(e));
        };
        const cleanup = () => socket.removeListener('data', onData);
        socket.on('data', onData);
        socket.once('error', (e) => { cleanup(); finish(e); });
        socket.once('close', () => { cleanup(); finish(new Error('Proxy connection closed during CONNECT')); });
      }
    };

    let baseSocket;
    if (config.protocol === 'https') {
      // Socket to the proxy itself is plain TCP here; TLS-to-proxy is applied
      // inside establish() before writing CONNECT.
      baseSocket = require('net').connect({ host: config.host, port: config.port });
      baseSocket.once('connect', () => establish(baseSocket));
      baseSocket.once('error', (e) => finish(e));
    } else {
      baseSocket = require('net').connect({ host: config.host, port: config.port }, () => establish(baseSocket));
      baseSocket.once('error', (e) => finish(e));
    }
  }
}

const agentsCache = new Map();
let undiciAgentCache = null;

function getTunnelAgent() {
  const config = loadConfig();
  if (config.protocol === 'socks5') return null; // SOCKS5 unsupported without extra deps
  const key = `${config.protocol}|${config.host}|${config.port}|${config.username}`;
  if (!agentsCache.has(key)) agentsCache.set(key, new ProxyConnectAgent(config));
  return agentsCache.get(key);
}

function getDispatcher() {
  const config = loadConfig();
  if (config.protocol === 'socks5') return null; // undici lacks SOCKS without deps
  try {
    const undici = require('undici');
    if (typeof undici.ProxyAgent !== 'function') return null;
    if (!undiciAgentCache) {
      const auth = config.username ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@` : '';
      undiciAgentCache = new undici.ProxyAgent(`${config.protocol}://${auth}${proxyAuthority(config)}`);
    }
    return undiciAgentCache;
  } catch (_) {
    return null;
  }
}

// Attach proxy transports when this app is selected. Returns opts untouched
// otherwise, so call sites never need to branch on whether proxying is active.
function applyToOptions(fetchOpts, appName) {
  const opts = fetchOpts || {};
  const config = loadConfig();
  if (!isSelectedFor(config, appName)) return opts;
  // Re-probe in the background on every use (TTL-gated) so a proxy that comes
  // back starts being used again without the user having to re-save anything.
  startProxyHostProbe(config);
  // The proxy is already known to be dead. The keyless apps (itunes, archive)
  // reach the network directly — measured 1362ms/1046ms/565ms direct vs a TCP
  // timeout through the proxy — so bypassing restores a working route for
  // free. Any other app keeps failing loudly instead of being silently
  // rerouted around a region block the user explicitly bridged.
  if (proxyHostIsUnreachable(config) && KEYLESS_DIRECT_FALLBACK_APPS.indexOf(appName) !== -1) {
    return opts;
  }
  const out = Object.assign({}, opts);
  const dispatcher = getDispatcher();
  if (dispatcher && !out.dispatcher) out.dispatcher = dispatcher;
  const agent = getTunnelAgent();
  if (agent && !out.agent) out.agent = agent;
  return out;
}

function status() {
  const config = loadConfig();
  const configured = !!(config.host && config.port);
  // "Configured and enabled" and "actually working" are different claims, and
  // only the second one is worth making to the user. Reporting the first as
  // "Active" is what let a stopped proxy look healthy for as long as it did.
  const hostUnreachable = proxyHostIsUnreachable(config);
  const active = !!(config.enabled && configured && config.protocol !== 'socks5') && !hostUnreachable;
  return {
    enabled: config.enabled,
    configured,
    protocol: config.protocol,
    hostLabel: configured ? `${config.host}:${config.port}` : '',
    hasAuth: !!(config.username || config.password),
    socksSupported: false,
    active,
    hostUnreachable,
    // Kept separate so the panel can say "not answering" without having to
    // infer it from active===false, which is also what a switched-off proxy says.
    savedActive: !!(config.enabled && configured && config.protocol !== 'socks5'),
    apps: Object.assign({}, config.apps),
  };
}

module.exports = {
  PROXY_APPS,
  loadConfig,
  saveConfig,
  clearConfig,
  normalizeConfig,
  getTunnelAgent,
  getDispatcher,
  applyToOptions,
  status,
};
