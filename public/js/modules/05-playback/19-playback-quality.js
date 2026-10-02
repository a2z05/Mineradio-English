// ============================================================
//  Playback quality — speed, sleep timer, tone control, level.
//
//  The rule for everything in this file: a control only ships if it drives
//  real audio. Four things here are wired to hardware-side state:
//
//    speed            the media element's clock (playbackRate), pitch kept
//    sleep timer      a deadline that fades out and pauses the player
//    equaliser        a chain of BiquadFilters sitting in the graph between
//                     the analyser and the output gain
//    normalisation    a gain derived from the track's own measured level
//
//  Two neighbouring features are NOT reimplemented here because they already
//  exist and are already real: gapless handoff with an equal-power crossfade
//  at the album boundary (13-playback-start-audio), and the fade-in/fade-out
//  sliders on the volume popover (08-audio-graph-controls). This module only
//  exposes the global gapless default, which the album context consults.
//
//  Normalisation is cut-only. Boosting a track whose level we guessed would
//  clip the output, and there is no limiter in this graph — so loud tracks
//  come down to the target and quiet ones are left alone. That is the whole
//  trade, and it is why the label says "pulls louder tracks down".
// ============================================================

var PBQ_SPEED_VALUES = [0.5, 0.75, 1, 1.25, 1.5, 2];
// Peaking bands, log-spaced across the audible range a listener actually uses.
var PBQ_EQ_BAND_HZ = [60, 150, 400, 1000, 2400, 6000, 14000];
var PBQ_EQ_BAND_LABELS = ['60', '150', '400', '1k', '2.4k', '6k', '14k'];
var PBQ_EQ_MIN_DB = -12;
var PBQ_EQ_MAX_DB = 12;
var PBQ_PREAMP_MIN_DB = -12;
var PBQ_PREAMP_MAX_DB = 12;
// Loudness target in dBFS RMS. Pop masters sit around -12, quieter material
// around -20; -16 pulls the loud end down without touching the quiet end.
var PBQ_NORM_TARGET_DB = -16;
var PBQ_NORM_MAX_CUT_DB = -12;
// Long enough for an RMS estimate to settle on a normal track, short enough
// that the level has arrived before the first chorus.
var PBQ_NORM_WINDOW_MS = 5000;
var PBQ_NORM_MIN_SAMPLES = 24;
var PBQ_NORM_RAMP_MS = 900;
var PBQ_NORM_CACHE_LIMIT = 400;
// Exactly the modes the markup offers. A mode no control can reach would be
// a value the normalizer accepts and nothing can ever produce.
var PBQ_SLEEP_MODES = ['off', '15', '30', '60', 'end'];

var playbackSpeedValue = 1;
var playbackEqualizerOn = false;
var playbackNormaliseOn = false;
var playbackGaplessDefaultOn = true;
var playbackEqGains = [0, 0, 0, 0, 0, 0, 0];
var playbackPreampDb = 0;

var sleepTimerMode = 'off';
var sleepTimerDeadline = 0;
var sleepTimerHandle = 0;
var sleepTimerTickHandle = 0;

// The tone chain. Built by connectPlaybackToneChain() when the graph is built,
// dropped by releasePlaybackToneChain() when it is torn down.
var pbqToneIn = null;
var pbqToneOut = null;
var pbqPreampNode = null;
var pbqFilterNodes = [];
var pbqToneCtx = null;
var pbqToneAvailable = false;

var pbqNormCache = null;
var pbqNorm = {
  key: '',
  active: false,
  measuring: false,
  startAt: 0,
  sum: 0,
  count: 0,
  gainDb: 0
};

// ---- preferences ----------------------------------------------------------

function normalizePlaybackSpeed(value) {
  var v = Number(value);
  if (!isFinite(v)) return 1;
  // Snap to the offered steps rather than accepting an arbitrary rate, so the
  // button that lights up is always one of the six the markup contains.
  var best = 1, bestDelta = Infinity;
  for (var i = 0; i < PBQ_SPEED_VALUES.length; i++) {
    var delta = Math.abs(PBQ_SPEED_VALUES[i] - v);
    if (delta < bestDelta) { bestDelta = delta; best = PBQ_SPEED_VALUES[i]; }
  }
  return best;
}

function normalizeSleepTimerMode(value) {
  var v = String(value == null ? '' : value).trim();
  return PBQ_SLEEP_MODES.indexOf(v) >= 0 ? v : 'off';
}

