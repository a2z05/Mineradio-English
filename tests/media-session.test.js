'use strict';
// OS integration — media keys, taskbar thumbnail, tray transport, notification.
//
// The renderer reports; the main process owns. That split is the whole design,
// so most of this file checks the two halves agree: every channel has a trusted
// handler, every handler has a preload surface, and the renderer's three hooks
// are on paths that already run on every track change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');
const mainSource = read('desktop/main.js');
const preloadSource = read('desktop/preload.js');
const loaderSource = read('public/js/index-loader.js');
const sessionSource = read('public/js/modules/14-system/00-media-session.js');
const switchCoreSource = read('public/js/modules/05-playback/12-playback-switch-core.js');
const startAudioSource = read('public/js/modules/05-playback/13-playback-start-audio.js');
const indexHtml = read('public/index.html');

// A window stand-in that records what the bridge asks Windows to do.
function fakeWindow(options = {}) {
  const record = {
    sent: [],
    thumbnails: [],
    represented: [],
    edited: [],
    destroyed: false,
    focused: options.focused === true,
    visible: true,
  };
  return {
    record,
    isDestroyed: () => record.destroyed,
    isFocused: () => record.focused,
    isVisible: () => record.visible,
    isMinimized: () => false,
    restore: () => { },
    focus: () => { },
    webContents: {
      send: (channel, payload) => record.sent.push([channel, payload]),
    },
    setRepresentedFilename: (name) => record.represented.push(name),
    setDocumentEdited: (flag) => record.edited.push(flag),
    setThumbarButtons: (buttons) => record.thumbnails.push(buttons),
  };
}

// ---------------------------------------------------------------- the bridge

test('publishing a track fills the taskbar row and the play state', async () => {
  const { MediaSessionBridge } = require('../desktop/media-session');
  const win = fakeWindow();
  const bridge = new MediaSessionBridge({ getWindow: () => win, appName: 'Mineradio' });

  await bridge.publish({ title: 'Une Vie', artist: 'Aya', album: 'Live', duration: 214, playing: true });

  assert.deepEqual(win.record.represented, ['Une Vie']);
  assert.deepEqual(win.record.edited, [true], 'the taskbar shows the track as in-progress while playing');
  assert.equal(win.record.thumbnails.length, 1);
  const buttons = win.record.thumbnails[0];
  assert.deepEqual(buttons.map((b) => b.tooltip), ['Pause', 'Previous track', 'Next track']);

  // The play glyph follows the state, not the other way round.
  await bridge.publish({ title: 'Une Vie', artist: 'Aya', album: 'Live', playing: false });
  assert.equal(win.record.thumbnails[1][0].tooltip, 'Play');
  assert.deepEqual(win.record.edited, [true, false]);
});

test('an empty track clears the taskbar row instead of leaving a stale one', async () => {
  const { MediaSessionBridge } = require('../desktop/media-session');
  const win = fakeWindow();
  const bridge = new MediaSessionBridge({ getWindow: () => win });

  await bridge.publish({ title: 'Something', artist: 'Someone', playing: true });
  assert.equal(win.record.thumbnails.length, 1);
  await bridge.publish({ reason: 'dispose' });
  assert.deepEqual(win.record.thumbnails[1], [], 'no track, no transport');
  assert.deepEqual(win.record.represented, ['Something', '']);
});

test('the same track twice keeps the artwork it already encoded', async () => {
  const { MediaSessionBridge } = require('../desktop/media-session');
  const win = fakeWindow();
  const bridge = new MediaSessionBridge({ getWindow: () => win });
  const art = 'data:image/jpeg;base64,AAAA';

  await bridge.publish({ title: 'A', artist: 'B', album: 'C', artwork: art, playing: true });
  const second = await bridge.publish({ title: 'A', artist: 'B', album: 'C', artwork: '', playing: false });
  assert.equal(second.hasArtwork, true, 'a pause must not throw the taskbar thumbnail away');

  // A different album is a different picture.
  const third = await bridge.publish({ title: 'A', artist: 'B', album: 'D', artwork: '', playing: false });
  assert.equal(third.hasArtwork, false);
});

