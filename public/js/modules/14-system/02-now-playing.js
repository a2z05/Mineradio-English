// ============================================================
//  EN-FORK — Now Playing.
//
//  What this is not, first, because the reference players all do the opposite:
//
//  1. It is not a second stage. Mineradio's 3D stage is the visualizer; a Now
//     Playing screen that renders its own cover spin and its own bars is a
//     second player wearing a player's clothes. The stage stays the visualizer.
//     What is added here is the strip of live spectrum directly under the cover,
//     drawn from the analyser the stage already samples — no extra audio graph,
//     no extra WebGL context, no second render loop.
//
//  2. It is not a clone. The panel is a right-hand sheet in the same glass,
//     gold and type as the playlist panel. Mineradio's identity is a stage with
//     a console at the bottom; this adds a readable panel to the side of it and
//     changes nothing about how the stage looks.
//
//  It reads the same state the console reads. It never writes playQueue,
//  currentIdx or playing; every control on it calls the function the console
//  button next to it calls.
// ============================================================

var NOW_PLAYING_STORE_KEY = 'mineradio-now-playing-v1';
var NOW_PLAYING_SPECTRUM_BINS = 40;
var nowPlayingOpen = false;
var nowPlayingBound = false;
var nowPlayingCanvas = null;
var nowPlayingCtx = null;
var nowPlayingSeeded = false;
var nowPlayingDragging = false;
var nowPlayingSpectrumBins = null;

// ---------------------------------------------------------- open / close

function nowPlayingPanel() {
  return document.getElementById('now-playing-panel');
}

function readNowPlayingPref() {
  try { return localStorage.getItem(NOW_PLAYING_STORE_KEY) === '1'; } catch (e) { return false; }
}

function writeNowPlayingPref(on) {
  try { localStorage.setItem(NOW_PLAYING_STORE_KEY, on ? '1' : '0'); } catch (e) { }
}

function nowPlayingShellPresent() {
  return typeof nowPlayingPanel === 'function' && !!nowPlayingPanel()
    && typeof document !== 'undefined' && !!document.body;
}

// Puts the page into whichever state `nowPlayingOpen` says it is in. Everything
// the sheet needs on screen is derived from that one flag, so opening is
// opening and booting with a remembered preference is the same code path.
function applyNowPlayingShellState() {
  if (!nowPlayingShellPresent()) return false;
  var panel = nowPlayingPanel();
  if (nowPlayingOpen) {
    panel.hidden = false;
    // One frame between display and the transition, or the sheet simply
    // appears instead of sliding.
    window.requestAnimationFrame(function () { panel.classList.add('open'); });
    document.body.classList.add('now-playing-open');
    paintNowPlaying();
    // The queue popover and the sheet fight for the same corner. The sheet
    // wins — it is the one that was deliberately opened.
    if (typeof closeMiniQueue === 'function' && miniQueueOpen) closeMiniQueue();
  } else {
    panel.classList.remove('open');
    document.body.classList.remove('now-playing-open');
    window.setTimeout(function () {
      if (nowPlayingOpen || !panel) return;
      panel.hidden = true;
      nowPlayingReleaseCanvas();
    }, 320);
  }
  updateNowPlayingChips();
  return true;
}

function openNowPlaying() {
  if (nowPlayingOpen) return;
  if (!nowPlayingShellPresent()) {
    // The markup is missing rather than late: installNowPlaying() will have
    // said so once already.
    return;
  }
  nowPlayingOpen = true;
  writeNowPlayingPref(true);
  applyNowPlayingShellState();
}

function closeNowPlaying() {
  if (!nowPlayingOpen) return;
  nowPlayingOpen = false;
  writeNowPlayingPref(false);
  if (!nowPlayingShellPresent()) return;
  applyNowPlayingShellState();
}

function toggleNowPlaying() {
  if (nowPlayingOpen) closeNowPlaying();
  else openNowPlaying();
}

// Called by openTrackDetailModal and closeTrackDetailModal. A second, named
// entry point so those two can call it without knowing the sheet's internals —
// and so nothing else has an excuse to reach into them.
function closeNowPlayingAfterTrackDetail() {
  closeNowPlaying();
}

// ---------------------------------------------------------- paint

function nowPlayingSong() {
  if (typeof playQueue !== 'undefined' && playQueue && currentIdx >= 0 && playQueue[currentIdx]) {
    return playQueue[currentIdx];
  }
  if (typeof currentLocalSong !== 'undefined' && currentLocalSong) return currentLocalSong;
  return null;
}

function nowPlayingArtwork(song) {
  // Same priority as the console: whatever the stage resolved is what the panel
  // shows, so switching the cover on the stage switches it here for free.
  var control = document.getElementById('control-cover');
  var inline = control && control.style && control.style.backgroundImage;
  var match = inline && /url\("(.+?)"\)/.exec(inline);
  if (match && match[1]) return match[1];
  var direct = song && (song.coverUrl || song.cover || song.albumCover || song.image);
  return direct ? String(direct) : '';
}