function normalizePlaybackEqGain(value) {
  var v = Number(value);
  if (!isFinite(v)) return 0;
  return Math.max(PBQ_EQ_MIN_DB, Math.min(PBQ_EQ_MAX_DB, Math.round(v * 2) / 2));
}

function normalizePlaybackPreamp(value) {
  var v = Number(value);
  if (!isFinite(v)) return 0;
  return Math.max(PBQ_PREAMP_MIN_DB, Math.min(PBQ_PREAMP_MAX_DB, Math.round(v * 2) / 2));
}

function normalizePlaybackEqBandList(list) {
  var out = [];
  for (var i = 0; i < PBQ_EQ_BAND_HZ.length; i++) {
    var v = list && list.length > i ? normalizePlaybackEqGain(list[i]) : 0;
    out.push(v);
  }
  return out;
}

function readPlaybackQualityPreference() {
  var fallback = { speed: 1, equalizer: false, normalise: false, gapless: true, preamp: 0, eq: [0, 0, 0, 0, 0, 0, 0] };
  try {
    var raw = JSON.parse(localStorage.getItem(PBQ_STORE_KEY) || '{}') || {};
    return {
      speed: normalizePlaybackSpeed(raw.speed),
      equalizer: raw.equalizer === true,
      normalise: raw.normalise === true,
      // Absent means "the shipped default", which is on — same rule the album
      // context uses (defaultEnabled !== false).
      gapless: raw.gapless !== false,
      preamp: normalizePlaybackPreamp(raw.preamp),
      eq: normalizePlaybackEqBandList(raw.eq)
    };
  } catch (e) {
    return fallback;
  }
}

function savePlaybackQualityPreference() {
  try {
    localStorage.setItem(PBQ_STORE_KEY, JSON.stringify({
      speed: playbackSpeedValue,
      equalizer: playbackEqualizerOn,
      normalise: playbackNormaliseOn,
      gapless: playbackGaplessDefaultOn,
      preamp: playbackPreampDb,
      eq: playbackEqGains
    }));
  } catch (e) { }
}

// ---- speed ----------------------------------------------------------------

function applyPlaybackSpeed() {
  var rate = normalizePlaybackSpeed(playbackSpeedValue);
  var applied = false;
  if (audio) {
    try {
      audio.playbackRate = rate;
      // Without this Chromium may resample pitch back to normal, and the
      // control would look like it worked while sounding like nothing happened.
      audio.preservesPitch = true;
      applied = true;
    } catch (e) { }
  }
  // A gapless preload is already decoding (sometimes already rolling) before
  // it becomes the current element, so it needs the rate too.
  try {
    var preload = albumGaplessState && albumGaplessState.preload;
    if (preload && preload.media) {
      preload.media.playbackRate = rate;
      preload.media.preservesPitch = true;
    }
  } catch (e) { }
  return applied;
}

function setPlaybackSpeed(value, silent) {
  var next = normalizePlaybackSpeed(value);
  if (next === playbackSpeedValue) {
    applyPlaybackSpeed();
    syncPlaybackQualityUi();
    return playbackSpeedValue;
  }
  playbackSpeedValue = next;
  savePlaybackQualityPreference();
  applyPlaybackSpeed();
  syncPlaybackQualityUi();
  if (!silent && typeof showToast === 'function') showToast('Speed ' + next + '×');
  return next;
}

// ---- sleep timer ----------------------------------------------------------

function sleepTimerRemainingMs() {
  if (sleepTimerMode === 'off') return 0;
  if (sleepTimerMode === 'end') return 0;
  return Math.max(0, sleepTimerDeadline - Date.now());
}

function sleepTimerLabel() {
  if (sleepTimerMode === 'off') return 'Sleep timer off';
  if (sleepTimerMode === 'end') return 'Sleeping when this track ends';
  var ms = sleepTimerRemainingMs();
  if (ms <= 0) return 'Sleeping now';
  var totalSeconds = Math.ceil(ms / 1000);
  var minutes = Math.floor(totalSeconds / 60);
  var seconds = totalSeconds % 60;
  return 'Sleeping in ' + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
}

function sleepTimerShouldStopAtTrackEnd() {
  return sleepTimerMode === 'end';
}

