'use strict';

// ============================================================
//  Remote Server Bridge (phone/web remote <-> local playback)
// ============================================================
var REMOTE_PUBLISH_INTERVAL_MS = 1000;
var REMOTE_POLL_INTERVAL_MS = 1000;
var REMOTE_QUEUE_TITLES_LIMIT = 50;
var remoteBridgeLastPublishAt = 0;
var remoteBridgePublishBusy = false;
var remoteBridgePollBusy = false;
var remoteBridgePollSinceId = 0;
var remoteBridgePublishTimer = null;
var remoteBridgeCmdTimer = null;
var remoteBridgeSearchResults = null;
var remoteBridgeSearchQuery = '';
var remoteBridgeSearchSeq = 0;

function remoteBridgeCurrentSong() {
  try {
    if (typeof window.currentSong !== 'undefined' && window.currentSong) return window.currentSong;
    var song = typeof currentCoverSong === 'function' ? currentCoverSong() : null;
    if (!song && Array.isArray(playQueue) && currentIdx >= 0 && currentIdx < playQueue.length) song = playQueue[currentIdx];
    return song || null;
  } catch (e) {
    return null;
  }
}

function remoteBridgeSnapshot() {
  var song = null;
  try { song = remoteBridgeCurrentSong(); } catch (e) { song = null; }
  var titles = [];
  try {
    var queue = Array.isArray(playQueue) ? playQueue : [];
    for (var i = 0; i < queue.length && i < REMOTE_QUEUE_TITLES_LIMIT; i++) {
      var item = queue[i] || {};
      titles.push(String(item.name || item.title || ''));
    }
  } catch (e) { }
  var snapshot = {};
  snapshot.playing = !!(audio && !audio.paused && !audio.ended && playing);
  snapshot.position = audio && isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0;
  snapshot.duration = audio && isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  snapshot.volume = clampRange(typeof targetVolume === 'number' ? targetVolume : Number(targetVolume) || 0, 0, 1);
  snapshot.playMode = String(playMode || 'loop');
  snapshot.queue = titles;
  if (song) {
    snapshot.track = {
      id: song.id != null ? String(song.id) : '',
      name: String(song.name || song.title || ''),
      artist: String(song.artist || ''),
      album: String(song.album || ''),
      cover: String(song.cover || ''),
      duration: Math.max(0, Number(song.duration || song.dt) || 0)
    };
  } else {
    snapshot.track = null;
  }
  snapshot.searchResults = remoteBridgeSearchResults;
  snapshot.searchQuery = remoteBridgeSearchQuery;
  return snapshot;
}

function remoteBridgeTrackKey(snapshot) {
  if (!snapshot || !snapshot.track) return '';
  return [snapshot.track.id, snapshot.track.name, snapshot.track.artist, snapshot.playing ? '1' : '0'].join('|');
}

async function publishRemoteSnapshot(reason) {
  if (remoteBridgePublishBusy) return;
  remoteBridgePublishBusy = true;
  try {
    var snapshot = remoteBridgeSnapshot();
    await apiJson('/api/remote/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason || '', snapshot: snapshot })
    });
    remoteBridgeLastPublishAt = Date.now();
  } catch (err) {
    console.warn('[RemoteBridge] publish failed:', err && (err.message || err));
  } finally {
    remoteBridgePublishBusy = false;
  }
}

