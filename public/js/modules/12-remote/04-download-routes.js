// 02-download-routes.js — the download route menu.
//
// There are two ways a track can be saved now, and they are not
// interchangeable: the direct route fetches the exact stream the player is
// already using, while yt-dlp searches YouTube and can therefore outlive an
// expiring URL or a provider that only offers a preview. Which one is right
// depends on the track, so the download button asks instead of guessing.
//
// The yt-dlp entries are only offered when /api/ytdlp/status reports the binary
// present. A route that cannot run is never shown as a choice.

var downloadRouteState = { menuEl: null, open: false, ytDlp: null, busy: false };

function downloadRouteEl(id) { return document.getElementById(id); }

// The song currently loaded in the player, or null. Shared by every route.
function downloadRouteCurrentSong() {
  try {
    if (typeof playQueue !== 'undefined' && Array.isArray(playQueue) && playQueue[currentIdx]) return playQueue[currentIdx];
  } catch (e) { }
  return null;
}

// yt-dlp needs a URL or a searchable name. Prefer the URL of the entry that is
// actually playing so the download lands on the same recording, and fall back
// to "name artist" — which is what makes this route work for the providers that
// hand the player nothing but metadata.
function downloadRouteTargetFor(song) {
  if (!song) return '';
  var direct = String(song.webUrl || song.directUrl || '').trim();
  if (/^https?:\/\//i.test(direct)) return direct;
  var videoId = String(song.videoId || song.vid || '').trim();
  if (videoId && /^[A-Za-z0-9_-]{6,}$/.test(videoId)) return 'https://www.youtube.com/watch?v=' + videoId;
  var id = String(song.id || '').trim();
  if (id && /^[A-Za-z0-9_-]{6,}$/.test(id) && (song.provider === 'ytmusic' || song.source === 'ytmusic' || song.provider === 'ytdlp' || song.source === 'ytdlp')) {
    return 'https://www.youtube.com/watch?v=' + id;
  }
  return '';
}

function downloadRouteLabelFor(song) {
  if (!song) return 'track';
  return [song.name || song.title || 'track', song.artist || ''].filter(Boolean).join(' - ');
}

// Asks the server once and caches the answer for the session; the binary cannot
// appear mid-run without a rebuild.
function downloadRouteYtDlpStatus() {
  if (downloadRouteState.ytDlp) return Promise.resolve(downloadRouteState.ytDlp);
  return apiJson('/api/ytdlp/status', { timeoutMs: 8000 })
    .then(function (res) {
      downloadRouteState.ytDlp = res && typeof res === 'object' ? res : { available: false };
      return downloadRouteState.ytDlp;
    })
    .catch(function () {
      downloadRouteState.ytDlp = { available: false };
      return downloadRouteState.ytDlp;
    });
}

function ensureDownloadRouteMenu() {
  if (downloadRouteState.menuEl && document.body.contains(downloadRouteState.menuEl)) return downloadRouteState.menuEl;
  var menu = document.createElement('div');
  menu.id = 'download-route-menu';
  menu.className = 'download-route-menu';
  menu.setAttribute('role', 'menu');
  menu.style.display = 'none';
  document.body.appendChild(menu);
  downloadRouteState.menuEl = menu;
  // A click anywhere else, or Escape, closes it — the same contract the app's
  // other popovers follow.
  document.addEventListener('pointerdown', function (e) {
    if (!downloadRouteState.open) return;
    if (menu.contains(e.target)) return;
    var trigger = e.target && e.target.closest ? e.target.closest('#download-track-btn, .fs-download-track') : null;
    if (trigger) return;
    closeDownloadRouteMenu();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (downloadRouteState.open && e.key === 'Escape') closeDownloadRouteMenu();
  });
  return menu;
}

function closeDownloadRouteMenu() {
  if (downloadRouteState.menuEl) downloadRouteState.menuEl.style.display = 'none';
  downloadRouteState.open = false;
}

function positionDownloadRouteMenu(menu, anchor) {
  var rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 0, bottom: 0, right: 0 };
  menu.style.visibility = 'hidden';
  menu.style.display = 'block';
  var width = menu.offsetWidth || 260;
  var height = menu.offsetHeight || 160;
  // Right-align to the button and keep it on screen; the window edges are the
  // only thing that decides where it lands.
  var left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
  var top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.style.visibility = 'visible';
}

