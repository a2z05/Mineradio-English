// ============================================================
//  EN-FORK — the compact player.
//
//  Two decisions worth stating, because both are the opposite of what the
//  reference players do and both are deliberate:
//
//  1. It is NOT a second BrowserWindow. A second window wants a second WebGL
//     context on the same GPU, and Mineradio's stage already owns one. A
//     compact player that costs 3D performance to exist is not a feature. So
//     it lives inside the main window.
//
//  2. It is NOT a second player. Everything it shows — the track, the elapsed
//     time, the play state, the like — is read from the same state the bottom
//     bar already renders. It hides the bar and draws the same truth smaller.
//     A duplicated transport is a transport that eventually disagrees with
//     itself.
//
//  It persists across a restart, because the reason to use it is that the
//  window is normally fullscreen and the controls live behind other windows.
// ============================================================

var MINI_PLAYER_STORE_KEY = 'mineradio-mini-player-v1';
var miniPlayerOpen = false;
var miniPlayerRestoreVisible = true;
var miniPlayerBound = false;
var miniPlayerSeekDragging = false;

function miniPlayerElement() {
  return document.getElementById('mini-player');
}

function readMiniPlayerPref() {
  try { return localStorage.getItem(MINI_PLAYER_STORE_KEY) === '1'; } catch (e) { return false; }
}

function writeMiniPlayerPref(on) {
  try { localStorage.setItem(MINI_PLAYER_STORE_KEY, on ? '1' : '0'); } catch (e) { }
}

function miniPlayerSong() {
  if (typeof playQueue !== 'undefined' && playQueue && currentIdx >= 0 && playQueue[currentIdx]) {
    return playQueue[currentIdx];
  }
  if (typeof currentLocalSong !== 'undefined' && currentLocalSong) return currentLocalSong;
  return null;
}

// The number the console shows is not the media element's clock: a track that
// failed to open, or a provider that never reported a duration, would otherwise
// read 0:00 while the stage is clearly playing it. The queue row is the thing
// that was known to be playable when it was added, so it is the thing the
// compact transport shows.
function miniPlayerDeclaredDuration() {
  var song = miniPlayerSong();
  var seconds = Number(song && (song.durationSec || song.duration)) || 0;
  if (!(seconds > 0) && typeof songDurationLabel === 'function' && song) {
    var parsed = /\b(\d{1,2}):(\d{2})\b/.exec(songDurationLabel(song) || '');
    if (parsed) seconds = Number(parsed[1]) * 60 + Number(parsed[2]);
  }
  return seconds > 0 && isFinite(seconds) ? seconds : 0;
}

// ---------------------------------------------------------- open / close

function enterMiniPlayer() {
  miniPlayerOpen = true;
  writeMiniPlayerPref(true);
  // Remember whether the console was up so leaving the mini player puts the
  // stage back the way it was found, rather than always dropping the controls.
  var bar = document.getElementById('bottom-bar');
  miniPlayerRestoreVisible = !!(bar && bar.classList.contains('visible'));
  var root = miniPlayerElement();
  if (root) {
    root.hidden = false;
    // One frame between display and the transition, or the slide is skipped
    // and the player simply appears.
    window.requestAnimationFrame(function () { root.classList.add('open'); });
  }
  if (bar) bar.classList.remove('visible', 'soft-hidden');
  document.body.classList.add('mini-player-mode');
  paintMiniPlayer();
  syncMiniPlayerButtons();
}

function exitMiniPlayer() {
  miniPlayerOpen = false;
  writeMiniPlayerPref(false);
  var root = miniPlayerElement();
  if (root) {
    root.classList.remove('open');
    // Hidden after the slide, not before: display:none mid-transition cancels
    // it and the bar reappears on top of a player that never moved.
    window.setTimeout(function () {
      if (miniPlayerOpen || !root) return;
      root.hidden = true;
    }, 340);
  }
  document.body.classList.remove('mini-player-mode');
  if (miniPlayerRestoreVisible && typeof revealBottomControls === 'function') {
    revealBottomControls(360);
  }
  syncMiniPlayerButtons();
}

