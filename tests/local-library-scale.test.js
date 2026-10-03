'use strict';
// Step 20: what the library does at 1k, 10k and 50k songs.
//
// The main process had a ceiling in the way of all three. stageSnapshot
// refused any index over 16 MB — reached at roughly 11k tracks — so past that
// every import and rescan threw LOCAL_LIBRARY_INDEX_TOO_LARGE, while loadIndex
// skipped an oversized file without a word and the next launch opened an empty
// library with nothing on screen to say why. Song text is what made it heavy:
// measured on a real library here, 55% of a 50k index was lyrics, read through
// one call and never listed, grouped or searched. They now live beside the
// track, and the index is whatever is left.
//
// The renderer's half is a different kind of problem. A list that builds a row
// per song is not a list at 50k, it is a tab crash: the window has to hold the
// same handful of rows whether there are a thousand songs or fifty thousand,
// and the grouping index behind search has to be built once rather than on
// every keystroke.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { namedFunctionSource } = require('./helpers/extract-function');

const {
  LocalMusicLibrary,
  MAX_LIBRARY_INDEX_BYTES,
  localFileId,
} = require('../desktop/local-music-library');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');
const storeSource = read('public/js/modules/13-library/00-local-library-store.js');
const pageSource = read('public/js/modules/13-library/01-library-page.js');

const SEP = String.fromCharCode(92);
const INDEX_NAME = 'local-music-library.json';

// The store functions the renderer half runs on, in the order the page loads
// them. Everything else the window touches is stubbed below.
const STORE_NAMES = [
  'invalidateLocalLibraryIndex', 'localFileIdOf', 'localLibrarySongKey',
  'localLibraryUserState', 'localLibraryIsFavorite', 'localLibraryNormalizeTracks',
  'localLibraryFolderOf', 'localLibraryKeyFor', 'localLibraryBuildGroups',
  'localLibraryBuildIndex', 'libraryViewMeta', 'localLibrarySortedCopy',
  'libraryViewRows', 'localLibrarySearchBlob', 'localLibrarySearchBlobs',
  'localLibraryScoreMatch', 'localLibraryScoreCeiling', 'localLibraryQueryTerms',
  'localLibraryMatchScore', 'localLibraryBlobCouldMatch', 'localLibraryHitBetter',
  'localLibraryCompareHits', 'localLibrarySearchSongs',
  'librarySearchTracks', 'localLibrarySearchCandidates',
];

function profileRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-scale-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { } });
  return path.join(root, 'profile');
}

// ---------------------------------------------------------------- records
//
// Built from the shape of a real index on this machine — same path lengths,
// same tag density, lyrics on about a third of the tracks at about 2 KB each,
// which is what 588 real records measured (36% carrying any, 2171 B average).
// Ids are hashes of the audio path because loadIndex rejects anything else.

function sampleLyric(i) {
  const line = `[00:${String(i % 60).padStart(2, '0')}.000] A verse line long enough to be worth counting`;
  let text = '';
  while (Buffer.byteLength(text, 'utf8') < 2000) text += line + '\n';
  return text;
}

// How many tracks in a fixture carry text. The 50k case thins this out, and
// the reason is measured rather than aesthetic: a sidecar write costs ~0.85 ms
// on this disk at any concurrency (write plus rename on NTFS — 8, 16, 32 and
// 64 all land between 0.80 and 0.89), so a third of 50k is ~14 s of one
// persist, which under the runner's file-level parallelism pushes the case to
// ~28 s against a budget meant to catch a quadratic, not to price a disk.
// One in twenty is still 800 sidecars — plenty to prove the drain — while the
// full density stays at 1k and 10k, where it costs 0.3 s and 2.8 s.
const lyricEvery = (size) => (size >= 50000 ? 20 : 3);

