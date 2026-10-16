'use strict';
// ytdlp.js — the yt-dlp binary as one more route to a playable stream, and as
// a download backend.
//
// Two jobs, one resolver:
//   1. PLAYBACK. ytmusic-api.js resolves a stream by asking InnerTube for a
//      progressive format. That works, but it is one undocumented call against
//      an endpoint YouTube changes whenever it likes; when it stops matching
//      the provider reports "no_progressive_stream" and the player switches to
//      another source. yt-dlp solves the same problem with 500 upstream
//      extractors maintained by other people, so it is offered as a real
//      source in the player's provider order and as a fallback resolver.
//   2. DOWNLOAD. The same command line, pointed at a file instead of a pipe.
//
// The binary is bundled (build.extraResources -> resources/bin/yt-dlp.exe). To
// keep one distributable, downloads mux to m4a rather than mp3: m4a needs no
// ffmpeg, and a missing ffmpeg must never turn a working download into a
// failure. Format selection therefore prefers m4a and falls back to whatever
// single audio stream exists, which is always what YouTube serves natively.
//
// Everything here is provider-agnostic on purpose: a caller hands over a URL or
// a search query, not a provider id.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// A single yt-dlp invocation is bounded. The binary retries internally; this
// covers the case where the process itself wedges on a dead socket.
const YTDLP_RUN_TIMEOUT_MS = 120000;
const YTDLP_RESOLVE_TIMEOUT_MS = 45000;
// yt-dlp writes progress as carriage-return frames, not lines, so stdout is
// accumulated and split on \r as well as \n.
const YTDLP_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

let cachedBinary = null;

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

function binaryCandidates() {
  const out = [];
  // Packaged: electron-builder extraResources lands next to app resources.
  try {
    if (process.resourcesPath) {
      out.push(path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'));
    }
  } catch (_) { /* not running under Electron */ }
  // Dev checkout.
  out.push(path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'));
  // An explicit override, for a user who already keeps yt-dlp somewhere.
  const override = String(process.env.MINERADIO_YTDLP_PATH || '').trim();
  if (override) out.push(override);
  return out;
}

// Resolves the binary path once and remembers it. A missing binary is not an
// error here: it is a capability the app simply does not have, and every caller
// branches on it rather than failing a download or a playback attempt.
function resolveYtDlpBinary(force) {
  if (cachedBinary && !force) return cachedBinary;
  let found = '';
  for (const candidate of binaryCandidates()) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) { found = candidate; break; }
    } catch (_) { /* unreadable candidate — try the next one */ }
  }
  // PATH lookup is a last resort; it is the only candidate that costs a spawn.
  if (!found) {
    const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      try {
        const full = path.join(dir, name);
        if (fs.existsSync(full)) { found = full; break; }
      } catch (_) { /* ignore unusable PATH entries */ }
    }
  }
  cachedBinary = found;
  return found;
}

function ytDlpAvailable() {
  return !!resolveYtDlpBinary();
}

function resetYtDlpCacheForTests() {
  cachedBinary = null;
  versionCache = null;
}

let versionCache = null;
function ytDlpVersion() {
  if (versionCache) return Promise.resolve(versionCache);
  if (!ytDlpAvailable()) return Promise.resolve('');
  return runYtDlpRaw(['--version'], 10000)
    .then((result) => {
      versionCache = String(result.stdout || '').trim().split(/\r?\n/)[0] || '';
      return versionCache;
    })
    .catch(() => '');
}

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

// Spawns the resolved yt-dlp binary and resolves with
// { ok, code, stdout, stderr, timedOut }. Never rejects on a non-zero exit:
// yt-dlp reports extraction failures as stderr text on a failing exit code, and
// the caller needs that text to explain why.
//
// The executable is never a parameter. It is whatever resolveYtDlpBinary()
// found — a fixed list of known paths, or a PATH lookup — so no caller and no
// request can name a process to run here. The argv is passed as an array with
// no shell, so URL and query arguments reach yt-dlp as single arguments even if
// they contain shell metacharacters.
function runYtDlpRaw(args, timeoutMs, onSpawn) {
  return new Promise((resolve) => {
    const bin = resolveYtDlpBinary();
    if (!bin) {
      resolve({ ok: false, code: -1, stdout: '', stderr: 'yt-dlp is not installed in this build.', missing: true });
      return;
    }
    let child;
    try {
      child = spawn(bin, Array.isArray(args) ? args : [], { windowsHide: true, shell: false });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err && err.message || err), spawnError: true });
      return;
    }
    if (typeof onSpawn === 'function') { try { onSpawn(child); } catch (_) {} }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (_) {}
    }, Math.max(1000, Number(timeoutMs) || YTDLP_RUN_TIMEOUT_MS));

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    };

    child.stdout.on('data', (chunk) => {
      if (stdout.length < YTDLP_MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < YTDLP_MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      stderr += String(err && err.message || err);
      finish(-1);
    });
    child.on('close', finish);
  });
}

