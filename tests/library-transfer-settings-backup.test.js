'use strict';
// Step 18: M3U in and out, and a backup that carries settings as well as
// playlists, favourites, ratings and history.
//
// Two failure modes are worth more than the happy path here. A restore that
// half-applies — library back, settings left behind — looks like it did not
// work at all, so the settings half is checked against the same success gate
// the library half uses. And a file offered as a playlist has to produce
// entries: .pls lines read `File1=path`, and unwrapped they match no audio
// extension, so the import reports "no audio" for a perfectly good playlist.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { namedFunctionSource } = require('./helpers/extract-function');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');

// Values produced inside a vm context keep that realm's Object.prototype, which
// strict deep equality reports as a different type even when the data matches.
// Round-tripping through JSON compares what both sides actually agree on.
const plain = (value) => JSON.parse(JSON.stringify(value));

const transfer = read('public/js/modules/13-library/05-library-transfer.js');
const mainSource = read('desktop/main.js');
const loader = read('public/js/index-loader.js');
const { LocalLibraryUserData } = require(path.join(appRoot, 'desktop/local-library-user-data.js'));

// ---------------------------------------------------------------- snapshot

function settingsSources() {
  // Everything between the namespace constant and the first function that talks
  // to the desktop bridge: the denylist, the budget, and the three helpers.
  return transfer.slice(
    transfer.indexOf('var LIBRARY_SETTINGS_PREFIX'),
    transfer.indexOf('async function libraryBackupUserData')
  );
}

function settingsSandbox(initial) {
  const store = new Map(Object.entries(initial || {}));
  const localStorage = {
    get length() { return store.size; },
    key(i) { const keys = Array.from(store.keys()); return i < keys.length ? keys[i] : null; },
    getItem(k) { return store.has(String(k)) ? store.get(String(k)) : null; },
    setItem(k, v) { store.set(String(k), String(v)); },
    removeItem(k) { store.delete(String(k)); },
  };
  const sandbox = { console, window: { localStorage }, localStorage };
  vm.runInNewContext(settingsSources(), sandbox);
  sandbox.snapshot = sandbox.librarySettingsSnapshot;
  sandbox.apply = sandbox.librarySettingsApply;
  sandbox.store = store;
  return sandbox;
}

test('a snapshot keeps preferences and leaves credentials on the machine', () => {
  const sb = settingsSandbox({
    'mineradio-close-behavior-v1': 'tray',
    'mineradio-playback-tone-v1': '{"speed":1.5}',
    'mineradio-login-cookie-export-v1': 'session-token',
    'mineradio-login-workflow-connections-v1': '["spotify"]',
    'mineradio-qq-playback-vip-evidence-v1': 'evidence',
    'mineradio-provider-vip-audit-v1': 'audit',
    'mineradio-playback-norm-v1': '{"track:1":0}',
    'mineradio-last-playback-v1': '{"idx":4}',
    'mr_remote_lan': 'device-id',
    'apex-player-volume': '0.8',
  });

  const { settings, skipped } = plain(sb.snapshot());
  assert.deepEqual(settings, {
    'mineradio-close-behavior-v1': 'tray',
    'mineradio-playback-tone-v1': '{"speed":1.5}',
    'apex-player-volume': '0.8',
  }, 'the preferences travel, including the one that predates the namespacing');
  assert.deepEqual(skipped, [], 'nothing was over budget');
  assert.ok(!('mr_remote_lan' in settings), 'the device id stays on this machine');
});

test('a preference too large for the file is named, not dropped in silence', () => {
  const sb = settingsSandbox({
    'mineradio-close-behavior-v1': 'tray',
    'mineradio-custom-covers': 'x'.repeat(6 * 1024 * 1024),
  });
  const { settings, skipped } = plain(sb.snapshot());
  assert.ok(settings['mineradio-close-behavior-v1'] === 'tray', 'the small one still fits');
  assert.deepEqual(skipped, ['mineradio-custom-covers'],
    'the user is told what was left out rather than finding out later');
  assert.ok(!('mineradio-custom-covers' in settings));
});

test('restore writes only its own namespace, and never deletes a key it does not mention', () => {
  const sb = settingsSandbox({ 'mineradio-kept-v1': 'before', 'other-app': 'untouched' });
  const applied = sb.apply({
    'mineradio-close-behavior-v1': 'quit',
    'apex-player-volume': '0.5',
    'mineradio-login-cookie-export-v1': 'do-not-write-this',
    'not-a-mineradio-key': 'nope',
    'mineradio-kept-v1': 'after',
    'mineradio-number-v1': 42,
  });
  assert.equal(applied, 3, 'the excluded key, the foreign key and the non-string are refused');
  assert.equal(sb.store.get('mineradio-close-behavior-v1'), 'quit');
  assert.equal(sb.store.get('apex-player-volume'), '0.5');
  assert.equal(sb.store.get('mineradio-kept-v1'), 'after');
  assert.equal(sb.store.get('other-app'), 'untouched', 'another app in the same origin is out of bounds');
  assert.equal(sb.store.has('mineradio-login-cookie-export-v1'), false,
    'a hand-edited backup cannot smuggle a session back in');
  assert.equal(sb.apply(null), 0, 'no settings block at all is not an error');
});

