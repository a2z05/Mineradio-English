// ============================================================
//  EN-FORK — keep the library in step with the disk.
//
//  Without this the library only changes when the user remembers to press
//  Refresh, which is the behaviour that makes a music player feel abandoned:
//  you drop an album in your folder and the app has not noticed.
//
//  fs.watch is recursive and async and therefore noisy: a single file copy
//  fires several events, a tag editor rewriting one file fires more, and a
//  cloud sync client can fire hundreds while it settles. So every event goes
//  into one debounce window, a rescan is scheduled at most every few seconds,
//  and two scans can never overlap (LocalMusicLibrary.scanFolders already
//  collapses a second caller onto the first, but not wasting the walk at all
//  is better).
//
//  The scan is the library's own scanFolders(): it re-reads only folders the
//  index already points at and only re-parses files whose mtime or size moved.
//  Nothing here parses a file or writes to the index.
// ============================================================

const DEBOUNCE_MS = 4000;
const MAX_DEBOUNCE_MS = 20000;
// The safety sweep is the last line of defence for roots fs.watch cannot hold.
// A full re-stat of a large folder is real work, so it stays well above the
// debounce window rather than matching it.
const SWEEP_MS = 120000;
const MIN_SWEEP_MS = 250;

class LocalLibraryWatcher {
  constructor(options = {}) {
    const library = options.library || null;
    const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
    this.library = library;
    this.onChange = onChange;
    this.debounceMs = Math.max(250, Number(options.debounceMs) || DEBOUNCE_MS);
    // The sweep has a floor so a mistyped intervalMs cannot turn a two-minute
    // re-stat into a one-second one — but it is an option, because a test that
    // has to observe a sweep inside a few hundred milliseconds otherwise could
    // not observe one at all, and untestable code here means untested code.
    this.intervalMs = Math.max(Number(options.intervalFloorMs) || MIN_SWEEP_MS,
      Number(options.intervalMs) || SWEEP_MS);
    this.watchers = new Map();
    this.watchRoots = [];
    this.timer = null;
    this.sinceFirstEvent = 0;
    this.scanning = false;
    this.pending = false;
    this.lastResult = null;
    this.stopped = false;
    this.changed = 0;
    this.failures = 0;
  }

  // fs.watch's `recursive` option exists on Windows and macOS. Linux returns
  // ENOSYS or delivers nothing, so there we fall back to one watcher per
  // top-level directory: enough to notice a new album folder without walking
  // 50k files every five seconds.
  //
  // Overridable because the behaviour is testable and worth testing: on a
  // platform where watching does not work, the sweep is the whole mechanism.
  supportsRecursive() {
    return process.platform === 'win32' || process.platform === 'darwin';
  }

  applyWatchRoots(folders) {
    this.watchRoots = (Array.isArray(folders) ? folders : [])
      .map((folder) => String(folder || '').trim())
      .filter(Boolean);
    this.syncWatchers();
  }

  syncWatchers() {
    if (this.stopped) return;
    const fs = require('fs');
    const path = require('path');
    const wanted = new Set(this.watchRoots);
    for (const [root, watcher] of Array.from(this.watchers.entries())) {
      if (wanted.has(root)) continue;
      try { watcher.close(); } catch (_) { /* already closed */ }
      this.watchers.delete(root);
    }
    if (!wanted.size) return;
    const recursive = this.supportsRecursive();
    const directories = recursive
      ? Array.from(wanted)
      : Array.from(wanted).flatMap((root) => {
        try {
          return fs.readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
            .map((entry) => path.join(root, entry.name));
        } catch (_) {
          return [];
        }
      });
    for (const directory of directories) {
      if (this.watchers.has(directory)) continue;
      try {
        const watcher = fs.watch(directory, { persistent: false, recursive });
        watcher.on('change', (_event, filename) => this.note(directory, filename));
        watcher.on('error', () => {
          // A root that vanished or a network share that dropped: drop the
          // watcher and wait for the next applyWatchRoots rather than throwing
          // out of an event handler.
          const current = this.watchers.get(directory);
          if (current) { try { current.close(); } catch (_) { /* ignore */ } }
          this.watchers.delete(directory);
        });
        this.watchers.set(directory, watcher);
      } catch (_) {
        // Unwatchable (network share, permission): the periodic sweep still
        // covers it, so this is not fatal.
      }
    }
  }

