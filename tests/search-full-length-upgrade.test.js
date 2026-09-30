'use strict';
// A search on this network answers in two acts: iTunes returns 30-second
// previews in ~0.6s and the Internet Archive returns the whole track in
// 3-30s. The merge ranks a whole track far above a preview, but only once both
// have arrived — so the first list a user sees is previews-only, and clicking
// one committed the queue to 29 seconds. These tests cover the three things
// that close that window: holding a preview-only first paint back, marking it
// provisional while it is up, and upgrading the click to the whole track.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { namedFunctionSource, functionBundle } = require('./helpers/extract-function');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');
const searchSource = read('public/js/modules/05-playback/07-search.js');
const fallbackSource = read('public/js/modules/05-playback/11-provider-fallback.js');
const queueSource = read('public/js/modules/05-playback/10-queue-actions.js');
const bothSources = [searchSource, fallbackSource];

function matchSandbox() {
  const sandbox = {};
  vm.runInNewContext(functionBundle(bothSources, [
    'simpleSearchNorm',
    'sourceSwitchArtistParts',
    'searchVersionSignature',
    'searchCanonicalSongKey',
    'normalizeMatchText',
    'artistNameParts',
    'searchSongIsFullLength',
    'searchListHasFullLength',
    'searchFullLengthLooksSameSong',
    'searchFullLengthTwin',
  ], '', `
    this.twin = searchFullLengthTwin;
    this.isFullLength = searchSongIsFullLength;
    this.listHasFullLength = searchListHasFullLength;
  `), sandbox);
  return sandbox;
}

const itunesPreview = {
  provider: 'itunes',
  id: 'itunes-hotel',
  name: 'Hotel California',
  artist: 'Eagles',
  album: 'Hotel California',
  duration: 30,
  playbackMode: 'preview',
  _searchScore: 120,
};
const archiveWhole = {
  provider: 'archive',
  id: 'eagles_hotel_california::01 - HOTEL CALIFORNIA.mp3',
  // The Archive names files the way they are stored, track number and all.
  name: '01 - HOTEL CALIFORNIA',
  artist: 'Eagles',
  duration: 394,
  playbackMode: 'direct-url',
  _searchScore: 400,
};

test('a 30-second preview upgrades to the whole track it shares a list with', () => {
  const s = matchSandbox();
  const found = s.twin(itunesPreview, [itunesPreview, archiveWhole]);
  assert.ok(found, 'the whole-track twin must be found');
  assert.strictEqual(found.id, archiveWhole.id);
  assert.strictEqual(found.playbackMode, 'direct-url');
  // The titles are not equal — that is the whole reason the merge keeps both
  // rows — so this only passes if the looser pairing is what runs.
  assert.notEqual(archiveWhole.name, itunesPreview.name);
});

test('a preview never upgrades to another preview or to a clip', () => {
  const s = matchSandbox();
  const deezerPreview = { provider: 'deezer', name: 'Hotel California', artist: 'Eagles', duration: 30, playbackMode: 'preview', _searchScore: 90 };
  const shortClip = { provider: 'archive', name: 'Hotel California', artist: 'Eagles', duration: 30, playbackMode: 'direct-url', _searchScore: 500 };
  assert.strictEqual(s.twin(itunesPreview, [itunesPreview, deezerPreview]), null,
    'a preview must not "upgrade" to a different preview');
  assert.strictEqual(s.twin(itunesPreview, [itunesPreview, shortClip]), null,
    'anything under 45s is still a clip whatever the label says');
  assert.strictEqual(s.twin(itunesPreview, [itunesPreview]), null);
  assert.strictEqual(s.twin(itunesPreview, []), null);
  assert.strictEqual(s.twin(itunesPreview, null), null);
});

