'use strict';
// The compact player.
//
// The two things that make it a real player rather than a decoration are that
// it never becomes a second copy of the truth, and that the user can get back
// out of it. Both are easy to break with a well-meaning edit, so both are
// checked here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');
const miniSource = read('public/js/modules/14-system/01-mini-player.js');
const indexHtml = read('public/index.html');
const miniCss = read('public/css/mini-player.css');
const loaderSource = read('public/js/index-loader.js');
const switchCoreSource = read('public/js/modules/05-playback/12-playback-switch-core.js');
const startAudioSource = read('public/js/modules/05-playback/13-playback-start-audio.js');
const progressSource = read('public/js/modules/06-lyrics/04-progress-seek.js');
const likeSource = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');

test('the compact transport is in the markup, with a way in and a way out', () => {
  assert.match(indexHtml, /<div id="mini-player" hidden/,
    'the player must start hidden — restoring the preference is its own decision');
  assert.match(indexHtml, /id="mini-player-btn"[^>]*onclick="enterMiniPlayer\(\)"/,
    'and there has to be a button on the console that reaches it');
  assert.match(indexHtml, /id="mini-player-exit"[^>]*onclick="exitMiniPlayer\(\)"/,
    'a compact player with no exit is a trap');

  // Every button is a real control, not a placeholder.
  for (const [id, call] of [
    ['mini-player-play', 'togglePlay()'],
    ['mini-player-prev', 'prevTrack(true)'],
    ['mini-player-next', 'nextTrack(true)'],
    ['mini-player-heart', 'toggleLikeCurrent()'],
  ]) {
    assert.ok(indexHtml.includes('id="' + id + '"'), id + ' must exist');
    assert.ok(indexHtml.includes('onclick="' + call + '"'), id + ' must call the same handler the console does');
  }
});

test('the stylesheet is loaded and sits above every panel that would cover it', () => {
  assert.match(indexHtml, /css\/mini-player\.css/);
  // The library page is z-index 900 and the modal mask 50; a compact player the
  // Library page can hide is not a persistent one.
  const declared = Number((miniCss.match(/^  z-index: (\d+);/m) || [])[1]);
  assert.ok(Number.isFinite(declared) && declared > 960,
    `the mini player is z-index ${declared}; the library page mask is 900`);
});

test('entering the mini player hides the console, leaving it puts it back', () => {
  const enter = miniSource.slice(miniSource.indexOf('function enterMiniPlayer()'),
    miniSource.indexOf('function exitMiniPlayer()'));
  assert.match(enter, /root\.hidden = false;/);
  assert.match(enter, /bar\.classList\.remove\('visible', 'soft-hidden'\)/,
    'the console has to actually step aside, not just be painted over');
  // And the state it found is remembered, so leaving restores that and not a
  // guess.
  assert.match(enter, /miniPlayerRestoreVisible = !!/);
  assert.match(miniCss, /body\.mini-player-mode #bottom-bar[\s\S]*?pointer-events: none !important/,
    'a hidden console that still eats clicks would swallow the mini player\'s own taps');

  const exit = miniSource.slice(miniSource.indexOf('function exitMiniPlayer()'),
    miniSource.indexOf('function toggleMiniPlayer()'));
  assert.match(exit, /if \(miniPlayerRestoreVisible && typeof revealBottomControls === 'function'\) \{\s*revealBottomControls\(360\)/);
  // The slide has to finish before display:none, or the console reappears over
  // a player that never moved.
  assert.match(exit, /setTimeout\([\s\S]*root\.hidden = true;[\s\S]*\}, 340\)/);
});

test('the mini player reads the player state instead of copying it', () => {
  const state = miniSource.slice(miniSource.indexOf('function miniPlayerSong()'));
  assert.match(state, /playQueue\[currentIdx\]/,
    'the track shown must be the one actually playing');
  assert.match(state, /currentLocalSong/,
    'a local track that is not in the queue still has to be nameable');

  // And nothing in it assigns to the queue, the index or the play state.
  assert.doesNotMatch(state, /playQueue\s*=/, 'the compact player must never rewrite the queue');
  assert.doesNotMatch(state, /currentIdx\s*=/, 'nor the play position');
  assert.doesNotMatch(state, /\bplaying\s*=/, 'nor the transport state — it reports, it does not drive');
});