function renderDownloadRouteMenu(anchor) {
  var menu = ensureDownloadRouteMenu();
  var song = downloadRouteCurrentSong();
  var ytdlp = downloadRouteState.ytDlp || { available: false };
  var label = downloadRouteLabelFor(song);
  var target = downloadRouteTargetFor(song);
  var hasSong = !!song;
  var isLocal = !!(song && (song.type === 'local' || song.source === 'local' || song.localUrl));

  function row(route, title, sub, enabled) {
    return '<button type="button" class="download-route-row"' + (enabled ? '' : ' disabled') +
      ' data-download-route="' + route + '" role="menuitem">' +
      '<b>' + title + '</b><small>' + sub + '</small></button>';
  }

  var html = '<div class="download-route-head">Save <b>' + escapeDownloadRouteText(label) + '</b></div>';

  if (!hasSong) {
    html += '<div class="download-route-empty">Nothing is playing.</div>';
  } else if (isLocal) {
    html += '<div class="download-route-empty">This track is already a local file.</div>';
  } else {
    html += row('direct', 'Direct URL', 'The stream the player is using', true);
    if (ytdlp.available) {
      html += row('ytdlp', 'yt-dlp', target ? 'Download the exact entry' : 'Search YouTube by name', true);
      html += row('ytdlp-proxy', 'yt-dlp via proxy', 'Route the extractor through the proxy', true);
    } else {
      html += '<div class="download-route-note">yt-dlp is not included in this build.</div>';
    }
  }
  if (ytdlp.available && ytdlp.version) {
    html += '<div class="download-route-foot">yt-dlp ' + escapeDownloadRouteText(ytdlp.version) + '</div>';
  }

  menu.innerHTML = html;
  Array.prototype.forEach.call(menu.querySelectorAll('[data-download-route]'), function (button) {
    button.addEventListener('click', function () {
      var route = button.getAttribute('data-download-route');
      closeDownloadRouteMenu();
      runDownloadRoute(route);
    });
  });
  if (anchor) positionDownloadRouteMenu(menu, anchor);
  downloadRouteState.open = true;
}

function escapeDownloadRouteText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The download button's new entry point: ask which route, then run it.
async function openDownloadRouteMenu(anchor) {
  if (downloadRouteState.busy) return;
  downloadRouteState.ytDlp = null; // re-ask each open so a rebuild is picked up after restart
  var status = await downloadRouteYtDlpStatus();
  downloadRouteState.ytDlp = status;
  renderDownloadRouteMenu(anchor || downloadRouteEl('download-track-btn'));
}

async function runDownloadRoute(route) {
  var song = downloadRouteCurrentSong();
  if (!song) { if (typeof showToast === 'function') showToast('No track selected to download'); return false; }

  if (route === 'direct') {
    // Unchanged behaviour: the direct route IS the original downloader.
    return typeof downloadCurrentTrack === 'function' ? downloadCurrentTrack() : false;
  }

  var useProxy = route === 'ytdlp-proxy';
  var target = downloadRouteTargetFor(song);
  var query = target || downloadRouteLabelFor(song);
  if (!query) { if (typeof showToast === 'function') showToast('This track has nothing to search for'); return false; }

  downloadRouteState.busy = true;
  if (typeof showToast === 'function') {
    showToast(useProxy ? 'Downloading via yt-dlp and the proxy…' : 'Downloading via yt-dlp…');
  }
  try {
    // The route flag is a request, not an override: the server only proxies
    // when the ytdlp box is ticked and the proxy answers, because a silent
    // bypass of a deliberate proxy choice is worse than an honest failure.
    var res = await apiJson('/api/download/ytdlp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A generous ceiling: yt-dlp downloads and then muxes, and a full track
      // over a slow proxy legitimately takes a while.
      timeoutMs: 180000,
      body: JSON.stringify({
        query: target,
        name: target ? '' : query,
        viaProxy: !!useProxy
      })
    });
    if (res && res.ok) {
      if (typeof showToast === 'function') {
        showToast(res.warning ? ('Saved ✓ — ' + res.warning) : 'Saved to Downloads/Mineradio ✓');
      }
      return true;
    }
    var why = (res && (res.message || res.error)) || 'unknown error';
    if (typeof showToast === 'function') showToast('yt-dlp download failed: ' + why);
    return false;
  } catch (err) {
    if (typeof showToast === 'function') showToast('yt-dlp download failed: ' + (err && err.message || err));
    return false;
  } finally {
    downloadRouteState.busy = false;
  }
}

// Every existing download button becomes the menu opener. Bound here rather
// than rewritten into the markup so the fullscreen bar and the desktop bar get
// the same behaviour from one place.
function bindDownloadRouteButtons() {
  var buttons = document.querySelectorAll('#download-track-btn, .fs-download-track, .download-track-btn');
  Array.prototype.forEach.call(buttons, function (button) {
    if (button.dataset.downloadRouteBound === '1') return;
    button.dataset.downloadRouteBound = '1';
    // The markup carries onclick="downloadCurrentTrack()". Replace it: the
    // menu is now the entry point, and it still offers "Direct URL" first.
    button.removeAttribute('onclick');
    button.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (downloadRouteState.open) { closeDownloadRouteMenu(); return; }
      openDownloadRouteMenu(button);
    });
    button.setAttribute('aria-haspopup', 'menu');
  });
}

window.openDownloadRouteMenu = openDownloadRouteMenu;
window.closeDownloadRouteMenu = closeDownloadRouteMenu;
window.runDownloadRoute = runDownloadRoute;
window.downloadRouteTargetFor = downloadRouteTargetFor;