test('a payload the bridge cannot use is dropped rather than forwarded', async () => {
  const { MediaSessionBridge } = require('../desktop/media-session');
  const win = fakeWindow();
  const bridge = new MediaSessionBridge({ getWindow: () => win });

  // A remote URL is not an image Windows can hold; only a data URL is.
  await bridge.publish({ title: 'X', artist: 'Y', artwork: 'https://example.com/cover.jpg' });
  assert.equal(bridge.lastState.hasTrack, true);
  assert.equal(bridge.lastState.artwork, '');
  assert.deepEqual(win.record.represented, ['X'], 'a wildly long title is clipped, not refused');
});

test('a long title is clipped to what a toast can actually show', async () => {
  const { MediaSessionBridge } = require('../desktop/media-session');
  const win = fakeWindow();
  const bridge = new MediaSessionBridge({ getWindow: () => win });
  await bridge.publish({ title: 'x'.repeat(400) });
  assert.equal(win.record.represented[0].length, 120);
});

test('a destroyed window is not an error', async () => {
  const { MediaSessionBridge } = require('../desktop/media-session');
  const bridge = new MediaSessionBridge({ getWindow: () => null });
  const result = await bridge.publish({ title: 'nothing to show' });
  assert.deepEqual(result, { ok: false, error: 'NO_WINDOW' });
  assert.deepEqual(await bridge.dispose(), { ok: true });
});

test('a command from the OS reaches the renderer as one channel', async () => {
  const { MediaSessionBridge } = require('../desktop/media-session');
  const win = fakeWindow();
  const bridge = new MediaSessionBridge({ getWindow: () => win });
  bridge.send('nextTrack');
  assert.deepEqual(win.record.sent, [['mineradio-media-command', { action: 'nextTrack' }]]);
});

// ---------------------------------------------------------------- wiring

test('every media channel is trusted-sender only and exposed to the renderer', () => {
  for (const channel of ['media-publish', 'media-keys', 'media-keys-status', 'now-playing-notify']) {
    const handler = "ipcMain.handle('mineradio-" + channel + "'";
    assert.ok(mainSource.includes(handler), channel + ' must have a handler');
    const guardAt = mainSource.indexOf(handler);
    const guard = mainSource.indexOf('UNTRUSTED_SENDER', guardAt);
    assert.ok(guard > guardAt && guard - guardAt < 400,
      channel + ' must refuse an untrusted sender before it does anything');
  }
  for (const name of ['publishMediaState', 'mediaKeys', 'mediaKeysStatus', 'notifyNowPlaying', 'onMediaCommand']) {
    assert.ok(preloadSource.includes(name + ':'), 'preload must expose ' + name);
  }
  assert.ok(preloadSource.includes("ipcRenderer.on('mineradio-media-command'"));
});

test('the media module is loaded after the state it reads', () => {
  assert.match(loaderSource, /'js\/modules\/14-system\/00-media-session\.js'/);
  // playQueue/currentIdx/playQueueAt are all declared by earlier modules; the
  // installer runs on load, so it must come after them or read nothing.
  const at = loaderSource.indexOf('14-system/00-media-session.js');
  for (const earlier of ['00-state/00-core-stores.js', '05-playback/13-playback-start-audio.js']) {
    assert.ok(loaderSource.indexOf(earlier) < at, earlier + ' must load before the media session');
  }
});

test('the media module installs itself and never blocks playback', () => {
  // Same rule as the playback guard: the scripts are concatenated, so an
  // installer called from another file would run before this file's state. It
  // installs itself, and the explicit call at the end of index.html is a
  // second, idempotent pass.
  assert.match(sessionSource, /installMediaSession\(\);\s*$/);
  assert.match(indexHtml, /if \(typeof installMediaSession === 'function'\) installMediaSession\(\);/);
  // Every entry into the OS is guarded, because none of these APIs exist in the
  // browser preview.
  assert.match(sessionSource, /if \(!api \|\| typeof api\.publishMediaState !== 'function'\) return;/);
  assert.match(sessionSource, /if \(typeof navigator === 'undefined' \|\| !navigator\.mediaSession\) return;/);
});