function realisticRecord(i, every) {
  const album = `Album ${i % 60}`;
  const title = `A reasonably long track title number ${i}`;
  const hasLyric = i % every === 0;
  const audioPath = `C:${SEP}Users${SEP}a2z${SEP}Music${SEP}Artists${SEP}Group ${i % 400}${SEP}`
    + `${album}${SEP}${String((i % 14) + 1).padStart(2, '0')} - ${title}.flac`;
  return {
    id: localFileId(audioPath),
    audioPath,
    relativePath: `${album}/${String((i % 14) + 1).padStart(2, '0')} - ${title}.flac`,
    name: title,
    artist: `Artist ${i % 900}`,
    album,
    albumArtist: `Artist ${i % 900}`,
    genre: ['Rock', 'Electronic', 'Jazz', 'Classical'][i % 4],
    year: 1995 + (i % 30),
    track: (i % 14) + 1,
    disc: 1,
    composer: i % 7 === 0 ? `Composer ${i % 50}` : '',
    comment: '',
    bitrate: 1411,
    sampleRate: 44100,
    codec: 'flac',
    duration: 180 + (i % 240),
    size: 12000000 + (i % 100000),
    mtimeMs: 1700000000000 + i * 1000,
    revision: `${(1700000000 + i).toString(36)}-2ed4c0`,
    coverPath: '',
    coverMime: '',
    lyric: hasLyric ? sampleLyric(i) : '',
    lyricSource: hasLyric ? 'embedded' : '',
    importedAt: 1700000000000,
    addedAt: 1700000000000,
  };
}

function syntheticLibrary(size) {
  const records = new Map();
  const order = [];
  const every = lyricEvery(size);
  for (let i = 0; i < size; i += 1) {
    const record = realisticRecord(i, every);
    records.set(record.id, record);
    order.push(record.id);
  }
  return { records, order };
}

// ---------------------------------------------------------------- the index

for (const size of [1000, 10000, 50000]) {
  test(`a ${size}-song library writes an index loadIndex accepts back`, async (t) => {
    const profile = profileRoot(t);
    const { records, order } = syntheticLibrary(size);
    const library = new LocalMusicLibrary({ userDataPath: profile });

    const wroteAt = Date.now();
    await library.persistSnapshot(order, records);
    const writeMs = Date.now() - wroteAt;

    const indexPath = path.join(profile, INDEX_NAME);
    const indexBytes = fs.statSync(indexPath).size;
    assert.ok(indexBytes <= MAX_LIBRARY_INDEX_BYTES,
      `${size} songs is ${(indexBytes / 1048576).toFixed(1)} MB, over the ${(MAX_LIBRARY_INDEX_BYTES / 1048576).toFixed(0)} MB the writer accepts`);
    // Lyric text is what used to put a 50k library at 68 MB. If it ever comes
    // back into the index this number climbs back towards that.
    assert.ok(indexBytes < 40 * 1024 * 1024,
      `the metadata index should stay near ${(indexBytes / 1048576).toFixed(1)} MB, not grow into the lyric budget`);

    const text = fs.readFileSync(indexPath, 'utf8');
    assert.ok(!text.includes('"lyric":'), 'no song text is left in the index');
    assert.ok(text.includes('"lyricSource":'), 'the source tag still is, so the UI can tell which have lyrics');

    // Opening is the constructor: loadIndex runs there, before anything asks
    // for a track, so the parse is inside the clock rather than paid for free.
    const readAt = Date.now();
    const reopened = new LocalMusicLibrary({
      userDataPath: profile,
      // A reload must come from the index alone; anything that tries to parse
      // a file here would mean the index is not carrying what it claims to.
      parseMetadata: async () => { throw new Error('reload must use the index'); },
    });
    const snapshot = reopened.listTracksSync();
    const readMs = Date.now() - readAt;

    assert.equal(snapshot.count, size, 'every track comes back');
    assert.equal(snapshot.warning, '', 'nothing was skipped on the way in');
    assert.equal(reopened.indexWarning, '');
    assert.ok(snapshot.tracks.every((track) => track.hasLyric === (records.get(track.localFileId).lyricSource !== '')),
      'hasLyric survives without the text that used to prove it');

    // Generous on purpose: the point is to catch a quadratic, not to price a
    // particular disk. A quadratic at this size is minutes; a slow disk is a
    // second or two, and the sidecar writes are already counted above.
    assert.ok(writeMs < 30000, `writing ${size} songs took ${writeMs} ms`);
    assert.ok(readMs < 5000, `opening ${size} songs took ${readMs} ms`);
  });
}