// ---------------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------------

// A yt-dlp argv is assembled from named pieces so a test can assert what a
// given situation produces without spawning anything. `extra` is appended last
// so a caller can always override a choice made here.
function buildYtDlpArgs(options) {
  const opts = options || {};
  const args = [];

  // --no-playlist everywhere. A bare YouTube URL sits inside a mix or a radio
  // queue, and without this a single-track resolve happily starts enumerating
  // the whole thing.
  args.push('--no-playlist');
  // No interactive prompts, and fail rather than hang on a bad URL.
  args.push('--no-warnings');
  args.push('--no-call-home');
  args.push('--socket-timeout', '15');
  args.push('--retries', '3');

  if (opts.proxy) args.push('--proxy', String(opts.proxy));
  if (opts.cookiesFromBrowser) args.push('--cookies-from-browser', String(opts.cookiesFromBrowser));
  if (opts.cookiesFile) args.push('--cookies', String(opts.cookiesFile));
  if (opts.ffmpegLocation) args.push('--ffmpeg-location', String(opts.ffmpegLocation));

  // A resolve wants a URL, not a file. -g prints the direct media URL(s) and
  // exits, so nothing is buffered to disk.
  if (opts.mode === 'resolve') {
    args.push('-f', opts.format || 'bestaudio[ext=m4a]/bestaudio/best');
    args.push('-g');
    return args.concat(Array.isArray(opts.extra) ? opts.extra : []);
  }

  // Download. m4a beats mp3 because YouTube already serves AAC-in-m4a: no
  // re-encode, and no ffmpeg requirement for the common case.
  args.push('-f', opts.format || 'bestaudio[ext=m4a]/bestaudio/best');
  if (!opts.noEmbed) {
    args.push('--embed-metadata');
    // Thumbnail embedding needs ffmpeg. Skip it rather than let a missing
    // ffmpeg fail an otherwise fine download.
    if (opts.ffmpegLocation) args.push('--embed-thumbnail');
  }
  if (opts.outputTemplate) args.push('-o', String(opts.outputTemplate));
  if (opts.printFilename) args.push('--print', 'after_move:filepath');
  if (opts.progress) args.push('--newline');
  return args.concat(Array.isArray(opts.extra) ? opts.extra : []);
}

// The single stream URL printed by `-g`. A resolve can print more than one line
// when yt-dlp needs separate video and audio streams; for audio-only format
// selection the last line is the audio, and the first is what a progressive
// format gives.
function parseResolvedUrl(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
  return lines.length ? lines[lines.length - 1] : '';
}