test('a track change and every transport change are reported', () => {
  // Track switch.
  assert.match(startAudioSource, /publishMediaState\('track'\)/);
  // play / pause / ended, from the one function that already reconciles state.
  assert.match(switchCoreSource, /publishMediaState\(reason\)/);
  // Stop is the one command the player did not have a function for.
  assert.match(sessionSource, /function stopPlayback\(\)/);
  assert.match(sessionSource, /audio\.currentTime = 0;/);
});

test('stop is distinct from pause', async () => {
  const { namedFunctionSource } = require('./helpers/extract-function');
  const source = namedFunctionSource(sessionSource, 'stopPlayback');
  assert.match(source, /audio\.pause\(\)/);
  // Rewinding is the difference: pause leaves the position, stop does not, so a
  // later Play restarts the track rather than resuming it.
  assert.match(source, /audio\.currentTime = 0/);
  assert.doesNotMatch(source, /fadeOutAndPauseAudio/,
    'stop must not run a fade — it is immediate, and the audio is already silent at that point');
});

test('the media keys are re-registered after anything that clears the shortcut table', () => {
  // unregisterAll() drops the hardware media keys as well as the app's own, and
  // it is called from the overlay registration — so that path has to put the
  // media keys back or the physical keys silently die.
  const resetAt = mainSource.indexOf('globalShortcut.unregisterAll()');
  assert.ok(resetAt > 0, 'the app really does clear the shortcut table');
  const around = mainSource.slice(resetAt - 200, resetAt + 400);
  assert.match(around, /mediaSession\.registerMediaKeys\(\)/,
    'the shortcut table is wiped without the media keys being put back');
});

