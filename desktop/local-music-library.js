const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const LOCAL_MUSIC_SCHEME = 'mineradio-local';
const LOCAL_LIBRARY_VERSION = 1;
const LOCAL_LIBRARY_FILE = 'local-music-library.json';
const LOCAL_LIBRARY_DIRECTORY = 'local-music-library';
const LOCAL_COVER_DIRECTORY = 'covers';
const MAX_LIBRARY_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_LYRIC_BYTES = 512 * 1024;
const MAX_COVER_BYTES = 6 * 1024 * 1024;
const MAX_UNKNOWN_DIMENSION_COVER_BYTES = 1024 * 1024;
const MAX_COVER_DIMENSION = 4096;
const MAX_COVER_PIXELS = 12 * 1024 * 1024;
const MAX_IMPORT_FILES = 50000;
const METADATA_CONCURRENCY = 3;
const MAX_MUSIC_FOLDERS = 64;
// A library root can sit anywhere the user points it, but a scan must not walk
// the whole drive by accident: 200k files is a full index on its own.
const MAX_SCAN_FILES = 200000;
const MAX_SCAN_DEPTH = 24;
const SCAN_EMIT_EVERY = 250;

const AUDIO_MIME = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.flac', 'audio/flac'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.opus', 'audio/ogg'],
]);
const COVER_EXTENSION_BY_MIME = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/bmp', '.bmp'],
]);
const COVER_MIME_BY_EXTENSION = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
]);
// Artwork a folder carries when its files have no picture tag of their own —
// the rung between "in the file" and "cached from a previous scan". Read in
// this order, so a folder that has both a cover.jpg and a folder.jpg shows the
// one taggers write first.
const FOLDER_ARTWORK_BASENAMES = ['cover', 'front', 'albumart', 'albumartsmall', 'folder', 'album', 'frontcover'];
const FOLDER_ARTWORK_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
// A folder cover is copied once per folder rather than once per track, so its
// name says which folder it came from instead of which track first needed it —
// twelve tracks sharing one folder.jpg cost one file, not twelve. Nothing else
// on disk starts with this prefix: track covers are named from a 24-character
// hex id, and "folder" is not hex.
const FOLDER_COVER_PREFIX = 'folder-';

let musicMetadataModulePromise = null;

function registerLocalMusicScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: LOCAL_MUSIC_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }]);
}

function normalizedAbsoluteFilePath(value) {
  const input = String(value || '').trim();
  if (!input || /^[\\/]{2}/.test(input) || !path.isAbsolute(input)) return '';
  return path.resolve(input);
}

function normalizedPathIdentity(value) {
  const resolved = normalizedAbsoluteFilePath(value);
  if (!resolved) return '';
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Relative paths are stored with forward slashes whatever the OS produced.
// They are grouping keys, not paths to open — the OS path lives in audioPath —
// so "Album/One.flac" has to mean the same thing on every machine, and a
// Windows backslash must not turn into an unknown folder on import.
function toRelativePath(value) {
  const text = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  return text.replace(/\/{2,}/g, '/');
}

function supportedAudioPath(value) {
  const resolved = normalizedAbsoluteFilePath(value);
  return resolved && AUDIO_MIME.has(path.extname(resolved).toLowerCase()) ? resolved : '';
}

function cleanText(value, fallback, maxLength = 1000) {
  const text = String(value == null ? '' : value).replace(/\0/g, '').trim();
  return (text || String(fallback || '')).slice(0, maxLength);
}

function localFileId(filePath) {
  return crypto.createHash('sha256').update(normalizedPathIdentity(filePath)).digest('hex').slice(0, 24);
}

function audioRevision(stat) {
  return `${Math.max(0, Math.round(Number(stat && stat.mtimeMs) || 0)).toString(36)}-${Math.max(0, Number(stat && stat.size) || 0).toString(36)}`;
}

function localMediaUrl(kind, id, revision, capability) {
  const query = new URLSearchParams();
  if (revision) query.set('v', revision);
  if (capability) query.set('cap', capability);
  return `${LOCAL_MUSIC_SCHEME}://${kind}/${encodeURIComponent(id)}${query.size ? `?${query.toString()}` : ''}`;
}

function isPathInside(root, candidate) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(candidate);
  const relative = path.relative(rootPath, targetPath);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch (_) {}
}

function isSharedCoverPath(coverPath) {
  return path.basename(String(coverPath || '')).startsWith(FOLDER_COVER_PREFIX);
}

// A cover copied out of a folder belongs to every track in it, so it is only
// deleted once nothing points at it any more — retagging one song must not
// blank the album's art for the other eleven. Covers taken from a file itself
// belong to that file alone and go as soon as it stops using them.
function sharedCoversStillInUse(records) {
  const inUse = new Set();
  for (const record of records) {
    if (record && record.coverPath && isSharedCoverPath(record.coverPath)) {
      inUse.add(path.resolve(record.coverPath));
    }
  }
  return inUse;
}

function embeddedImageDimensions(data, mime) {
  if (!Buffer.isBuffer(data) || data.length < 10) return null;
  const normalizedMime = String(mime || '').toLowerCase();
  if (normalizedMime === 'image/png' && data.length >= 24 && data.toString('ascii', 1, 4) === 'PNG') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (normalizedMime === 'image/gif') {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (normalizedMime === 'image/bmp' && data.length >= 26) {
    return { width: Math.abs(data.readInt32LE(18)), height: Math.abs(data.readInt32LE(22)) };
  }
  if ((normalizedMime === 'image/jpeg' || normalizedMime === 'image/jpg') && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      const marker = data[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = data.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  if (normalizedMime === 'image/webp' && data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF') {
    const kind = data.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      return {
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3),
      };
    }
    if (kind === 'VP8L' && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

function coverWithinBudget(data, mime) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_COVER_BYTES) return false;
  const dimensions = embeddedImageDimensions(data, mime);
  if (!dimensions) return data.length <= MAX_UNKNOWN_DIMENSION_COVER_BYTES;
  const width = Number(dimensions.width) || 0;
  const height = Number(dimensions.height) || 0;
  return width > 0
    && height > 0
    && width <= MAX_COVER_DIMENSION
    && height <= MAX_COVER_DIMENSION
    && width * height <= MAX_COVER_PIXELS;
}

function parseByteRange(value, size) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(text);
  if (!match || (!match[1] && !match[2]) || size <= 0) return { invalid: true };
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - Math.floor(suffix));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
    start = Math.floor(start);
    end = Math.min(size - 1, Math.floor(end));
  }
  if (start < 0 || end < start || start >= size) return { invalid: true };
  return { start, end };
}

function decodeLyricBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  if (!buffer.length) return '';
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8').replace(/\0/g, '').trim();
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le').replace(/\0/g, '').trim();
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1];
      swapped[i - 1] = buffer[i];
    }
    return swapped.toString('utf16le').replace(/\0/g, '').trim();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/\0/g, '').trim();
  } catch (_) {
    try {
      return new TextDecoder('gb18030').decode(buffer).replace(/\0/g, '').trim();
    } catch (_) {
      return buffer.toString('utf8').replace(/\0/g, '').trim();
    }
  }
}

function formatLrcTimestamp(timestamp) {
  const totalMs = Math.max(0, Math.round(Number(timestamp) || 0));
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}]`;
}

function embeddedLyricText(common) {
  const lyrics = Array.isArray(common && common.lyrics) ? common.lyrics : [];
  for (const item of lyrics) {
    const syncText = Array.isArray(item && item.syncText) ? item.syncText : [];
    if (syncText.length) {
      const lines = syncText
        .filter((line) => line && String(line.text || '').trim())
        .map((line) => `${formatLrcTimestamp(line.timestamp)}${String(line.text || '').trim()}`);
      if (lines.length) return lines.join('\n').slice(0, MAX_LYRIC_BYTES);
    }
    const text = cleanText(item && item.text, '', MAX_LYRIC_BYTES);
    if (text) return text;
  }
  return '';
}

function normalizeImportEntries(input) {
  const entries = [];
  const seen = new Set();
  for (const item of Array.isArray(input) ? input.slice(0, MAX_IMPORT_FILES) : []) {
    const requestedPath = typeof item === 'string' ? item : item && item.path;
    const filePath = supportedAudioPath(requestedPath);
    const identity = normalizedPathIdentity(filePath);
    if (!filePath || !identity || seen.has(identity)) continue;
    seen.add(identity);
    entries.push({
      path: filePath,
      relativePath: toRelativePath(cleanText(item && item.relativePath, path.basename(filePath), 2000)) || path.basename(filePath),
    });
  }
  return entries;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(Math.max(1, limit), items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function defaultParseMetadata(filePath) {
  if (!musicMetadataModulePromise) musicMetadataModulePromise = import('music-metadata');
  const module = await musicMetadataModulePromise;
  return module.parseFile(filePath, { duration: true, skipCovers: false });
}

async function readSidecarLyric(lyricPath) {
  if (!lyricPath) return '';
  try {
    const stat = await fs.promises.stat(lyricPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_LYRIC_BYTES) return '';
    return decodeLyricBuffer(await fs.promises.readFile(lyricPath)).slice(0, MAX_LYRIC_BYTES);
  } catch (_) {
    return '';
  }
}

// A .txt sitting beside a track is a note just as often as it is a lyric — a
// tracklist, "see booklet", a URL. Only take one when its shape says the words
// were meant to be sung, so a stray text file cannot take the panel over from
// the online lookup that would have found the real thing.
function looksLikeLyricText(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  // Timed, even a single line: that is an .lrc in all but name.
  if (lines.some((line) => /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(line))) return true;
  const body = lines.filter((line) => !/^\[[a-z][a-z0-9-]{0,15}:[^\]]*\]$/i.test(line));
  return body.length >= 3 && body.filter((line) => line.length >= 2).length >= 3;
}

// Read the folder image once per import, not once per track: a rescan of an
// album asks twelve times and gets the same answer from one readFile.
async function loadFolderArtwork(artworkPath, cache) {
  if (!artworkPath) return null;
  const identity = normalizedPathIdentity(artworkPath);
  if (cache.has(identity)) return cache.get(identity);
  const pending = (async () => {
    try {
      const stat = await fs.promises.stat(artworkPath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_COVER_BYTES) return null;
      const data = await fs.promises.readFile(artworkPath);
      return {
        format: COVER_MIME_BY_EXTENSION.get(path.extname(artworkPath).toLowerCase()) || '',
        data,
      };
    } catch (_) {
      return null;
    }
  })();
  cache.set(identity, pending);
  return pending;
}

// One readdir per folder feeds everything that sits beside the track: lyrics in
// an .lrc, lyrics in a .txt, and the album art the folder itself carries.
// Rescan walks every folder the library already came from, so a cover or a
// lyric file dropped in afterwards is picked up without importing by hand.
async function buildSidecarIndex(entries) {
  const directories = Array.from(new Set(entries.map((entry) => path.dirname(entry.path))));
  const lyrics = new Map();
  const artwork = new Map();
  await mapWithConcurrency(directories, METADATA_CONCURRENCY, async (directory) => {
    const lookup = new Map();
    const candidates = new Map();
    try {
      const names = await fs.promises.readdir(directory);
      for (const name of names) {
        const extension = path.extname(name).toLowerCase();
        const base = path.basename(name, path.extname(name)).toLowerCase();
        if (extension === '.lrc' || extension === '.txt') {
          const sidecar = lookup.get(base) || { lrc: '', txt: '' };
          // An .lrc wins a name it shares with a .txt: timestamps beat none,
          // and only one of the two is ever read.
          if (extension === '.lrc') sidecar.lrc = path.join(directory, name);
          else if (!sidecar.lrc) sidecar.txt = path.join(directory, name);
          lookup.set(base, sidecar);
          continue;
        }
        if (FOLDER_ARTWORK_EXTENSIONS.has(extension) && FOLDER_ARTWORK_BASENAMES.indexOf(base) >= 0 && !candidates.has(base)) {
          candidates.set(base, path.join(directory, name));
        }
      }
    } catch (_) {}
    const identity = normalizedPathIdentity(directory);
    lyrics.set(identity, lookup);
    let cover = '';
    for (const base of FOLDER_ARTWORK_BASENAMES) {
      const hit = candidates.get(base);
      if (hit) { cover = hit; break; }
    }
    artwork.set(identity, cover);
  });
  return { lyrics, artwork, artworkBytes: new Map() };
}

class LocalMusicLibrary {
  constructor(options = {}) {
    this.userDataPath = path.resolve(String(options.userDataPath || process.cwd()));
    this.libraryDirectory = path.join(this.userDataPath, LOCAL_LIBRARY_DIRECTORY);
    this.coverDirectory = path.join(this.libraryDirectory, LOCAL_COVER_DIRECTORY);
    this.indexPath = path.join(this.userDataPath, LOCAL_LIBRARY_FILE);
    this.parseMetadata = typeof options.parseMetadata === 'function' ? options.parseMetadata : defaultParseMetadata;
    this.records = new Map();
    this.order = [];
    this.folders = [];
    this.mediaToken = crypto.randomBytes(24).toString('hex');
    this.protocolInstalled = false;
    this.mutation = Promise.resolve();
    this.scanInFlight = null;
    this.loadIndex();
  }

  loadIndex() {
    try {
      const stat = fs.statSync(this.indexPath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_LIBRARY_INDEX_BYTES) return;
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      if (!parsed || parsed.version !== LOCAL_LIBRARY_VERSION || !Array.isArray(parsed.records)) return;
      if (/^[a-f0-9]{48}$/i.test(String(parsed.mediaToken || ''))) this.mediaToken = String(parsed.mediaToken).toLowerCase();
      const nextRecords = new Map();
      const nextOrder = [];
      for (const source of parsed.records.slice(0, MAX_IMPORT_FILES)) {
        const audioPath = supportedAudioPath(source && source.audioPath);
        const id = cleanText(source && source.id, '', 64).toLowerCase();
        if (!audioPath || !/^[a-f0-9]{24}$/.test(id) || id !== localFileId(audioPath) || nextRecords.has(id)) continue;
        let coverPath = normalizedAbsoluteFilePath(source.coverPath);
        if (!coverPath || !isPathInside(this.coverDirectory, coverPath)) coverPath = '';
        const record = {
          id,
          audioPath,
          relativePath: toRelativePath(cleanText(source.relativePath, path.basename(audioPath), 2000)) || path.basename(audioPath),
          name: cleanText(source.name, path.basename(audioPath, path.extname(audioPath)), 1000),
          artist: cleanText(source.artist, 'Local file', 1000),
          album: cleanText(source.album, '', 1000),
          // The tag fields a real library sorts and groups by. Older indexes do
          // not carry them, so every one falls back to '' and the views that
          // group on them simply bucket the tracks under "Unknown".
          albumArtist: cleanText(source.albumArtist, '', 1000),
          genre: cleanText(source.genre, '', 400),
          year: Math.max(0, Math.min(9999, Number(source.year) || 0)),
          track: Math.max(0, Number(source.track) || 0),
          disc: Math.max(0, Number(source.disc) || 0),
          composer: cleanText(source.composer, '', 400),
          comment: cleanText(source.comment, '', 2000),
          bitrate: Math.max(0, Number(source.bitrate) || 0),
          sampleRate: Math.max(0, Number(source.sampleRate) || 0),
          codec: cleanText(source.codec, '', 100),
          duration: Math.max(0, Number(source.duration) || 0),
          size: Math.max(0, Number(source.size) || 0),
          mtimeMs: Math.max(0, Number(source.mtimeMs) || 0),
          revision: cleanText(source.revision, '', 100),
          coverPath,
          coverMime: cleanText(source.coverMime, '', 100),
          lyric: cleanText(source.lyric, '', MAX_LYRIC_BYTES),
          lyricSource: source.lyricSource === 'sidecar' ? 'sidecar' : (source.lyricSource === 'embedded' ? 'embedded' : ''),
          importedAt: Math.max(0, Number(source.importedAt) || 0),
          addedAt: Math.max(0, Number(source.addedAt) || Number(source.importedAt) || 0),
        };
        nextRecords.set(id, record);
        nextOrder.push(id);
      }
      this.records = nextRecords;
      this.order = nextOrder;
      // Folders are an optional field: an index written before folder tracking
      // existed still loads, it just has no folders to re-scan.
      this.folders = Array.isArray(parsed.folders)
        ? parsed.folders.map((folder) => cleanText(folder, '', 2000)).filter(Boolean).slice(0, MAX_MUSIC_FOLDERS)
        : [];
    } catch (_) {}
  }

  // Walk one root and yield every supported audio file beneath it, one path at
  // a time. It never recurses through junctions or symlinks itself — it would
  // otherwise happily loop a 10GB folder onto itself — and it stays well
  // outside MAX_SCAN_FILES by stopping early rather than piling up memory.
  async *scanFolderPaths(root, onProgress) {
    const startRoot = normalizedAbsoluteFilePath(root);
    if (!startRoot) return { scanned: 0, stopped: 'INVALID_ROOT' };
    const seenRealPaths = new Set();
    const stack = [{ dir: startRoot, depth: 0 }];
    let scanned = 0;
    try {
      seenRealPaths.add(normalizedPathIdentity(await fs.promises.realpath(startRoot)));
    } catch (_) {
      return { scanned: 0, stopped: 'UNREADABLE_ROOT' };
    }
    while (stack.length) {
      const { dir, depth } = stack.pop();
      let names = [];
      try {
        names = await fs.promises.readdir(dir);
      } catch (_) {
        continue;
      }
      for (const name of names) {
        const candidate = path.join(dir, name);
        let stat = null;
        try {
          stat = await fs.promises.lstat(candidate);
        } catch (_) {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (depth >= MAX_SCAN_DEPTH) continue;
          try {
            const real = normalizedPathIdentity(await fs.promises.realpath(candidate));
            if (!real || seenRealPaths.has(real)) continue;
            seenRealPaths.add(real);
          } catch (_) {
            continue;
          }
          stack.push({ dir: candidate, depth: depth + 1 });
          continue;
        }
        if (!stat.isFile()) continue;
        scanned += 1;
        if (scanned > MAX_SCAN_FILES) return { scanned, stopped: 'LIMIT_REACHED' };
        if (AUDIO_MIME.has(path.extname(name).toLowerCase())) {
          yield candidate;
          if (onProgress && scanned % SCAN_EMIT_EVERY === 0) onProgress(scanned);
        }
      }
    }
    return { scanned, stopped: '' };
  }

  // The folders the library owns. Stored as absolute resolved paths so a scan
  // always lands in the same place regardless of how the user picked it.
  listFoldersSync() {
    return { ok: true, folders: this.folders.slice() };
  }

  async addFolder(root) {
    const resolved = normalizedAbsoluteFilePath(root);
    if (!resolved || !AUDIO_MIME.size) return { ok: false, folders: this.folders.slice(), error: 'LOCAL_FOLDER_INVALID' };
    let stat = null;
    try {
      stat = await fs.promises.stat(resolved);
    } catch (_) {
      return { ...this.listFoldersSync(), ok: false, error: 'LOCAL_FOLDER_UNREADABLE' };
    }
    if (!stat.isDirectory()) return { ...this.listFoldersSync(), ok: false, error: 'LOCAL_FOLDER_INVALID' };
    const operation = async () => {
      const already = this.folders.some((folder) => normalizedPathIdentity(folder) === normalizedPathIdentity(resolved));
      const nextFolders = already ? this.folders.slice() : this.folders.concat([resolved]).slice(0, MAX_MUSIC_FOLDERS);
      this.folders = nextFolders;
      await this.persistSnapshot(this.order, this.records);
      return { ...this.listTracksSync(), folders: nextFolders.slice() };
    };
    const pending = this.mutation.then(operation, operation);
    this.mutation = pending.catch(() => {});
    return pending;
  }

  async removeFolder(root) {
    const identity = normalizedPathIdentity(root);
    // Rows that came from this root go with it, or the folder list and the
    // track list drift apart forever: the next rescan would re-add everything
    // because the orphan-directory fallback still points at those files.
    // removeTracks() runs first because it serializes on this.mutation — calling
    // it from inside the operation below would deadlock against it.
    const doomed = [];
    for (const [id, record] of this.records) {
      const directory = normalizedPathIdentity(path.dirname(record.audioPath));
      if (directory && (directory === identity || directory.startsWith(`${identity}${path.sep}`))) {
        doomed.push(id);
      }
    }
    if (doomed.length) await this.removeTracks(doomed);
    const operation = async () => {
      const nextFolders = this.folders.filter((folder) => normalizedPathIdentity(folder) !== identity);
      this.folders = nextFolders;
      await this.persistSnapshot(this.order, this.records);
      return { ...this.listTracksSync(), folders: nextFolders.slice() };
    };
    const pending = this.mutation.then(operation, operation);
    this.mutation = pending.catch(() => {});
    return pending;
  }

  // Scan every folder the library owns and absorb whatever is found. Works in
  // the importFiles stream, so a 20k-file scan parses tags in small batches
  // instead of holding the whole thing in memory at once.
  //
  // Roots are the registered folders PLUS any directory the index already
  // points at that sits outside them — tracks imported by file picker must not
  // vanish from a rescan just because the user never registered a folder.
  async scanFolders(onProgress) {
    // One walk at a time. Two overlapping scans would both read the same
    // stale index and the second would re-add whatever the first just removed.
    if (this.scanInFlight) return this.scanInFlight;
    this.scanInFlight = this.runFolderScan(onProgress).finally(() => {
      this.scanInFlight = null;
    });
    return this.scanInFlight;
  }

  async runFolderScan(onProgress) {
    const orderSnapshot = this.order.slice();
    const recordsSnapshot = new Map(this.records);
    const roots = this.folders.slice();
    const seenRoots = new Set(roots.map((root) => normalizedPathIdentity(root)));
    // Orphan roots carry the relative prefix their existing records already
    // use, so a file dropped in beside them lands as "Album/Two.flac" and not
    // a bare "Two.flac" — the relative path is the only grouping the index has.
    const orphanRoots = [];
    for (const id of orderSnapshot) {
      const record = recordsSnapshot.get(id);
      if (!record) continue;
      const directory = path.dirname(record.audioPath);
      const identity = normalizedPathIdentity(directory);
      if (!identity || seenRoots.has(identity)) continue;
      const inside = roots.some((root) => {
        const rootIdentity = normalizedPathIdentity(root);
        return !!rootIdentity && (identity === rootIdentity
          || identity.startsWith(`${rootIdentity}${path.sep}`));
      });
      if (inside) continue;
      if (orphanRoots.some((known) => normalizedPathIdentity(known.root) === identity)) continue;
      const relativeDirectory = toRelativePath(path.dirname(toRelativePath(record.relativePath || '')));
      orphanRoots.push({
        root: directory,
        prefix: relativeDirectory && relativeDirectory !== '.' ? `${relativeDirectory}/` : '',
      });
      seenRoots.add(identity);
    }
    const entries = [];
    const found = new Set();
    const unreadable = new Set();
    let scanned = 0;
    const walk = async (root, prefix) => {
      let generator;
      try {
        generator = this.scanFolderPaths(root, onProgress);
      } catch (_) {
        unreadable.add(normalizedPathIdentity(root));
        return;
      }
      let sawFile = false;
      for await (const filePath of generator) {
        sawFile = true;
        const identity = normalizedPathIdentity(filePath);
        if (!identity || found.has(identity)) continue;
        found.add(identity);
        let stat = null;
        try {
          const candidate = await fs.promises.stat(filePath);
          if (candidate.isFile()) stat = candidate;
        } catch (_) {
          continue;
        }
        scanned += 1;
        const previous = recordsSnapshot.get(localFileId(filePath));
        if (previous
          && Math.round(Number(previous.mtimeMs) || 0) === Math.round(Number(stat.mtimeMs) || 0)
          && Number(previous.size) === Number(stat.size)) continue;
        const relativePath = `${prefix}${toRelativePath(path.relative(root, filePath)) || path.basename(filePath)}`;
        entries.push({ path: filePath, relativePath });
      }
      // A root that yielded nothing at all is indistinguishable from one that
      // is simply empty, so only report it unreadable when readdir itself fails.
      if (!sawFile) {
        try {
          await fs.promises.readdir(root);
        } catch (_) {
          unreadable.add(normalizedPathIdentity(root));
        }
      }
    };
    for (const root of roots) await walk(root, '');
    for (const orphan of orphanRoots) await walk(orphan.root, orphan.prefix);
    if (!roots.length && !orphanRoots.length) {
      return { ...this.listTracksSync(), folders: [], added: 0, changed: 0, removed: 0, scanned: 0 };
    }
    const gone = orderSnapshot.filter((id) => {
      const record = recordsSnapshot.get(id);
      if (!record) return false;
      if (unreadable.has(normalizedPathIdentity(path.dirname(record.audioPath)))) return false;
      return !found.has(normalizedPathIdentity(record.audioPath));
    });
    let snapshot;
    let removed = 0;
    if (gone.length) {
      snapshot = await this.removeTracks(gone);
      removed = snapshot.removed || 0;
    }
    let added = 0;
    let changed = 0;
    if (entries.length) {
      const before = recordsSnapshot.size;
      snapshot = await this.importFiles(entries, { replace: false });
      const after = snapshot.count - removed;
      added = Math.max(0, after - before);
      changed = Math.max(0, entries.length - added);
    }
    if (!snapshot) snapshot = this.listTracksSync();
    return { ...snapshot, folders: this.folders.slice(), added, changed, removed, scanned };
  }

  serializeRecord(record) {
    const coverAvailable = !!record.coverPath;
    return {
      type: 'local',
      source: 'local',
      provider: 'local',
      id: `local:${record.id}`,
      localFileId: record.id,
      localKey: record.id,
      localUrl: localMediaUrl('audio', record.id, record.revision, this.mediaToken),
      localPath: record.relativePath || path.basename(record.audioPath),
      localMissing: false,
      name: record.name,
      title: record.name,
      artist: record.artist || 'Local file',
      album: record.album || '',
      albumArtist: record.albumArtist || '',
      genre: record.genre || '',
      year: Math.max(0, Number(record.year) || 0),
      track: Math.max(0, Number(record.track) || 0),
      disc: Math.max(0, Number(record.disc) || 0),
      composer: record.composer || '',
      comment: record.comment || '',
      bitrate: Math.max(0, Number(record.bitrate) || 0),
      sampleRate: Math.max(0, Number(record.sampleRate) || 0),
      codec: record.codec || '',
      addedAt: Math.max(0, Number(record.addedAt) || 0),
      duration: Math.max(0, Number(record.duration) || 0),
      cover: coverAvailable ? localMediaUrl('cover', record.id, record.revision, this.mediaToken) : '',
      hasLyric: !!record.lyric,
      lyricSource: record.lyricSource || '',
    };
  }

  listTracksSync() {
    const tracks = [];
    for (const id of this.order) {
      const record = this.records.get(id);
      if (record) tracks.push(this.serializeRecord(record));
    }
    return { ok: true, version: LOCAL_LIBRARY_VERSION, count: tracks.length, tracks };
  }

  async listTracks() {
    const tracks = [];
    for (let index = 0; index < this.order.length; index += 1) {
      const record = this.records.get(this.order[index]);
      if (record) tracks.push(this.serializeRecord(record));
      if (index > 0 && index % 400 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    return { ok: true, version: LOCAL_LIBRARY_VERSION, count: tracks.length, tracks };
  }

  lyricForTrack(value) {
    const id = cleanText(value, '', 64).replace(/^local:/, '').toLowerCase();
    if (!/^[a-f0-9]{24}$/.test(id)) return { ok: false, localFileId: '', lyric: '', lyricSource: '', error: 'LOCAL_TRACK_INVALID' };
    const record = this.records.get(id);
    if (!record) return { ok: false, localFileId: id, lyric: '', lyricSource: '', missing: true, error: 'LOCAL_TRACK_MISSING' };
    return {
      ok: true,
      localFileId: id,
      lyric: record.lyric || '',
      lyricSource: record.lyricSource || '',
    };
  }

  async stageSnapshot(order, records) {
    await fs.promises.mkdir(path.dirname(this.indexPath), { recursive: true });
    const payload = {
      version: LOCAL_LIBRARY_VERSION,
      updatedAt: Date.now(),
      mediaToken: this.mediaToken,
      folders: this.folders.slice(0, MAX_MUSIC_FOLDERS),
      records: order.map((id) => records.get(id)).filter(Boolean),
    };
    const text = JSON.stringify(payload);
    if (Buffer.byteLength(text, 'utf8') > MAX_LIBRARY_INDEX_BYTES) {
      const error = new Error('LOCAL_LIBRARY_INDEX_TOO_LARGE');
      error.code = 'LOCAL_LIBRARY_INDEX_TOO_LARGE';
      throw error;
    }
    const temporary = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, text, 'utf8');
      return temporary;
    } catch (error) {
      safeUnlink(temporary);
      throw error;
    }
  }

  async persistSnapshot(order, records) {
    const temporary = await this.stageSnapshot(order, records);
    try {
      await fs.promises.rename(temporary, this.indexPath);
    } catch (error) {
      safeUnlink(temporary);
      throw error;
    }
  }

  async stageCover(id, picture, previous) {
    if (!picture) return { path: '', mime: '' };
    const mime = cleanText(picture && picture.format, '', 100).toLowerCase();
    const extension = COVER_EXTENSION_BY_MIME.get(mime);
    const data = picture && picture.data ? Buffer.from(picture.data) : null;
    if (!extension || !coverWithinBudget(data, mime)) {
      return {
        path: previous && previous.coverPath || '',
        mime: previous && previous.coverMime || '',
        rejected: !!(extension && data && data.length),
      };
    }
    await fs.promises.mkdir(this.coverDirectory, { recursive: true });
    const digest = crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
    const target = path.join(this.coverDirectory, `${id}-${digest}${extension}`);
    if (fs.existsSync(target)) return { path: target, mime };
    const temporary = path.join(this.coverDirectory, `.${id}-${digest}.${process.pid}.${Date.now()}.stage`);
    await fs.promises.writeFile(temporary, data);
    return { path: target, mime, stagedPath: temporary };
  }

  // A cover that came from beside the track rather than out of it. It is
  // addressed by folder and by content, so every track in the album resolves to
  // the same file and re-importing the album does not copy it again. Returns
  // null when the image cannot be carried — over budget, unreadable, no mime we
  // serve — which simply drops back to whatever is already cached: a folder
  // without usable art is normal, not a warning worth repeating per track.
  async stageFolderCover(directoryIdentity, picture) {
    if (!picture) return null;
    const mime = cleanText(picture && picture.format, '', 100).toLowerCase();
    const extension = COVER_EXTENSION_BY_MIME.get(mime);
    const data = picture && picture.data ? Buffer.from(picture.data) : null;
    if (!extension || !coverWithinBudget(data, mime)) return null;
    await fs.promises.mkdir(this.coverDirectory, { recursive: true });
    const digest = crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
    const folder = crypto.createHash('sha256').update(String(directoryIdentity || '')).digest('hex').slice(0, 16);
    const target = path.join(this.coverDirectory, `${FOLDER_COVER_PREFIX}${folder}-${digest}${extension}`);
    if (fs.existsSync(target)) return { path: target, mime };
    // Random suffix, not just pid and millisecond: several tracks of the same
    // album are parsed concurrently and all compute this same temporary name.
    const temporary = path.join(this.coverDirectory,
      `.${FOLDER_COVER_PREFIX}${folder}-${digest}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.stage`);
    await fs.promises.writeFile(temporary, data);
    return { path: target, mime, stagedPath: temporary };
  }

  async parseEntry(entry, sidecars) {
    const stat = await fs.promises.stat(entry.path);
    if (!stat.isFile()) {
      const error = new Error('LOCAL_AUDIO_NOT_FILE');
      error.code = 'LOCAL_AUDIO_NOT_FILE';
      throw error;
    }
    const id = localFileId(entry.path);
    const previous = this.records.get(id);
    let metadata = {};
    let metadataError = '';
    try {
      metadata = await this.parseMetadata(entry.path) || {};
    } catch (error) {
      metadataError = String(error && error.message || error || 'METADATA_PARSE_FAILED').slice(0, 500);
    }
    const common = metadata.common || {};
    const format = metadata.format || {};
    const fallbackTitle = path.basename(entry.path, path.extname(entry.path));
    const artists = Array.isArray(common.artists) ? common.artists.filter(Boolean).join(' / ') : '';
    const directoryIdentity = normalizedPathIdentity(path.dirname(entry.path));
    const picture = Array.isArray(common.picture) && common.picture.length ? common.picture[0] : null;
    // Artwork, in the order it is asked for: what the file itself carries, then
    // what sits beside it in the folder, then whatever an earlier scan already
    // cached. That last rung is the one that keeps an album's cover alive when
    // the tag reader is having a bad day, and when the folder image has since
    // been edited away.
    let cover;
    if (metadataError) {
      cover = {
        path: previous && previous.coverPath || '',
        mime: previous && previous.coverMime || '',
      };
    } else if (picture) {
      cover = await this.stageCover(id, picture, previous);
    } else {
      const folderPicture = await loadFolderArtwork(sidecars.artwork.get(directoryIdentity), sidecars.artworkBytes);
      const shared = folderPicture ? await this.stageFolderCover(directoryIdentity, folderPicture) : null;
      cover = shared || {
        path: previous && previous.coverPath || '',
        mime: previous && previous.coverMime || '',
      };
    }
    const sidecarDirectory = sidecars.lyrics.get(directoryIdentity);
    const sidecar = sidecarDirectory && sidecarDirectory.get(fallbackTitle.toLowerCase());
    let lyric = '';
    let lyricSource = '';
    // A synchronized file placed beside the track is the user saying "use this"
    // and beats whatever the tag carries. A plain-text file does not carry that
    // authority — half of them are notes — so it is asked for last, and only
    // when it reads like lyrics. What the tag carries sits between the two.
    if (sidecar && sidecar.lrc) {
      lyric = await readSidecarLyric(sidecar.lrc);
      if (lyric) lyricSource = 'sidecar';
    }
    if (!lyric) {
      lyric = embeddedLyricText(common);
      if (lyric) lyricSource = 'embedded';
    }
    if (!lyric && sidecar && sidecar.txt) {
      const plain = await readSidecarLyric(sidecar.txt);
      if (plain && looksLikeLyricText(plain)) {
        lyric = plain;
        lyricSource = 'sidecar';
      }
    }
    if (!lyric && metadataError && previous && previous.lyric) {
      lyric = previous.lyric;
      lyricSource = previous.lyricSource || '';
    }
    const relativeDirectory = path.dirname(entry.relativePath || '');
    const fallbackAlbum = relativeDirectory && relativeDirectory !== '.' ? relativeDirectory.split(/[\\/]/).join(' / ') : '';
    // music-metadata hands back several of these as arrays, and track/disc as a
    // {no, of} pair. Normalising here keeps every view downstream from having
    // to know that, and a failed parse falls back to whatever the record had.
    const keep = (value, fallback) => (metadataError && previous ? value || fallback : value);
    const firstText = (value) => Array.isArray(value) ? (value.filter(Boolean)[0] || '') : String(value || '');
    const listText = (value) => Array.isArray(value)
      ? value.filter(Boolean).map((entry) => String(entry).trim()).filter(Boolean).join(', ')
      : firstText(value);
    const numbered = (value) => Math.max(0, Number(value && typeof value === 'object' ? value.no : value) || 0);
    return {
      record: {
        id,
        audioPath: entry.path,
        relativePath: toRelativePath(entry.relativePath) || path.basename(entry.path),
        name: cleanText(common.title, metadataError && previous ? previous.name : fallbackTitle, 1000),
        artist: cleanText(common.artist || artists, metadataError && previous ? previous.artist : 'Local file', 1000),
        album: cleanText(common.album, metadataError && previous ? previous.album : fallbackAlbum, 1000),
        albumArtist: cleanText(keep(listText(common.albumartist), previous && previous.albumArtist), '', 1000),
        genre: cleanText(keep(listText(common.genre), previous && previous.genre), '', 400),
        year: Math.max(0, Math.min(9999, Number(keep(common.year, previous && previous.year)) || 0)),
        track: numbered(keep(common.track, previous && previous.track)),
        disc: numbered(keep(common.disk, previous && previous.disc)),
        composer: cleanText(keep(listText(common.composer), previous && previous.composer), '', 400),
        comment: cleanText(keep(listText(common.comment), previous && previous.comment), '', 2000),
        bitrate: Math.max(0, Math.round(Number(keep(format.bitrate, previous && previous.bitrate)) || 0)),
        sampleRate: Math.max(0, Math.round(Number(keep(format.sampleRate, previous && previous.sampleRate)) || 0)),
        codec: cleanText(keep(format.codec || format.container, previous && previous.codec), '', 100),
        duration: Math.max(0, Number(format.duration) || (metadataError && previous ? Number(previous.duration) : 0) || 0),
        size: Math.max(0, Number(stat.size) || 0),
        mtimeMs: Math.max(0, Number(stat.mtimeMs) || 0),
        revision: audioRevision(stat),
        coverPath: cover.path,
        coverMime: cover.mime,
        lyric,
        lyricSource,
        importedAt: Date.now(),
        // First-seen time, not last-parsed time: "Recently added" is about when
        // the file arrived, and a re-tag on rescan must not bump it to today.
        addedAt: previous && Number(previous.addedAt) > 0 ? Number(previous.addedAt) : Date.now(),
      },
      metadataError,
      coverWarning: cover.rejected ? 'LOCAL_COVER_REJECTED_BY_BUDGET' : '',
      stagedCoverPath: cover.stagedPath || '',
      previousCoverPath: previous && previous.coverPath || '',
    };
  }

  importFiles(input, options = {}) {
    const entries = normalizeImportEntries(input);
    const replace = options.replace === true;
    const operation = async () => {
      if (!entries.length) return { ok: false, count: 0, tracks: [], failures: [], error: 'NO_SUPPORTED_LOCAL_AUDIO' };
      const sidecars = await buildSidecarIndex(entries);
      const parsed = await mapWithConcurrency(entries, METADATA_CONCURRENCY, async (entry) => {
        try {
          return await this.parseEntry(entry, sidecars);
        } catch (error) {
          return {
            failure: {
              name: path.basename(entry.path),
              error: String(error && (error.code || error.message) || error || 'LOCAL_IMPORT_FAILED').slice(0, 500),
            },
          };
        }
      });
      const nextRecords = replace ? new Map() : new Map(this.records);
      const nextOrder = replace ? [] : this.order.slice();
      const failures = [];
      const metadataWarnings = [];
      const stagedCovers = [];
      const cleanupAfterCommit = new Set();
      for (const result of parsed) {
        if (!result || result.failure) {
          if (result && result.failure) failures.push(result.failure);
          continue;
        }
        const record = result.record;
        nextRecords.set(record.id, record);
        // A track already in the index keeps its place. Re-tagging a file or
        // rescanning a folder must not shuffle the library so that everything
        // you touched last week is now at the bottom.
        if (!nextOrder.includes(record.id)) nextOrder.push(record.id);
        if (result.metadataError) metadataWarnings.push({ name: path.basename(record.audioPath), error: result.metadataError });
        if (result.coverWarning) metadataWarnings.push({ name: path.basename(record.audioPath), error: result.coverWarning });
        if (result.stagedCoverPath) {
          stagedCovers.push({ stagedPath: result.stagedCoverPath, targetPath: record.coverPath });
        }
        if (
          result.previousCoverPath
          && (!record.coverPath || path.resolve(result.previousCoverPath) !== path.resolve(record.coverPath))
        ) {
          cleanupAfterCommit.add(result.previousCoverPath);
        }
      }
      if (!nextOrder.length) {
        for (const cover of stagedCovers) safeUnlink(cover.stagedPath);
        return { ok: false, count: 0, tracks: [], failures, metadataWarnings, error: 'LOCAL_IMPORT_FAILED' };
      }
      const removedRecords = replace
        ? this.order.filter((id) => !nextRecords.has(id)).map((id) => this.records.get(id)).filter(Boolean)
        : [];
      for (const record of removedRecords) if (record.coverPath) cleanupAfterCommit.add(record.coverPath);
      let snapshotTemporary = '';
      const createdCoverTargets = [];
      try {
        snapshotTemporary = await this.stageSnapshot(nextOrder, nextRecords);
        for (const cover of stagedCovers) {
          if (fs.existsSync(cover.targetPath)) {
            safeUnlink(cover.stagedPath);
            continue;
          }
          await fs.promises.rename(cover.stagedPath, cover.targetPath);
          createdCoverTargets.push(cover.targetPath);
        }
        await fs.promises.rename(snapshotTemporary, this.indexPath);
        snapshotTemporary = '';
      } catch (error) {
        safeUnlink(snapshotTemporary);
        for (const cover of stagedCovers) safeUnlink(cover.stagedPath);
        for (const target of createdCoverTargets) safeUnlink(target);
        throw error;
      }
      this.records = nextRecords;
      this.order = nextOrder;
      const sharedCoversInUse = sharedCoversStillInUse(nextRecords.values());
      for (const oldCoverPath of cleanupAfterCommit) {
        if (sharedCoversInUse.has(path.resolve(oldCoverPath))) continue;
        safeUnlink(oldCoverPath);
      }
      const snapshot = this.listTracksSync();
      return { ...snapshot, failures, metadataWarnings };
    };
    const pending = this.mutation.then(operation, operation);
    this.mutation = pending.catch(() => {});
    return pending;
  }

  removeTracks(ids) {
    const requested = new Set((Array.isArray(ids) ? ids : [ids])
      .map((id) => cleanText(id, '', 64).replace(/^local:/, '').toLowerCase())
      .filter((id) => /^[a-f0-9]{24}$/.test(id)));
    const operation = async () => {
      if (!requested.size) return { ...this.listTracksSync(), removed: 0 };
      const nextRecords = new Map(this.records);
      const removed = [];
      for (const id of requested) {
        const record = nextRecords.get(id);
        if (record) removed.push(record);
        nextRecords.delete(id);
      }
      const nextOrder = this.order.filter((id) => nextRecords.has(id));
      await this.persistSnapshot(nextOrder, nextRecords);
      this.records = nextRecords;
      this.order = nextOrder;
      // Only the cover copy cached under our own directory goes. record.audioPath
      // is the user's file and is deliberately never unlinked here. A cover
      // shared with the rest of the folder stays until the last track that
      // used it is gone with it.
      const sharedCoversInUse = sharedCoversStillInUse(nextRecords.values());
      for (const record of removed) {
        if (!record.coverPath) continue;
        if (sharedCoversInUse.has(path.resolve(record.coverPath))) continue;
        safeUnlink(record.coverPath);
      }
      return { ...this.listTracksSync(), removed: removed.length };
    };
    const pending = this.mutation.then(operation, operation);
    this.mutation = pending.catch(() => {});
    return pending;
  }

  // Re-read every folder the library already came from. New files turn up,
  // edited files get re-tagged, files that were deleted stop showing up as a
  // row that can never play. Only folders this library already imported are
  // scanned, so a rescan never reaches into a directory the user never chose.
  rescan(onProgress) {
    // Unchanged files are skipped rather than re-parsed: a 500-track library
    // would otherwise re-read every tag on each rescan. Both sides are rounded
    // because record.mtimeMs is stored at whatever precision the OS handed out
    // (and survives JSON untouched), while audioRevision() fingerprints with
    // Math.round — comparing one rounded side against one raw side would
    // report every track as newly edited forever.
    return this.scanFolders(onProgress);
  }

  recordForRequest(requestUrl) {
    try {
      const url = new URL(requestUrl);
      const kind = url.hostname === 'audio' ? 'audio' : (url.hostname === 'cover' ? 'cover' : '');
      const id = decodeURIComponent(url.pathname.replace(/^\/+/, '')).toLowerCase();
      if (!kind || !/^[a-f0-9]{24}$/.test(id) || url.searchParams.get('cap') !== this.mediaToken) return null;
      const record = this.records.get(id);
      if (!record) return null;
      const filePath = kind === 'audio' ? record.audioPath : record.coverPath;
      if (!filePath) return null;
      if (kind === 'audio' && !supportedAudioPath(filePath)) return null;
      if (kind === 'cover' && (!isPathInside(this.coverDirectory, filePath) || !COVER_MIME_BY_EXTENSION.has(path.extname(filePath).toLowerCase()))) return null;
      return { record, kind, filePath };
    } catch (_) {
      return null;
    }
  }

  async mediaResponse(request) {
    const method = String(request && request.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD', 'X-Content-Type-Options': 'nosniff' },
      });
    }
    const target = this.recordForRequest(request && request.url);
    if (!target) return new Response('Not found', { status: 404, headers: { 'X-Content-Type-Options': 'nosniff' } });
    let stat;
    try {
      stat = await fs.promises.stat(target.filePath);
      if (!stat.isFile()) throw new Error('NOT_FILE');
    } catch (_) {
      return new Response('Not found', { status: 404, headers: { 'X-Content-Type-Options': 'nosniff' } });
    }
    const size = Math.max(0, Number(stat.size) || 0);
    const rangeHeader = request.headers && request.headers.get ? request.headers.get('range') : '';
    const range = rangeHeader ? parseByteRange(rangeHeader, size) : null;
    if (range && range.invalid) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}`, 'X-Content-Type-Options': 'nosniff' },
      });
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : Math.max(0, size - 1);
    const extension = path.extname(target.filePath).toLowerCase();
    const contentType = target.kind === 'audio'
      ? (AUDIO_MIME.get(extension) || 'application/octet-stream')
      : (target.record.coverMime || COVER_MIME_BY_EXTENSION.get(extension) || 'application/octet-stream');
    const headers = {
      'Content-Type': contentType,
      'Content-Length': String(size ? end - start + 1 : 0),
      'Accept-Ranges': 'bytes',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    };
    const origin = request.headers && request.headers.get ? String(request.headers.get('origin') || '') : '';
    if (/^http:\/\/127\.0\.0\.1:\d+$/i.test(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers.Vary = 'Origin';
    }
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    if (method === 'HEAD' || !size) return new Response(null, { status: range ? 206 : 200, headers });
    const stream = fs.createReadStream(target.filePath, { start, end });
    return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers });
  }

  async installProtocol(protocol) {
    if (this.protocolInstalled) return;
    await protocol.handle(LOCAL_MUSIC_SCHEME, (request) => this.mediaResponse(request));
    this.protocolInstalled = true;
  }
}

module.exports = {
  AUDIO_MIME,
  FOLDER_ARTWORK_BASENAMES,
  LOCAL_MUSIC_SCHEME,
  LocalMusicLibrary,
  coverWithinBudget,
  decodeLyricBuffer,
  embeddedImageDimensions,
  embeddedLyricText,
  localFileId,
  looksLikeLyricText,
  parseByteRange,
  registerLocalMusicScheme,
};