// The path printed by --print after_move:filepath. Windows paths contain a
// colon, so this cannot be a naive split on ':'.
function parsePrintedPath(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

// yt-dlp's stderr is long and multi-line; the last ERROR line is the actual
// reason and the rest is context. Falls back to the tail when it never says
// ERROR (a kill, a timeout, a crash).
function summarizeYtDlpError(stderr, fallback) {
  const text = String(stderr || '');
  const errors = text.split(/\r?\n/).filter((line) => /^\s*ERROR:/.test(line));
  if (errors.length) return errors[errors.length - 1].replace(/^\s*ERROR:\s*/, '').trim().slice(0, 300);
  const tail = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
  return (tail || fallback || 'yt-dlp failed').slice(0, 300);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// yt-dlp argv for a search. --flat-playlist keeps it to one request: it lists
// the result entries without opening each one, which is the difference between
// a search that returns in a second and one that opens ten videos.
function buildYtDlpSearchArgs(options) {
  const opts = options || {};
  const args = ['--no-warnings', '--no-call-home', '--socket-timeout', '15', '--retries', '2'];
  if (opts.proxy) args.push('--proxy', String(opts.proxy));
  if (opts.cookiesFromBrowser) args.push('--cookies-from-browser', String(opts.cookiesFromBrowser));
  if (opts.cookiesFile) args.push('--cookies', String(opts.cookiesFile));
  args.push('--flat-playlist', '-J');
  return args;
}

// Reads the -J JSON into the song shape the rest of the app already uses.
// yt-dlp reports a search either as { entries: [...] } (a playlist-shaped
// result) or as a single video object.
function parseYtDlpSearchJson(text) {
  let parsed = null;
  try { parsed = JSON.parse(String(text || '')); } catch (_) { return []; }
  const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : (parsed && parsed.id ? [parsed] : []);
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const id = String(entry.id || '').trim();
    const title = String(entry.title || '').trim();
    if (!id || !title) return null;
    const thumb = entry.thumbnail
      || (Array.isArray(entry.thumbnails) && entry.thumbnails.length ? entry.thumbnails[entry.thumbnails.length - 1].url : '');
    return {
      provider: 'ytdlp',
      source: 'ytdlp',
      id,
      // The web URL is what a later resolve call receives; keeping it here means
      // the resolve does not have to search a second time and land on a
      // different entry than the one the user picked.
      webUrl: String(entry.url || (id ? `https://www.youtube.com/watch?v=${id}` : '')),
      name: title,
      artist: String(entry.uploader || entry.channel || entry.artist || '').trim() || 'Unknown artist',
      album: '',
      cover: String(thumb || ''),
      duration: Math.max(0, Math.round(Number(entry.duration) || 0)),
      playable: true,
    };
  }).filter(Boolean);
}

async function searchWithYtDlp(query, options) {
  const opts = options || {};
  if (!ytDlpAvailable()) return { ok: false, reason: 'ytdlp_missing', songs: [] };
  const text = String(query || '').trim();
  if (!text) return { ok: false, reason: 'empty_query', songs: [] };
  const limit = Math.max(1, Math.min(25, Number(opts.limit) || 8));
  const args = buildYtDlpSearchArgs(opts);
  args.push(`ytsearch${limit}:${text}`);
  const result = await runYtDlpRaw(args, Number(opts.timeoutMs) || YTDLP_RESOLVE_TIMEOUT_MS);
  if (!result.ok) {
    return {
      ok: false,
      reason: result.timedOut ? 'search_timeout' : 'search_failed',
      message: result.timedOut ? 'yt-dlp did not answer in time.' : summarizeYtDlpError(result.stderr, 'yt-dlp search failed.'),
      songs: [],
    };
  }
  return { ok: true, songs: parseYtDlpSearchJson(result.stdout) };
}

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

// Reported to the renderer so the UI offers the yt-dlp routes only where the
// binary actually exists, instead of showing a control that cannot work.
function getYtDlpCapabilities() {
  const bin = resolveYtDlpBinary();
  return {
    available: !!bin,
    version: versionCache || '',
    path: bin || '',
    // The bundled copy means the common case is "available".
    download: !!bin,
    resolve: !!bin,
    // Downloads embed metadata without ffmpeg, but not artwork.
    embedsThumbnail: !!bin && !!process.env.MINERADIO_FFMPEG_PATH,
  };
}

// ---------------------------------------------------------------------------
// Resolve / download
// ---------------------------------------------------------------------------