test('lyric text leaves the index and comes back from beside the track', async (t) => {
  const profile = profileRoot(t);
  const { records, order } = syntheticLibrary(300);
  const library = new LocalMusicLibrary({ userDataPath: profile });
  await library.persistSnapshot(order, records);

  // Index 0 and index 3 both carry lyrics; index 1 does not.
  const [withLyric, withoutLyric, , alsoWithLyric] = order;
  const expected = sampleLyric(0);
  const lyricsDir = path.join(profile, 'local-music-library', 'lyrics');

  assert.ok(fs.existsSync(path.join(lyricsDir, `${withLyric}.txt`)),
    'the text is a file beside the track');
  assert.equal(fs.readFileSync(path.join(lyricsDir, `${withLyric}.txt`), 'utf8'), expected,
    'and it is the text that was on the record');
  assert.ok(!fs.existsSync(path.join(lyricsDir, `${withoutLyric}.txt`)),
    'a track with no lyric does not get an empty file');
  assert.ok(records.get(withLyric).lyric === undefined,
    'the record let go of it only once the copy on disk was confirmed');

  const reopened = new LocalMusicLibrary({ userDataPath: profile });
  // decodeLyricBuffer normalises the trailing newline away, exactly as it does
  // for every .lrc the user drops beside a track.
  assert.equal(reopened.lyricForTrack(withLyric).lyric, expected.trim(),
    'the words are readable after a restart, from disk');
  assert.equal(reopened.lyricForTrack(withLyric).lyricSource, 'embedded');
  assert.equal(reopened.lyricForTrack(withoutLyric).lyric, '');
  assert.equal(reopened.listTracksSync().tracks[0].hasLyric, true,
    'the list still knows which tracks have lyrics without reading any of them');

  // Removing a track takes its words with it, and leaves everyone else's.
  await reopened.removeTracks([withLyric]);
  assert.equal(fs.existsSync(path.join(lyricsDir, `${withLyric}.txt`)), false,
    'the track went, so its lyric file went');
  assert.ok(fs.existsSync(path.join(lyricsDir, `${alsoWithLyric}.txt`)),
    'the other tracks kept theirs');
  assert.equal(reopened.listTracksSync().count, 299);
});

test('an index written by an older build still opens, and its lyrics move out on the next write', async (t) => {
  const profile = profileRoot(t);
  fs.mkdirSync(profile, { recursive: true });
  const audioPath = `C:${SEP}Music${SEP}Legacy${SEP}Old Song.flac`;
  const legacy = {
    version: 1,
    updatedAt: Date.now(),
    mediaToken: 'a'.repeat(48),
    folders: [],
    records: [{
      id: localFileId(audioPath),
      audioPath,
      relativePath: 'Legacy/Old Song.flac',
      name: 'Old Song',
      artist: 'Long Ago',
      album: 'Earlier',
      albumArtist: '',
      genre: '',
      year: 1999,
      track: 1,
      disc: 1,
      composer: '',
      comment: '',
      bitrate: 320,
      sampleRate: 44100,
      codec: 'mp3',
      duration: 200,
      size: 4000000,
      mtimeMs: 1700000000000,
      revision: 'x-y',
      coverPath: '',
      coverMime: '',
      lyric: '[00:03.000] Words the old build stored inline',
      lyricSource: 'sidecar',
      importedAt: 1700000000000,
      addedAt: 1700000000000,
    }],
  };
  fs.writeFileSync(path.join(profile, INDEX_NAME), JSON.stringify(legacy), 'utf8');

  const library = new LocalMusicLibrary({ userDataPath: profile });
  const id = localFileId(audioPath);
  assert.equal(library.listTracksSync().count, 1, 'the old file still opens');
  assert.equal(library.listTracksSync().tracks[0].hasLyric, true,
    'and still claims its lyric even though nothing has parsed a file yet');
  assert.equal(library.lyricForTrack(id).lyric, '[00:03.000] Words the old build stored inline',
    'the only copy of the text is read straight out of the index');

  // One write is all it takes: the text lands beside the track and stops
  // riding in the index that every mutation rewrites.
  await library.persistSnapshot(library.order, library.records);
  const onDisk = JSON.parse(fs.readFileSync(path.join(profile, INDEX_NAME), 'utf8'));
  assert.ok(!('lyric' in onDisk.records[0]), 'the text is no longer in the index');
  assert.equal(onDisk.records[0].lyricSource, 'sidecar', 'what it came from stays');
  assert.equal(fs.readFileSync(
    path.join(profile, 'local-music-library', 'lyrics', `${id}.txt`), 'utf8'
  ), '[00:03.000] Words the old build stored inline');

  const reopened = new LocalMusicLibrary({ userDataPath: profile });
  assert.equal(reopened.listTracksSync().tracks[0].hasLyric, true);
  assert.equal(reopened.lyricForTrack(id).lyric, '[00:03.000] Words the old build stored inline',
    'and a second restart reads it from the sidecar');
});