function applyRemoteCommand(cmd) {
  cmd = cmd || {};
  var payload = cmd.payload || {};
  switch (String(cmd.type || '')) {
    case 'toggle':
      if (typeof togglePlay === 'function') togglePlay();
      break;
    case 'next':
      if (typeof nextTrack === 'function') nextTrack(true);
      break;
    case 'prev':
      if (typeof prevTrack === 'function') prevTrack(true);
      break;
    case 'seek':
      if (payload && payload.position != null && typeof commitProgressSeek === 'function' && getPlaybackDurationSeconds()) {
        commitProgressSeek(Number(payload.position), playing);
      }
      break;
    case 'volume':
      if (payload && payload.value != null && typeof setVolume === 'function') setVolume(Number(payload.value), true);
      break;
    case 'playIndex':
      var idx = Math.round(Number(payload && payload.index));
      if (isFinite(idx) && idx >= 0 && idx < playQueue.length && typeof playQueueAt === 'function') playQueueAt(idx);
      break;
    case 'enqueue':
      var song = null;
      if (payload && payload.song && typeof payload.song === 'object') song = cloneSong(payload.song);
      else if (payload && payload.index != null && Array.isArray(playlist)) song = playlist[Math.round(Number(payload.index))];
      if (song) {
        if (typeof queueItemKey !== 'function') break;
        var existingIdx = -1;
        var targetKey = queueItemKey(song);
        for (var i = 0; i < playQueue.length; i++) {
          if (queueItemKey(playQueue[i]) === targetKey) { existingIdx = i; break; }
        }
        if (existingIdx < 0) {
          queueSongNext(song);
          if (typeof showToast === 'function') showToast('Added from remote: ' + (song.name || ''));
        } else if (existingIdx !== currentIdx && typeof showToast === 'function') {
          showToast('Already in queue');
        }
      }
      break;
    case 'search':
      remoteBridgeHandleSearchCommand(payload);
      break;
  }
  setTimeout(function () { publishRemoteSnapshot('cmd:' + String(cmd.type || '')); }, 120);
}

async function remoteBridgeHandleSearchCommand(payload) {
  var q = String((payload && payload.query) || '').trim();
  if (!q) return;
  var seq = ++remoteBridgeSearchSeq;
  try {
    var data = await apiJson('/api/search?keywords=' + encodeURIComponent(q));
    if (seq !== remoteBridgeSearchSeq) return;
    var songs = data && Array.isArray(data.songs) ? data.songs.slice(0, 30).map(function (s, i) {
      return {
        index: i,
        name: String(s.name || s.title || ''),
        artist: String(s.artist || ''),
        album: String(s.album || ''),
        cover: String(s.cover || '')
      };
    }) : [];
    playlist = data && Array.isArray(data.songs) ? data.songs : [];
    remoteBridgeSearchQuery = q;
    remoteBridgeSearchResults = songs;
  } catch (err) {
    console.warn('[RemoteBridge] search failed:', err && (err.message || err));
    if (seq === remoteBridgeSearchSeq) remoteBridgeSearchResults = [];
  }
}

async function pollRemoteCommands() {
  if (remoteBridgePollBusy) return;
  remoteBridgePollBusy = true;
  try {
    var data = await apiJson('/api/remote/poll-cmds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sinceId: remoteBridgePollSinceId })
    });
    var cmds = data && Array.isArray(data.cmds) ? data.cmds : [];
    for (var i = 0; i < cmds.length; i++) {
      try { applyRemoteCommand(cmds[i]); } catch (err) {
        console.warn('[RemoteBridge] command failed:', cmds[i] && cmds[i].type, err && (err.message || err));
      }
      if (cmds[i] && cmds[i].id != null) remoteBridgePollSinceId = Number(cmds[i].id) || 0;
    }
  } catch (err) {
    // Route may not exist yet on this server build; stay silent and retry later.
  } finally {
    remoteBridgePollBusy = false;
  }
}

function startRemoteServerBridge() {
  if (remoteBridgePublishTimer || remoteBridgeCmdTimer) return;
  var lastTrackKey = remoteBridgeTrackKey(remoteBridgeSnapshot());
  remoteBridgePublishTimer = setInterval(function () {
    try {
      var key = remoteBridgeTrackKey(remoteBridgeSnapshot());
      if (key !== lastTrackKey) {
        lastTrackKey = key;
        publishRemoteSnapshot('track-change');
      } else {
        publishRemoteSnapshot('tick');
      }
    } catch (err) {
      console.warn('[RemoteBridge] publish loop error:', err && (err.message || err));
    }
  }, REMOTE_PUBLISH_INTERVAL_MS);
  remoteBridgeCmdTimer = setInterval(function () {
    try { pollRemoteCommands(); } catch (err) { /* fail soft */ }
  }, REMOTE_POLL_INTERVAL_MS);
}

setTimeout(startRemoteServerBridge, 1500);

// ============================================================