function toggleMiniPlayer() {
  if (miniPlayerOpen) exitMiniPlayer();
  else enterMiniPlayer();
}

function syncMiniPlayerButtons() {
  var entry = document.getElementById('mini-player-btn');
  if (entry) {
    entry.classList.toggle('active', miniPlayerOpen);
    entry.setAttribute('aria-pressed', miniPlayerOpen ? 'true' : 'false');
  }
  var exit = document.getElementById('mini-player-exit');
  if (exit) exit.classList.toggle('active', miniPlayerOpen);
}

// ---------------------------------------------------------- paint

function paintMiniPlayer() {
  var root = miniPlayerElement();
  if (!root || !miniPlayerOpen) return;
  var song = miniPlayerSong();
  var title = document.getElementById('mini-player-title');
  var artist = document.getElementById('mini-player-artist');
  var cover = document.getElementById('mini-player-cover');
  if (title) title.textContent = (song && song.name) || 'Nothing playing';
  if (artist) {
    var who = song && (song.artist || song.album);
    var src = song && typeof songSourceTagHtml === 'function' ? songSourceTagHtml(song) : '';
    artist.textContent = (who || '') + (src ? '  ' + src.replace(/<[^>]*>/g, '').trim() : '');
  }
  if (cover) {
    var art = (song && (song.coverUrl || song.cover)) || '';
    var control = document.getElementById('control-cover');
    var inline = control && control.style && control.style.backgroundImage;
    var match = inline && /url\("(.+?)"\)/.exec(inline);
    if (match && match[1]) art = match[1];
    if (art) {
      cover.style.backgroundImage = 'url("' + String(art).replace(/"/g, '\\"') + '")';
      cover.classList.remove('cover-empty');
    } else {
      cover.style.backgroundImage = '';
      cover.classList.add('cover-empty');
    }
  }
  paintMiniPlayerProgress();
  paintMiniPlayerHeart();
}

function paintMiniPlayerHeart() {
  var btn = document.getElementById('mini-player-heart');
  if (!btn) return;
  var liked = false;
  try {
    liked = typeof isSongLiked === 'function' ? !!isSongLiked(miniPlayerSong()) : false;
  } catch (e) { }
  btn.classList.toggle('liked', liked);
  btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
}

function paintMiniPlayerProgress() {
  var fill = document.getElementById('mini-player-progress-fill');
  if (!fill) return;
  if (miniPlayerSeekDragging) return;
  var duration = 0;
  var current = 0;
  try {
    // The element's clock is the truth about where the audio is, but it can be
    // absent — a track that failed to open, or a provider that never reported
    // a duration. The queue row is the duration that was known to be playable,
    // so it is what is shown when the element has none.
    if (typeof getPlaybackDurationSeconds === 'function') duration = getPlaybackDurationSeconds();
    if (typeof getPlaybackCurrentSeconds === 'function') current = getPlaybackCurrentSeconds();
  } catch (e) { }
  if (!(duration > 0)) duration = miniPlayerDeclaredDuration();
  var pct = duration > 0 ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;
  fill.style.width = pct + '%';
  var track = document.getElementById('mini-player-progress');
  if (track) {
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(Math.round(duration || 0)));
    track.setAttribute('aria-valuenow', String(Math.round(current || 0)));
  }
  if (!miniPlayerOpen) return;
  var clock = document.getElementById('mini-player-time');
  if (clock) {
    var elapsed = typeof formatProgramTime === 'function'
      ? formatProgramTime(current)
      : Math.floor(current / 60) + ':' + String(Math.floor(current % 60)).padStart(2, '0');
    clock.textContent = duration > 0
      ? elapsed + ' / ' + (typeof formatProgramTime === 'function' ? formatProgramTime(duration) : '0:00')
      : elapsed;
  }
}