test('a library that will not open says so instead of showing nothing', (t) => {
  const oversized = profileRoot(t);
  fs.mkdirSync(oversized, { recursive: true });
  fs.writeFileSync(path.join(oversized, INDEX_NAME), Buffer.alloc(MAX_LIBRARY_INDEX_BYTES + 1));
  const tooBig = new LocalMusicLibrary({ userDataPath: oversized });
  assert.equal(tooBig.indexWarning, 'LOCAL_LIBRARY_INDEX_TOO_LARGE');
  assert.equal(tooBig.listTracksSync().count, 0);
  assert.equal(tooBig.listTracksSync().warning, 'LOCAL_LIBRARY_INDEX_TOO_LARGE',
    'the count alone would read as "your music is gone"');

  const corrupt = profileRoot(t);
  fs.mkdirSync(corrupt, { recursive: true });
  fs.writeFileSync(path.join(corrupt, INDEX_NAME), '{"version":1,"records":[not json', 'utf8');
  const broken = new LocalMusicLibrary({ userDataPath: corrupt });
  assert.ok(broken.indexWarning, 'a file that will not parse is reported, not swallowed');
  assert.equal(broken.listTracksSync().warning, broken.indexWarning);

  const fresh = profileRoot(t);
  const never = new LocalMusicLibrary({ userDataPath: fresh });
  assert.equal(never.indexWarning, '', 'having no library yet is not a failure');
});

// The store and the empty state as the page runs them: the real declarations,
// the real hydrate, and the desktop bridge stood in by whatever list the test
// hands over.
function rendererSandbox(snapshot) {
  const start = storeSource.indexOf('var localLibraryStore');
  const sandbox = {
    console,
    window: {
      desktopWindow: {
        listLocalMusicLibrary: async () => snapshot,
        getLocalLibraryUserData: async () => ({ ok: false }),
        listLocalMusicFolders: async () => ({ ok: false }),
      },
    },
    hydrateCustomCover: (song) => song,
    cloneSong: (song) => Object.assign({}, song),
    escHtml: (value) => String(value),
    libraryPage: { query: '' },
  };
  vm.runInNewContext(
    storeSource.slice(start, storeSource.indexOf('};', start) + 2)
      + '\n' + [
        'invalidateLocalLibraryIndex', 'localFileIdOf', 'localLibrarySongKey',
        'localLibraryNormalizeTracks', 'hydrateLocalLibraryStore',
        'rebuildLocalLibraryById', 'setLocalLibraryStoreTracks',
      ].map((n) => namedFunctionSource(storeSource, n)).join('\n')
      + '\n' + namedFunctionSource(pageSource, 'libraryEmptyStateHtml'),
    sandbox
  );
  return sandbox;
}