  // A scan already running: flag that another is owed and return. The running
  // scan's own completion path picks it up.
  async runScan(reason) {
    if (this.stopped) return null;
    if (!this.library || typeof this.library.scanFolders !== 'function') return null;
    this.scanning = true;
    try {
      const result = await this.library.scanFolders();
      this.changed += 1;
      // A scan changes the very list this watcher is watching. Indexing a
      // subdirectory beside an indexed file turns it into an orphan root of its
      // own, and deleting the last file under one takes it away again — so the
      // roots read at start() are stale the moment the walk finds something.
      // Nothing else re-reads them on this path: the watcher's own scans never
      // leave the watcher, so without this a library with no registered folder
      // gains directories the sweep covers and fs.watch never does.
      // Compared first because this runs after every debounced walk, and
      // readdir-ing every root on each one is not free on a large library.
      if (typeof this.library.watchDirectories === 'function') {
        const roots = this.library.watchDirectories();
        if (roots.join('\n') !== this.watchRoots.join('\n')) this.applyWatchRoots(roots);
      }
      this.lastResult = result || null;
      if (typeof this.onChange === 'function') this.onChange({ reason: reason || 'watch', result });
      return result;
    } catch (error) {
      this.failures += 1;
      return null;
    } finally {
      this.scanning = false;
      if (this.pending && !this.stopped) {
        this.pending = false;
        this.schedule(200);
      }
    }
  }

  schedule(delayMs) {
    if (this.stopped) return;
    const now = Date.now();
    if (!this.sinceFirstEvent) this.sinceFirstEvent = now;
    const elapsed = now - this.sinceFirstEvent;
    // A folder being filled right now keeps extending the window, but never past
    // the ceiling — otherwise a large copy delays the update indefinitely.
    const wait = Math.max(250, Math.min(MAX_DEBOUNCE_MS - elapsed, Number(delayMs) || this.debounceMs));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sinceFirstEvent = 0;
      this.runScan('watch');
    }, wait);
  }

  note(directory, filename) {
    // Noise filter: editors and sync clients write temporary files next to the
    // real one. Watching for them only buys a scan that finds no change.
    const name = String(filename || '').toLowerCase();
    if (name.startsWith('.') || name.endsWith('.tmp') || name.endsWith('.part')
      || name.endsWith('.crdownload') || name.endsWith('.partial') || name.endsWith('~')) return;
    this.schedule(this.debounceMs);
  }

  start() {
    if (this.stopped || this.sweeper) return this;
    // fs.watch is not a guarantee: a NAS folder, a drive letter that arrives
    // late, or a platform without recursive watching. The sweep is what makes
    // "automatic sync" true rather than "sync, usually".
    this.sweeper = setInterval(() => {
      if (this.stopped || this.scanning) return;
      // Inside a debounce window the event-driven scan is already owed; running
      // a second one here would walk the disk twice for one change.
      if (this.sinceFirstEvent) return;
      this.runScan('interval');
    }, this.intervalMs);
    if (this.sweeper && typeof this.sweeper.unref === 'function') this.sweeper.unref();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = null; }
    for (const watcher of this.watchers.values()) {
      try { watcher.close(); } catch (_) { /* already closed */ }
    }
    this.watchers.clear();
    return this;
  }

  status() {
    return {
      ok: true,
      running: !this.stopped,
      watching: this.watchRoots.length,
      watchers: this.watchers.size,
      recursive: this.supportsRecursive(),
      scanning: this.scanning,
      pending: this.pending,
      scans: this.changed,
      failures: this.failures,
      intervalMs: this.intervalMs,
    };
  }
}

module.exports = { DEBOUNCE_MS, MAX_DEBOUNCE_MS, LocalLibraryWatcher };
