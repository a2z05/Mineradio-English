// ============================================================
//  Playback guards for the local library — two things that used to look like
//  the player being broken rather than the disk being wrong.
//
//  1. A file that has been moved, renamed or deleted since it was scanned
//     makes the custom protocol answer 404. The audio element then just sits
//     there: no sound, no toast, no advance. The queue would stall on the
//     first dead row for the rest of the session.
//  2. Listen counters. The rest of the app records listens for its own
//     dashboard; the library's favourites, Most played and Recently played
//     views read a different store, so nothing was ever written to them from
//     playback.
//
//  Both hooks are passive: nothing here decides what plays next on its own
//  beyond skipping a track that cannot be read.
// ============================================================

var LIBRARY_MISSING_SKIP_WINDOW_MS = 8000;
var LIBRARY_MISSING_SKIP_MAX = 8;
var LIBRARY_MISSING_SAME_TRACK_MS = 1500;
var libraryMissingGuard = { count: 0, at: 0, key: '' };

function libraryIsLocalKey(key) {
  return String(key || '').slice(0, 6) === 'local:';
}

function libraryLocalSongAt(idx) {
  var song = typeof idx === 'number' && idx >= 0 && idx < playQueue.length
    ? playQueue[idx]
    : null;
  if (!song && typeof currentLocalSong !== 'undefined') song = currentLocalSong;
  return song && libraryIsLocalKey(queueItemKey(song)) ? song : null;
}

function libraryMarkTrackMissing(song) {
  if (!song) return;
  song.localMissing = true;
  var id = localLibrarySongKey(song);
  var cached = id && localLibraryStore.byId[id];
  // Only the flag flips. The row stays: a rescan re-checks it, and silently
  // dropping entries would make the counts disagree with the index on disk.
  if (cached) cached.localMissing = true;
  if (localLibraryStore.index) invalidateLocalLibraryIndex();
}

function libraryNoteMissingTrack(song, media) {
  var key = queueItemKey(song);
  var now = Date.now();
  var guard = libraryMissingGuard;
  // The load path can report the same failure twice — once when the fetch
  // fails and again if a stall recovery retries it. One skip per track.
  if (guard.key === key && now - guard.at < LIBRARY_MISSING_SAME_TRACK_MS) return;
  // A quiet gap means the last streak is over; count runs of dead files, not
  // dead files for the whole session.
  if (now - guard.at > LIBRARY_MISSING_SKIP_WINDOW_MS) guard.count = 0;
  guard.key = key;
  guard.at = now;
  guard.count += 1;

  libraryMarkTrackMissing(song);
  showToast('File is missing: ' + String(song.name || 'this track'));

  if (typeof libraryRecordPlaybackEvent === 'function') {
    libraryRecordPlaybackEvent(song, 'skip');
  }

  if (guard.count > LIBRARY_MISSING_SKIP_MAX) {
    // Too many dead files in a row: the folder was probably renamed. Carrying
    // on would click through the whole library a track at a time.
    if (typeof stopAtQueueEnd === 'function') stopAtQueueEnd('missing-files');
    showToast('Several library files are missing — rescan your music folders');
    return;
  }

  if (playQueue.length > 1 && typeof nextTrack === 'function') {
    // nextTrack, not "play whatever this mode says next": a file that cannot
    // be read should not consume the Play once decision.
    nextTrack(true);
  } else if (typeof stopAtQueueEnd === 'function') {
    stopAtQueueEnd('missing-file');
  }
}

// Media `error` events do not bubble, so this is registered on the capture
// path. That also means one listener covers every <audio> the player swaps in
// during a session, without having to rebind at each creation site.
function libraryOnMediaError(event) {
  var target = event && event.target;
  if (!target) return;
  var tag = String(target.tagName || '').toUpperCase();
  if (tag !== 'AUDIO' && tag !== 'VIDEO') return;
  if (typeof audio !== 'undefined' && audio && target !== audio) return;
  if (!target.error) return;
  // 1 (aborted) is what a deliberate track switch looks like, and it is not a
  // dead file. Only a real fetch or decode failure counts.
  if (target.error.code === 1) return;

  var song = libraryLocalSongAt(currentIdx);
  if (!song) return;
  // A stale element reporting on a track we have already left must not
  // advance the queue for the one we just moved to.
  if (target.__mineradioQueueItemKey && target.__mineradioQueueItemKey !== queueItemKey(song)) return;

  libraryNoteMissingTrack(song, target);
}

var libraryMediaErrorWatchInstalled = false;
function libraryInstallMediaErrorWatch() {
  if (libraryMediaErrorWatchInstalled) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  libraryMediaErrorWatchInstalled = true;
  window.addEventListener('error', libraryOnMediaError, true);
}

// One event per listen, mapped from what the listen session already decided:
// finished the track, listened to part of it, or bailed before it counted.
// Keys are 'local:<id>' for library tracks and anything else for streams —
// everything else returns before touching the bridge.
function libraryRecordListenEvent(key, completed, effective) {
  if (!libraryIsLocalKey(key)) return;
  if (!window.desktopWindow || typeof window.desktopWindow.setLocalLibraryUser !== 'function') return;
  if (typeof libraryRecordPlaybackEvent !== 'function') return;
  var localKey = String(key).slice(6);
  var song = localLibraryStore.byId[localKey] || { localKey: localKey, localFileId: localKey };
  var kind = effective ? (completed ? 'complete' : 'play') : 'skip';
  libraryRecordPlaybackEvent(song, kind);
}

// Installed here rather than from the startup module: all of these files are
// concatenated into one script, so calling it from an earlier module would run
// before this module's own state has been initialised and the guard flag would
// be reset on the next line of execution.
libraryInstallMediaErrorWatch();
