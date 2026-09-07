'use strict';
// ============================================================
//  Remote config store (phone remote: inbox dir, library dirs,
//  pairing token, paired device tokens).
//
//  Backed by data/remote-config.json so paired phones survive PC
//  restarts. Writes are atomic (tmp + rename) and debounced; the
//  file is polled with fs.watchFile so external edits hot-reload.
// ============================================================
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'remote-config.json');
const MAX_DEVICES = 20;
const MAX_LIBRARY_DIRS = 5;
const SAVE_DEBOUNCE_MS = 250;
const WATCH_POLL_MS = 600;

// Defaults follow the legacy env-var setup: MINERADIO_MUSIC_DIR moves the
// data root, MINERADIO_LIBRARY_DIRS is a comma-separated list of extra
// read-only music folders.
function defaultInboxDir() {
  const base = process.env.MINERADIO_MUSIC_DIR || DATA_DIR;
  return path.join(base, 'music-inbox');
}

function envDefaultLibraryDirs() {
  return String(process.env.MINERADIO_LIBRARY_DIRS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(d => path.isAbsolute(d))
    .slice(0, MAX_LIBRARY_DIRS);
}

const DEFAULTS = {
  inboxDir: null, // null -> defaultInboxDir()
  libraryDirs: envDefaultLibraryDirs(),
  pairingToken: '',
  devices: {},
};

function normalizeDeviceMeta(meta) {
  return {
    pairedAt: Number(meta && meta.pairedAt) || Date.now(),
    name: String((meta && meta.name) || ''),
  };
}

function normalizeConfig(raw, previous) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const prev = previous && typeof previous === 'object' ? previous : null;

  let devices = {};
  if (src.devices && typeof src.devices === 'object') {
    for (const key of Object.keys(src.devices)) {
      const token = String(key || '').trim().toLowerCase();
      if (!/^[a-f0-9]{8,64}$/.test(token)) continue;
      devices[token] = normalizeDeviceMeta(src.devices[key]);
    }
  }
  let deviceEntries = Object.entries(devices);
  if (deviceEntries.length > MAX_DEVICES) {
    deviceEntries.sort((a, b) => (Number(a[1].pairedAt) || 0) - (Number(b[1].pairedAt) || 0));
    deviceEntries = deviceEntries.slice(deviceEntries.length - MAX_DEVICES);
  }
  const cappedDevices = {};
  for (const [token, meta] of deviceEntries) cappedDevices[token] = meta;

  // An invalid new value keeps the last known good one instead of wiping it.
  let pairingToken = String(src.pairingToken || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(pairingToken)) {
    const prevToken = prev ? String(prev.pairingToken || '').trim().toUpperCase() : '';
    pairingToken = /^[A-Z0-9]{4,12}$/.test(prevToken) ? prevToken : '';
  }

  let inboxDir = null;
  if (typeof src.inboxDir === 'string' && src.inboxDir.trim() && path.isAbsolute(src.inboxDir.trim())) {
    inboxDir = path.normalize(src.inboxDir.trim());
  } else if (src.inboxDir !== null && src.inboxDir !== undefined && src.inboxDir !== '') {
    const prevInbox = prev ? prev.inboxDir : null;
    if (typeof prevInbox === 'string' && prevInbox) inboxDir = prevInbox;
  }

  let libraryDirs = [];
  if (Array.isArray(src.libraryDirs)) {
    for (const entry of src.libraryDirs) {
      const dir = String(entry || '').trim();
      if (!dir || !path.isAbsolute(dir)) continue;
      const norm = path.normalize(dir);
      if (!libraryDirs.includes(norm)) libraryDirs.push(norm);
    }
  }
  libraryDirs = libraryDirs.slice(0, MAX_LIBRARY_DIRS);

  return { inboxDir, libraryDirs, pairingToken, devices: cappedDevices };
}

function readFileRaw() {
  try {
    let text = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM
    return text;
  } catch (_) {
    return '';
  }
}

let current = normalizeConfig((() => {
  const raw = readFileRaw().trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
})(), null);

const changeCallbacks = [];
let saveTimer = null;
let lastWrittenText = null;

function effective() {
  return Object.assign({}, current, {
    inboxDir: current.inboxDir || defaultInboxDir(),
    libraryDirs: current.libraryDirs.slice(),
    devices: Object.assign({}, current.devices),
  });
}

function load() {
  const raw = readFileRaw().trim();
  if (raw) {
    try {
      current = normalizeConfig(JSON.parse(raw), current);
    } catch (_) { /* keep last known good config */ }
  }
  return effective();
}

function serialize() {
  return JSON.stringify(current, null, 2) + '\n';
}

function persistNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const text = serialize();
  const tmpPath = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tmpPath, text, 'utf8');
    fs.renameSync(tmpPath, CONFIG_PATH);
    lastWrittenText = text;
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    console.error('[RemoteConfigStore] save failed:', err && (err.message || err));
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, SAVE_DEBOUNCE_MS);
}

// Merge a partial patch into the config, persist it (debounced) and return
// the resulting effective config.
function update(patch) {
  const merged = Object.assign({}, current, patch && typeof patch === 'object' ? patch : {});
  current = normalizeConfig(merged, current);
  scheduleSave();
  return effective();
}

function onChange(cb) {
  if (typeof cb !== 'function') return () => {};
  changeCallbacks.push(cb);
  return () => {
    const idx = changeCallbacks.indexOf(cb);
    if (idx >= 0) changeCallbacks.splice(idx, 1);
  };
}

// Poll the file so edits made outside this process hot-reload. Self-writes
// are recognized by their exact text and ignored.
try {
  fs.watchFile(CONFIG_PATH, { interval: WATCH_POLL_MS }, () => {
    const raw = readFileRaw().trim();
    if (!raw || raw === lastWrittenText) return;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { return; }
    current = normalizeConfig(parsed, current);
    lastWrittenText = raw;
    const snapshot = effective();
    for (const cb of changeCallbacks.slice()) {
      try { cb(snapshot); } catch (err) {
        console.error('[RemoteConfigStore] change listener failed:', err && (err.message || err));
      }
    }
  });
} catch (_) { /* polling unavailable; in-process updates still work */ }

module.exports = {
  CONFIG_PATH,
  DEFAULTS,
  load,
  update,
  effective,
  onChange,
  defaultInboxDir,
};