// ---------------------------------------------------------------- backup UI

async function transferSandbox(opts) {
  opts = opts || {};
  const store = new Map(Object.entries(opts.storage || {}));
  const localStorage = {
    get length() { return store.size; },
    key(i) { const keys = Array.from(store.keys()); return i < keys.length ? keys[i] : null; },
    getItem(k) { return store.has(String(k)) ? store.get(String(k)) : null; },
    setItem(k, v) { store.set(String(k), String(v)); },
    removeItem(k) { store.delete(String(k)); },
  };
  const sandbox = {
    console,
    Object,
    Array,
    JSON,
    String,
    Number,
    setTimeout(fn, ms) { sandbox.pending.push({ fn, ms }); return sandbox.pending.length; },
    pending: [],
    toasts: [],
    exports: [],
    restored: [],
    showSettings: null,
    showToast(m) { sandbox.toasts.push(m); },
    location: { reload() { sandbox.reloaded = (sandbox.reloaded || 0) + 1; } },
    localLibrarySetUserData(v) { sandbox.userData = v; },
    setLocalLibraryStoreTracks(v) { sandbox.tracks = v; },
    libraryPaintPlaylistPane() {},
    libraryPaintNav() {},
    libraryPage: { open: false },
    libraryRebuildRows() {},
    window: {
      localStorage,
      desktopWindow: opts.desktop || null,
    },
  };
  const text = [
    settingsSources(),
    namedFunctionSource(transfer, 'libraryBackupUserData'),
    namedFunctionSource(transfer, 'libraryRestoreUserData'),
  ].join('\n');
  vm.runInNewContext(text, sandbox);
  sandbox.store = store;
  return sandbox;
}

test('the backup file carries the settings alongside the library', async () => {
  const sb = await transferSandbox({
    storage: { 'mineradio-close-behavior-v1': 'tray', 'mineradio-login-cookie-export-v1': 'token' },
    desktop: {
      async backupLocalLibraryUserData() {
        return { ok: true, payload: { kind: 'mineradio-local-library', userData: { songs: {}, playlists: [] } } };
      },
      async exportJsonFile(payload) { sb.exported = payload; return { ok: true }; },
    },
  });
  await sb.libraryBackupUserData();
  assert.ok(sb.exported, 'the file was written');
  assert.deepEqual(plain(sb.exported.data.settings), { 'mineradio-close-behavior-v1': 'tray' });
  assert.equal(sb.exported.data.kind, 'mineradio-local-library');
  assert.deepEqual(sb.toasts, ['Backup saved']);
});

test('settings are written only after the library half is accepted', async () => {
  const build = (ok) => transferSandbox({
    storage: { 'mineradio-close-behavior-v1': 'tray' },
    desktop: {
      async restoreLocalLibraryUserData() {
        return ok ? { ok: true, songs: { a: 1 }, playlists: [] } : { ok: false, error: 'BAD_BACKUP' };
      },
      async importJsonFile() {
        return { text: JSON.stringify({ kind: 'mineradio-local-library', settings: { 'mineradio-close-behavior-v1': 'quit' } }) };
      },
    },
  });

  const refused = await build(false);
  await refused.libraryRestoreUserData();
  assert.equal(refused.store.get('mineradio-close-behavior-v1'), 'tray',
    'a backup the main process refuses must not touch a single preference');
  assert.equal(refused.pending.length, 0, 'and nothing is scheduled either');
  assert.deepEqual(refused.toasts, ['That backup is unreadable — nothing was changed']);

  const accepted = await build(true);
  await accepted.libraryRestoreUserData();
  assert.equal(accepted.store.get('mineradio-close-behavior-v1'), 'quit');
  assert.match(accepted.toasts[0], /Backup restored/);
  assert.match(accepted.toasts[0], /1 setting applied/);
  assert.equal(accepted.pending.length, 1, 'the reload is scheduled, not immediate');
  assert.equal(accepted.pending[0].ms, 900, 'the toast has a moment to be read');
  assert.equal(accepted.reloaded, undefined, 'and does not fire in the same tick');
  accepted.pending.forEach((job) => job.fn());
  assert.equal(accepted.reloaded, 1, 'settings are read at boot, so the window reloads once they are in');
});

