'use strict';
// Playback quality: speed, sleep timer, equaliser, normalisation.
//
// The rule this file enforces is the one the feature was built under — a
// control only ships if it drives real audio. So each test asks the same
// question in a different shape: does the value the user picks reach the
// media clock, a deadline that pauses the player, a filter node in the
// graph, or a gain computed from a measurement? Anything that only lights
// up a button fails here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');

const quality = read('public/js/modules/05-playback/19-playback-quality.js');
const graph = read('public/js/modules/05-playback/08-audio-graph-controls.js');
const startAudio = read('public/js/modules/05-playback/13-playback-start-audio.js');
const cuefield = read('public/js/modules/05-playback/18-cuefield-automix-integration.js');
const mainLoop = read('public/js/modules/11-main-loop.js');
const coreStores = read('public/js/modules/00-state/00-core-stores.js');
const loader = read('public/js/index-loader.js');
const indexHtml = read('public/index.html');

function arrayLiteral(source, name) {
  const at = source.indexOf('var ' + name + ' = [');
  assert.ok(at >= 0, name + ' must be declared');
  const end = source.indexOf(']', at);
  return source.slice(source.indexOf('[', at), end + 1);
}

function literalList(source, name) {
  return JSON.parse(arrayLiteral(source, name).replace(/'/g, '"'));
}

// ---- every control is wired to a handler ----------------------------------

test('each segmented control in the markup calls its own setter with its own value', () => {
  const SEGMENTS = [
    ['pbq-speed-seg', 'data-pbq-speed', 'setPlaybackSpeed'],
    ['pbq-sleep-seg', 'data-pbq-sleep', 'setSleepTimerMode'],
    ['pbq-eq-preset-seg', 'data-pbq-preset', 'applyPlaybackEqPreset'],
  ];
  for (const [id, attr, setter] of SEGMENTS) {
    assert.ok(indexHtml.includes('id="' + id + '"'), id + ' must exist');
    assert.ok(indexHtml.includes(attr + '="'), attr + ' options must exist');
    assert.ok(quality.includes('function ' + setter + '('), setter + ' must be defined');
    assert.ok(
      quality.includes(setter + '(btn.getAttribute(\'' + attr + '\'))'),
      id + ' must pass ' + attr + ' through to ' + setter +
      ' — a handler that ignores the button it came from is a dead control'
    );
  }
});

test('the three switches are toggles with defined handlers, not labels', () => {
  for (const [id, fn] of [
    ['t-pbqEqualizer', 'togglePlaybackEqualizer'],
    ['t-pbqNormalise', 'togglePlaybackNormalise'],
    ['t-pbqGapless', 'togglePlaybackGaplessDefault'],
  ]) {
    assert.ok(indexHtml.includes('id="' + id + '"'), id + ' must exist');
    assert.ok(indexHtml.includes('onclick="' + fn + '()"'),
      id + ' must be wired to ' + fn);
    assert.ok(quality.includes('function ' + fn + '()'), fn + ' must be defined');
  }
});

test('the equaliser sliders carry their band index through to the setter', () => {
  const bands = [...indexHtml.matchAll(/data-pbq-band="(\d+)"/g)].map((m) => m[1]);
  const declared = literalList(quality, 'PBQ_EQ_BAND_HZ');
  assert.equal(bands.length, declared.length,
    'every band in the code needs a slider, or the band cannot be reached');
  assert.deepEqual(bands, declared.map((_, i) => String(i)),
    'the sliders have to be numbered in order — a shuffled index writes the wrong filter');
  assert.ok(quality.includes('setPlaybackEqBand(input.getAttribute(\'data-pbq-band\'), input.value, true)'),
    'dragging a band must call the setter with that band\'s index');
  // Preamp shares the same persistence path as the bands.
  assert.ok(indexHtml.includes('id="pbq-preamp"'));
  assert.ok(quality.includes('setPlaybackPreamp(preamp.value'));
});

// ---- speed ----------------------------------------------------------------

test('speed writes the media element clock and keeps the pitch', () => {
  assert.match(quality, /audio\.playbackRate = rate/);
  // Without this Chromium may pitch-shift back to normal, and the control
  // would move while sounding like nothing happened.
  assert.match(quality, /audio\.preservesPitch = true/);
  // The normalizer is a snap-to-offered-steps, not a passthrough: a value no
  // button can produce would light up no button at all.
  const speeds = literalList(quality, 'PBQ_SPEED_VALUES');
  assert.ok(speeds.includes(0.5) && speeds.includes(2) && speeds.includes(1));
  const normalizer = quality.slice(quality.indexOf('function normalizePlaybackSpeed('));
  assert.match(normalizer, /var best = 1/, 'an unparsable rate falls back to normal speed');
  assert.match(normalizer, /PBQ_SPEED_VALUES\[i\]/, 'the value is matched against the offered steps');
});

test('speed is re-applied on every track and on a gapless preload already rolling', () => {
  assert.match(startAudio, /if \(typeof applyPlaybackSpeed === 'function'\) applyPlaybackSpeed\(\);/,
    'the track-ui step is the one place every switch passes through');
  // A gapless preload starts playing before it is the current element, so it
  // has to be given the rate at construction or the crossfade runs at 1x.
  assert.match(startAudio, /media\.playbackRate = typeof normalizePlaybackSpeed === 'function'/);
  assert.match(startAudio, /media\.preservesPitch = true/);
  // And graph recovery carries the rate over to the replacement element.
  assert.match(graph, /var rate = oldAudio\.playbackRate \|\| 1;[\s\S]{0,900}audio\.playbackRate = rate/);
});

// ---- sleep timer ----------------------------------------------------------

test('the sleep modes in the code are exactly the buttons in the markup', () => {
  const markup = [...indexHtml.matchAll(/data-pbq-sleep="([^"]+)"/g)].map((m) => m[1]).sort();
  const modes = literalList(quality, 'PBQ_SLEEP_MODES').slice().sort();
  assert.deepEqual(modes, markup,
    'a mode no button can select is unreachable, and a button with no mode does nothing');
  assert.match(quality, /return PBQ_SLEEP_MODES\.indexOf\(v\) >= 0 \? v : 'off'/,
    'the normalizer is a whitelist that falls back to off');
});

test('a timed sleep fades out and pauses instead of cutting', () => {
  const fire = quality.slice(quality.indexOf('function fireSleepTimer()'));
  assert.match(fire, /fadeOutAndPauseAudio\(\)/,
    'the same helper the pause button uses — it ramps the real output gain first');
  // Which also means the gain comes back on the next play, because that path
  // is startPlaybackFadeIn(), already wired to the transport.
  assert.match(graph, /function fadeOutAndPauseAudio\(\)/);
  assert.match(graph, /function startPlaybackFadeIn\(\)/);
  assert.match(quality, /setTimeout\(fireSleepTimer/);
});

test('"end of track" stops before anything advances, in both ended handlers', () => {
  const handlers = startAudio.split('audio.onended = function () {').slice(1);
  assert.equal(handlers.length, 2,
    'there is a local-file path and a remote path; only one of them sleeping would be a coin flip');
  for (const body of handlers) {
    // The split gives the start of each handler; the bodies differ in depth,
    // so take a window that certainly contains the whole advance decision.
    const src = body.slice(0, 1400);
    const atSleep = src.indexOf('sleepTimerShouldStopAtTrackEnd');
    assert.ok(atSleep > 0, 'this ended handler never consults the sleep timer');
    assert.ok(src.indexOf('finalizeListenSession(true)') < atSleep,
      'the listen must still be recorded before the stop');
    assert.ok(src.indexOf('playAlbumGaplessNextOnEnded') > atSleep,
      'and the stop has to come before the queue advances');
    // Searched from the sleep check onward: what matters is that nothing
    // after the stop can still roll on to the next song.
    assert.ok(src.indexOf('nextTrack', atSleep) > atSleep,
      'or the player rolls on to the next song');
  }
  assert.match(quality, /function sleepTimerShouldStopAtTrackEnd\(\) \{\s*\n\s*return sleepTimerMode === 'end';/);
});

// ---- equaliser ------------------------------------------------------------

test('the tone stage is a real filter chain in the graph', () => {
  assert.match(quality, /audioCtx\.createBiquadFilter\(\)/);
  assert.match(quality, /filter\.type = 'peaking'/);
  assert.match(quality, /filter\.frequency\.value = PBQ_EQ_BAND_HZ\[i\]/);
  const bands = literalList(quality, 'PBQ_EQ_BAND_HZ');
  assert.equal(bands.length, 7);
  for (const hz of bands) assert.ok(hz > 20 && hz < 20000, hz + 'Hz is not an audible band');
  // Ascending, so a slider order cannot map to the wrong filter.
  for (let i = 1; i < bands.length; i++) {
    assert.ok(bands[i] > bands[i - 1], 'bands must ascend: ' + bands[i - 1] + ' -> ' + bands[i]);
  }
});

test('the chain sits on the last hop, after the output gain', () => {
  // Metering and the loudness measurement read the analyser, which is fed by
  // the source directly — so neither can see its own output.
  assert.match(graph, /analyser\.connect\(gainNode\);\s*\n[\s\S]{0,600}connectPlaybackOutputHop\(gainNode, audioCtx\.destination\)/);
  assert.match(graph, /gainNode\.connect\(audioCtx\.destination\)/,
    'the direct connection has to survive as the fallback, or a missing stage becomes silence');
  // And the stage is an all-or-nothing add-on: playback never depends on it.
  assert.match(quality, /function connectPlaybackOutputHop\(fromNode, destination\)/);
  const hop = quality.slice(quality.indexOf('function connectPlaybackOutputHop('), quality.indexOf('function releasePlaybackToneChain('));
  assert.match(hop, /fromNode\.connect\(destination\)/, 'the fallback path has to be reachable from the same function');
});

test('the chain is scoped to the AudioContext, so a crossfade cannot orphan it', () => {
  // A cuefield crossfade keeps a second element alive across a graph rebuild.
  // If the stage died with the first graph, that element would be wired into a
  // node nothing reads any more and would go silent mid-fade.
  const disconnect = graph.slice(graph.indexOf('function disconnectAudioGraphNodes('));
  const end = disconnect.indexOf('\nfunction ', 1);
  const body = disconnect.slice(0, end > 0 ? end : disconnect.length);
  assert.doesNotMatch(body, /releasePlaybackToneChain/,
    'the stage must survive a per-track teardown');
  assert.match(body, /equaliser chain deliberately survives/);
  // It is released exactly when the context it belongs to goes away.
  assert.match(graph, /audioCtx\.close\(\)[\s\S]{0,260}releasePlaybackToneChain\(\)/);
  assert.match(quality, /pbqToneCtx === audioCtx/, 'and rebuilt when the context identity changes');
});

test('the crossfading second graph leaves through the same stage', () => {
  // Without this the track that fades in would be the one track in the app
  // that ignores the user's tone settings.
  assert.match(cuefield, /connectPlaybackOutputHop\(graph\.gainNode, audioCtx\.destination\)/);
  assert.match(cuefield, /graph\.gainNode\.connect\(audioCtx\.destination\)/,
    'the direct fallback still has to be there');
  // An adopted prepared graph is re-asserted, in case it was built in an
  // older context.
  assert.match(graph, /preparedGraph\.adopted = true;[\s\S]{0,400}connectPlaybackOutputHop\(gainNode, audioCtx\.destination\)/);
});

test('turning the equaliser off flattens the bands instead of rewiring', () => {
  // Rewiring under a playing track would drop audio for a frame or two.
  const apply = quality.slice(quality.indexOf('function applyPlaybackToneChain('));
  assert.match(apply, /playbackEqualizerOn \? \(playbackEqGains\[i\] \|\| 0\) : 0/);
  assert.match(apply, /function applyPlaybackToneChain\(rampMs\)/);
  // Every setter goes through it, so no path can leave a stale filter value.
  for (const setter of ['setPlaybackEqBand', 'setPlaybackPreamp', 'togglePlaybackEqualizer', 'applyPlaybackEqPreset']) {
    const body = quality.slice(quality.indexOf('function ' + setter + '('));
    const stop = body.indexOf('\nfunction ', 1);
    assert.ok(body.slice(0, stop > 0 ? stop : body.length).includes('applyPlaybackToneChain('),
      setter + ' must push the new value into the chain');
  }
});

// ---- normalisation --------------------------------------------------------

test('normalisation measures the track and can only ever cut', () => {
  const fromRms = quality.slice(quality.indexOf('function playbackNormGainFromRms('));
  assert.match(fromRms, /var delta = PBQ_NORM_TARGET_DB - db/);
  assert.match(fromRms, /if \(!\(delta < 0\)\) return 0/,
    'a track already under the target is left exactly where it is');
  assert.match(fromRms, /Math\.max\(PBQ_NORM_MAX_CUT_DB,/,
    'the cut is clamped, so a near-silent track cannot be pulled down into nothing');
  // Boosting would clip: there is no limiter in this graph.
  assert.doesNotMatch(fromRms, /Math\.max\(0, delta\)/);
  assert.doesNotMatch(quality, /DynamicsCompressor|createWaveShaper/);
  // The measurement comes from the analyser, which the main loop refills from
  // the source — upstream of the output gain, so dragging the volume slider
  // cannot change what gets recorded.
  const sampleFn = quality.slice(quality.indexOf('function trackPlaybackLoudnessSample('));
  assert.match(sampleFn, /pbqNorm\.sum \+= value \* value/);
  assert.match(sampleFn, /pbqNorm\.count\+\+/);
  assert.match(sampleFn, /finishPlaybackLoudnessMeasurement\(true\)/);
});

test('the sampler runs after the frame reads the analyser, while audio plays', () => {
  const at = mainLoop.indexOf('trackPlaybackLoudnessSample(rms)');
  assert.ok(at > 0, 'nothing ever feeds the measurement');
  assert.ok(mainLoop.indexOf('getByteFrequencyData') < at, 'it has to come after the spectrum read');
  const rmsAt = mainLoop.indexOf('rms = Math.sqrt(rms / Math.max(1, rmsCount));');
  assert.ok(rmsAt > 0 && rmsAt < at, 'and after the RMS this frame is finalised');
  // Guarded, so a frame without audio costs one typeof.
  assert.match(mainLoop, /if \(typeof trackPlaybackLoudnessSample === 'function'\) trackPlaybackLoudnessSample\(rms\);/);
});

test('a measured level is remembered, and a known track settles at once', () => {
  assert.ok(coreStores.includes("PBQ_NORM_STORE_KEY = 'mineradio-playback-norm-v1'"));
  assert.match(quality, /localStorage\.setItem\(PBQ_NORM_STORE_KEY/);
  assert.match(quality, /playbackNormCachePut\(pbqNorm\.key, db\)/);
  // The cache is bounded, or a long session would outgrow localStorage.
  assert.match(quality, /PBQ_NORM_CACHE_LIMIT/);
  const begin = quality.slice(quality.indexOf('function beginPlaybackLoudnessMeasurement('));
  assert.match(begin, /Object\.prototype\.hasOwnProperty\.call\(cache, key\)/,
    'a known track is applied from the cache instead of re-measured mid-song');
  assert.match(begin, /pbqNorm\.active = true;/,
    'an unknown track is measured');
  // The measurement is armed per track, from the one step every switch runs.
  assert.match(startAudio, /if \(typeof beginPlaybackLoudnessMeasurement === 'function'\) beginPlaybackLoudnessMeasurement\(song\);/);
});

// ---- gapless (already real — this only owns the default) ------------------

test('the gapless switch moves the default the album context actually reads', () => {
  const toggle = quality.slice(quality.indexOf('function togglePlaybackGaplessDefault()'));
  assert.match(toggle, /albumGaplessState\.defaultEnabled = playbackGaplessDefaultOn/);
  assert.match(toggle, /clearAlbumGaplessPreload\('album-gapless-default-off'\)/,
    'turning it off has to drop the album held open now, or the switch looks dead');
  // And the default is re-read at boot, from the persisted preference.
  assert.match(quality, /albumGaplessState\.defaultEnabled = playbackGaplessDefaultOn;/);
  assert.match(startAudio, /albumGaplessState\.defaultEnabled !== false/,
    'this is the rule the album context falls back to — the two must agree');
  // The real crossfade and handoff stay where they were; this module does not
  // reimplement them.
  assert.match(startAudio, /function runAlbumGaplessBalancedCrossfade\(/);
  assert.match(startAudio, /function startAlbumGaplessHandoff\(/);
});

// ---- persistence ----------------------------------------------------------

test('every setting is written with a normalizer and read back through one', () => {
  assert.ok(coreStores.includes("PBQ_STORE_KEY = 'mineradio-playback-tone-v1'"),
    'the preference needs a key, or the next launch forgets it');
  const save = quality.slice(quality.indexOf('function savePlaybackQualityPreference()'));
  for (const field of ['speed', 'equalizer', 'normalise', 'gapless', 'preamp', 'eq']) {
    assert.ok(save.includes(field + ':'),
      'the save payload must carry ' + field + ' — a field left out is a setting that resets');
  }
  const load = quality.slice(quality.indexOf('function readPlaybackQualityPreference()'));
  assert.match(load, /normalizePlaybackSpeed\(raw\.speed\)/);
  assert.match(load, /normalizePlaybackPreamp\(raw\.preamp\)/);
  assert.match(load, /normalizePlaybackEqBandList\(raw\.eq\)/);
  // A value stored before a new band existed must still load.
  assert.match(load, /raw\.gapless !== false/, 'absent means the shipped default, which is on');
  // Every setter persists after writing, in that order.
  for (const setter of ['setPlaybackSpeed', 'setPlaybackEqBand', 'setPlaybackPreamp',
    'togglePlaybackEqualizer', 'togglePlaybackNormalise', 'togglePlaybackGaplessDefault']) {
    const body = quality.slice(quality.indexOf('function ' + setter + '('));
    const stop = body.indexOf('\nfunction ', 1);
    assert.ok(body.slice(0, stop > 0 ? stop : body.length).includes('savePlaybackQualityPreference()'),
      setter + ' must save, or the restart half never sees it');
  }
});

test('the read-back lights the button for the value in force, not the last one pressed', () => {
  const sync = quality.slice(quality.indexOf('function syncPlaybackQualityUi()'));
  assert.match(sync, /btn\.classList\.toggle\('active', normalizePlaybackSpeed\(btn\.getAttribute\('data-pbq-speed'\)\) === playbackSpeedValue\)/);
  assert.match(sync, /btn\.classList\.toggle\('active', normalizeSleepTimerMode\(btn\.getAttribute\('data-pbq-sleep'\)\) === sleepTimerMode\)/);
  assert.match(sync, /eqToggle\.classList\.toggle\('on', playbackEqualizerOn === true\)/);
  assert.match(sync, /normToggle\.classList\.toggle\('on', playbackNormaliseOn === true\)/);
  assert.match(sync, /gapToggle\.classList\.toggle\('on', playbackGaplessDefaultOn === true\)/);
  // The status line has to tell the truth about the graph, not the intent.
  assert.match(sync, /has no tone stage/);
  assert.match(sync, /measuring this track/);
  assert.match(quality, /function syncSleepTimerStatus\(\)/);
  assert.match(quality, /pbqElement\('pbq-sleep-status'\)/);
});

// ---- assembly -------------------------------------------------------------

test('it loads after the state it reads and installs itself', () => {
  assert.match(loader, /'js\/modules\/05-playback\/19-playback-quality\.js'/);
  const at = loader.indexOf('19-playback-quality.js');
  for (const earlier of ['00-state/00-core-stores.js', '05-playback/08-audio-graph-controls.js',
    '05-playback/13-playback-start-audio.js', '05-playback/18-cuefield-automix-integration.js']) {
    assert.ok(loader.indexOf(earlier) < at, earlier + ' must load before playback quality');
  }
  assert.match(quality, /installPlaybackQuality\(\);\s*$/);
  assert.match(indexHtml, /if \(typeof installPlaybackQuality === 'function'\) installPlaybackQuality\(\);/);
  // The controls are bound idempotently, because install runs twice on purpose.
  assert.match(quality, /if \(speedSeg && !speedSeg\.__pbqBound\)/);
  assert.match(quality, /if \(input\.__pbqBound\) return;/);
});

test('a cold start cannot throw before there is a player', () => {
  // installPlaybackQuality runs at load, long before a graph or a queue.
  assert.match(quality, /if \(typeof albumGaplessState !== 'undefined' && albumGaplessState\)/);
  assert.match(quality, /if \(!audioCtx \|\| !destination \|\| !audioCtx\.createBiquadFilter\) return null;/);
  assert.match(quality, /if \(!fromNode \|\| !destination\) return false;/);
  assert.match(quality, /try \{\s*\n\s*audio\.playbackRate = rate;/);
  // And an optional stage missing is reported, never fatal.
  assert.match(quality, /console\.warn\('tone chain unavailable:'/);
});

// ---- surviving the settings panel rebuild ---------------------------------

// The settings panel is not a static document: organizeFxConsoleWorkspace()
// tears #fx-panel apart and rebuilds it from FX_CONSOLE_LAYOUT, then deletes
// every top-level node it did not move out of the old markup first. Residual
// discovery only rescues nodes that contain an input, select, textarea or
// button, so a control made of divs and spans — a toggle, a status line —
// cannot be found by accident. Leaving one off the table does not merely hide
// it; the element is gone by the time the user opens settings, and the click
// handler still installed on document points at nothing.
const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source',
  'area', 'base', 'col', 'embed', 'track', 'wbr']);
// Direct children of the section that are meant to disappear: the heading is
// replaced by the group title, the hint by the group hint, and the toggle
// wrapper by the grid the console builds for itself.
const DECORATIVE_CLASSES = new Set(['fx-section-label', 'fx-sub', 'fx-toggle-grid']);

// Parse just the Playback quality section into a parent-linked tree, so the
// test can ask the question the rebuild actually asks: what is inside what.
function playbackQualitySection(workspace) {
  const start = indexHtml.indexOf('<div class="fx-section-label">Playback quality</div>');
  const end = indexHtml.indexOf('<div class="fx-section-label">Quality preset</div>');
  assert.ok(start >= 0 && end > start, 'the Playback quality section must exist in index.html');
  const markup = indexHtml.slice(start, end);

  const blockClasses = new Set(
    (/var blockSelector = '([^']+)'/.exec(workspace) || [])[1]
      .split(',').map((s) => s.trim().replace(/^\./, '')).filter(Boolean)
  );
  assert.ok(blockClasses.size > 10, 'blockSelector must still be a real list of block classes');

  const nodes = [];
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  while ((m = tagRe.exec(markup))) {
    const tag = m[2].toLowerCase();
    if (m[1]) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const attrs = m[3];
    const id = (/\bid="([^"]*)"/.exec(attrs) || [])[1] || '';
    const cls = ((/\bclass="([^"]*)"/.exec(attrs) || [])[1] || '').split(/\s+/).filter(Boolean);
    const node = { tag, id, classes: cls, parent: stack.length ? stack[stack.length - 1] : null };
    nodes.push(node);
    if (!VOID_TAGS.has(tag)) stack.push(node);
  }
  assert.ok(nodes.length > 30, 'the section should parse into a real tree, got ' + nodes.length);
  const registered = new Set(
    [...workspace.matchAll(/fxConsoleItem\('([^']+)'/g)].map((x) => x[1])
  );
  return { nodes, registered, blockClasses };
}

function nearestBlock(node, blockClasses) {
  let n = node;
  while (n) {
    if (n.classes.some((c) => blockClasses.has(c))) return n;
    n = n.parent;
  }
  return null;
}

function hasRegisteredInside(block, nodes, registered) {
  const within = (n) => {
    if (n === block) return true;
    let p = n.parent;
    while (p) { if (p === block) return true; p = p.parent; }
    return false;
  };
  return nodes.some((n) => n.id && registered.has(n.id) && within(n));
}

test('every playback-quality control is listed in the console layout, or it is deleted', () => {
  const workspace = read('public/js/modules/07-fx/09-console-workspace.js');
  const { nodes, registered, blockClasses } = playbackQualitySection(workspace);

  const orphaned = [];
  const decorative = [];
  for (const node of nodes) {
    if (node.id && registered.has(node.id)) continue;
    const block = nearestBlock(node, blockClasses);
    if (block && hasRegisteredInside(block, nodes, registered)) continue;
    // Nothing in the markup will move this node out before the old panel is
    // thrown away, so it only survives if it is one of the three wrappers the
    // rebuild is expected to discard. An id means it was meant to be a control,
    // and a decorative class must never excuse one — that is exactly how the
    // sleep status line disappeared the first time.
    if (!node.id && node.classes.some((c) => DECORATIVE_CLASSES.has(c)) &&
        (!node.parent || node.parent.classes.some((c) => c === 'fx-section-label'))) {
      decorative.push(node);
      continue;
    }
    orphaned.push((node.id ? '#' + node.id : '<' + node.tag + '>') +
      (node.classes.length ? '.' + node.classes.join('.') : ''));
  }

  assert.deepEqual(orphaned, [],
    'these are not moved out by FX_CONSOLE_LAYOUT and not rescued as residuals, ' +
    'so organizeFxConsoleWorkspace() deletes them from the settings panel');

  // The registration has to land somewhere the user can actually reach: the
  // playback group on the System tab, not the "Other settings" leftovers bin.
  const playbackGroup = workspace.slice(
    workspace.indexOf("{ key: 'playback', title: 'Playback quality'"),
    workspace.indexOf("{ key: 'performance', title: 'Performance & background'")
  );
  assert.ok(playbackGroup.indexOf("{ key: 'playback', title: 'Playback quality'") === 0,
    'the group must exist so the controls are not filed as residuals');
  for (const node of nodes) {
    if (node.id && registered.has(node.id)) {
      assert.ok(playbackGroup.includes("fxConsoleItem('" + node.id + "'"),
        '#' + node.id + ' must sit in the Playback quality group');
    }
  }

  // And the reason this matters, pinned so nobody "simplifies" it away.
  // Leftovers are removed outright once the walk is done …
  assert.match(workspace, /!node\.classList\.contains\('fx-tab-page'\)\) node\.remove\(\);/);
  // … and the walk can only see form controls. It then climbs to the nearest
  // enclosing block, which is why `.fx-toggle` is in blockSelector at all — but
  // the climb never starts. A switch built from a div and a span contains no
  // input, select, textarea or button, so nothing is ever mapped up to it and
  // it has no second chance. The registry is the only thing that can save it.
  const residual = workspace.slice(
    workspace.indexOf('function fxConsoleFindUnclassifiedControls'),
    workspace.indexOf('function organizeFxConsoleWorkspace')
  );
  const searches = [...residual.matchAll(/(?:matches|querySelectorAll)\('([^']*)'\)/g)].map((x) => x[1]);
  assert.ok(searches.length >= 2, 'the walk searches roots and their subtrees');
  for (const sel of searches) {
    assert.equal(sel, 'input:not([type="hidden"]),select,textarea,button',
      'residual discovery must keep starting from form controls — every other ' +
      'entry point would change which controls survive a rebuild');
  }
});

test('the console keeps the toggles together instead of scattering them', () => {
  const workspace = read('public/js/modules/07-fx/09-console-workspace.js');
  // Three consecutive switches share one fx-toggle-grid per group; a non-toggle
  // between them closes the grid. The markup puts them side by side, so the
  // registry must not interleave a slider in the middle of them.
  const playbackGroup = workspace.slice(
    workspace.indexOf("{ key: 'playback', title: 'Playback quality'"),
    workspace.indexOf("{ key: 'performance', title: 'Performance & background'")
  );
  const order = ['pbq-speed-seg', 'pbq-sleep-seg', 'pbq-sleep-status',
    't-pbqEqualizer', 't-pbqNormalise', 't-pbqGapless', 'pbq-preamp'];
  const positions = order.map((id) => playbackGroup.indexOf("fxConsoleItem('" + id + "'"));
  assert.ok(positions.every((p) => p >= 0), 'all seven must be registered');
  assert.deepEqual(positions, positions.slice().sort((a, b) => a - b),
    'registration order has to keep the three switches adjacent');
});
