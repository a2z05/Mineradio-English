'use strict';
// A file on this device used to be the end of the line for lyrics: the global
// lookup short-circuited for local tracks, so a track without an embedded or
// sidecar .lrc showed the title placeholder forever, and a track whose only
// lyrics were Chinese never got a translation. Nora's local library asks the
// online chain whenever the offline read does not answer. These tests run that
// function for real — not its text — because the interesting behaviour is the
// ORDER of the two lookups and who backs out when the newer track wins.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { namedFunctionSource } = require('./helpers/extract-function');

const playbackSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'),
  'utf8'
);

// Everything the function reaches for. The 1500ms hang-reminder and the 16s
// track-switch give-up are collected instead of fired, so a test decides when
// (and whether) they run rather than waiting on the wall clock.
const PRELUDE = `
  var calls = { fetch: [], apply: [], state: [], scheduled: [], preferred: 0 };
  var timers = [];
  function setTimeout(fn) { timers.push(fn); return timers.length; }
  function clearTimeout() {}
  function cancelPendingTrackFallbackLyrics() { calls.cancelled = (calls.cancelled || 0) + 1; }
  function applyFetchedLyricResponse(song, token, payload, options) {
    calls.apply.push({ name: song && song.name, token: token, lyric: payload && payload.lyric, options: options });
    return { usableLyric: !!(payload && payload.lyric) };
  }
  function setOriginalLyricsState() { calls.state.push(Array.prototype.slice.call(arguments)); }
  function applyPreferredLyricsForCurrent() { calls.preferred += 1; }
  function normalizeLyricTranslationMode(mode) { return mode || 'off'; }
  function hasUsableLyricLines(lines) { return Array.isArray(lines) && lines.length > 0; }
  function withLyricFallback(lines) { return lines; }
  function scheduleTrackSwitchFallbackLyrics(song, token, delay) {
    calls.scheduled.push({ name: song && song.name, token: token, delay: delay });
  }
  function fetchLyric(song, token) { calls.fetch.push({ name: song && song.name, token: token }); }
  function queueItemKey(song) { return String((song && song.name) || ''); }
  function flushTimers() {
    var pending = timers.slice();
    timers.length = 0;
    pending.forEach(function (entry) { entry(); });
    return pending.length;
  }
`;

async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function boot() {
  const read = {};
  const sandbox = {
    console: { warn() {} },
    window: { desktopWindow: { readLocalMusicLyric: () => read.promise } },
    trackSwitchToken: 7,
    currentLocalSong: null,
    fx: { lyricTranslationMode: 'off' },
  };
  vm.runInNewContext(
    `${PRELUDE}\n${namedFunctionSource(playbackSource, 'applyLocalTrackLyricOnDemand')}\n` +
    'this.__calls = calls; this.__flush = flushTimers; this.__apply = applyLocalTrackLyricOnDemand;',
    sandbox
  );
  return {
    sandbox,
    // Deferred rather than a settled promise so a test can move the track on
    // before the bridge answers — that race is the whole point of the token.
    armRead() {
      let resolve; let reject;
      read.promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { resolve, reject };
    },
  };
}

async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function localSong(overrides) {
  return Object.assign({
    name: 'Local Song',
    source: 'local',
    provider: 'local',
    localFileId: 'a'.repeat(24),
    localKey: 'local:' + 'a'.repeat(24),
    hasLyric: false,
  }, overrides);
}

test('a local file with no lyrics of its own goes straight to the online chain', async () => {
  const { sandbox, armRead } = boot();
  armRead();
  const song = localSong();
  sandbox.currentLocalSong = song;
  // hasLyric is false, so there is no disk read to wait for and the online
  // chain starts in the same tick — no wasted hold before the first attempt.
  const running = sandbox.__apply(song, sandbox.trackSwitchToken);
  assert.equal(running, undefined, 'the caller is not made to wait on a lyric lookup');
  assert.equal(sandbox.__calls.state[0][2], 'pending');
  assert.equal(sandbox.__calls.fetch.length, 1, 'the online chain is the only chance this track has');
  assert.equal(sandbox.__calls.fetch[0].token, sandbox.trackSwitchToken);
  assert.equal(sandbox.__calls.scheduled[0].delay, 16000, 'the track-switch give-up is armed with it');
  assert.equal(sandbox.__calls.apply.length, 0, 'an unanswered lookup must not paint an empty lyric');
});

