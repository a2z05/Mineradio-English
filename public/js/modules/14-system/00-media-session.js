// ============================================================
//  EN-FORK — hand the player to the operating system.
//
//  Mineradio's whole front end is a 3D stage: the cover, the lyrics, the
//  water. None of that can be handed to a media key. So this module does the
//  unglamorous half of desktop playback:
//
//    - a real Media Session, so the hardware keys, the lock screen and any
//      Bluetooth headset reach the player;
//    - a report of the current track to the main process, which owns the
//      taskbar thumbnail, the tray transport and the notification;
//    - a compact mini player that follows the window and remembers itself.
//
//  Everything here is best-effort. The browser preview has none of these APIs,
//  and a player that refuses to play because a decoration failed would be
//  exactly the kind of fake-feeling player this rebuild is trying not to be.
// ============================================================

var mediaCommandUnbound = false;
var mediaNotificationOn = true;
var mediaNotificationTimer = null;
var mediaPublishedTrackKey = '';
var mediaPublishedState = '';
var mediaArtworkCanvas = null;
var mediaArtworkUrl = '';
var mediaArtworkTrackKey = '';

function currentMediaSong() {
  if (typeof playQueue !== 'undefined' && playQueue && currentIdx >= 0 && playQueue[currentIdx]) {
    return playQueue[currentIdx];
  }
  if (typeof currentLocalSong !== 'undefined' && currentLocalSong) return currentLocalSong;
  return null;
}

// ---------------------------------------------------------- artwork

// The cover as a small data URL. Windows keeps exactly one thumbnail texture,
// so this is 256px square and JPEG/WebP — a 1000px PNG of an embedded cover is
// megabytes over IPC for pixels nobody ever sees.
function mediaArtworkDataUrl(song) {
  var src = mediaArtworkSource(song);
  if (!src) return '';
  if (src.indexOf('data:image/') === 0) return src;
  var key = (typeof queueItemKey === 'function' ? queueItemKey(song) : String(src)) + '|' + src;
  if (mediaArtworkUrl && mediaArtworkTrackKey === key) return mediaArtworkUrl;
  var img = document.getElementById('thumb-cover');
  if (!img || !img.naturalWidth) return '';
  try {
    if (!mediaArtworkCanvas) mediaArtworkCanvas = document.createElement('canvas');
    var size = 256;
    mediaArtworkCanvas.width = mediaArtworkCanvas.height = size;
    var cx = mediaArtworkCanvas.getContext('2d');
    if (!cx) return '';
    cx.clearRect(0, 0, size, size);
    var side = Math.min(img.naturalWidth, img.naturalHeight);
    cx.drawImage(
      img,
      (img.naturalWidth - side) / 2,
      (img.naturalHeight - side) / 2,
      side, side,
      0, 0, size, size
    );
    var out = '';
    try {
      var webp = mediaArtworkCanvas.toDataURL('image/webp', 0.86);
      if (/^data:image\/webp/i.test(webp)) out = webp;
    } catch (e) { /* WebP is not always encodable; JPEG always is. */ }
    if (!out) out = mediaArtworkCanvas.toDataURL('image/jpeg', 0.86);
    mediaArtworkUrl = out;
    mediaArtworkTrackKey = key;
    return out;
  } catch (error) {
    return '';
  }
}

// The thumbnail element lags the cover swap by a frame, so a bare element read
// can hand back the previous track's art. The swapped cover URL is the truth.
function mediaArtworkSource(song) {
  var cover = document.getElementById('control-cover');
  var inline = cover && cover.style && cover.style.backgroundImage;
  var match = inline && /url\("(.+?)"\)/.exec(inline);
  if (match && match[1] && match[1] !== 'none') return match[1];
  return (song && (song.coverUrl || song.cover || song.albumCover || song.image)) || '';
}

// ---------------------------------------------------------- publish

function mediaReportPayload(song, isPlaying, opts) {
  opts = opts || {};
  song = song || {};
  var duration = 0;
  if (typeof audio !== 'undefined' && audio) duration = Number(audio.duration) || 0;
  if (!(duration > 0)) duration = Number(song.duration) || 0;
  return {
    title: String(song.name || song.title || ''),
    artist: String(song.artist || ''),
    album: String(song.album || ''),
    duration: duration > 0 ? duration : 0,
    artwork: opts.withArtwork === false ? '' : mediaArtworkDataUrl(song),
    playing: !!isPlaying,
    reason: opts.reason || 'track',
  };
}

