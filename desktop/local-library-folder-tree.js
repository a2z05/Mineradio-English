// ============================================================
//  EN-FORK — the folder tree behind the Library page's Folders view.
//
//  The renderer cannot build this itself. A track's `relativePath` is relative
//  to *its own* scan root, and the record never says which root that was — so
//  "Album/track.mp3" is ambiguous the moment the library has two music folders.
//  Only this process knows `record.audioPath`, so the tree is built here and
//  the renderer receives labels, counts and opaque ids and nothing else.
//
//  A node id is `base64url(<root key>/<segments under that root>)`. Two roots
//  cannot collide because a registered root's key is a digest of its absolute
//  path and an unregistered one (a file imported by drag-and-drop) is a digest
//  of its own directory. Resolving an id rejoins it against the root and then
//  checks the result still sits inside that root, so a crafted id cannot be
//  turned into a path outside the library.
//
//  No absolute path is ever serialized: `label` is a single path segment and
//  `id` is opaque. The only absolute path this file produces is handed straight
//  to `shell` by the caller that asked for it.
//
//  Everything here is read-only.
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TREE_DEPTH = 24; // the scan stops at the same depth
const MAX_TREE_NODES = 200000;
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus']);

function digest(text) {
  return crypto.createHash('sha1').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
}

function normalizeFolder(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function isInside(candidate, root) {
  const child = normalizeFolder(candidate).toLowerCase();
  const parent = normalizeFolder(root).toLowerCase();
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.startsWith(`${parent}/`);
}

// The registered root a directory belongs to, or '' when it belongs to none.
function registeredRootOf(directory, roots) {
  const candidate = normalizeFolder(directory);
  if (!candidate) return '';
  let best = '';
  for (const root of roots) {
    const normalized = normalizeFolder(root);
    if (!normalized || !isInside(candidate, normalized)) continue;
    if (normalized.length > best.length) best = normalized;
  }
  return best;
}

function encodeId(text) {
  return Buffer.from(String(text || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeId(value) {
  const raw = String(value || '').trim();
  if (!raw || !/^[A-Za-z0-9_-]{1,4096}$/.test(raw)) return '';
  let text = '';
  try {
    text = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch (_) {
    return '';
  }
  if (!text || text.includes('\0')) return '';
  return text;
}

function segmentsOf(folder) {
  return normalizeFolder(folder).split('/').filter(Boolean);
}

// ---------------------------------------------------------------- building

// buildFolderTree(records, folders)
//   records: [{ id, audioPath }]  — every record in the index
//   folders: [absolute strings]   — the registered roots
//
// Returns { roots: [{ id, label, count, childCount, children, ... }], limited }.
// Children are nested plain objects, not maps, so the result is JSON-ready and
// the renderer never has to reassemble anything.
function buildFolderTree(records, folders) {
  const roots = (Array.isArray(folders) ? folders : [])
    .map(normalizeFolder)
    .filter(Boolean);
  const rootList = [];
  const rootByKey = new Map();

  const addRoot = (key, label, absolute, registered) => {
    const existing = rootByKey.get(key);
    if (existing) return existing;
    const node = {
      key, label, registered: !!registered, absolute: absolute || '', count: 0, children: new Map(),
    };
    rootByKey.set(key, node);
    rootList.push(node);
    return node;
  };
  for (const root of roots) addRoot(`r:${digest(root)}`, segmentsOf(root).pop() || root, root, true);

  let budget = MAX_TREE_NODES;
  let limited = false;
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || !record.audioPath) continue;
    budget -= 1;
    if (budget <= 0) { limited = true; break; }
    const directory = normalizeFolder(path.dirname(record.audioPath));
    if (!directory) continue;
    const owner = registeredRootOf(directory, roots);
    // A track no registered root claims gets a root of its own: a file the user
    // dropped in by hand must not disappear from the folder view just because
    // it never had a folder registered for it.
    const key = owner ? `r:${digest(owner)}` : `o:${digest(directory)}`;
    const root = owner
      ? (rootByKey.get(key) || addRoot(key, segmentsOf(owner).pop() || owner, owner, true))
      : addRoot(key, segmentsOf(directory).pop() || directory, directory, false);
    root.count += 1;

    const rest = owner ? directory.slice(owner.length + 1) : '';
    const segments = rest ? segmentsOf(rest) : [];
    let node = root;
    let prefix = root.key;
    for (let depth = 0; depth < segments.length; depth += 1) {
      prefix = `${prefix}/${segments[depth]}`;
      let child = node.children.get(prefix);
      if (!child) {
        child = { key: prefix, label: segments[depth], registered: false, absolute: '', count: 0, children: new Map() };
        node.children.set(prefix, child);
      }
      child.count += 1;
      node = child;
    }
  }

  const flatten = (node, depth) => {
    const children = Array.from(node.children.values())
      .map((child) => flatten(child, depth + 1))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
    return {
      id: encodeId(node.key),
      label: node.label,
      count: node.count,
      depth,
      registered: !!node.registered,
      childCount: children.length,
      children,
    };
  };

  const tree = rootList
    .filter((node) => node.count > 0 || node.registered)
    .map((node) => flatten(node, 0))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
  if (limited) tree.limited = true;
  return tree;
}

// ---------------------------------------------------------------- resolving

// resolveNodeId(id, records, folders) -> '' | absolute directory
//
// Ids only. The renderer never supplies a path, and every answer is re-checked
// against the root the id named before it leaves this function.
function resolveNodeId(id, records, folders) {
  const text = decodeId(id);
  if (!text) return '';
  const slash = text.indexOf('/');
  const rootKey = slash < 0 ? text : text.slice(0, slash);
  const rest = slash < 0 ? '' : text.slice(slash + 1);
  const roots = (Array.isArray(folders) ? folders : []).map(normalizeFolder).filter(Boolean);

  let absolute = '';
  if (rootKey.startsWith('r:')) {
    const root = roots.find((candidate) => `r:${digest(candidate)}` === rootKey);
    if (!root) return '';
    absolute = rest ? `${root}/${rest}` : root;
  } else if (rootKey.startsWith('o:')) {
    // An unregistered root is only recoverable from a record that lives in it.
    const owner = (Array.isArray(records) ? records : []).find((record) => record && record.audioPath
      && `o:${digest(normalizeFolder(path.dirname(record.audioPath)))}` === rootKey);
    if (!owner) return '';
    const directory = normalizeFolder(path.dirname(owner.audioPath));
    absolute = rest ? `${directory}/${rest}` : directory;
  } else {
    return '';
  }
  const rootAbs = rootKey.startsWith('r:')
    ? (roots.find((candidate) => `r:${digest(candidate)}` === rootKey) || '')
    : (function () {
      const owner = (Array.isArray(records) ? records : []).find((record) => record && record.audioPath
        && `o:${digest(normalizeFolder(path.dirname(record.audioPath)))}` === rootKey);
      return owner ? normalizeFolder(path.dirname(owner.audioPath)) : '';
    }());
  if (!rootAbs) return '';
  // The guard: a crafted id can name segments, but never segments that leave
  // the root it claimed to be inside.
  if (!isInside(absolute, rootAbs)) return '';
  return absolute;
}

// The smallest directory that contains every one of these tracks. Used to turn
// "rescan this folder node" into a path without ever asking the renderer for
// one: the ids come from rows the renderer already had, and the answer is a
// directory those rows provably live in.
function commonDirectoryOf(recordList) {
  const list = (Array.isArray(recordList) ? recordList : [])
    .map((record) => record && record.audioPath ? normalizeFolder(path.dirname(record.audioPath)) : '')
    .filter(Boolean);
  if (!list.length) return '';
  const first = segmentsOf(list[0]);
  let shared = first.length;
  for (let i = 1; i < list.length && shared > 0; i += 1) {
    const other = segmentsOf(list[i]);
    let at = 0;
    while (at < shared && at < other.length
      && other[at].toLowerCase() === first[at].toLowerCase()) at += 1;
    shared = at;
  }
  if (!shared) return '';
  return first.slice(0, shared).join('/');
}

async function listDirectoryEntries(directory) {
  let entries;
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (_) {
    return { ok: false, directories: [], files: [], error: 'LOCAL_FOLDER_UNREADABLE' };
  }
  const directories = [];
  const files = [];
  for (const entry of entries) {
    // Symlinks are skipped rather than followed: this is the one place a
    // renderer-chosen id becomes a path the filesystem is asked to read, and a
    // link can point anywhere.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) directories.push(entry.name);
    else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(entry.name);
  }
  directories.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return { ok: true, directories, files };
}

module.exports = {
  AUDIO_EXTENSIONS,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  buildFolderTree,
  commonDirectoryOf,
  decodeId,
  digest,
  encodeId,
  isInside,
  listDirectoryEntries,
  normalizeFolder,
  registeredRootOf,
  resolveNodeId,
  segmentsOf,
};