// Turns a URL or a "name artist" query into one playable stream URL. Returns
// { ok:false } with a human reason rather than throwing, because every caller
// treats this as one route in a fallback chain.
async function resolveWithYtDlp(target, options) {
  const opts = options || {};
  const bin = resolveYtDlpBinary();
  if (!bin) return { ok: false, reason: 'ytdlp_missing', message: 'yt-dlp is not installed in this build.' };
  const query = String(target || '').trim();
  if (!query) return { ok: false, reason: 'resolve_failed', message: 'Nothing to resolve.' };

  const args = buildYtDlpArgs({
    mode: 'resolve',
    format: opts.format,
    proxy: opts.proxy,
    cookiesFromBrowser: opts.cookiesFromBrowser,
    cookiesFile: opts.cookiesFile,
  });
  // A search query is not a URL. yt-dlp's own search prefix turns it into the
  // extractor's top result, which is what a "play this song" fallback wants.
  const source = /^https?:\/\//i.test(query) ? query : `ytsearch1:${query}`;
  args.push(source);

  const result = await runYtDlpRaw(args, Number(opts.timeoutMs) || YTDLP_RESOLVE_TIMEOUT_MS);
  if (!result.ok) {
    return {
      ok: false,
      reason: result.timedOut ? 'resolve_timeout' : 'resolve_failed',
      message: result.timedOut
        ? 'yt-dlp did not answer in time.'
        : summarizeYtDlpError(result.stderr, 'yt-dlp could not resolve a stream.'),
    };
  }
  const url = parseResolvedUrl(result.stdout);
  if (!url) return { ok: false, reason: 'no_progressive_stream', message: 'yt-dlp found no audio stream for this entry.' };
  return { ok: true, url, resolver: 'ytdlp' };
}

// Downloads to a destination directory. `onProgress` receives lines yt-dlp
// prints as it works; the caller decides whether to forward them to the UI.
async function downloadWithYtDlp(target, destinationDir, options) {
  const opts = options || {};
  const bin = resolveYtDlpBinary();
  if (!bin) return { ok: false, reason: 'ytdlp_missing', message: 'yt-dlp is not installed in this build.' };
  const query = String(target || '').trim();
  if (!query) return { ok: false, reason: 'resolve_failed', message: 'Nothing to download.' };

  const dir = destinationDir || path.join(os.homedir(), 'Downloads', 'Mineradio');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}

  const args = buildYtDlpArgs({
    mode: 'download',
    format: opts.format,
    proxy: opts.proxy,
    cookiesFromBrowser: opts.cookiesFromBrowser,
    cookiesFile: opts.cookiesFile,
    ffmpegLocation: opts.ffmpegLocation,
    noEmbed: opts.noEmbed,
    progress: true,
    printFilename: true,
    // %(title)s keeps yt-dlp's own sanitisation, which handles the Windows
    // reserved names and trailing dots that a hand-rolled name does not.
    outputTemplate: path.join(dir, '%(title)s [%(id)s].%(ext)s'),
    extra: opts.extra,
  });
  const source = /^https?:\/\//i.test(query) ? query : `ytsearch1:${query}`;
  args.push(source);

  const result = await runYtDlpRaw(args, Number(opts.timeoutMs) || YTDLP_RUN_TIMEOUT_MS, (child) => {
    if (typeof opts.onProgress !== 'function') return;
    const push = (chunk) => {
      String(chunk).split(/[\r\n]+/).filter(Boolean).forEach((line) => {
        try { opts.onProgress(line); } catch (_) {}
      });
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
  });

  const savedPath = parsePrintedPath(result.stdout);
  if (!result.ok) {
    return {
      ok: false,
      reason: result.timedOut ? 'download_timeout' : 'download_failed',
      message: result.timedOut
        ? 'yt-dlp did not finish in time.'
        : summarizeYtDlpError(result.stderr, 'yt-dlp could not download this track.'),
      path: savedPath,
    };
  }
  // --print after_move:filepath is the authority on where the file landed. If
  // it is missing the download still succeeded, so report what is known rather
  // than failing on a parse.
  let bytes = 0;
  try { if (savedPath && fs.existsSync(savedPath)) bytes = fs.statSync(savedPath).size; } catch (_) {}
  return { ok: true, path: savedPath, bytes };
}

module.exports = {
  resolveYtDlpBinary,
  ytDlpAvailable,
  ytDlpVersion,
  buildYtDlpArgs,
  buildYtDlpSearchArgs,
  parseResolvedUrl,
  parsePrintedPath,
  parseYtDlpSearchJson,
  summarizeYtDlpError,
  getYtDlpCapabilities,
  resolveWithYtDlp,
  downloadWithYtDlp,
  searchWithYtDlp,
  resetYtDlpCacheForTests,
  YTDLP_RESOLVE_TIMEOUT_MS,
  YTDLP_RUN_TIMEOUT_MS,
};