// One call per real change. The main process reuses the previous artwork when
// the title/artist/album triple is unchanged, so this is safe to be generous
// with — but it is not free, so the play state is packed into one string and a
// pure repeat is dropped here.
function publishMediaState(reason) {
  var song = currentMediaSong();
  var isPlaying = !!(typeof playing !== 'undefined' && playing);
  var key = typeof queueItemKey === 'function' && song ? queueItemKey(song) : '';
  var stateKey = key + '|' + (isPlaying ? 1 : 0) + '|' + String(song && song.album || '');
  if (stateKey === mediaPublishedState && reason !== 'force') return;
  mediaPublishedState = stateKey;

  if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
  try {
    var meta = new MediaMetadata({
      title: String(song && song.name || ''),
      artist: String(song && song.artist || ''),
      album: String(song && song.album || ''),
      artwork: mediaArtworkSessionArt(song),
    });
    navigator.mediaSession.metadata = meta;
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  } catch (error) {
    // A browser without MediaMetadata (older WebKit, an odd UA) is fine.
  }
  publishMediaToMain(reason === 'force' ? 'track' : (reason || 'track'), song, isPlaying);
}

function mediaArtworkSessionArt(song) {
  var src = mediaArtworkSource(song);
  if (!src) return [];
  // The type has to be a MIME type, not a fragment of one. A local cover is
  // the app's own scheme and matches nothing here, so the fallback below used
  // to be 'image/jpeg' — and then had 'image/' put in front of it, so every
  // lock screen and volume mixer was told the art was "image/image/jpeg" and
  // showed nothing. A bare 'jpeg' fallback keeps the whole type in one place.
  var type = /data:image\/(png|jpe?g|webp|gif)/i.exec(src);
  var mime = type ? type[1].toLowerCase() : 'jpeg';
  if (mime === 'jpg') mime = 'jpeg';
  return [{ src: src, sizes: '512x512', type: 'image/' + mime }];
}

function publishMediaToMain(reason, song, isPlaying) {
  var api = typeof getDesktopWindowApi === 'function' ? getDesktopWindowApi() : null;
  if (!api || typeof api.publishMediaState !== 'function') return;
  var payload = mediaReportPayload(song, isPlaying, { reason: reason });
  try {
    var answer = api.publishMediaState(payload);
    if (answer && typeof answer.then === 'function') {
      answer.then(function (result) {
        if (result && result.ok && tray) createOrUpdateTrayRef();
        scheduleMediaNotification(reason, song);
      })['catch'](function () { });
    }
  } catch (error) { /* the OS integration is decoration; never block playback */ }
}

// The tray has to be rebuilt for the transport to appear. main.js owns that
// menu; the renderer only nudges it when the bridge confirms it took the update.
function createOrUpdateTrayRef() {
  if (typeof requestTrayRefresh === 'function') requestTrayRefresh();
}

// ---------------------------------------------------------- notifications

function scheduleMediaNotification(reason, song) {
  if (!mediaNotificationOn) return;
  if (reason !== 'track' || !song || !song.name) return;
  // A burst of skips during a scan must not turn into a burst of toasts.
  if (mediaNotificationTimer) clearTimeout(mediaNotificationTimer);
  mediaNotificationTimer = setTimeout(function () {
    mediaNotificationTimer = null;
    var api = typeof getDesktopWindowApi === 'function' ? getDesktopWindowApi() : null;
    if (!api || typeof api.notifyNowPlaying !== 'function') return;
    try {
      api.notifyNowPlaying({ title: song.name, artist: song.artist });
    } catch (error) { }
  }, 400);
}

function setMediaNotifications(on) {
  mediaNotificationOn = !!on;
  try { localStorage.setItem('mineradio-media-notify-v1', mediaNotificationOn ? '1' : '0'); } catch (e) { }
  if (!mediaNotificationOn && mediaNotificationTimer) {
    clearTimeout(mediaNotificationTimer);
    mediaNotificationTimer = null;
  }
  return mediaNotificationOn;
}

function readMediaNotificationPref() {
  try { return localStorage.getItem('mineradio-media-notify-v1') !== '0'; } catch (e) { return true; }
}

// ---------------------------------------------------------- media keys