test('the tray shows a transport only when something is loaded', () => {
  assert.match(mainSource, /media\.hasTrack \? \[/,
    'an empty tray must stay a plain Show/Quit menu');
  assert.match(mainSource, /mediaSession\.send\('togglePlay'\)/);
  assert.match(mainSource, /tray\.setToolTip\(media\.hasTrack/);
});

test('a track notification is not fired while the user is looking at the player', () => {
  const main = read('desktop/media-session.js');
  const source = main.slice(main.indexOf('async notifyTrackChange(payload)'));
  assert.ok(source.length > 200, 'the notification method has to be there');
  assert.match(source, /win\.isFocused\(\)/);
  const focusAt = source.indexOf('isFocused');
  const guardAt = source.indexOf("if (focused");
  assert.ok(focusAt >= 0 && guardAt > focusAt, 'the focused check must come before the notification is built');
  // And it must be silent: a notification that makes a sound on every skip is
  // worse than no notification.
  assert.match(source, /silent: true/);
});

test('the media keys are handed to Electron as accelerators it accepts', () => {
  // Measured against this Electron build with a throwaway main process:
  //   playPause / next / previous / stop  -> all rejected, "conversion failure"
  //   MediaPlayPause, MediaNextTrack, MediaStop -> registered
  //   MediaPreviousTrack -> registered (MediaPrevTrack, which the docs name,
  //   is rejected here — the previous key is the one that has to be checked)
  // The table held the four action names instead, so register() threw for all
  // of them, the binding map came back empty, and the hardware keys did
  // nothing. The renderer then reported "Media keys unavailable" and moved on.
  const expected = ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop'];
  const { MEDIA_KEY_ACTIONS, MediaSessionBridge } = require('../desktop/media-session');
  assert.deepEqual(MEDIA_KEY_ACTIONS.map((entry) => entry[0]), expected);
  assert.deepEqual(MEDIA_KEY_ACTIONS.map((entry) => entry[1]),
    ['togglePlay', 'nextTrack', 'prevTrack', 'stopPlayback']);
  // An accelerator that is also an action name is how the mix-up happened.
  const actions = MEDIA_KEY_ACTIONS.map((entry) => entry[1]);
  for (const [accelerator] of MEDIA_KEY_ACTIONS) {
    assert.ok(!actions.includes(accelerator),
      accelerator + ' is an action name, not a key on the keyboard');
  }

  // And the table really is what reaches register(), not a copy of it — and the
  // callback Electron fires for a key press is the one that reaches the
  // renderer, on the channel the preload listens to. The whole point of the
  // registration is that one line.
  const electronPath = require.resolve('electron');
  const previous = require.cache[electronPath];
  const handed = [];
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, path: path.dirname(electronPath),
    loaded: true, children: [], paths: [],
    exports: {
      globalShortcut: {
        register: (accelerator, callback) => { handed.push([accelerator, callback]); return true; },
        unregister: () => { },
      },
    },
  };
  try {
    const win = fakeWindow();
    const bridge = new MediaSessionBridge({ getWindow: () => win, appName: 'Mineradio' });
    const result = bridge.registerMediaKeys();
    assert.deepEqual(handed.map((entry) => entry[0]), expected,
      'the four keys are what the OS is asked for');
    assert.deepEqual(Object.keys(result.binding).sort(),
      ['nextTrack', 'prevTrack', 'stopPlayback', 'togglePlay'],
      'each action reports the key that really registered');
    assert.ok(result.results.every((item) => item.ok));

    // Press each key in turn and read what the renderer would be told.
    for (const [, callback] of handed) callback();
    assert.deepEqual(win.record.sent, [
      ['mineradio-media-command', { action: 'togglePlay' }],
      ['mineradio-media-command', { action: 'nextTrack' }],
      ['mineradio-media-command', { action: 'prevTrack' }],
      ['mineradio-media-command', { action: 'stopPlayback' }],
    ], 'a key press arrives as the action the preload forwards');
    const preload = read('desktop/preload.js');
    const onAt = preload.indexOf('onMediaCommand');
    assert.ok(onAt >= 0, 'the renderer has a way to hear that channel');
    assert.match(preload.slice(onAt, onAt + 260), /mineradio-media-command/);

    bridge.unregisterMediaKeys();
  } finally {
    if (previous) require.cache[electronPath] = previous;
    else delete require.cache[electronPath];
  }
});

test('the artwork handed to the OS carries a MIME type that means something', () => {
  const vm = require('node:vm');
  const { namedFunctionSource } = require('./helpers/extract-function');
  const source = namedFunctionSource(sessionSource, 'mediaArtworkSessionArt')
    + '\n' + namedFunctionSource(sessionSource, 'mediaArtworkSource');
  // A local cover is not a data URL: it is the app's own scheme, so the regex
  // finds no type and the fallback was 'image/jpeg' — which then had 'image/'
  // prepended again, producing "image/image/jpeg". The lock screen and the
  // volume mixer drop an artwork entry whose type is not a real image MIME.
  const build = (background, song) => {
    const sandbox = {
      document: { getElementById: () => ({ style: { backgroundImage: background ? 'url("' + background + '")' : '' } }) },
    };
    vm.runInNewContext(source + '\nresult = mediaArtworkSessionArt;', sandbox);
    return sandbox.result(song || { name: 'In the End' });
  };

  const local = build('mineradio-local://cover/2a6c19a6952304c14ade7049');
  assert.equal(local.length, 1, 'a cover that is there is offered');
  assert.match(local[0].type, /^image\/(png|jpeg|webp|gif)$/,
    'got ' + local[0].type);
  assert.equal(local[0].type, 'image/jpeg');
  assert.match(local[0].src, /^mineradio-local:/);

  const png = build('data:image/png;base64,AAAA');
  assert.equal(png[0].type, 'image/png', 'a real data URL keeps its own type');

  assert.deepEqual(Array.from(build('', { name: 'x', coverUrl: '' })), [],
    'no cover means no artwork entry at all');
});