// ---------------------------------------------------------- seeking

function miniPlayerSeekFromEvent(event) {
  var track = document.getElementById('mini-player-progress');
  if (!track || !event) return;
  var rect = track.getBoundingClientRect();
  if (!rect || !rect.width) return;
  var x = (event.clientX || 0) - rect.left;
  var ratio = Math.max(0, Math.min(1, x / rect.width));
  var fill = document.getElementById('mini-player-progress-fill');
  if (fill) fill.style.width = (ratio * 100) + '%';
  // Seek against the same duration the bar just drew, or the fill and the
  // position disagree whenever the element's clock is missing.
  var duration = 0;
  try {
    if (typeof getPlaybackDurationSeconds === 'function') duration = getPlaybackDurationSeconds();
  } catch (e) { }
  if (!(duration > 0)) duration = miniPlayerDeclaredDuration();
  var target = ratio * duration;
  track.setAttribute('aria-valuenow', String(Math.round(target)));
  if (typeof audio !== 'undefined' && audio && audio.src && duration > 0) {
    try { audio.currentTime = Math.max(0, Math.min(duration - 0.05, target)); } catch (e) { }
    if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
  }
  paintMiniPlayerProgress();
}

function bindMiniPlayerSeek() {
  var track = document.getElementById('mini-player-progress');
  if (!track || track._mineradioMiniSeekBound) return;
  track._mineradioMiniSeekBound = true;

  track.addEventListener('pointerdown', function (event) {
    miniPlayerSeekDragging = true;
    track.classList.add('dragging');
    if (track.setPointerCapture && event.pointerId != null) {
      try { track.setPointerCapture(event.pointerId); } catch (e) { }
    }
    miniPlayerSeekFromEvent(event);
    event.preventDefault();
  });
  track.addEventListener('pointermove', function (event) {
    if (!miniPlayerSeekDragging) return;
    miniPlayerSeekFromEvent(event);
  });
  ['pointerup', 'pointercancel'].forEach(function (name) {
    // On window, not on the bar. The bar takes pointer capture, and a release
    // outside the window (a browser preview, a preview pane, a drag that ends
    // over the OS taskbar) never reaches the element — which left the flag set
    // and the clock frozen for the rest of the session.
    window.addEventListener(name, function () {
      if (!miniPlayerSeekDragging) return;
      miniPlayerSeekDragging = false;
      track.classList.remove('dragging');
      // One final read so the fill matches the position that was actually set.
      paintMiniPlayerProgress();
    });
  });
  // Keyboard: the bar is a role=slider, so arrows have to move it.
  track.addEventListener('keydown', function (event) {
    if (typeof audio === 'undefined' || !audio || !audio.src) return;
    var step = event.shiftKey ? 30 : 5;
    if (event.key === 'ArrowLeft') { audio.currentTime = Math.max(0, audio.currentTime - step); }
    else if (event.key === 'ArrowRight') {
      audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + step);
    } else return;
    event.preventDefault();
    if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
    paintMiniPlayerProgress();
  });
}

// ---------------------------------------------------------- install

function installMiniPlayer() {
  if (miniPlayerBound) return;
  miniPlayerBound = true;
  bindMiniPlayerSeek();
  syncMiniPlayerButtons();
  // The transport renders before the queue is hydrated, so a first paint is a
  // guess and the real one arrives with the first track.
  setTimeout(function () { if (miniPlayerOpen) paintMiniPlayer(); }, 0);
  setTimeout(function () { if (miniPlayerOpen) paintMiniPlayer(); }, 1500);
  if (readMiniPlayerPref()) {
    // Restored: the bar starts down and the compact transport slides up, which
    // is what the user left the window looking like.
    setTimeout(function () { enterMiniPlayer(); }, 60);
  }
}

// Installed by its own body — see the playback guard for why.
installMiniPlayer();