test('a backup with no settings block restores the library and leaves preferences alone', async () => {
  const sb = await transferSandbox({
    storage: { 'mineradio-close-behavior-v1': 'tray' },
    desktop: {
      async restoreLocalLibraryUserData() { return { ok: true, songs: {}, playlists: [] }; },
      async importJsonFile() { return { text: JSON.stringify({ kind: 'mineradio-local-library', userData: {} }) }; },
    },
  });
  await sb.libraryRestoreUserData();
  assert.equal(sb.store.get('mineradio-close-behavior-v1'), 'tray');
  assert.equal(sb.reloaded, undefined, 'nothing changed, so there is nothing to re-read');
  assert.deepEqual(sb.toasts, ['Backup restored']);
});

// ---------------------------------------------------------------- playlists

// The parser runs in a vm with the real path module, so relative resolution and
// the platform's notion of an absolute path are the ones the app will use.
const parsePlaylist = vm.runInNewContext(
  namedFunctionSource(mainSource, 'parsePlaylistText') + '; parsePlaylistText',
  { path, process, String, RegExp, Set, Math }
);

test('playlist text resolves to files, in both of the formats we offer', () => {
  const parse = parsePlaylist;
  const base = path.resolve(path.sep + 'playlists');

  // M3U: comments, an absolute path, and a relative one beside the file.
  const m3u = ['#EXTM3U', '#EXTINF:245,U2 - City of Blinding Lights',
    path.join(base, 'one.mp3'), 'two.flac', '', 'notes.txt'].join('\r\n');
  assert.deepEqual(plain(parse(m3u, base)), [
    { path: path.join(base, 'one.mp3'), relativePath: '' },
    { path: path.join(base, 'two.flac'), relativePath: '' },
  ], 'comments and non-audio lines are skipped, both path styles are kept');

  // A UTF-8 BOM written by a Windows tool must not prefix the first path.
  const bom = String.fromCharCode(0xfeff) + path.join(base, 'first.mp3');
  assert.equal(parse(bom, base).length, 1, 'the byte-order mark is not part of the filename');
  assert.equal(parse(bom, base)[0].path, path.join(base, 'first.mp3'));

  // PLS: the path is wrapped, which is why it used to match nothing at all.
  const pls = ['[playlist]', 'File1=' + path.join(base, 'alpha.mp3'),
    'File2=beta.m4a', 'Title1=Alpha - Song', 'Length1=200', 'NumberOfEntries=2', 'Version=2'].join('\n');
  assert.deepEqual(plain(parse(pls, base)), [
    { path: path.join(base, 'alpha.mp3'), relativePath: '' },
    { path: path.join(base, 'beta.m4a'), relativePath: '' },
  ], 'FileN= is unwrapped; TitleN= and the header carry no audio and are dropped');

  // The same track listed twice is one entry, even across case on Windows.
  const twice = [path.join(base, 'dup.mp3'), path.join(base, 'dup.mp3')].join('\n');
  assert.equal(parse(twice, base).length, 1);

  assert.deepEqual(plain(parse('', base)), [], 'an empty file yields no entries');
  assert.deepEqual(plain(parse('#EXTM3U\n', base)), [], 'and so does a header with nothing under it');
});

test('playlist files on disk parse the way the file dialog promises', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-playlists-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { } });
  for (const name of ['alpha.mp3', 'beta.m4a']) fs.writeFileSync(path.join(dir, name), '');

  // A byte-order-marked M3U of the sort a Windows tool writes, with no header.
  const m3uPath = path.join(dir, 'set.m3u8');
  fs.writeFileSync(m3uPath,
    String.fromCharCode(0xfeff) + ['alpha.mp3', 'beta.m4a', '# a note'].join('\r\n') + '\r\n',
    'utf8');
  const m3uEntries = parsePlaylist(fs.readFileSync(m3uPath, 'utf8'), path.dirname(m3uPath));
  assert.equal(m3uEntries.length, 2, 'both tracks, neither the note nor the BOM');
  for (const entry of m3uEntries) {
    assert.ok(fs.existsSync(entry.path), 'resolved to a file that exists: ' + entry.path);
  }

  // And a .pls, which the dialog offers and which used to import nothing.
  const plsPath = path.join(dir, 'set.pls');
  fs.writeFileSync(plsPath, [
    '[playlist]',
    'File1=alpha.mp3',
    'File2=' + path.join(dir, 'beta.m4a'),
    'Title1=Alpha - Song',
    'Length1=200',
    'NumberOfEntries=2',
    'Version=2',
  ].join('\n'), 'utf8');
  const plsEntries = parsePlaylist(fs.readFileSync(plsPath, 'utf8'), path.dirname(plsPath));
  assert.equal(plsEntries.length, 2, 'a .pls yields entries rather than "no audio"');
  for (const entry of plsEntries) {
    assert.ok(fs.existsSync(entry.path), 'resolved to a file that exists: ' + entry.path);
  }
  assert.deepEqual(plain(plsEntries).map((e) => path.basename(e.path)), ['alpha.mp3', 'beta.m4a']);
});

