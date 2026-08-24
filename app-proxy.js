'use strict';
// app-proxy — one shared HTTP(S)/SOCKS proxy with per-app selection.
// Lets the user route individual music services (Spotify, NetEase, QQ,
// Kugou, Soda/Qishui) through a proxy where they're geo-blocked, while
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

const PROXY_APPS = ['spotify', 'netease', 'qq', 'kugou', 'qishui'];
const PROXY_PROTOCOLS = ['http', 'https', 'socks5'];

const DEFAULT_CONFIG = {
  enabled: false,
  protocol: 'http',
  host: '',
  port: 0,
  username: '',
  password: '',
  apps: { spotify: true, netease: false, qq: false, kugou: false, qishui: false },
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
  return next;
}

function clearConfig() {
  try { fs.unlinkSync(PROXY_CONFIG_FILE); } catch (_) {}
  cachedConfig = null;
  agentsCache.clear();
  undiciAgentCache = null;
}

function isSelectedFor(config, appName) {
  return !!(config.enabled && config.host && config.port && appName && config.apps[appName]);
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
  return {
    enabled: config.enabled,
    configured,
    protocol: config.protocol,
    hostLabel: configured ? `${config.host}:${config.port}` : '',
    hasAuth: !!(config.username || config.password),
    socksSupported: false,
    active: !!(config.enabled && configured && config.protocol !== 'socks5'),
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