function nowPlayingDeclaredDuration() {
  var song = nowPlayingSong();
  var seconds = Number(song && (song.durationSec || song.duration)) || 0;
  if (!(seconds > 0) && typeof songDurationLabel === 'function' && song) {
    var parsed = /\b(\d{1,2}):(\d{2})\b/.exec(songDurationLabel(song) || '');
    if (parsed) seconds = Number(parsed[1]) * 60 + Number(parsed[2]);
  }
  return seconds > 0 && isFinite(seconds) ? seconds : 0;
}

function paintNowPlaying() {
  if (!nowPlayingOpen) return;
  var song = nowPlayingSong();
  var title = document.getElementById('now-playing-title');
  var artist = document.getElementById('now-playing-artist');
  var album = document.getElementById('now-playing-album');
  var source = document.getElementById('now-playing-source');
  var cover = document.getElementById('now-playing-cover');
  var has = !!(song && song.name);

  if (title) title.textContent = has ? song.name : 'Nothing playing';
  if (artist) artist.textContent = has ? (song.artist || '') : '';
  if (album) album.textContent = has ? (song.album || '') : '';
  if (source) {
    // The provider tag is the same markup the console uses, stripped of its own
    // click handlers — the panel's buttons are already buttons.
    var tag = '';
    if (has && typeof songSourceTagHtml === 'function') {
      tag = String(songSourceTagHtml(song) || '').replace(/\son\w+\s*=\s*"[^"]*"/gi, '').trim();
    }
    source.innerHTML = tag;
  }
  if (cover) {
    var art = nowPlayingArtwork(song);
    if (art) {
      cover.style.backgroundImage = 'url("' + art.replace(/"/g, '\\"') + ')';
      cover.classList.remove('cover-empty');
    } else {
      cover.style.backgroundImage = '';
      cover.classList.add('cover-empty');
    }
  }
  paintNowPlayingTransport();
  paintNowPlayingProgress();
  updateNowPlayingChips();
}

function paintNowPlayingTransport() {
  if (!nowPlayingOpen) return;
  var isPlaying = typeof playing !== 'undefined' && !!playing;
  var icon = document.getElementById('now-playing-play-icon');
  if (icon) {
    icon.innerHTML = isPlaying
      ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
      : '<path d="M8 5v14l11-7z"/>';
  }
  var play = document.getElementById('now-playing-play');
  if (play) {
    play.title = isPlaying ? 'Pause' : 'Play';
    play.setAttribute('aria-label', play.title);
  }
  var mode = document.getElementById('now-playing-mode');
  var modeIcon = document.getElementById('now-playing-mode-icon');
  if (mode && typeof playModeLabel === 'function') {
    var label = playModeLabel(playMode);
    mode.title = label;
    mode.setAttribute('aria-label', label);
    mode.classList.toggle('active', playMode !== 'loop');
  }
  if (modeIcon && typeof playModeIconMarkup === 'function') {
    modeIcon.innerHTML = playModeIconMarkup(playMode);
  }
  var like = document.getElementById('now-playing-like');
  if (like) {
    var liked = false;
    try {
      liked = typeof isSongLiked === 'function' ? !!isSongLiked(nowPlayingSong()) : false;
    } catch (e) { }
    like.classList.toggle('liked', liked);
    like.setAttribute('aria-pressed', liked ? 'true' : 'false');
    like.title = liked ? 'Remove from favourites' : 'Add to favourites';
  }
}

function updateNowPlayingChips() {
  if (typeof document === 'undefined') return;
  var entry = document.getElementById('now-playing-btn');
  if (entry) {
    entry.classList.toggle('active', nowPlayingOpen);
    entry.setAttribute('aria-pressed', nowPlayingOpen ? 'true' : 'false');
  }
  var lyrics = document.getElementById('now-playing-lyrics');
  if (lyrics && typeof fx !== 'undefined' && fx) {
    lyrics.classList.toggle('active', !!fx.particleLyrics);
  }
  var queue = document.getElementById('now-playing-queue');
  if (queue) queue.classList.toggle('active', typeof miniQueueOpen !== 'undefined' && !!miniQueueOpen);
}

