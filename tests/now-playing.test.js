'use strict';
// The Now Playing sheet.
//
// Three things could quietly go wrong here, and each is worth a test of its
// own: it could become a second copy of the transport, it could become a second
// stage (its own visualiser, its own audio graph), or it could sit above the
// modal mask and make the rest of the player unreachable. The design rules are
// in the module's header; these are the teeth.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');

const sheetSource = read('public/js/modules/14-system/02-now-playing.js');
const miniSource = read('public/js/modules/14-system/01-mini-player.js');
const indexHtml = read('public/index.html');
const sheetCss = read('public/css/now-playing.css');
const loaderSource = read('public/js/index-loader.js');
const startAudioSource = read('public/js/modules/05-playback/13-playback-start-audio.js');
const switchCoreSource = read('public/js/modules/05-playback/12-playback-switch-core.js');
const progressSource = read('public/js/modules/06-lyrics/04-progress-seek.js');
const detailSource = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');
const mainLoopSource = read('public/js/modules/11-main-loop.js');
const shortcutsSource = read('public/js/modules/10-shell/01-viewport-resize-shortcuts.js');
const coreStoresSource = read('public/js/modules/00-state/00-core-stores.js');

test('the sheet exists, and every control on it is the console\'s own', () => {
  assert.match(indexHtml, /<div id="now-playing-panel" hidden/);
  assert.match(indexHtml, /id="now-playing-btn"[^>]*onclick="toggleNowPlaying\(\)"/);
  assert.match(indexHtml, /id="now-playing-close"[^>]*onclick="closeNowPlaying\(\)"/);

  // Each button calls the exact function the button next to it on the console
  // calls. Nothing here owns transport logic of its own.
  for (const [id, call] of [
    ['now-playing-play', 'togglePlay()'],
    ['now-playing-prev', 'prevTrack(true)'],
    ['now-playing-next', 'nextTrack(true)'],
    ['now-playing-like', 'toggleLikeCurrent()'],
    ['now-playing-mode', 'cyclePlayMode()'],
  ]) {
    assert.ok(indexHtml.includes('id="' + id + '"'), id + ' must exist');
    assert.ok(indexHtml.includes('onclick="' + call + '"'),
      id + ' must call ' + call + ' — the same handler the console button calls');
  }
  assert.match(indexHtml, /id="now-playing-spectrum"/, 'the live strip has to be there');
});

test('it sits under the modal mask, so nothing in the player becomes unreachable', () => {
  assert.match(indexHtml, /css\/now-playing\.css/);
  const declared = Number((sheetCss.match(/^  z-index: (\d+);/m) || [])[1]);
  assert.ok(Number.isFinite(declared) && declared < 50,
    `the sheet is z-index ${declared}; .modal-mask is 50, and above it the search box, ` +
    'the lyrics panel and every dialog would be hidden behind a panel that cannot dismiss them');

  // Opening a dialog from the sheet has to put the sheet away rather than leave
  // it stranded under the mask.
  assert.match(detailSource,
    /function openTrackDetailModal[\s\S]{0,700}closeNowPlayingAfterTrackDetail\(\)/,
    'opening the details modal must close the sheet first');
  assert.match(detailSource,
    /function closeTrackDetailModal[\s\S]{0,900}closeNowPlayingAfterTrackDetail\(\)/,
    'and closing it must not leave the sheet open underneath');
});

test('the sheet reads state instead of owning it', () => {
  assert.match(sheetSource, /playQueue\[currentIdx\]/, 'the track shown must be the one playing');
  assert.match(sheetSource, /currentLocalSong/, 'a local track not in the queue still has a name');

  // Nothing on the sheet writes the queue, the index, or the play state.
  const body = sheetSource.slice(sheetSource.indexOf('function nowPlayingSong()'));
  assert.doesNotMatch(body, /playQueue\s*=/, 'the sheet must never rewrite the queue');
  assert.doesNotMatch(body, /currentIdx\s*=/, 'nor the play position');
  assert.doesNotMatch(body, /\bplaying\s*=/, 'nor the transport state — it reports, it does not drive');
});