function stopSleepTimer(notify) {
  if (sleepTimerHandle) { clearTimeout(sleepTimerHandle); sleepTimerHandle = 0; }
  if (sleepTimerTickHandle) { clearInterval(sleepTimerTickHandle); sleepTimerTickHandle = 0; }
  sleepTimerMode = 'off';
  sleepTimerDeadline = 0;
  syncPlaybackQualityUi();
  if (notify && typeof showToast === 'function') showToast('Sleep timer off');
}

function fireSleepTimer() {
  var wasMode = sleepTimerMode;
  if (sleepTimerHandle) { clearTimeout(sleepTimerHandle); sleepTimerHandle = 0; }
  if (sleepTimerTickHandle) { clearInterval(sleepTimerTickHandle); sleepTimerTickHandle = 0; }
  sleepTimerMode = 'off';
  sleepTimerDeadline = 0;
  syncPlaybackQualityUi();
  if (typeof showToast === 'function') showToast('Sleep timer — pausing playback');
  // The existing fade-out helper ramps the real output gain and pauses once it
  // reaches silence, so the timer never cuts audio mid-note.
  if (typeof fadeOutAndPauseAudio === 'function') fadeOutAndPauseAudio().catch(function () { });
  return wasMode;
}

function startSleepTimerTick() {
  if (sleepTimerTickHandle) clearInterval(sleepTimerTickHandle);
  sleepTimerTickHandle = setInterval(function () {
    if (sleepTimerMode === 'off' || sleepTimerMode === 'end') {
      if (sleepTimerTickHandle) { clearInterval(sleepTimerTickHandle); sleepTimerTickHandle = 0; }
      return;
    }
    if (sleepTimerRemainingMs() <= 0) return;
    syncSleepTimerStatus();
  }, 1000);
}

function setSleepTimerMode(mode, silent) {
  var next = normalizeSleepTimerMode(mode);
  if (sleepTimerHandle) { clearTimeout(sleepTimerHandle); sleepTimerHandle = 0; }
  if (sleepTimerTickHandle) { clearInterval(sleepTimerTickHandle); sleepTimerTickHandle = 0; }
  sleepTimerMode = next;
  sleepTimerDeadline = 0;
  if (next !== 'off' && next !== 'end') {
    sleepTimerDeadline = Date.now() + parseInt(next, 10) * 60 * 1000;
    sleepTimerHandle = setTimeout(fireSleepTimer, sleepTimerDeadline - Date.now());
    startSleepTimerTick();
  }
  syncPlaybackQualityUi();
  if (!silent && typeof showToast === 'function') {
    showToast(next === 'off' ? 'Sleep timer off'
      : next === 'end' ? 'Sleep at end of track'
        : 'Sleep in ' + next + ' min');
  }
  return next;
}

// ---- tone chain (equaliser + preamp + normalisation) ----------------------

function playbackToneWantedDb() {
  var db = playbackEqualizerOn ? playbackPreampDb : 0;
  if (playbackNormaliseOn) db += Number(pbqNorm.gainDb) || 0;
  return Math.max(-24, Math.min(24, db));
}

function playbackToneLinear() {
  return Math.pow(10, playbackToneWantedDb() / 20);
}

function writePlaybackToneGain(rampMs) {
  if (!pbqPreampNode || !audioCtx) return false;
  var linear = playbackToneLinear();
  var now = audioCtx.currentTime || 0;
  try {
    var param = pbqPreampNode.gain;
    param.cancelScheduledValues(now);
    if (rampMs > 0) {
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(linear, now + rampMs / 1000);
    } else {
      param.setValueAtTime(linear, now);
    }
    return true;
  } catch (e) {
    try { pbqPreampNode.gain.value = linear; return true; } catch (e2) { return false; }
  }
}

function applyPlaybackToneChain(rampMs) {
  var installed = pbqFilterNodes.length > 0 && !!pbqPreampNode;
  for (var i = 0; i < pbqFilterNodes.length; i++) {
    // Equaliser off means flat, not absent: the chain stays wired so flipping
    // the switch cannot rebuild the graph under a playing track.
    var db = playbackEqualizerOn ? (playbackEqGains[i] || 0) : 0;
    try { pbqFilterNodes[i].gain.value = db; } catch (e) { }
  }
  var wrote = writePlaybackToneGain(rampMs || 0);
  pbqToneAvailable = installed && wrote;
  return pbqToneAvailable;
}

