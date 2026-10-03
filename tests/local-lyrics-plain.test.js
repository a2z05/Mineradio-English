'use strict';
// Requirement 12's plain-text half. The scanner goes to the trouble of reading
// an embedded USLT frame or a .txt beside a track and marking hasLyric, and the
// panel then showed "Title - Artist" for it anyway: parseLyricText keeps only
// lines that carry a [mm:ss] tag, and almost no embedded or plain-text lyric
// has one. 68 embedded and 146 sidecar lyrics in a real library were in that
// state, and every one of them then went out to the network for words that were
// already on disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { namedFunctionSource } = require('./helpers/extract-function');

const lyricSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js'),
  'utf8'
);

const FUNCTIONS = [
  'hasUsableLyricLines',
  'isNoLyricText',
  'lyricTagTimeToSeconds',
  'finalizeLyricLineDurations',
  'parseLyricText',
  'parsePlainLyricLines',
  'lyricFallbackTextForSong',
  'withLyricFallbackForSong',
  'parseLyricResponseToOriginalState',
];

// The parts of the module this test does not exercise, stubbed so the real
// functions above run unmodified.
const PRELUDE = `
  var document = null;
  function parseYrcText() { return []; }
  function buildLyricTranslationPayload() { return { lines: [], source: 'none' }; }
  function attachLyricTranslations(lines) { return lines; }
  function cloneLyricLines(lines) {
    return (lines || []).map(function (line) { return Object.assign({}, line); });
  }
  function playbackDurationFromSong(song) { return Number(song && song.duration) || 0; }
`;

function boot() {
  const sandbox = {};
  vm.runInNewContext(
    `${PRELUDE}\n${FUNCTIONS.map((name) => namedFunctionSource(lyricSource, name)).join('\n')}\n` +
    'this.__parse = parseLyricResponseToOriginalState; this.__plain = parsePlainLyricLines;',
    sandbox
  );
  return sandbox;
}

const PLAIN = [
  'I wake up to static again',
  'The room is quiet and cold',
  'Nothing left to hold on to',
  'I keep the radio on',
].join('\n');

test('an untimed lyric becomes lines instead of a title placeholder', () => {
  const sandbox = boot();
  const state = sandbox.__parse(
    { name: 'Plain Song', artist: 'Somebody', duration: 160 },
    { lyric: PLAIN }
  );
  assert.equal(state.timingSource, 'plain',
    'the panel has to be able to tell real content from the title stand-in');
  assert.equal(state.usableLyric, true,
    'usableLyric is what decides whether the online lookup runs at all');
  assert.equal(state.lines.length, 4);
  assert.equal(state.lines[0].text, 'I wake up to static again');
  assert.equal(state.lines[0].fallback, undefined,
    'none of these lines is the fallback, so hasUsableLyricLines accepts them');
  assert.ok(state.lines.every((line) => !line.fallback));
});

test('untimed lines are spread across the track, in order, and not clumped', () => {
  const sandbox = boot();
  const lines = sandbox.__plain(PLAIN, 160);
  assert.equal(lines.length, 4);
  assert.equal(lines[0].t, 0);
  for (let i = 1; i < lines.length; i += 1) {
    assert.ok(lines[i].t > lines[i - 1].t, `line ${i} must come after line ${i - 1}`);
  }
  // Even spacing over the track: 160s / 4 lines puts the last one at 120s.
  assert.ok(Math.abs(lines[lines.length - 1].t - 120) < 0.001,
    `last line sits at ${lines[lines.length - 1].t}s`);
  assert.ok(lines.every((line) => line.duration > 0),
    'every line needs a duration or the stage advances past it immediately');
});

test('an untimed lyric with no duration to spread over still renders', () => {
  const sandbox = boot();
  const state = sandbox.__parse({ name: 'No Duration' }, { lyric: PLAIN });
  assert.equal(state.usableLyric, true);
  assert.equal(state.lines.length, 4);
  assert.ok(state.lines[3].t > 0, 'the fallback spacing still separates the lines');
});

test('a timed lyric is still read as timed, not as plain text', () => {
  const sandbox = boot();
  const state = sandbox.__parse(
    { name: 'Timed', artist: 'Somebody', duration: 160 },
    { lyric: '[00:12.50]First\n[00:20.00]Second' }
  );
  assert.equal(state.timingSource, 'lrc-line');
  assert.equal(state.lines.length, 2);
  assert.ok(Math.abs(state.lines[0].t - 12.5) < 0.001, 'the timestamp itself is kept');
});

test('a response with nothing in it still falls back to the title', () => {
  const sandbox = boot();
  for (const lyric of ['', '   \n  \n ', null, undefined]) {
    const state = sandbox.__parse({ name: 'Silent', artist: 'Somebody' }, { lyric });
    assert.equal(state.timingSource, 'fallback', `for ${JSON.stringify(lyric)}`);
    assert.equal(state.usableLyric, false);
    assert.equal(state.lines.length, 1);
    assert.equal(state.lines[0].text, 'Silent - Somebody');
    assert.equal(state.lines[0].fallback, true);
  }
});

test('lines the reader would have dropped on whitespace are kept', () => {
  const sandbox = boot();
  const messy = PLAIN.split('\n').map((line) => `   ${line}   `).join('\r\n');
  assert.equal(sandbox.__plain(messy, 60).length, 4, 'trimming must not delete a line');
  assert.equal(sandbox.__plain('', 60).length, 0);
  assert.equal(sandbox.__plain('   \n\n  ', 60).length, 0);
});