test('the whole track has to be the same song, not just the same query', () => {
  const s = matchSandbox();
  const otherArtist = { provider: 'archive', name: '01 - HOTEL CALIFORNIA', artist: 'Scorpions', duration: 394, playbackMode: 'direct-url', _searchScore: 900 };
  const otherSong = { provider: 'archive', name: '01 - Life in the Fast Lane', artist: 'Eagles', duration: 280, playbackMode: 'direct-url', _searchScore: 900 };
  const cover = { provider: 'archive', name: 'Hotel California (Cover)', artist: 'Some Bar Band', duration: 300, playbackMode: 'direct-url', _searchScore: 900 };
  assert.strictEqual(s.twin(itunesPreview, [otherArtist]), null, 'a different artist is a different song');
  assert.strictEqual(s.twin(itunesPreview, [otherSong]), null, 'a different title is a different song');
  assert.strictEqual(s.twin(itunesPreview, [cover]), null, 'a cover by another artist must not replace the row');
  // The same artist under a differently-spelled title still matches.
  const sameSongOtherCut = { provider: 'archive', name: 'Hotel California - Eagles', artist: 'Eagles', duration: 392, playbackMode: 'direct-url', _searchScore: 500 };
  assert.strictEqual(s.twin(itunesPreview, [sameSongOtherCut]).id, sameSongOtherCut.id);
});

test('when several whole tracks match, the best-scored one wins', () => {
  const s = matchSandbox();
  const weak = Object.assign({}, archiveWhole, { id: 'weak', _searchScore: 100 });
  const strong = Object.assign({}, archiveWhole, { id: 'strong', _searchScore: 800 });
  const mid = Object.assign({}, archiveWhole, { id: 'mid', _searchScore: 400 });
  assert.strictEqual(s.twin(itunesPreview, [weak, mid, strong]).id, 'strong');
});

test('a song that already plays in full is never redirected', () => {
  const s = matchSandbox();
  assert.strictEqual(s.twin(archiveWhole, [archiveWhole, itunesPreview]), null);
  assert.strictEqual(s.isFullLength(archiveWhole), true);
  assert.strictEqual(s.isFullLength(itunesPreview), false);
  assert.strictEqual(s.isFullLength({ name: 'x', duration: 20, playbackMode: 'direct-url' }), false);
  // A provider that declares nothing is believed to be a whole track.
  assert.strictEqual(s.isFullLength({ name: 'x', duration: 240 }), true);
  assert.strictEqual(s.listHasFullLength([itunesPreview]), false);
  assert.strictEqual(s.listHasFullLength([itunesPreview, archiveWhole]), true);
  assert.strictEqual(s.listHasFullLength(null), false);
});