// The chain is scoped to the AudioContext, not to a track. The graph is torn
// down and rebuilt on every track switch, and a cuefield crossfade runs a
// second media element in parallel — if the stage died with the first graph,
// the incoming track would arrive with no equaliser and the outgoing one
// would drop out of it mid-fade.
function ensurePlaybackToneChain(destination) {
  if (!audioCtx || !destination || !audioCtx.createBiquadFilter) return null;
  if (pbqToneIn && pbqToneOut && pbqToneCtx === audioCtx) {
    pbqToneAvailable = true;
    return pbqToneIn;
  }
  releasePlaybackToneChain();
  try {
    var head = audioCtx.createGain();
    head.gain.value = playbackToneLinear();
    var filters = [];
    // Preamp first so the tone stage always sees the level the user asked for.
    var cursor = head;
    for (var i = 0; i < PBQ_EQ_BAND_HZ.length; i++) {
      var filter = audioCtx.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = PBQ_EQ_BAND_HZ[i];
      filter.Q.value = 1.1;
      filter.gain.value = 0;
      cursor.connect(filter);
      cursor = filter;
      filters.push(filter);
    }
    cursor.connect(destination);
    pbqToneIn = head;
    pbqPreampNode = head;
    pbqFilterNodes = filters;
    pbqToneOut = cursor;
    pbqToneCtx = audioCtx;
    applyPlaybackToneChain(0);
    return pbqToneIn;
  } catch (err) {
    console.warn('tone chain unavailable:', err && (err.message || err));
    releasePlaybackToneChain();
    return null;
  }
}

// The last hop out of a graph: the output gain of whichever path is currently
// audible — the main element, or a cuefield-prepared one during a crossfade.
// The node's outgoing connections are cleared first, because a graph that is
// rewired twice would drive the chain at double level and sound like an
// unexplained +6 dB jump.
function connectPlaybackOutputHop(fromNode, destination) {
  if (!fromNode || !destination) return false;
  var toneIn = ensurePlaybackToneChain(destination);
  try { fromNode.disconnect(); } catch (e) { }
  if (toneIn) {
    try {
      fromNode.connect(toneIn);
      pbqToneAvailable = true;
      return true;
    } catch (err) { }
  }
  pbqToneAvailable = false;
  try { fromNode.connect(destination); } catch (e) { return false; }
  return false;
}

function releasePlaybackToneChain() {
  var nodes = [pbqToneIn, pbqPreampNode, pbqToneOut].concat(pbqFilterNodes);
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (!node) continue;
    try { node.disconnect(); } catch (e) { }
  }
  pbqToneIn = null;
  pbqToneOut = null;
  pbqPreampNode = null;
  pbqFilterNodes = [];
  pbqToneCtx = null;
  pbqToneAvailable = false;
}

function setPlaybackEqBand(index, db, silent) {
  index = Number(index);
  if (!(index >= 0 && index < playbackEqGains.length)) return 0;
  var next = normalizePlaybackEqGain(db);
  playbackEqGains[index] = next;
  savePlaybackQualityPreference();
  applyPlaybackToneChain(0);
  syncPlaybackQualityUi();
  if (!silent && typeof showToast === 'function') {
    showToast('EQ ' + PBQ_EQ_BAND_LABELS[index] + 'Hz ' + (next > 0 ? '+' : '') + next + ' dB');
  }
  return next;
}

function setPlaybackPreamp(db, silent) {
  var next = normalizePlaybackPreamp(db);
  playbackPreampDb = next;
  savePlaybackQualityPreference();
  applyPlaybackToneChain(0);
  syncPlaybackQualityUi();
  if (!silent && typeof showToast === 'function') {
    showToast('Preamp ' + (next > 0 ? '+' : '') + next + ' dB');
  }
  return next;
}

function togglePlaybackEqualizer() {
  playbackEqualizerOn = !playbackEqualizerOn;
  savePlaybackQualityPreference();
  applyPlaybackToneChain(0);
  syncPlaybackQualityUi();
  if (typeof showToast === 'function') showToast('Equaliser ' + (playbackEqualizerOn ? 'on' : 'off'));
  return playbackEqualizerOn;
}

function togglePlaybackNormalise() {
  playbackNormaliseOn = !playbackNormaliseOn;
  savePlaybackQualityPreference();
  applyPlaybackToneChain(playbackNormaliseOn ? PBQ_NORM_RAMP_MS : 0);
  syncPlaybackQualityUi();
  if (typeof showToast === 'function') {
    showToast('Volume normalisation ' + (playbackNormaliseOn ? 'on' : 'off'));
  }
  return playbackNormaliseOn;
}