test('a bridge read that fails still reaches the online chain', async () => {
  const { sandbox, armRead } = boot();
  const read = armRead();
  const song = localSong({ hasLyric: true });
  sandbox.currentLocalSong = song;
  sandbox.__apply(song, sandbox.trackSwitchToken);
  // The file claims it has lyrics and then the read fails: a rejected bridge is
  // not a verdict on the lyrics, only on the disk.
  assert.equal(sandbox.__calls.fetch.length, 0, 'the disk read is allowed to answer first');
  read.reject(new Error('bridge gone'));
  await settle();

  assert.equal(sandbox.__calls.fetch.length, 1);
  assert.equal(sandbox.__calls.apply.length, 0);
});

test('lyrics that ARE on disk win, and stay won even when the reminder fires', async () => {
  const { sandbox, armRead } = boot();
  const read = armRead();
  const song = localSong({ hasLyric: true });
  sandbox.currentLocalSong = song;
  const running = sandbox.__apply(song, sandbox.trackSwitchToken);
  read.resolve({ ok: true, lyric: '[00:01.000]on disk', lyricSource: 'sidecar' });
  await settle();
  assert.equal(running, undefined, 'the caller is not made to wait on a lyric lookup');

  assert.equal(sandbox.__calls.apply.length, 1);
  assert.equal(sandbox.__calls.apply[0].lyric, '[00:01.000]on disk');
  assert.equal(sandbox.__calls.apply[0].options.persist, false, 'an embedded line must not overwrite the cached online copy');

  // The hang-reminder was armed before the read answered. Let it fire: with an
  // answer already in hand it must do nothing, or every good local track would
  // pay for a second lookup it does not need.
  assert.ok(sandbox.__flush() > 0, 'the reminder is armed up front so a stuck bridge cannot hang forever');
  await settle();
  assert.equal(sandbox.__calls.fetch.length, 0, 'offline lyrics already resolved the question');
});

test('unreadable on-disk lyrics fall through to the online chain', async () => {
  const { sandbox, armRead } = boot();
  const read = armRead();
  const song = localSong({ hasLyric: true });
  sandbox.currentLocalSong = song;
  const running = sandbox.__apply(song, sandbox.trackSwitchToken);
  read.resolve({ ok: true, lyric: '' });
  await settle();
  assert.equal(running, undefined);

  assert.equal(sandbox.__calls.fetch.length, 1, 'an unusable offline answer is not an answer');
});

test('translations are looked up online even when the file has lyrics', async () => {
  const { sandbox, armRead } = boot();
  sandbox.fx.lyricTranslationMode = 'zh';
  const read = armRead();
  const song = localSong({ hasLyric: true });
  sandbox.currentLocalSong = song;
  const running = sandbox.__apply(song, sandbox.trackSwitchToken);
  read.resolve({ ok: true, lyric: '[00:01.000]世界和平' });
  await settle();
  assert.equal(running, undefined);

  // An embedded or sidecar file almost never carries a translation, and the
  // global chain is where translations come from (NetEase, step 4).
  assert.equal(sandbox.__calls.apply.length, 1, 'the offline lines are shown immediately');
  assert.equal(sandbox.__calls.fetch.length, 1, 'and the lookup runs alongside them');
});

test('a track that changed underneath the lookup changes nothing', async () => {
  const { sandbox, armRead } = boot();
  const read = armRead();
  const song = localSong({ hasLyric: true, name: 'Slow Song' });
  sandbox.currentLocalSong = song;
  const running = sandbox.__apply(song, sandbox.trackSwitchToken);
  // The user skips on before the bridge answers.
  sandbox.trackSwitchToken = 99;
  sandbox.currentLocalSong = localSong({ name: 'Next Song' });
  read.resolve({ ok: true, lyric: '[00:01.000]stale' });
  await settle();
  assert.equal(running, undefined);

  assert.equal(sandbox.__calls.apply.length, 0, 'the previous track must not paint into the new panel');
  sandbox.__flush();
  await settle();
  assert.equal(sandbox.__calls.fetch.length, 0, 'and must not start work on the new track either');
});