test('a preview-only list is held back, then marked provisional', () => {
  // The grace window is what stops the previews being the first thing on
  // screen at all; the strip is what says so when a slow source means they
  // have to be. Both are driven by the same flag the click waits on.
  assert.match(searchSource, /var SEARCH_PREVIEW_GRACE_MS = \d+/);
  assert.match(searchSource, /var SEARCH_FULL_LENGTH_WAIT_MS = \d+/);
  assert.match(searchSource, /SEARCH_FULL_LENGTH_PROVIDERS = \['archive', 'soundcloud'\]/);

  const paint = namedFunctionSource(searchSource, 'paint');
  assert.match(paint, /!isFinal && searchFullLengthPending && !searchListHasFullLength\(list\)/,
    'a preview-only partial paint must wait out the grace window');
  assert.match(paint, /Date\.now\(\) - searchStartedAt < SEARCH_PREVIEW_GRACE_MS/);
  assert.match(namedFunctionSource(searchSource, 'renderSongSearchResults'), /searchFullLengthPendingHtml\(\)/,
    'the results header must carry the provisional notice');

  // The flag has to be set before the fan-out and cleared when it settles, or
  // the click waits forever on a source that already answered.
  assert.match(searchSource, /beginSearchFullLengthWait\(requestSeq,/);
  assert.strictEqual(searchSource.split('endSearchFullLengthWait(requestSeq)').length - 1, 2,
    'the wait must be released on both the normal and the failing path');
  assert.match(searchSource, /SEARCH_FULL_LENGTH_PROVIDERS\.indexOf\(provider\) !== -1/);
});

// A runnable copy of the click path: the twin helpers from 07-search.js plus
// commitSearchResultSelection/playSearchResult from 10-queue-actions.js, wired
// to a fake queue. `pending` says whether a full-length source is still in
// flight; `arriveOnWait` publishes the Archive result when the wait answers.
function clickSandbox(playlist, options) {
  options = options || {};
  const sandbox = {
    playlist: playlist.slice(),
    playQueue: [],
    currentIdx: -1,
    homeForcedOpen: true,
    homeSuppressed: true,
    searchRequestSeq: 3,
    SEARCH_FULL_LENGTH_WAIT_MS: 50,
    played: null,
    toast: '',
    setHomeControlsLocked() {},
    cloneSong(song) { return Object.assign({}, song); },
    queueItemKey(song) { return song.provider + ':' + song.id; },
    moveQueueIndexToTop(index) { return index; },
    $results: { classList: { remove() {} } },
    $input: { value: 'hotel california', blur() {} },
    playQueueAt(index) { sandbox.played = sandbox.playQueue[index]; },
    showToast(message) { sandbox.toast = message; },
  };
  vm.runInNewContext(`${functionBundle(bothSources, [
    'simpleSearchNorm',
    'sourceSwitchArtistParts',
    'searchVersionSignature',
    'searchCanonicalSongKey',
    'normalizeMatchText',
    'artistNameParts',
    'searchSongIsFullLength',
    'searchFullLengthLooksSameSong',
    'searchFullLengthTwin',
  ], '', 'this.searchFullLengthTwin = searchFullLengthTwin;')}
    var searchSelectToken = 0;
    var FIXTURE_WHOLE_TRACK = ${JSON.stringify(archiveWhole)};
    ${namedFunctionSource(queueSource, 'commitSearchResultSelection')}
    ${namedFunctionSource(queueSource, 'playSearchResult')}
    this.playSearchResult = playSearchResult;
    this.searchFullLengthIsPending = function () { return ${options.pending ? 'true' : 'false'}; };
    this.waitForFullLengthResults = function () {
      ${options.arriveOnWait ? 'playlist.push(FIXTURE_WHOLE_TRACK);' : ''}
      return Promise.resolve();
    };
  `, sandbox);
  return sandbox;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('clicking a preview picks the whole track instead', async () => {
  const sandbox = clickSandbox([itunesPreview, archiveWhole], { pending: false });
  sandbox.playSearchResult(0);
  assert.ok(sandbox.played, 'the click must start playback');
  assert.strictEqual(sandbox.played.playbackMode, 'direct-url',
    'the whole-track twin must be what plays, not the row that was clicked');
  assert.strictEqual(sandbox.played.id, archiveWhole.id);
  assert.strictEqual(sandbox.toast, '', 'no waiting is needed when the twin is already on screen');
});

test('a preview waits for the source still in flight before committing', async () => {
  const sandbox = clickSandbox([itunesPreview], { pending: true, arriveOnWait: true });
  sandbox.playSearchResult(0);
  assert.strictEqual(sandbox.played, null, 'the preview must not start while the whole track may still arrive');
  assert.match(sandbox.toast, /full track/i, 'the user has to be told why nothing has started yet');
  await tick();
  assert.ok(sandbox.played, 'the click must still start playback once the wait answers');
  assert.strictEqual(sandbox.played.id, archiveWhole.id);
  assert.strictEqual(sandbox.played.playbackMode, 'direct-url');
});

test('a preview still plays when the wait finds nothing', async () => {
  const sandbox = clickSandbox([itunesPreview], { pending: true });
  sandbox.playSearchResult(0);
  await tick();
  assert.ok(sandbox.played, 'an empty wait must fall back to the preview rather than to nothing');
  assert.strictEqual(sandbox.played.id, itunesPreview.id);
});

test('a second click during the wait replaces the first instead of queueing twice', async () => {
  const sandbox = clickSandbox([itunesPreview], { pending: true, arriveOnWait: true });
  sandbox.playSearchResult(0);
  sandbox.playSearchResult(0);
  await tick();
  assert.strictEqual(sandbox.playQueue.length, 1,
    'only the newest click may commit; the superseded waiter must drop out');
  assert.strictEqual(sandbox.currentIdx, 0);
});