test('one flag decides every pixel of it', () => {
  // open, close and boot-with-preference all funnel through the same apply, so
  // the two paths cannot drift into different DOM states.
  assert.match(sheetSource, /function applyNowPlayingShellState\(\)/);
  assert.match(sheetSource, /function openNowPlaying\(\) \{[\s\S]*?applyNowPlayingShellState\(\);\s*\}/);
  assert.match(sheetSource, /function closeNowPlaying\(\) \{[\s\S]*?applyNowPlayingShellState\(\);\s*\}/);
  assert.match(sheetSource, /nowPlayingOpen = true;\s*\n\s*applyNowPlayingShellState\(\);/,
    'restoring the preference must go through the same apply as a click');
  // And every paint is gated on that flag, so a closed sheet costs one boolean.
  assert.match(sheetSource, /function paintNowPlaying\(\) \{\s*\n\s*if \(!nowPlayingOpen\) return;/);
  assert.match(sheetSource, /function paintNowPlayingTransport\(\) \{\s*\n\s*if \(!nowPlayingOpen\) return;/);
  assert.match(sheetSource, /if \(!nowPlayingOpen \|\| nowPlayingDragging\) return;/);
  assert.match(sheetSource, /if \(!nowPlayingOpen\) return;\s*\n\s*if \(!nowPlayingCanvas/, 'the spectrum stops first too');
});

test('the strip is drawn from the stage\'s analyser, not its own', () => {
  // No second graph, no second context: the whole point of "integrated with
  // Mineradio's visualizer".
  assert.doesNotMatch(sheetSource, /createAnalyser/);
  assert.doesNotMatch(sheetSource, /new AudioContext/);
  assert.doesNotMatch(sheetSource, /setInterval\(/,
    'it draws on the main loop\'s cadence; a private timer would fight the stage for frames');
  assert.match(sheetSource, /beatFrequencyData/, 'the band split the stage already computes');
  assert.match(sheetSource, /frequencyData/, 'and the full spectrum behind it');
  // The main loop calls it right after the frame that refills those arrays.
  assert.match(mainLoopSource, /paintNowPlayingSpectrum\(\)/);
  const at = mainLoopSource.indexOf('paintNowPlayingSpectrum()');
  assert.ok(at > 0, 'the sheet has to be driven from somewhere');
  assert.ok(mainLoopSource.indexOf('getByteFrequencyData') < at,
    'the draw must come after the read that refreshes the data, not before it');
});

test('the three things that change what it shows are hooked', () => {
  assert.match(startAudioSource, /paintNowPlaying\(\)/, 'a track switch repaints it');
  assert.match(switchCoreSource, /paintNowPlaying\(\)/, 'so does every play/pause');
  assert.match(progressSource, /paintNowPlayingProgress\(\)/,
    'the clock is driven by the same function as the console, not by a timer of its own');
  assert.match(detailSource, /paintNowPlayingTransport\(\)/,
    'otherwise the like button would disagree with the console one');
});

test('escape and N are wired exactly once', () => {
  // Twice would mean: press N, open, close — and Escape would stop reaching the
  // modals while the sheet is shut. So the viewport handler owns both and the
  // sheet registers neither.
  assert.match(shortcutsSource, /e\.code === 'Escape'\) \{[\s\S]{0,220}nowPlayingOpen[\s\S]{0,120}closeNowPlaying\(\)/,
    'Escape has to close the sheet before it reaches anything else');
  assert.match(shortcutsSource, /else if \(e\.code === 'KeyN'\) \{[\s\S]{0,200}toggleNowPlaying\(\)/);
  assert.doesNotMatch(sheetSource, /document\.addEventListener\('keydown'/,
    'the sheet must not claim the same keys a second time');
  assert.doesNotMatch(coreStoresSource, /toggleNowPlaying/,
    'and it must not be in the configurable hotkey table, where it would swallow Escape for the modals');
});

test('it loads after the state it reads and installs itself', () => {
  assert.match(loaderSource, /'js\/modules\/14-system\/02-now-playing\.js'/);
  const at = loaderSource.indexOf('14-system/02-now-playing.js');
  for (const earlier of ['00-state/00-core-stores.js', '05-playback/06-track-detail-lyrics-actions.js']) {
    assert.ok(loaderSource.indexOf(earlier) < at, earlier + ' must load before the sheet');
  }
  assert.match(sheetSource, /installNowPlaying\(\);\s*$/);
  assert.match(indexHtml, /if \(typeof installNowPlaying === 'function'\) installNowPlaying\(\);/);
});

test('a missing panel is reported once instead of dying silently', () => {
  // The markup ships with the app, so it being absent means a half-parsed
  // index.html — a dead button with no other trace is the worst outcome.
  assert.match(sheetSource, /if \(!nowPlayingShellPresent\(\)\) \{/);
  assert.match(sheetSource, /showToast\('Now playing panel failed to load'\)/);
  assert.match(sheetSource, /nowPlayingMissingShellWarned = true;/,
    'the two install sites must not toast twice');
  // And the early exits have to be inside the idempotent guard, so a later call
  // does not quietly fall through into binding nothing.
  const install = sheetSource.slice(sheetSource.indexOf('function installNowPlaying()'));
  assert.match(install, /nowPlayingBound = true;\s*\n\s*if \(!nowPlayingShellPresent\(\)\)/);
});

test('a cold start cannot throw before there is a player', () => {
  // installNowPlaying runs at load, long before a queue exists. Every read of
  // player state is behind a typeof or a try.
  assert.match(sheetSource, /if \(typeof getPlaybackDurationSeconds === 'function'\)/);
  assert.match(sheetSource, /try \{[\s\S]{0,80}isSongLiked[\s\S]{0,60}\} catch/);
  assert.match(sheetSource, /typeof playModeLabel === 'function'/);
});

test('the compact player coexists without either taking the other\'s job', () => {
  // The sheet slides in from the right; the compact player and the console are
  // both centred with translateX(-50%), so they have to be moved out of the
  // sheet's way rather than drawn over it.
  assert.match(sheetCss, /body\.now-playing-open #mini-player/);
  assert.match(sheetCss, /body\.now-playing-open #bottom-bar/);
  // The compact player still owns its own clock, and it has a fallback duration
  // for a track whose media element never reports one.
  assert.match(miniSource, /miniPlayerDeclaredDuration\(\)/);
  assert.match(miniSource, /getElementById\('mini-player-time'\)/);
});