test('the dialog that offers .pls actually understands one', () => {
  // The import handler and its parser have to agree, or the file dialog is
  // promising something the reader throws away.
  assert.match(mainSource, /extensions: \['m3u', 'm3u8', 'pls'\]/);
  const at = mainSource.indexOf("ipcMain.handle('mineradio-local-library-import-m3u'");
  assert.ok(at >= 0, 'the import handler must exist');
  const handler = mainSource.slice(at, mainSource.indexOf('ipcMain.handle(', at + 10));
  assert.match(handler, /parsePlaylistText\(text, baseDirectory\)/,
    'the handler reads through the parser rather than its own copy of the loop');
  assert.match(handler, /PLAYLIST_HAD_NO_AUDIO/);
});

// ---------------------------------------------------------------- the store

test('a backup round trip puts ratings and playlists back without wiping what is newer', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-backup-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { } });

  const a = new LocalLibraryUserData({ userDataPath: dir });
  await a.setFavorite('aaaabbbbccccddddeeeeffff', true);
  await a.setRating('aaaabbbbccccddddeeeeffff', 5);
  await a.recordEvent('aaaabbbbccccddddeeeeffff', 'play');
  await a.createPlaylist('Road trip', 'pl-road');
  await a.addToPlaylist('pl-road', ['aaaabbbbccccddddeeeeffff']);

  const payload = a.backupPayload();
  assert.equal(payload.kind, 'mineradio-local-library');

  // Life goes on: a new favourite and a new playlist after the snapshot.
  const b = new LocalLibraryUserData({ userDataPath: dir });
  await b.setFavorite('111122223333444455556666', true);
  await b.createPlaylist('Made later', 'pl-later');

  const merged = await b.restorePayload(payload);
  assert.equal(merged.ok, true);
  assert.equal(merged.songs['aaaabbbbccccddddeeeeffff'].rating, 5, 'the rating came back');
  assert.equal(merged.songs['aaaabbbbccccddddeeeeffff'].favorite, true);
  assert.ok(merged.songs['aaaabbbbccccddddeeeeffff'].plays >= 1, 'so did the play count');
  assert.equal(merged.songs['111122223333444455556666'].favorite, true,
    'a merge keeps what the backup never heard of');
  assert.ok(merged.playlists.some((p) => p.id === 'pl-later'),
    'including a playlist created after the backup was taken');

  // Replace is the other half of the contract.
  const replaced = await b.restorePayload(payload, { replace: true });
  assert.equal(replaced.ok, true);
  assert.ok(!replaced.playlists.some((p) => p.id === 'pl-later'), 'replace means replace');
  assert.ok(replaced.playlists.some((p) => p.id === 'pl-road'));
});

test('a backup that does not look like one is refused rather than merged', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-backup-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { } });

  const store = new LocalLibraryUserData({ userDataPath: dir });
  await store.setFavorite('aaaabbbbccccddddeeeeffff', true);
  const before = store.backupPayload();

  for (const bad of [null, 'a string', 42, {}, { kind: 'something-else' }, { hello: 'world' }]) {
    const result = await store.restorePayload(bad);
    assert.equal(result.ok, false, 'refused: ' + JSON.stringify(bad));
    assert.equal(result.error, 'BAD_BACKUP');
  }

  const after = store.backupPayload();
  assert.equal(after.userData.songs['aaaabbbbccccddddeeeeffff'].favorite, true,
    'nothing that was refused was allowed to clear what was already there');
  assert.deepEqual(Object.keys(after.userData.songs), Object.keys(before.userData.songs));
});

test('the transfer module is loaded and its menu reaches both halves', () => {
  assert.match(loader, /'js\/modules\/13-library\/05-library-transfer\.js'/);
  const page = read('public/js/modules/13-library/01-library-page.js');
  assert.match(page, /\['Import M3U playlist', 'libraryImportM3u\(\)'\]/);
  assert.match(page, /\['Export this view as M3U', 'libraryExportM3u\(\)'\]/);
  assert.match(page, /\['Backup library data', 'libraryBackupUserData\(\)'\]/);
  assert.match(page, /\['Restore backup', 'libraryRestoreUserData\(\)'\]/);
  // The desktop bridge is what makes all four real; without it they say so.
  const preload = read('desktop/preload.js');
  for (const name of ['exportLocalLibraryM3u', 'importLocalLibraryM3u',
    'backupLocalLibraryUserData', 'restoreLocalLibraryUserData', 'exportJsonFile', 'importJsonFile']) {
    assert.ok(preload.includes(name + ':'), name + ' must be exposed by the preload bridge');
  }
});