function togglePlaybackGaplessDefault() {
  playbackGaplessDefaultOn = !playbackGaplessDefaultOn;
  if (typeof albumGaplessState !== 'undefined' && albumGaplessState) {
    albumGaplessState.defaultEnabled = playbackGaplessDefaultOn;
    if (!playbackGaplessDefaultOn && albumGaplessState.enabled) {
      // Turning the default off must also drop the album that is currently
      // held open, or the switch would look dead until the next track.
      if (typeof clearAlbumGaplessPreload === 'function') clearAlbumGaplessPreload('album-gapless-default-off');
      albumGaplessState.enabled = false;
      albumGaplessState.albumKey = '';
      albumGaplessState.disabledAlbumKey = '';
    }
  }
  savePlaybackQualityPreference();
  syncPlaybackQualityUi();
  if (typeof showToast === 'function') {
    showToast('Gapless albums ' + (playbackGaplessDefaultOn ? 'on' : 'off'));
  }
  return playbackGaplessDefaultOn;
}

var PBQ_EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0],
  bass: [7, 5, 2, 0, 0, -1, -2],
  vocal: [-3, -2, 1, 4, 4, 1, -1],
  bright: [-2, -1, 0, 1, 3, 5, 6],
  // A mild bass and treble lift with a slight mid dip — the classic loudness
  // contour, kept under +6 dB so it cannot push the output into clipping.
  loudness: [5, 3, 0, -2, 0, 3, 5]
};

function applyPlaybackEqPreset(name, silent) {
  var preset = PBQ_EQ_PRESETS[String(name || '').toLowerCase()];
  if (!preset) return null;
  playbackEqGains = normalizePlaybackEqBandList(preset);
  if (!playbackEqualizerOn) playbackEqualizerOn = true;
  savePlaybackQualityPreference();
  applyPlaybackToneChain(0);
  syncPlaybackQualityUi();
  if (!silent && typeof showToast === 'function') showToast('EQ preset: ' + String(name).toLowerCase());
  return playbackEqGains.slice();
}

// ---- loudness measurement -------------------------------------------------

function playbackNormTrackKey(song) {
  song = song || null;
  try {
    if (song && typeof queueItemKey === 'function') {
      var key = queueItemKey(song);
      if (key) return String(key);
    }
  } catch (e) { }
  if (!song) return '';
  return String(song.id || song.videoId || song.localKey || (song.name + '|' + song.artist));
}

function playbackNormCacheLoad() {
  if (pbqNormCache) return pbqNormCache;
  try {
    var raw = JSON.parse(localStorage.getItem(PBQ_NORM_STORE_KEY) || '{}') || {};
    pbqNormCache = (typeof raw === 'object' && raw) ? raw : {};
  } catch (e) {
    pbqNormCache = {};
  }
  return pbqNormCache;
}

function playbackNormCacheSave() {
  try {
    localStorage.setItem(PBQ_NORM_STORE_KEY, JSON.stringify(pbqNormCache || {}));
  } catch (e) { }
}

function playbackNormCachePut(key, db) {
  if (!key) return;
  var cache = playbackNormCacheLoad();
  // Re-insert so the key moves to the end: insertion order is the eviction
  // order, which keeps recently played tracks measured.
  delete cache[key];
  cache[key] = db;
  var keys = Object.keys(cache);
  if (keys.length > PBQ_NORM_CACHE_LIMIT) {
    for (var i = 0; i < keys.length - PBQ_NORM_CACHE_LIMIT; i++) delete cache[keys[i]];
  }
  playbackNormCacheSave();
}

function playbackNormGainFromRms(rms) {
  var value = Number(rms);
  if (!(value > 0)) return 0;
  var db = 20 * Math.log(value) / Math.LN10;
  var delta = PBQ_NORM_TARGET_DB - db;
  // Cut only — see the file header.
  if (!(delta < 0)) return 0;
  return Math.max(PBQ_NORM_MAX_CUT_DB, Math.round(delta * 2) / 2);
}