function bindMediaSessionCommands() {
  if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
  var handlers = {
    play: function () { if (typeof togglePlay === 'function') togglePlay(); },
    pause: function () { if (typeof togglePlay === 'function') togglePlay(); },
    toggleplayback: function () { if (typeof togglePlay === 'function') togglePlay(); },
    stop: function () { stopPlayback(); },
    previoustrack: function () { if (typeof prevTrack === 'function') prevTrack(true); },
    nexttrack: function () { if (typeof nextTrack === 'function') nextTrack(true); },
    seekbackward: function (details) {
      if (typeof audio === 'undefined' || !audio || !audio.src) return;
      var step = Math.max(1, Number((details && details.seekOffset) || 10));
      audio.currentTime = Math.max(0, (Number(audio.currentTime) || 0) - step);
      if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
    },
    seekforward: function (details) {
      if (typeof audio === 'undefined' || !audio || !audio.src) return;
      var step = Math.max(1, Number((details && details.seekOffset) || 10));
      var duration = Number(audio.duration) || 0;
      audio.currentTime = Math.min(duration > 0 ? duration : Infinity, (Number(audio.currentTime) || 0) + step);
      if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
    },
    seekto: function (details) {
      if (!details || !details.fastSeek || typeof audio === 'undefined' || !audio || !audio.src) return;
      var duration = Number(audio.duration) || 0;
      var target = Number(details.seekTime) || 0;
      audio.currentTime = Math.max(0, duration > 0 ? Math.min(target, duration) : target);
      if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
    },
  };
  Object.keys(handlers).forEach(function (name) {
    try { navigator.mediaSession.setActionHandler(name, handlers[name]); } catch (error) { /* unsupported action */ }
  });
}

// Stop is the one command the player has no function for: it means "stop, and
// stay stopped", which is neither pause (the audio must not resume on the next
// track) nor a teardown the user can undo.
function stopPlayback() {
  if (typeof audio !== 'undefined' && audio) {
    try {
      if (typeof clearAudioFadeTimers === 'function') clearAudioFadeTimers();
      audio.pause();
      audio.currentTime = 0;
    } catch (error) { }
  }
  if (typeof setPlayIcon === 'function') setPlayIcon(false);
  if (typeof hideLoading === 'function') hideLoading();
  if (typeof syncPlaybackStateFromAudioEvent === 'function') syncPlaybackStateFromAudioEvent('stop');
  publishMediaState('force');
}

// ---------------------------------------------------------- install

function installMediaSession() {
  if (mediaCommandUnbound) return;
  mediaCommandUnbound = true;
  mediaNotificationOn = readMediaNotificationPref();
  bindMediaSessionCommands();

  // The transport renders before the library is hydrated, so the current track
  // has to be found wherever it is.
  setTimeout(function () { publishMediaState('force'); }, 0);
  setTimeout(function () { publishMediaState('force'); }, 1200);
  setTimeout(function () { publishMediaState('force'); }, 4000);

  var api = typeof getDesktopWindowApi === 'function' ? getDesktopWindowApi() : null;
  if (!api) return;

  if (typeof api.onMediaCommand === 'function') {
    api.onMediaCommand(function (payload) {
      var action = payload && payload.action;
      if (action === 'togglePlay' && typeof togglePlay === 'function') togglePlay();
      else if (action === 'prevTrack' && typeof prevTrack === 'function') prevTrack(true);
      else if (action === 'nextTrack' && typeof nextTrack === 'function') nextTrack(true);
      else if (action === 'stopPlayback') stopPlayback();
      // A hardware key must bring the player back into view, or it looks
      // broken when the window is behind something.
      try { if (typeof api.restore === 'function') api.restore(); } catch (error) { }
    });
  }

  // Ask for the hardware media keys once. Whether they registered comes back
  // as a binding map, and what failed is reported rather than assumed.
  if (typeof api.mediaKeys === 'function') {
    try {
      var answer = api.mediaKeys({});
      if (answer && typeof answer.then === 'function') {
        answer.then(function (result) {
          if (result && result.ok) {
            var missed = (result.results || []).filter(function (item) { return !item.ok; });
            if (missed.length && typeof showToast === 'function') {
              showToast('Media keys unavailable — another app has ' + missed.length + ' of them');
            }
          }
        })['catch'](function () { });
      }
    } catch (error) { }
  }
}

// Installed by its own body: the modules are concatenated into one script, so
// anything that calls this from an earlier file would run before this file's
// state exists.
installMediaSession();