test('an index that will not open is told apart from an empty library', async (t) => {
  const profile = profileRoot(t);
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, INDEX_NAME), '{"version":1,"records":[not json', 'utf8');
  const library = new LocalMusicLibrary({ userDataPath: profile });
  const snapshot = library.listTracksSync();
  assert.equal(snapshot.count, 0, 'nothing was loaded');
  assert.ok(snapshot.warning, 'but the reason travels with the count');

  // The page reads through hydrateLocalLibraryStore, so that is the call that
  // has to pick the reason up. A field nothing reads is worth no more than no
  // field at all, which is how this shipped in the first place.
  const sb = rendererSandbox(snapshot);
  await sb.hydrateLocalLibraryStore({ force: true });
  assert.equal(sb.localLibraryStore.warning, snapshot.warning,
    'the store keeps what the main process reported');
  const broken = sb.libraryEmptyStateHtml();
  assert.match(broken, /could not be opened/);
  assert.doesNotMatch(broken, /Your library is empty/,
    'an unreadable index must not invite the user to start over as though they had none');

  // A write that lands is proof the file on disk is one we made and checked the
  // size of, so the complaint is withdrawn here rather than carried into every
  // later session by a constructor that runs once.
  const { records, order } = syntheticLibrary(4);
  await library.persistSnapshot(order, records);
  assert.equal(library.indexWarning, '', 'the write that replaced it clears it');
  assert.equal(library.listTracksSync().warning, '');

  // And on the page, a list the main process has just answered with retires a
  // warning about some older file — so a library that is later emptied reads as
  // empty rather than staying labelled broken for the rest of the session.
  sb.setLocalLibraryStoreTracks([]);
  assert.equal(sb.localLibraryStore.warning, '');
  assert.match(sb.libraryEmptyStateHtml(), /Your library is empty/,
    'empty again, not broken');
});

// ---------------------------------------------------------------- the window

const OVERSCAN = Number(/var LIBRARY_OVERSCAN\s*=\s*(\d+)/.exec(pageSource)[1]);
assert.ok(Number.isFinite(OVERSCAN) && OVERSCAN >= 0, 'the window overscan must be readable');

function scaleSong(i) {
  return {
    localFileId: String(i).padStart(24, '0'),
    localKey: String(i).padStart(24, '0'),
    localUrl: 'mineradio-local://audio/' + i,
    localPath: `Album ${i % 60}/Track ${i}.flac`,
    name: `Track ${i}`,
    artist: `Artist ${i % 900}`,
    album: `Album ${i % 60}`,
    albumArtist: `Artist ${i % 900}`,
    genre: ['Rock', 'Electronic', 'Jazz', 'Classical'][i % 4],
    year: 1995 + (i % 30),
    composer: '',
    duration: 180 + (i % 240),
    addedAt: 1700000000000 + i,
  };
}

// The window itself is what is under test, so the row markup is stubbed: what
// matters is how many rows reach the DOM and whether that number moves when
// the library does, not what each row looks like.
function windowSandbox(tracks) {
  const elements = {};
  const element = (extra) => Object.assign({ style: {}, dataset: {}, innerHTML: '', hidden: false }, extra || {});
  elements['library-spacer'] = element();
  elements['library-window'] = element();
  elements['library-scroller'] = element({ clientHeight: 640 });
  elements['library-empty'] = element();

  const sandbox = {
    console,
    localLibraryStore: { tracks, byId: {}, userData: { songs: {}, playlists: [] }, folders: [], index: null, indexAt: 0 },
    libraryPage: {
      open: true, view: 'songs', query: '', rows: [], songs: [],
      rowHeight: 54, scrollTop: 0, loading: false, scanning: false, scanAt: 0,
      selection: {}, selectedOrder: [], anchor: -1, drill: null, drillStamp: 0, status: '',
    },
    document: { getElementById: (id) => elements[id] || null },
    librarySongRowHtml: (song, index) => `<i data-row="${index}"></i>`,
    libraryGroupRowHtml: (group, index) => `<b data-row="${index}"></b>`,
    libraryPlaylistRowHtml: (playlist, index) => `<u data-row="${index}"></u>`,
    libraryEmptyStateHtml: () => 'empty',
    escHtml: (value) => String(value),
  };
  vm.runInNewContext(
    namedFunctionSource(pageSource, 'libraryRenderWindow')
      + '\n' + namedFunctionSource(pageSource, 'libraryRowAt')
      + `\nvar LIBRARY_OVERSCAN = ${OVERSCAN};`,
    sandbox
  );
  sandbox.elements = elements;
  sandbox.render = () => sandbox.libraryRenderWindow(false);
  sandbox.renderedRows = () => (elements['library-window'].innerHTML.match(/data-row=/g) || []).length;
  return sandbox;
}