function finishPlaybackLoudnessMeasurement(applyToGraph) {
  if (!pbqNorm.active) return 0;
  pbqNorm.active = false;
  pbqNorm.measuring = false;
  if (pbqNorm.count > 0) {
    var meanSquare = pbqNorm.sum / pbqNorm.count;
    var rms = Math.sqrt(Math.max(0, meanSquare));
    var db = playbackNormGainFromRms(rms);
    pbqNorm.gainDb = db;
    if (pbqNorm.key) playbackNormCachePut(pbqNorm.key, db);
    if (applyToGraph !== false) applyPlaybackToneChain(PBQ_NORM_RAMP_MS);
    syncPlaybackQualityUi();
    return db;
  }
  return 0;
}

function beginPlaybackLoudnessMeasurement(song) {
  var key = playbackNormTrackKey(song);
  var cache = playbackNormCacheLoad();
  var cached = key && Object.prototype.hasOwnProperty.call(cache, key) ? Number(cache[key]) : null;
  pbqNorm.key = key;
  pbqNorm.sum = 0;
  pbqNorm.count = 0;
  pbqNorm.startAt = performance.now();
  if (cached != null && isFinite(cached)) {
    // Known track: settle at the stored level at once and do not touch it
    // again mid-play — a level that jumps halfway through a song is worse
    // than one that is a few tenths of a dB out.
    pbqNorm.gainDb = cached;
    pbqNorm.active = false;
    pbqNorm.measuring = false;
    applyPlaybackToneChain(0);
    return cached;
  }
  pbqNorm.gainDb = 0;
  pbqNorm.active = true;
  pbqNorm.measuring = true;
  applyPlaybackToneChain(0);
  return 0;
}

function trackPlaybackLoudnessSample(rms) {
  if (!pbqNorm.active) return 0;
  var value = Number(rms);
  if (!(value > 0)) return 0;
  var now = performance.now();
  pbqNorm.sum += value * value;
  pbqNorm.count++;
  if (now - pbqNorm.startAt >= PBQ_NORM_WINDOW_MS && pbqNorm.count >= PBQ_NORM_MIN_SAMPLES) {
    return finishPlaybackLoudnessMeasurement(true);
  }
  return 0;
}

// ---- UI -------------------------------------------------------------------

function pbqElement(id) {
  return document.getElementById(id);
}

function syncSleepTimerStatus() {
  var el = pbqElement('pbq-sleep-status');
  if (el) el.textContent = sleepTimerLabel();
}

function syncPlaybackQualityUi() {
  if (typeof document === 'undefined' || !document.getElementById) return;
  var speedSeg = pbqElement('pbq-speed-seg');
  if (speedSeg) {
    speedSeg.querySelectorAll('[data-pbq-speed]').forEach(function (btn) {
      btn.classList.toggle('active', normalizePlaybackSpeed(btn.getAttribute('data-pbq-speed')) === playbackSpeedValue);
    });
  }
  var sleepSeg = pbqElement('pbq-sleep-seg');
  if (sleepSeg) {
    sleepSeg.querySelectorAll('[data-pbq-sleep]').forEach(function (btn) {
      btn.classList.toggle('active', normalizeSleepTimerMode(btn.getAttribute('data-pbq-sleep')) === sleepTimerMode);
    });
  }
  syncSleepTimerStatus();

  var eqToggle = pbqElement('t-pbqEqualizer');
  if (eqToggle) eqToggle.classList.toggle('on', playbackEqualizerOn === true);
  var normToggle = pbqElement('t-pbqNormalise');
  if (normToggle) normToggle.classList.toggle('on', playbackNormaliseOn === true);
  var gapToggle = pbqElement('t-pbqGapless');
  if (gapToggle) gapToggle.classList.toggle('on', playbackGaplessDefaultOn === true);

  var preamp = pbqElement('pbq-preamp');
  if (preamp && Math.abs(Number(preamp.value) - playbackPreampDb) > 0.001) preamp.value = playbackPreampDb;
  var preampOut = pbqElement('pbq-preamp-value');
  if (preampOut) preampOut.textContent = (playbackPreampDb > 0 ? '+' : '') + playbackPreampDb + ' dB';

  var bandInputs = document.querySelectorAll('[data-pbq-band]');
  bandInputs.forEach(function (input) {
    var index = Number(input.getAttribute('data-pbq-band'));
    var db = playbackEqGains[index] || 0;
    if (Math.abs(Number(input.value) - db) > 0.001) input.value = db;
    var out = input.parentNode ? input.parentNode.querySelector('output') : null;
    if (out) out.textContent = (db > 0 ? '+' : '') + db;
  });

  var presetSeg = pbqElement('pbq-eq-preset-seg');
  if (presetSeg) {
    presetSeg.querySelectorAll('[data-pbq-preset]').forEach(function (btn) {
      var wanted = PBQ_EQ_PRESETS[btn.getAttribute('data-pbq-preset')];
      var matches = !!wanted && wanted.length === playbackEqGains.length && wanted.every(function (v, i) {
        return Math.abs(v - playbackEqGains[i]) < 0.01;
      });
      btn.classList.toggle('active', matches);
    });
  }

  var status = pbqElement('pbq-status');
  if (status) {
    var parts = [];
    if (playbackEqualizerOn) {
      if (pbqToneIn) {
        parts.push('Equaliser live (' + PBQ_EQ_BAND_HZ.length + ' bands, preamp ' +
          (playbackPreampDb > 0 ? '+' : '') + playbackPreampDb + ' dB)');
      } else if (typeof audioReady !== 'undefined' && audioReady) {
        // A graph exists but has no tone stage: the capture-stream fallback
        // routes around Web Audio's output, so there is nothing to filter.
        parts.push('Equaliser set, but this audio path has no tone stage');
      } else {
        parts.push('Equaliser set — engages on the first track');
      }
    } else {
      parts.push('Equaliser off');
    }
    if (playbackNormaliseOn) {
      parts.push(pbqNorm.measuring
        ? 'measuring this track…'
        : 'normalising ' + (pbqNorm.gainDb ? (pbqNorm.gainDb > 0 ? '+' : '') + pbqNorm.gainDb + ' dB' : 'at unity — no cut needed'));
    } else {
      parts.push('normalisation off');
    }
    status.textContent = parts.join(' · ');
  }
}

