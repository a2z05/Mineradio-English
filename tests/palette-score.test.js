'use strict';
// The cover-palette scorer.
//
// It runs in the browser (it needs a canvas and the app's own extractor), so
// what is checked here is the arithmetic that decides whether its report is
// true. One of those — the circular standard deviation — was written wrong
// once and produced a spread-out set of hues that read as "12°, all the same".
// A report that cannot be trusted is worse than no report.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(appRoot, 'scripts/palette-score.browser.js'), 'utf8');

function bodyOf(name) {
  const at = source.indexOf('function ' + name + '(');
  assert.ok(at >= 0, name + ' must exist');
  const next = source.indexOf('\n  function ', at + 1);
  const nextTop = source.indexOf('\nasync function ', at + 1);
  const end = [next, nextTop].filter((i) => i > 0).sort((a, b) => a - b)[0];
  return source.slice(at, end || source.length);
}

test('the circular spread is converted after the root, not inside it', () => {
  const body = bodyOf('circular');
  // sqrt(-2 ln R) is in radians. Multiplying inside the root squares the
  // conversion factor and reports a standard deviation that is far too small —
  // it turned a set spread over the whole wheel into "12°, nearly one colour".
  assert.match(body, /Math\.sqrt\(Math\.max\(0, -2 \* Math\.log\(Math\.max\(1e-9, R\)\)\)\) \* 180 \/ Math\.PI/,
    'the degree conversion has to be outside the square root');
  // The mean has to be circular too: a plain average of 359° and 1° is 180°.
  assert.match(body, /Math\.atan2\(sy, sx\)/);
  assert.match(body, /Math\.cos\(a\)/, 'hues are averaged as unit vectors');
});

test('a grey primary is not counted as a hue', () => {
  const body = bodyOf('css2hue');
  assert.match(body, /out\[1\] > 0\.12/,
    'below that the "hue" is an artefact of rounding, and counting it invents variety');
});

test('the pink/red band is measured, not assumed', () => {
  const body = bodyOf('pinkRedShare');
  assert.match(body, /h >= 330 \|\| h < 25/,
    'the band has to wrap the top of the wheel, or rose never counts');
});

test('it compares what it extracted against what the picture already was', () => {
  // Both distributions over the same images — without the source one there is
  // nothing to compare the extractor to, and "the scene looks pink" is just an
  // opinion.
  assert.match(source, /sourceDominantHue/);
  assert.match(source, /appExtractedPrimary/);
  assert.match(source, /pinkRedShareShift/);
  assert.match(source, /spreadChange/);
  // The extractor under test is the app's own, not a reimplementation.
  assert.match(source, /updateLyricPaletteFromCover\(canvas\)/);
  assert.match(source, /stageLyrics\.palette/);
  // And the images come through the app's proxy, or the canvas taints and
  // getImageData throws.
  assert.match(source, /\/api\/cover\?url=/);
});

test('one provider failing does not fail the run', () => {
  assert.match(source, /catch \(e\) \{ \/\* one provider failing must not fail the run \*\/\s*\}/);
  assert.match(source, /try \{ await one\(list\[i\]\); \} catch \(e\) \{ failed\+\+; \}/);
  assert.match(source, /if \(!list\.length\) throw new Error\('no covers returned by the search API'\)/,
    'an empty set must say so loudly rather than report 0% of nothing');
});