function paintNowPlayingProgress() {
  if (!nowPlayingOpen || nowPlayingDragging) return;
  var fill = document.getElementById('now-playing-progress-fill');
  var track = document.getElementById('now-playing-progress');
  var elapsed = document.getElementById('now-playing-elapsed');
  var remaining = document.getElementById('now-playing-remaining');
  if (!fill) return;

  var duration = 0;
  var current = 0;
  try {
    if (typeof getPlaybackDurationSeconds === 'function') duration = getPlaybackDurationSeconds();
    if (typeof getPlaybackCurrentSeconds === 'function') current = getPlaybackCurrentSeconds();
  } catch (e) { }
  // Same rule as the console and the compact player: the element's clock wins
  // when it has one, the queue row is the duration that was known to be
  // playable when it does not.
  if (!(duration > 0)) duration = nowPlayingDeclaredDuration();

  var pct = duration > 0 ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;
  fill.style.width = pct + '%';
  if (track) {
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(Math.round(duration || 0)));
    track.setAttribute('aria-valuenow', String(Math.round(current || 0)));
  }
  var fmt = typeof formatProgramTime === 'function'
    ? function (sec) { return formatProgramTime(sec); }
    : function (sec) {
      var s = Math.max(0, Math.floor(Number(sec) || 0));
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    };
  if (elapsed) elapsed.textContent = fmt(current);
  // Counted down, not counted up: what a listener wants to know is how long is
  // left, and "-1:24" answers that where "3:36" of a 5:00 does not.
  if (remaining) remaining.textContent = duration > 0 ? '-' + fmt(Math.max(0, duration - current)) : '--:--';
}

// ---------------------------------------------------------- spectrum

// The strip is drawn from beatFrequencyData, not from its own analyser: the
// main loop refills that array several times a frame and it is already FFT_SIZE
// long. Reading it costs one typed-array copy.
function nowPlayingSeedSpectrum() {
  nowPlayingSeeded = true;
  var bins = NOW_PLAYING_SPECTRUM_BINS;
  nowPlayingSpectrumBins = new Uint8Array(bins);
  if (!nowPlayingCanvas || !nowPlayingCtx) return;
  // The backing store is dpr-scaled; the stylesheet still owns the CSS size, so
  // nothing is written to style.width here. Doing that would win against the
  // rule and double the strip on a high-dpi screen.
  nowPlayingCtx.clearRect(0, 0, nowPlayingCanvas.width, nowPlayingCanvas.height);
}

function paintNowPlayingSpectrum() {
  if (!nowPlayingOpen) return;
  if (!nowPlayingCanvas || !nowPlayingCtx) {
    nowPlayingCanvas = document.getElementById('now-playing-spectrum');
    if (!nowPlayingCanvas || !nowPlayingCanvas.getContext) return;
    var rect = nowPlayingCanvas.getBoundingClientRect();
    var dpr = Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1));
    nowPlayingCanvas.width = Math.max(40, Math.round((rect.width || 180) * dpr));
    nowPlayingCanvas.height = Math.max(16, Math.round((rect.height || 30) * dpr));
    try { nowPlayingCtx = nowPlayingCanvas.getContext('2d'); } catch (e) { nowPlayingCtx = null; }
    if (!nowPlayingCtx) return;
    nowPlayingSeeded = false;
  }
  if (!nowPlayingSeeded) nowPlayingSeedSpectrum();
  if (!nowPlayingCtx || !nowPlayingSpectrumBins) return;

  var bins = nowPlayingSpectrumBins;
  var source = typeof beatFrequencyData !== 'undefined' && beatFrequencyData && beatFrequencyData.length
    ? beatFrequencyData
    : (typeof frequencyData !== 'undefined' && frequencyData.length ? frequencyData : null);
  var count = bins.length;
  if (source) {
    // Log-ish grouping: the FFT bins are linear in frequency, so evenly spaced
    // bars would put two thirds of them above 5 kHz where nothing lives.
    var usable = source.length;
    var band = Math.floor(usable / count);
    for (var i = 0; i < count; i += 1) {
      var from = Math.floor(i * usable / count);
      var to = Math.max(from + 1, Math.floor((i + 1) * usable / count));
      var peak = 0;
      // Bands are wide at the top, so one sample per bin would make the right
      // half flicker. Take the peak of a few samples instead of the first.
      var step = Math.max(1, Math.floor(band / 3));
      for (var j = from; j < to && j < usable; j += step) {
        if (source[j] > peak) peak = source[j];
      }
      bins[i] = peak;
    }
  } else {
    for (var k = 0; k < count; k += 1) bins[k] = 0;
  }

  var ctx = nowPlayingCtx;
  var w = nowPlayingCanvas.width;
  var h = nowPlayingCanvas.height;
  ctx.clearRect(0, 0, w, h);
  var barW = Math.max(1, Math.floor((w / count) * 0.56));
  var gap = Math.max(1, Math.floor((w / count) * 0.44));
  // A floor, so a pause or a track that has not opened yet shows a flat line
  // rather than a blank strip. A visualizer that vanishes when it has nothing
  // to say looks broken.
  for (var b = 0; b < count; b += 1) {
    var value = bins[b] / 255;
    var level = 0.06 + value * 0.94;
    var barH = Math.max(2, Math.round(level * h));
    var x = b * (barW + gap);
    var grad = ctx.createLinearGradient(0, h, 0, h - barH);
    grad.addColorStop(0, 'rgba(244, 210, 138, .34)');
    grad.addColorStop(1, '#f4d28a');
    ctx.fillStyle = grad;
    ctx.fillRect(x, h - barH, barW, barH);
  }
}