function bindPlaybackQualityControls() {
  var speedSeg = pbqElement('pbq-speed-seg');
  if (speedSeg && !speedSeg.__pbqBound) {
    speedSeg.__pbqBound = true;
    speedSeg.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-pbq-speed]') : null;
      if (!btn || !speedSeg.contains(btn)) return;
      setPlaybackSpeed(btn.getAttribute('data-pbq-speed'));
    });
  }
  var sleepSeg = pbqElement('pbq-sleep-seg');
  if (sleepSeg && !sleepSeg.__pbqBound) {
    sleepSeg.__pbqBound = true;
    sleepSeg.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-pbq-sleep]') : null;
      if (!btn || !sleepSeg.contains(btn)) return;
      setSleepTimerMode(btn.getAttribute('data-pbq-sleep'));
    });
  }
  var preamp = pbqElement('pbq-preamp');
  if (preamp && !preamp.__pbqBound) {
    preamp.__pbqBound = true;
    preamp.addEventListener('input', function () { setPlaybackPreamp(preamp.value, true); });
    preamp.addEventListener('change', function () { setPlaybackPreamp(preamp.value, false); });
  }
  var bandInputs = document.querySelectorAll('[data-pbq-band]');
  bandInputs.forEach(function (input) {
    if (input.__pbqBound) return;
    input.__pbqBound = true;
    input.addEventListener('input', function () {
      setPlaybackEqBand(input.getAttribute('data-pbq-band'), input.value, true);
    });
    input.addEventListener('change', function () {
      setPlaybackEqBand(input.getAttribute('data-pbq-band'), input.value, false);
    });
  });
  var presetSeg = pbqElement('pbq-eq-preset-seg');
  if (presetSeg && !presetSeg.__pbqBound) {
    presetSeg.__pbqBound = true;
    presetSeg.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-pbq-preset]') : null;
      if (!btn || !presetSeg.contains(btn)) return;
      applyPlaybackEqPreset(btn.getAttribute('data-pbq-preset'));
    });
  }
}

function installPlaybackQuality() {
  var prefs = readPlaybackQualityPreference();
  playbackSpeedValue = prefs.speed;
  playbackEqualizerOn = prefs.equalizer;
  playbackNormaliseOn = prefs.normalise;
  playbackGaplessDefaultOn = prefs.gapless;
  playbackPreampDb = prefs.preamp;
  playbackEqGains = prefs.eq;
  if (typeof albumGaplessState !== 'undefined' && albumGaplessState) {
    albumGaplessState.defaultEnabled = playbackGaplessDefaultOn;
  }
  bindPlaybackQualityControls();
  applyPlaybackSpeed();
  syncPlaybackQualityUi();
}

installPlaybackQuality();
