function pauseCurrentAudioForTrackSwitch() {
  playToggleBusy = false;
  if (!audio) return;
  try {
    audioFadeSerial++;
    clearAudioFadeTimers();
    audio.onended = null;
    audio.pause();
  } catch (e) { }
  playing = false;
  setPlayIcon(false);
  syncPlaybackStateFromAudioEvent('track-switch');
}

function syncPlaybackStateFromAudioEvent(reason) {
  if (typeof updatePlaybackResumePauseMarker === 'function') updatePlaybackResumePauseMarker(reason);
  var isPlaying = !!(audio && audio.src && !audio.paused && !audio.ended);
  playing = isPlaying;
  setPlayIcon(isPlaying);
  if (!isPlaying) hideLoading();
  if (reason === 'play' || reason === 'playing') {
    switchPlaybackVisualToEmily();
    if (typeof markStageLyricsPlaybackResume === 'function') markStageLyricsPlaybackResume(reason);
  }
  forcePlaybackControlsInteractive();
}

function isPlaybackRecursionError(err) {
  var msg = String((err && err.message) || err || '');
  return err instanceof RangeError || /maximum call stack size exceeded/i.test(msg);
}

function safePlaybackStep(label, fn) {
  try {
    return fn();
  } catch (err) {
    console.warn('[PlaybackSetupStep]', label, err);
    return null;
  }
}

function playbackFailureNoticeFromError(err) {
  if (typeof playbackRestrictionNotice !== 'function') return null;
  var msg = String(err && err.message ? err.message : (err || '')).trim();
  if (!msg) return null;
  var lower = msg.toLowerCase();
  var category = '';
  if (/vip_required|paid_required|trial_only|need_vip|only_vip|member|vip|会员|付费|购买/.test(lower + msg)) category = 'vip_required';
  else if (/401|403|login_required|auth|cookie|credential|unauthorized|forbidden/.test(lower)) category = 'login_required';
  else if (/copyright|not playable|unavailable/.test(lower)) category = 'copyright_unavailable';
  else if (/url.*empty|no url|no supported source/.test(lower)) category = 'url_unavailable';
  if (!category) return null;
  var song = playQueue && currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null;
  return playbackRestrictionNotice(song, { reason: category, message: msg });
}

function playbackFailureToastText(err) {
  var contextualNotice = playbackFailureNoticeFromError(err);
  if (contextualNotice) return contextualNotice.title + ': ' + contextualNotice.body;
  if (isPlaybackRecursionError(err)) return 'Playback preparation error; player kept responsive';
  var msg = String(err && err.message ? err.message : (err || '')).trim();
  var lower = msg.toLowerCase();
  if (/notallowederror|play\(\) failed|user gesture|autoplay/.test(lower)) return 'Playback failed: browser blocked autoplay; press Play once';
  if (/notsupportederror|no supported source|decode|media_err_decode/.test(lower)) return 'Playback failed: unsupported audio format or decode error; try another source or lower quality';
  if (/notfounderror|setSinkId|sink|output device|audio output/.test(lower)) return 'Playback failed: audio output device unavailable; switch back to system default';
  if (/aborterror|aborted|interrupted/.test(lower)) return 'Playback interrupted by a new track switch';
  if (/network|failed to fetch|timeout|econnreset|etimedout|err_connection|http 5|502|503|504/.test(lower)) return 'Playback failed: network request timed out or service unavailable';
  if (/401|403|login_required|auth|cookie|credential|unauthorized|forbidden/.test(lower)) return 'Playback failed: sign-in expired; please sign in to the platform again';
  if (/vip_required|paid_required|trial_only|need_vip|only_vip|member/.test(lower)) return 'Playback failed: this track requires VIP or purchase';
  if (/copyright|unavailable|not playable|url.*empty|no url/.test(lower)) return 'Playback failed: no playable URL returned; try another source';
  return 'Playback failed: ' + (msg || 'unknown reason; try another source or sign in again');
}
function scheduleAudioResumePosition(media, seconds, token) {
  seconds = Math.max(0, Number(seconds) || 0);
  if (!media || seconds < 0.35) return;
  var applied = false;
  function applyResume() {
    if (applied || token !== trackSwitchToken || !media) return;
    var duration = Number(media.duration) || 0;
    var target = duration > 0 ? Math.min(seconds, Math.max(0, duration - 0.45)) : seconds;
    try {
      media.currentTime = target;
      applied = true;
      if (typeof syncBeatMapPlaybackCursor === 'function') syncBeatMapPlaybackCursor(target, true);
      if (typeof syncPodcastDjMapCursor === 'function') syncPodcastDjMapCursor(target, true);
      updatePlaybackProgressUi();
    } catch (e) { }
  }
  media.addEventListener('loadedmetadata', applyResume, { once: true });
  media.addEventListener('canplay', applyResume, { once: true });
  setTimeout(applyResume, 520);
  applyResume();
}