function nowPlayingReleaseCanvas() {
  // The 2D context is only released with the panel; a canvas kept alive by a
  // closed panel is a few hundred KB held for nothing.
  if (nowPlayingCanvas) nowPlayingCanvas.width = 1;
  if (nowPlayingCanvas) nowPlayingCanvas.height = 1;
  nowPlayingCanvas = null;
  nowPlayingCtx = null;
  nowPlayingSpectrumBins = null;
  nowPlayingSeeded = false;
}

// ---------------------------------------------------------- seeking

function nowPlayingSeekFromEvent(event) {
  var track = document.getElementById('now-playing-progress');
  if (!track || !event) return;
  var rect = track.getBoundingClientRect();
  if (!rect || !rect.width) return;
  var ratio = Math.max(0, Math.min(1, ((event.clientX || 0) - rect.left) / rect.width));
  var fill = document.getElementById('now-playing-progress-fill');
  if (fill) fill.style.width = (ratio * 100) + '%';

  var duration = 0;
  try {
    if (typeof getPlaybackDurationSeconds === 'function') duration = getPlaybackDurationSeconds();
  } catch (e) { }
  if (!(duration > 0)) duration = nowPlayingDeclaredDuration();
  var target = ratio * duration;
  track.setAttribute('aria-valuenow', String(Math.round(target)));
  if (typeof audio !== 'undefined' && audio && audio.src && duration > 0) {
    try { audio.currentTime = Math.max(0, Math.min(duration - 0.05, target)); } catch (e) { }
    if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
  }
  paintNowPlayingProgress();
}

function bindNowPlayingSeek() {
  if (!nowPlayingShellPresent()) return;
  var track = document.getElementById('now-playing-progress');
  if (!track || track._mineradioNowPlayingSeekBound) return;
  track._mineradioNowPlayingSeekBound = true;

  track.addEventListener('pointerdown', function (event) {
    nowPlayingDragging = true;
    track.classList.add('dragging');
    if (track.setPointerCapture && event.pointerId != null) {
      try { track.setPointerCapture(event.pointerId); } catch (e) { }
    }
    nowPlayingSeekFromEvent(event);
    event.preventDefault();
  });
  track.addEventListener('pointermove', function (event) {
    if (!nowPlayingDragging) return;
    nowPlayingSeekFromEvent(event);
  });
  ['pointerup', 'pointercancel'].forEach(function (name) {
    // On window, not on the bar: a release outside the window never reaches the
    // element, and a seek flag left set would freeze the panel's clock.
    window.addEventListener(name, function () {
      if (!nowPlayingDragging) return;
      nowPlayingDragging = false;
      track.classList.remove('dragging');
      paintNowPlayingProgress();
    });
  });
  track.addEventListener('keydown', function (event) {
    if (typeof audio === 'undefined' || !audio || !audio.src) return;
    var step = event.shiftKey ? 30 : 5;
    if (event.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - step);
    else if (event.key === 'ArrowRight') audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + step);
    else return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
    paintNowPlayingProgress();
  });
}

// ---------------------------------------------------------- install

// The shell is markup that ships with the app, so a missing panel means the
// markup was never parsed — a half-loaded index.html, a stripped build, a
// preview server serving a stale file. The symptom would otherwise be one dead
// button and no other trace. `installNowPlaying()` is called from two places
// (its own body and the tail of index.html), so the notice goes out once.
var nowPlayingMissingShellWarned = false;

function installNowPlaying() {
  if (nowPlayingBound) return;
  nowPlayingBound = true;
  if (!nowPlayingShellPresent()) {
    if (!nowPlayingMissingShellWarned && typeof showToast === 'function') {
      nowPlayingMissingShellWarned = true;
      showToast('Now playing panel failed to load');
    }
    return;
  }
  bindNowPlayingSeek();
  applyNowPlayingShellState();
  // The panel paints from queue state that is hydrated asynchronously, so a
  // first paint is a guess and the real one arrives with the first track.
  setTimeout(function () { if (nowPlayingOpen) paintNowPlaying(); }, 0);
  setTimeout(function () { if (nowPlayingOpen) paintNowPlaying(); }, 1500);
  if (readNowPlayingPref()) {
    // Restored: the sheet opens the way the user left it. The same flag drives
    // it, so booting open and clicking the button cannot land in different
    // states.
    nowPlayingOpen = true;
    applyNowPlayingShellState();
  }
}

// Installed by its own body — see the playback guard for why.
installNowPlaying();