function wrapRows(sandbox, tracks) {
  sandbox.libraryPage.rows = tracks.map((song) => ({ kind: 'song', song }));
}

test('the list window holds the same handful of rows at 1k and at 50k', () => {
  const counts = [];
  for (const size of [1000, 50000]) {
    const tracks = [];
    for (let i = 0; i < size; i += 1) tracks.push(scaleSong(i));
    const sandbox = windowSandbox(tracks);
    wrapRows(sandbox, tracks);

    sandbox.libraryPage.scrollTop = 0;
    sandbox.libraryRenderWindow(true);
    assert.equal(sandbox.elements['library-spacer'].style.height, `${size * 54}px`,
      'the scrollbar still describes the whole library');
    const atTop = sandbox.renderedRows();
    assert.ok(atTop > 0, `${size} songs rendered something`);
    assert.ok(atTop <= 20,
      `${size} songs put ${atTop} rows in the DOM — the window must not follow the library up`);

    // Deep in the list, where a naive renderer has already built fifty
    // thousand nodes and given up.
    sandbox.libraryPage.scrollTop = Math.floor(size * 54 * 0.6);
    sandbox.libraryRenderWindow(true);
    const midway = sandbox.renderedRows();
    assert.ok(midway > 0 && midway <= 20 + OVERSCAN,
      `${size} songs at 60% scroll put ${midway} rows in the DOM`);
    counts.push({ atTop, midway });
  }
  assert.equal(counts[0].atTop, counts[1].atTop,
    'a thousand songs and fifty thousand paint the same number of rows at the top');
  assert.equal(counts[0].midway, counts[1].midway,
    'and the same number halfway down');
});

test('the window paints the rows the scroll offset names, not the first ones', () => {
  // Counting rows proves the window stays small; it says nothing about whether
  // those are the right rows. A renderer that painted 0..17 at every scroll
  // offset would satisfy every assertion above while showing the same songs at
  // the top and the bottom of a fifty thousand track library — bounded, and
  // wrong in a way nobody notices until they scroll.
  const tracks = [];
  for (let i = 0; i < 50000; i += 1) tracks.push(scaleSong(i));
  const sandbox = windowSandbox(tracks);
  wrapRows(sandbox, tracks);

  // The stub stamps each row with the index it was asked for, so the painted
  // slice can be read straight back out of the markup.
  const painted = () => (sandbox.elements['library-window'].innerHTML.match(/data-row="(\d+)"/g) || [])
    .map((markup) => Number(markup.replace(/[^0-9]/g, '')));

  for (const fraction of [0, 0.5, 0.999]) {
    const target = Math.floor(tracks.length * fraction);
    sandbox.libraryPage.scrollTop = target * 54;
    sandbox.libraryRenderWindow(true);

    const rows = painted();
    assert.ok(rows.length > 0 && rows.length <= 20 + OVERSCAN,
      `at ${fraction} the window holds ${rows.length} rows`);
    assert.deepEqual(rows, Array.from({ length: rows.length }, (_, k) => rows[0] + k),
      `at ${fraction} the slice is contiguous — no holes in the middle of the list`);

    // The one that matters: the first row painted is the row the offset names,
    // minus the overscan drawn above it to hide the seam on scroll.
    const expectedFirst = Math.max(0, Math.floor(sandbox.libraryPage.scrollTop / 54) - OVERSCAN);
    assert.equal(rows[0], expectedFirst,
      `at ${fraction} the window starts at row ${expectedFirst}, not row ${rows[0]}`);
    assert.ok(rows[0] <= target && target <= rows[rows.length - 1] + OVERSCAN,
      `at ${fraction} the row being scrolled to is actually on screen`);

    // And the offset that positions the window describes the same slice, so the
    // rows cannot drift away from where the scrollbar says they are.
    const transform = sandbox.elements['library-window'].style.transform;
    const offset = Number(String(transform).replace(/[^0-9.\-]/g, ''));
    assert.ok(Math.abs(offset / 54 - rows[0]) < 1,
      `at ${fraction} the window is translated to row ${offset / 54}, but painted row ${rows[0]}`);
  }
});