test('the paint is hooked into the three places that change what it shows', () => {
  assert.match(startAudioSource, /paintMiniPlayer\(\)/, 'a track switch repaints it');
  assert.match(switchCoreSource, /paintMiniPlayer\(\)/, 'so does every play/pause');
  assert.match(progressSource, /paintMiniPlayerProgress\(\)/,
    'the progress fill is driven by the same clock as the console');
  assert.match(likeSource, /paintMiniPlayerHeart\(\)/,
    'otherwise the compact like button would disagree with the console one');
});

test('progress is dragged, not clicked, and the position is seeked', () => {
  assert.match(miniSource,
    /audio\.currentTime = Math\.max\(0, Math\.min\(duration - 0\.05, target\)\)/,
    'a seek must land inside the track, not one second past the end');
  assert.match(miniSource, /pointerdown[\s\S]*pointermove[\s\S]*pointerup/,
    'dragging is the interaction; a click that jumps is not a seek bar');
  // While dragging, the tick must not fight the pointer.
  assert.match(miniSource, /if \(miniPlayerSeekDragging\) return;/);
  // And it is a role=slider, so the keyboard has to work.
  assert.match(miniSource, /ArrowLeft/);
  assert.match(miniSource, /ArrowRight/);
});

test('it survives a restart, and an empty player says so', () => {
  assert.match(miniSource, /localStorage\.setItem\(MINI_PLAYER_STORE_KEY, on \? '1' : '0'\)/);
  assert.match(miniSource, /if \(readMiniPlayerPref\(\)\) \{\s*[\s\S]*?enterMiniPlayer\(\); \}, 60\)/,
    'the preference has to be read on boot, or "persistent" means nothing');
  assert.match(miniSource, /title\.textContent = \(song && song\.name\) \|\| 'Nothing playing'/,
    'an empty player must not show the last track it remembered');
});

test('immersive mode still has a way back', () => {
  // Immersive mode hides #thumb-wrap and most of the chrome. The console
  // survives it (that is what immersive mode is for), so the mini player must
  // not depend on anything immersive hides.
  const immersiveHidden = read('public/css/index.css').slice(
    read('public/css/index.css').indexOf('body.immersive-mode #desktop-titlebar'),
    read('public/css/index.css').indexOf('body.immersive-mode .modal-mask {'));
  for (const id of ['mini-player-play', 'mini-player-progress', 'mini-player-title']) {
    assert.ok(!immersiveHidden.includes('#' + id),
      id + ' must survive immersive mode, or there is no way out of it');
  }
});

test('the module installs itself and is loaded after what it reads', () => {
  assert.match(miniSource, /installMiniPlayer\(\);\s*$/);
  assert.match(loaderSource, /'js\/modules\/14-system\/01-mini-player\.js'/);
  assert.match(indexHtml, /if \(typeof installMiniPlayer === 'function'\) installMiniPlayer\(\);/);
  const at = loaderSource.indexOf('14-system/01-mini-player.js');
  for (const earlier of ['00-state/00-core-stores.js', '06-lyrics/04-progress-seek.js']) {
    assert.ok(loaderSource.indexOf(earlier) < at, earlier + ' must load before the mini player');
  }
});

test('nothing it calls can throw before the player has a track', () => {
  // installMiniPlayer runs at load, long before a queue exists. Every read of
  // player state is behind a typeof or a try, so a cold start cannot stop here.
  const install = miniSource.slice(miniSource.indexOf('function installMiniPlayer()'));
  assert.doesNotMatch(install, /\bpaintMiniPlayer\(\);\s*\}\s*$/m);
  assert.match(miniSource, /if \(miniPlayerOpen\) paintMiniPlayer\(\);/,
    'the deferred repaints are gated on the player actually being open');
  assert.match(miniSource, /if \(typeof getPlaybackDurationSeconds === 'function'\) duration = getPlaybackDurationSeconds\(\);/);
});