test('a window that has not moved is not rebuilt', () => {
  const tracks = [];
  for (let i = 0; i < 1000; i += 1) tracks.push(scaleSong(i));
  const sandbox = windowSandbox(tracks);
  wrapRows(sandbox, tracks);
  sandbox.libraryRenderWindow(true);
  const key = sandbox.elements['library-window'].dataset.key;
  assert.ok(key, 'the window records what it painted');

  sandbox.elements['library-window'].innerHTML = 'left alone';
  sandbox.libraryRenderWindow(false);
  assert.equal(sandbox.elements['library-window'].innerHTML, 'left alone',
    'scrolling back over rows already on screen does not repaint them');
  assert.equal(sandbox.elements['library-window'].dataset.key, key);
});

// ---------------------------------------------------------------- search

function searchSandbox(tracks) {
  const sandbox = {
    console,
    localLibraryStore: { tracks, byId: {}, userData: { songs: {}, playlists: [] }, folders: [], index: null, indexAt: 0 },
    libraryPage: { query: '', rows: [], view: 'songs' },
    localLibraryNormalizeTracks: (list) => list,
    hydrateCustomCover: (song) => song,
    hydrateCustomCovers: (list) => list,
    cloneSong: (song) => Object.assign({}, song),
    songCoverSrc: () => '',
    showTrackDetail: () => { },
  };
  vm.runInNewContext(
    STORE_NAMES.map((n) => namedFunctionSource(storeSource, n)).join('\n'),
    sandbox
  );
  return sandbox;
}

test('search and grouping over 50k songs stay off the render path', () => {
  const tracks = [];
  for (let i = 0; i < 50000; i += 1) tracks.push(scaleSong(i));
  const sandbox = searchSandbox(tracks);

  const builtAt = Date.now();
  const index = sandbox.localLibraryBuildIndex();
  const buildMs = Date.now() - builtAt;
  assert.ok(index.albums.length > 0 && index.artists.length > 0 && index.folders.length > 0);
  // O(n) at this size is a few hundred milliseconds. A second is a quadratic
  // hiding in the grouping, and it would cost that on every keystroke.
  assert.ok(buildMs < 5000, `building the group index over 50k songs took ${buildMs} ms`);

  const again = sandbox.localLibraryBuildIndex();
  assert.equal(again, index, 'the index is built once and reused, not rebuilt per lookup');

  const searchAt = Date.now();
  const hits = sandbox.librarySearchTracks('artist 123 album 7');
  const searchMs = Date.now() - searchAt;
  assert.ok(Array.isArray(hits));
  assert.ok(hits.length > 0 && hits.length < tracks.length,
    `a two-term search over 50k songs returned ${hits.length}`);
  assert.ok(searchMs < 3000, `searching 50k songs took ${searchMs} ms`);

  const viewAt = Date.now();
  const albums = sandbox.libraryViewRows('albums');
  const viewMs = Date.now() - viewAt;
  assert.ok(albums.length > 0);
  assert.ok(viewMs < 5000, `the albums view took ${viewMs} ms`);

  sandbox.invalidateLocalLibraryIndex();
  assert.notEqual(sandbox.localLibraryBuildIndex(), index, 'invalidating throws the memo away');
});
