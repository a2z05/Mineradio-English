'use strict';
// Mineradio Remote — phone web app for controlling the desktop player over LAN.
// Talks to /api/remote/* on the same origin with a Bearer device token.

(function () {
  var TOKEN_KEY = 'mr_device_token';
  var ORIGIN_KEY = 'mr_last_good_origin';
  var LAN_URL_KEY = 'mr_last_lan_url';
  var INSTALL_LATER_KEY = 'mr_install_later_at';
  var POLL_MS = 5000;
  var MAX_BACKOFF_MS = 30000;
  var PLAYABLE_POLL_MS = 4000;

  // ---------- state ----------
  var deviceToken = localStorage.getItem(TOKEN_KEY) || '';
  var snapshot = {};
  var snapAge = 0;            // ms since last snapshot (for local progress ticking)
  var seeking = false;
  var wantStream = false;     // true while an SSE connection should be alive
  var streamAbort = null;
  var backoffMs = 1000;
  var timers = [];
  var deadToken = false;

  // Render-diff caches (see applySnapshot) — skip DOM writes when unchanged.
  var lastCoverSrc = null;
  var lastPlayingShown = null;
  var lastQueueKey = '';
  var lastSearchKey = '';

  // IP-change recovery: remember every origin the PC has answered on, plus
  // the lanUrl it advertises, so a stale installed app can find it again.
  var knownOrigins = (function () {
    try { return JSON.parse(localStorage.getItem(LAN_URL_KEY) || '[]') || []; } catch (_) { return []; }
  })();
  var recoveryBusy = false;

  // Phone output mode ("cast" this device)
  var outputPhone = false;
  var phoneAudio = null;
  var lastPlayableSrc = '';
  var playableTimer = null;
  var autoplayBlocked = false;
  var phoneSeeking = false;
  var phoneVolTouched = false;

  // ---------- dom ----------
  function $(id) { return document.getElementById(id); }
  var el = {
    viewPair: $('view-pair'), viewPlayer: $('view-player'),
    pairStatus: $('pair-status'),
    connDot: $('conn-dot'), connBanner: $('conn-banner'), connText: $('conn-text'),
    btnReconnect: $('btn-reconnect'),
    coverImg: $('cover-img'), coverPh: $('cover-ph'),
    btnOutput: $('btn-output'), outputLabel: $('output-label'),
    title: $('track-title'), artists: $('track-artists'),
    progress: $('progress'), timeCur: $('time-cur'), timeDur: $('time-dur'),
    icPlay: $('ic-play'), icPause: $('ic-pause'),
    btnPrev: $('btn-prev'), btnToggle: $('btn-toggle'), btnNext: $('btn-next'),
    volume: $('volume'), tapChip: $('tap-chip'),
    btnPlayMode: $('btn-playmode'), playModeLabel: $('playmode-label'),
    btnDownload: $('btn-download'), btnRefresh: $('btn-refresh'),
    tabQueue: $('tab-queue'), tabSearch: $('tab-search'),
    tabLibrary: $('tab-library'), tabTransfer: $('tab-transfer'),
    secQueue: $('sec-queue'), secSearch: $('sec-search'),
    secLibrary: $('sec-library'), secTransfer: $('sec-transfer'),
    queueList: $('queue-list'), queueEmpty: $('queue-empty'),
    searchForm: $('search-form'), searchInput: $('search-input'),
    searchStatus: $('search-status'), searchResults: $('search-results'),
    libUp: $('lib-up'), libPath: $('lib-path'), libNote: $('lib-note'),
    libraryList: $('library-list'), libraryEmpty: $('library-empty'),
    uploadFiles: $('upload-files'), uploadFolder: $('upload-folder'),
    uploadPause: $('upload-pause'), uploadList: $('upload-progress-list'),
    transferNote: $('transfer-note'),
    toast: $('toast'),
    btnInstall: $('btn-install'),
    installSheet: $('install-sheet'), installYes: $('install-yes'), installLater: $('install-later')
  };

  // ---------- helpers ----------
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign(
      { Authorization: 'Bearer ' + deviceToken },
      opts.body ? { 'Content-Type': 'application/json' } : {},
      opts.headers || {}
    );
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, ok: res.ok, data: data };
      });
    });
  }

  function cmd(type, payload) {
    if (deadToken || !deviceToken) return Promise.resolve(null);
    var body = Object.assign({ type: type }, payload || {});
    return api('/api/remote/cmd', { method: 'POST', body: body }).then(function (r) {
      if (r.status === 401) logout(true);
      return r;
    }).catch(function () {});
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var PLAY_MODE_LABELS = { loop: 'Loop', shuffle: 'Shuffle', single: 'Single' };
  var lastPlayModeShown = '';
  function updatePlayModeDisplay(mode) {
    if (mode === lastPlayModeShown) return;
    lastPlayModeShown = mode;
    el.playModeLabel.textContent = PLAY_MODE_LABELS[mode] || 'Loop';
    el.btnPlayMode.classList.toggle('active', mode === 'shuffle' || mode === 'single');
  }

  function textOf(v) {
    if (!v) return '';
    if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join(', ');
    if (typeof v === 'object') return v.name || v.title || v.nickname || '';
    return String(v);
  }

  // ---------- toast ----------
  var toastTimer = null;
  function showToast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, ms || 2200);
  }

  // ---------- views ----------
  function showPair(msg) {
    stopPhoneOutput();
    setOutputMode(false, true);
    el.viewPair.hidden = false;
    el.viewPlayer.hidden = true;
    el.pairStatus.classList.remove('busy');
    el.pairStatus.textContent = msg || 'Scan the QR code shown in the PC app to pair.';
  }
  function showPlayer() {
    el.viewPair.hidden = true;
    el.viewPlayer.hidden = false;
    refreshState();
    setTimeout(offerInstall, 1200);
  }

  function logout(dead) {
    deviceToken = '';
    localStorage.removeItem(TOKEN_KEY);
    deadToken = !!dead;
    stopStream();
    stopPhoneOutput();
    resetRenderCaches();
    showPair(dead
      ? 'PC no longer recognizes this phone — scan the QR again'
      : 'Session expired. Scan the QR code again to pair.');
  }

  function resetRenderCaches() {
    lastCoverSrc = null;
    lastPlayingShown = null;
    lastQueueKey = '';
    lastSearchKey = '';
    el.searchResults.textContent = '';
    el.queueList.textContent = '';
  }

  function setConn(up, label) {
    el.connDot.className = 'dot' + (up ? ' on' : ' off');
    if (up) backoffMs = 1000;
    el.connBanner.classList.toggle('show', !!label);
    if (label) el.connText.textContent = label;
  }

  // ---------- pairing ----------
  function pairFromHash() {
    var m = (location.hash || '').match(/^#pair=([A-Za-z0-9_-]+)/);
    if (!m) return false;
    history.replaceState(null, '', location.pathname); // strip hash so reload doesn't re-pair
    el.viewPair.hidden = false;
    el.pairStatus.classList.add('busy');
    el.pairStatus.textContent = 'Pairing';
    api('/api/remote/pair', { method: 'POST', body: { token: m[1] } }).then(function (r) {
      if (r.ok && r.data && r.data.deviceToken) {
        deviceToken = r.data.deviceToken;
        localStorage.setItem(TOKEN_KEY, deviceToken);
        deadToken = false;
        rememberOrigin();
        resetRenderCaches();
        showPlayer();
        connectStream();
      } else if (r.status === 429) {
        showPair('Too many attempts. Get a fresh QR code and try again.');
      } else if (r.status === 401 || r.status === 400) {
        showPair('Invalid or expired code. Get a fresh QR code from the PC app.');
      } else {
        showPair('Pairing failed (' + r.status + ').');
      }
    }).catch(function () {
      showPair('Cannot reach the PC. Check Wi-Fi and firewall.');
    });
    return true;
  }

  // ---------- origin recovery ----------
  function rememberOrigin() {
    try { localStorage.setItem(ORIGIN_KEY, location.origin); } catch (_) {}
  }

  // Record every origin the PC advertises (snapshot.lanUrl) so we can hop
  // back to it later if the phone's current origin goes stale.
  function rememberLanHint(lanUrl) {
    if (!lanUrl) return;
    var m = String(lanUrl).match(/^https?:\/\/[^\/]+/);
    if (!m) return;
    var origin = m[0];
    if (origin === location.origin) return;
    if (knownOrigins.indexOf(origin) === -1) {
      knownOrigins.unshift(origin);
      knownOrigins = knownOrigins.slice(0, 6);
      try { localStorage.setItem(LAN_URL_KEY, JSON.stringify(knownOrigins)); } catch (_) {}
    }
  }

  // Probe candidates for a Mineradio PC. A hit is any origin whose
  // /remote/ page answers (no-cors fetch resolves on any HTTP response).
  function findPcOrigin(onProgress) {
    var candidates = [];
    function push(origin) {
      if (origin && origin !== location.origin && candidates.indexOf(origin) === -1) candidates.push(origin);
    }
    knownOrigins.forEach(push);

    // Derive the phone's own /24 subnet and sweep it — the PC lives there in
    // the common home-Wi-Fi case. Probe both default and alt server ports.
    var hostMatch = location.hostname.match(/^\d+\.\d+\.\d+\.(\d+)$/);
    if (hostMatch) {
      var base = location.hostname.split('.').slice(0, 3).join('.');
      var me = Number(hostMatch[1]);
      for (var i = 1; i <= 254; i++) {
        if (i === me) continue;
        push('http://' + base + '.' + i + ':3000');
      }
    }
    if (!candidates.length) return Promise.resolve('');

    var CONCURRENCY = 24;
    return new Promise(function (resolve) {
      var pos = 0;
      var active = 0;
      var settled = false;
      function settle(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }
      function next() {
        if (settled) return;
        while (active < CONCURRENCY && pos < candidates.length) {
          pos++;
          active++;
          (function (origin) {
            var probe = fetch(origin + '/remote/', { mode: 'no-cors', cache: 'no-store' })
              .then(function () { return true; }).catch(function () { return false; });
            var timeout = new Promise(function (resolveT) { setTimeout(function () { resolveT(false); }, 1200); });
            Promise.race([probe, timeout]).then(function (hit) {
              active--;
              if (settled) return;
              if (hit) {
                if (onProgress) onProgress('PC found at ' + origin.replace('http://', '') + ' — connecting…');
                settle(origin);
                return;
              }
              if (pos >= candidates.length && active <= 0) settle('');
              else next();
            });
          })(candidates[pos - 1]);
        }
        if (pos >= candidates.length && active <= 0) settle('');
      }
      next();
    });
  }

  // Called when the current origin can't reach the PC: try remembered origins,
  // then sweep the subnet. On success jump to the PC carrying this device's
  // token through #migrate= (localStorage is per-origin, so the token must be
  // handed over explicitly).
  var lastSweepAt = 0;
  function recoverConnection() {
    if (recoveryBusy || !deviceToken || deadToken) return;
    // A full sweep takes tens of seconds of radio time; don't hammer it.
    if (Date.now() - lastSweepAt < 45000) return;
    lastSweepAt = Date.now();
    recoveryBusy = true;
    setConn(false, 'Looking for the PC on your Wi-Fi…');
    var myToken = deviceToken;
    findPcOrigin(function (progressMsg) { setConn(false, progressMsg); }).then(function (origin) {
      recoveryBusy = false;
      if (origin) {
        try { location.replace(origin + '/remote/#migrate=' + encodeURIComponent(myToken)); } catch (_) {}
      } else {
        setConn(false, "Can't find the PC — same Wi-Fi? Tap Reconnect.");
      }
    });
  }

  function consumeMigrateToken() {
    var m = (location.hash || '').match(/^#migrate=([A-Za-z0-9_.-]+)/);
    if (!m) return false;
    history.replaceState(null, '', location.pathname); // strip so reload doesn't re-migrate
    var incoming = m[1];
    // Verify against THIS origin's PC before adopting — an attacker on the
    // network could otherwise bait a token out of a stale URL.
    fetch('/api/remote/state', { headers: { Authorization: 'Bearer ' + incoming }, cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) return;
        deviceToken = incoming;
        localStorage.setItem(TOKEN_KEY, deviceToken);
        deadToken = false;
        rememberOrigin();
        resetRenderCaches();
        showPlayer();
        connectStream();
      }).catch(function () {});
    return true;
  }

  // ---------- snapshots ----------
  // EN-FORK PERF FIX: the PC publishes a full snapshot every second. Rebuilding
  // the queue/search DOM and resetting coverImg.src on every tick caused
  // flicker + constant image refetches, which read as "the remote is slow".
  // Only touch the DOM when values actually changed.
  function applySnapshot(s) {
    if (!s || typeof s !== 'object') return;
    snapshot = s;
    snapAge = 0;

    // The PC publishes the current track as a nested object; flatten it once
    // here so the rest of the UI can keep reading flat fields.
    var t = s.track && typeof s.track === 'object' ? s.track : null;
    if (t) {
      if (s.title == null && t.name != null) s.title = t.name;
      if (s.artist == null && t.artist != null) s.artist = t.artist;
      if (!s.artists && t.artist != null) s.artists = t.artist;
      if (!s.cover && t.cover != null) s.cover = t.cover;
      if (!s.duration && t.duration != null) s.duration = t.duration;
    }

    var titleText = textOf(s.title || s.name || (s.song && (s.song.name || s.song.title))) || 'Not playing';
    var artistText = textOf(s.artists || s.artist || (s.song && (s.song.artists || s.song.artist)));
    if (titleText !== el.title.textContent) el.title.textContent = titleText;
    if (artistText !== el.artists.textContent) el.artists.textContent = artistText;

    var cover = s.cover || s.coverUrl || s.picUrl || (s.song && (s.song.cover || s.song.picUrl)) || '';
    if (cover !== lastCoverSrc) {
      lastCoverSrc = cover;
      if (cover) {
        el.coverImg.onerror = function () {
          el.coverImg.hidden = true;
          el.coverPh.style.display = 'flex';
        };
        el.coverImg.src = cover;
        el.coverImg.hidden = false;
        el.coverPh.style.display = 'none';
      } else {
        el.coverImg.removeAttribute('src');
        el.coverImg.hidden = true;
        el.coverPh.style.display = 'flex';
      }
    }

    var dur = Number(s.duration) || Number(s.dt) || 0;
    var durFloor = Math.floor(dur);
    if (durFloor !== Number(el.progress.max)) {
      el.progress.max = durFloor;
      el.timeDur.textContent = fmtTime(dur);
    }

    var playing = s.playing === true || s.paused === false;
    if (!outputPhone) {
      if (!seeking) updateProgressDisplay();
      if (playing !== lastPlayingShown) {
        el.icPlay.hidden = playing;
        el.icPause.hidden = !playing;
        lastPlayingShown = playing;
      }
    }

    updatePlayModeDisplay(String(s.playMode || 'loop'));

    // The PC advertises its current LAN URL — remember it for IP-change hops.
    rememberLanHint(s.lanUrl);

    if (!outputPhone && !seeking && document.activeElement !== el.volume) {
      // PC reports volume as a 0-1 fraction; the slider is 0-100.
      var vRaw = s.volumePercent != null ? Number(s.volumePercent)
        : (s.volume != null ? Number(s.volume) * 100 : NaN);
      if (isFinite(vRaw)) {
        el.volume.value = Math.round(Math.max(0, Math.min(100, vRaw)));
      }
      paintRange(el.volume);
    }

    if (Array.isArray(s.queue)) {
      var activeIdx = s.queueIndex != null ? Number(s.queueIndex)
        : (s.index != null ? Number(s.index) : currentQueueIndex(s.queue));
      var qKey = JSON.stringify(s.queue) + '#' + activeIdx;
      if (qKey !== lastQueueKey) {
        lastQueueKey = qKey;
        renderQueue(s.queue, activeIdx);
      }
    }
    if (Array.isArray(s.searchResults)) {
      var rKey = JSON.stringify(s.searchResults);
      if (rKey !== lastSearchKey) {
        lastSearchKey = rKey;
        el.searchStatus.textContent = s.searchResults.length ? '' : 'No results.';
        renderSearchResults(s.searchResults);
      }
    }

    if (outputPhone) syncPhoneFromState();
  }

  function currentPos() {
    var pos = Number(snapshot.position != null ? snapshot.position : snapshot.progress) || 0;
    var playing = snapshot.playing === true || snapshot.paused === false;
    return playing ? pos + snapAge / 1000 : pos;
  }
  function updateProgressDisplay() {
    var pos = Math.min(currentPos(), Number(el.progress.max) || 0);
    el.progress.value = Math.floor(pos);
    el.timeCur.textContent = fmtTime(pos);
    paintRange(el.progress);
  }

  function paintRange(input) {
    var min = Number(input.min) || 0;
    var max = Number(input.max) || 100;
    var pct = max > min ? ((input.value - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fill', pct.toFixed(2) + '%');
  }

  function refreshState() {
    if (!deviceToken) return;
    api('/api/remote/state').then(function (r) {
      if (r.status === 401) { logout(true); return; }
      if (r.ok) {
        rememberOrigin();
        setConn(true);
        applySnapshot(r.data && r.data.snapshot ? r.data.snapshot : r.data);
      }
    }).catch(function () {
      setConn(false, 'Cannot reach the PC — looking for it…');
      recoverConnection();
    });
  }

  // ---------- SSE via fetch (EventSource cannot send Authorization headers) ----------
  function connectStream() {
    stopStreamOnly();
    if (!deviceToken) return;
    wantStream = true;
    var ctrl = new AbortController();
    streamAbort = ctrl;
    function stopped() { return !wantStream || streamAbort !== ctrl; }
    fetch('/api/remote/events', {
      headers: { Authorization: 'Bearer ' + deviceToken, Accept: 'text/event-stream' },
      signal: ctrl.signal,
      cache: 'no-store'
    }).then(function (res) {
      if (stopped()) return null;
      if (res.status === 401) { logout(true); return null; }
      if (!res.ok || !res.body) throw new Error('sse http ' + res.status);
      rememberOrigin();
      streamDown(false);
      refreshState();
      return readEventStream(res.body.getReader(), stopped);
    }).catch(function (err) {
      if (stopped()) return;
      scheduleReconnect(err && err.message);
    });
  }

  function readEventStream(reader, stopped) {
    var decoder = new TextDecoder();
    var buf = '';
    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) throw new Error('stream closed');
        buf += decoder.decode(chunk.value, { stream: true });
        var frames = buf.split('\n\n');
        buf = frames.pop();
        frames.forEach(function (frame) {
          var eventName = '';
          var dataLines = [];
          frame.split('\n').forEach(function (l) {
            if (l.indexOf('event:') === 0) eventName = l.slice(6).trim();
            else if (l.indexOf('data:') === 0) dataLines.push(l.slice(5).replace(/^ /, ''));
          });
          var data = dataLines.join('\n');
          if (!data) return;
          try {
            var msg = JSON.parse(data);
            if (!msg || typeof msg !== 'object') return;
            // Server sends the raw snapshot under "event: state"; other
            // events (inbox, download) carry unrelated payloads.
            if (eventName === 'state') applySnapshot(msg);
            else if (!eventName && msg.type === 'state' && msg.snapshot) applySnapshot(msg.snapshot);
          } catch (_) { /* ignore malformed frame */ }
        });
        return pump();
      });
    }
    return pump().catch(function () {
      if (!stopped()) scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    stopStreamOnly();
    if (!deviceToken) return;
    setConn(false, 'Live connection down — retrying…');
    setTimeout(function () {
      // After a couple of quick retries on this origin, sweep the network for
      // the PC (it may have a new IP). Recovery jumps origins via #migrate=.
      if (backoffMs >= MAX_BACKOFF_MS) recoverConnection();
      else connectStream();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }

  function manualReconnect() {
    backoffMs = 1000;
    setConn(false, 'Reconnecting…');
    // Try this origin once; if it's dead the sweep finds the PC elsewhere.
    var alive = fetch('/api/remote/state', {
      headers: { Authorization: 'Bearer ' + deviceToken }, cache: 'no-store'
    }).then(function (res) { return res.ok; }).catch(function () { return false; });
    Promise.race([alive, new Promise(function (r) { setTimeout(function () { r(false); }, 2000); })])
      .then(function (ok) {
        if (ok) {
          connectStream();
          refreshState();
        } else {
          recoverConnection();
        }
      });
  }

  function stopStreamOnly() {
    wantStream = false;
    if (streamAbort) { try { streamAbort.abort(); } catch (_) {} streamAbort = null; }
  }
  function stopStream() {
    stopStreamOnly();
  }
  function streamDown(down) {
    setConn(!down, down ? 'Live connection down — retrying…' : '');
  }

  // ---------- queue ----------
  function renderQueue(queue, activeIdx) {
    el.queueList.textContent = '';
    el.queueEmpty.hidden = queue.length > 0;
    queue.forEach(function (t, i) {
      var li = document.createElement('li');
      li.className = 'tap' + (i === activeIdx ? ' active' : '');
      // Queue entries may be full track objects or bare title strings.
      var qTitle = (typeof t === 'string') ? t : textOf(t.title || t.name);
      var qArtist = (typeof t === 'string') ? '' : textOf(t.artists || t.artist);
      li.innerHTML =
        '<span class="idx">' + (i + 1) + '</span>' +
        '<span class="rmain"><div class="rt">' + esc(qTitle) + '</div>' +
        '<div class="ra">' + esc(qArtist) + '</div></span>';
      li.addEventListener('click', function () { cmd('playIndex', { index: i }); });
      el.queueList.appendChild(li);
    });
  }

  // ---------- search ----------
  function renderSearchResults(results) {
    el.searchResults.textContent = '';
    results.forEach(function (t, i) {
      var li = document.createElement('li');
      li.innerHTML =
        '<span class="idx"></span>' +
        '<span class="rmain"><div class="rt">' + esc(textOf(t.title || t.name)) + '</div>' +
        '<div class="ra">' + esc(textOf(t.artists || t.artist)) + '</div></span>' +
        '<button class="ract" type="button" aria-label="Play">&#9654;</button>' +
        '<button class="ract" type="button" aria-label="Add to queue">+</button>';
      var buttons = li.querySelectorAll('.ract');
      buttons[0].addEventListener('click', function () {
        cmd('enqueue', { track: t, index: i, play: true });
      });
      buttons[1].addEventListener('click', function () {
        cmd('enqueue', { track: t, index: i });
      });
      el.searchResults.appendChild(li);
    });
  }

  el.searchForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = el.searchInput.value.trim();
    if (!q) return;
    el.searchStatus.textContent = 'Searching "' + q + '"…';
    el.searchResults.textContent = '';
    lastSearchKey = ''; // allow the incoming results to render even if identical
    cmd('search', { query: q });
  });

  // ---------- tabs ----------
  function selectTab(which) {
    var tabs = ['queue', 'search', 'library', 'transfer'];
    tabs.forEach(function (name) {
      var active = name === which;
      el['tab' + name.charAt(0).toUpperCase() + name.slice(1)].classList.toggle('active', active);
      el['sec' + name.charAt(0).toUpperCase() + name.slice(1)].hidden = !active;
    });
    if (which === 'library') refreshLibrary();
  }
  el.tabQueue.addEventListener('click', function () { selectTab('queue'); });
  el.tabSearch.addEventListener('click', function () { selectTab('search'); });
  el.tabLibrary.addEventListener('click', function () { selectTab('library'); });
  el.tabTransfer.addEventListener('click', function () { selectTab('transfer'); });

  // ---------- library (PC -> phone browsing) ----------
  var libDir = '';
  var libraryCache = { dirs: [], files: [] };

  // The PC only accepts the device token via the Authorization header, so
  // downloads run through fetch + blob instead of plain navigation.
  function contentDispositionName(header) {
    if (!header) return '';
    var m = header.match(/filename\*=(?:UTF-8|utf-8)''([^;]+)/i);
    if (m) { try { return decodeURIComponent(m[1].replace(/^"|"$/g, '')); } catch (_) {} }
    m = header.match(/filename="?([^";]+)"?/);
    return m ? m[1] : '';
  }

  function downloadRemote(query, fallbackName) {
    return fetch('/api/remote/' + query, {
      headers: { Authorization: 'Bearer ' + deviceToken },
      cache: 'no-store'
    }).then(function (res) {
      if (res.status === 401) { logout(true); return undefined; }
      if (!res.ok) {
        showToast(res.status === 413 ? 'That folder is too large to ZIP' : 'Download failed (' + res.status + ')', 2400);
        return undefined;
      }
      return res.blob().then(function (blob) {
        var name = contentDispositionName(res.headers.get('Content-Disposition')) || fallbackName;
        var link = document.createElement('a');
        var objUrl = URL.createObjectURL(blob);
        link.href = objUrl;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(objUrl); }, 30000);
      });
    }).catch(function () {
      showToast('Download failed — check the PC connection', 2400);
    });
  }

  function refreshLibrary() {
    api('/api/remote/library').then(function (r) {
      if (r.status === 401) { logout(true); return; }
      if (!r.ok || !r.data) return;
      libraryCache = r.data;
      renderLibrary();
    }).catch(function () {});
  }

  function renderLibrary() {
    var dirs = libraryCache.dirs || [];
    var files = libraryCache.files || [];
    var prefix = libDir ? libDir + '/' : '';
    var visibleDirs = dirs.filter(function (d) {
      return d.path.indexOf(prefix) === 0 && d.path.slice(prefix.length).indexOf('/') === -1;
    });
    var visibleFiles = files.filter(function (f) {
      return f.path.indexOf(prefix) === 0 && f.path.slice(prefix.length).indexOf('/') === -1;
    });
    var rootName = (libraryCache.roots && libraryCache.roots[1]) || 'PC';
    var inExtraRoot = false;
    for (var i = 1; i < (libraryCache.roots || []).length; i++) {
      if (libDir === libraryCache.roots[i] || libDir.indexOf(libraryCache.roots[i] + '/') === 0) inExtraRoot = true;
    }

    el.libPath.textContent = libDir ? decodeURIComponent(libDir.split('/').pop()) : rootName + ' inbox';
    el.libUp.hidden = !libDir;
    el.libraryList.textContent = '';
    el.libraryEmpty.hidden = visibleDirs.length + visibleFiles.length > 0;

    visibleDirs.forEach(function (d) {
      var li = document.createElement('li');
      li.className = 'tap';
      li.innerHTML =
        '<span class="idx">&#128193;</span>' +
        '<span class="rmain"><div class="rt">' + esc(d.name) + '</div></span>' +
        '<button class="ract" type="button" aria-label="Download folder as ZIP">&#8681;</button>';
      li.addEventListener('click', function () { libDir = d.path; renderLibrary(); });
      li.querySelector('.ract').addEventListener('click', function (ev) {
        ev.stopPropagation();
        showToast('Preparing ZIP…', 2000);
        downloadRemote('zip?dir=' + encodeURIComponent(d.path),
          (d.name || 'folder') + '.zip');
      });
      el.libraryList.appendChild(li);
    });

    visibleFiles.forEach(function (f) {
      var li = document.createElement('li');
      li.innerHTML =
        '<span class="idx">&#9835;</span>' +
        '<span class="rmain"><div class="rt">' + esc(f.name.replace(/\.[^.]+$/, '')) + '</div>' +
        '<div class="ra">' + fmtSize(f.size) + '</div></span>' +
        '<button class="ract" type="button" aria-label="Play on PC">&#9654;</button>' +
        '<button class="ract" type="button" aria-label="Download">&#8681;</button>';
      var buttons = li.querySelectorAll('.ract');
      buttons[0].addEventListener('click', function () {
        cmd('enqueueLocal', { path: f.path, name: f.name.replace(/\.[^.]+$/, '') });
      });
      buttons[1].addEventListener('click', function () {
        downloadRemote('download?path=' + encodeURIComponent(f.path),
          f.name || 'track');
      });
      el.libraryList.appendChild(li);
    });

    if (!visibleDirs.length && !visibleFiles.length) {
      el.libNote.textContent = inExtraRoot
        ? 'This PC folder is read-only.'
        : 'Upload songs from the Transfer tab, then they appear here.';
    } else {
      el.libNote.textContent = '';
    }
  }

  el.libUp.addEventListener('click', function () {
    libDir = libDir.indexOf('/') >= 0 ? libDir.slice(0, libDir.lastIndexOf('/')) : '';
    renderLibrary();
  });

  function fmtSize(bytes) {
    bytes = Number(bytes) || 0;
    if (bytes > 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
    if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    if (bytes > 1024) return Math.round(bytes / 1024) + ' KB';
    return bytes + ' B';
  }

  // ---------- transfer (phone -> PC uploads) ----------
  var uploadQueue = [];
  var uploadActive = null;
  var uploadPaused = false;

  function queueUploads(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    el.transferNote.textContent = '';
    files.forEach(function (file) {
      uploadQueue.push({
        file: file,
        rel: String(file.webkitRelativePath || file.name || 'upload.bin'),
        li: null, bar: null, retried: false,
      });
    });
    attachUploadRows();
    pumpUploads();
  }

  function attachUploadRows() {
    uploadQueue.forEach(function (item) { attachUploadRow(item); });
    if (uploadActive) attachUploadRow(uploadActive);
    updatePauseButton();
  }

  function attachUploadRow(item) {
    if (item.li) return;
    var li = document.createElement('li');
    var name = item.rel.split('/').pop();
    li.innerHTML = '<div class="uname">' + esc(item.rel) + '</div>' +
      '<div class="ubar"><i></i></div>';
    item.bar = li.querySelector('.ubar i');
    item.li = li;
    el.uploadList.appendChild(li);
  }

  function setUploadProgress(item, pct, cls) {
    if (!item.li) attachUploadRow(item);
    item.bar.style.width = pct.toFixed(1) + '%';
    if (cls) item.li.className = cls;
  }

  function updatePauseButton() {
    var busy = !!uploadActive || uploadQueue.length > 0;
    el.uploadPause.hidden = !busy;
    el.uploadPause.textContent = uploadPaused ? 'Resume uploads' : 'Pause uploads';
  }

  function pumpUploads() {
    if (uploadPaused || uploadActive || !uploadQueue.length) return;
    uploadActive = uploadQueue.shift();
    var item = uploadActive;
    attachUploadRow(item);

    var xhr = new XMLHttpRequest();
    item.xhr = xhr;
    var url = '/api/remote/upload?path=' + encodeURIComponent(item.rel);
    xhr.open('POST', url);
    // The PC accepts the device token only via the Authorization header.
    xhr.setRequestHeader('Authorization', 'Bearer ' + deviceToken);
    xhr.upload.onprogress = function (ev) {
      if (ev.lengthComputable) setUploadProgress(item, (ev.loaded / ev.total) * 100);
    };
    xhr.onload = function () {
      var ok = xhr.status >= 200 && xhr.status < 300;
      if ((xhr.status === 0 || xhr.status >= 500) && !item.retried) {
        item.retried = true;
        item.li.className = '';
        uploadQueue.push(item); // retry once
      } else {
        setUploadProgress(item, ok ? 100 : 100, ok ? 'done' : 'err');
      }
      finishItem();
    };
    xhr.onerror = function () {
      if (!item.retried) {
        item.retried = true;
        uploadQueue.push(item);
      } else {
        setUploadProgress(item, 100, 'err');
      }
      finishItem();
    };
    try { xhr.send(item.file); }
    catch (_) { finishItem(); }

    function finishItem() {
      uploadActive = null;
      updatePauseButton();
      pumpUploads();
      if (!uploadQueue.length && !uploadActive) {
        el.transferNote.textContent = 'Uploads finished — files are in the PC inbox folder.';
      }
    }
  }

  el.uploadPause.addEventListener('click', function () {
    uploadPaused = !uploadPaused;
    if (uploadActive && uploadPaused) {
      try { uploadActive.xhr.abort(); } catch (_) {}
      uploadQueue.unshift(uploadActive); // re-queue at front, progress restarts
      uploadActive = null;
    }
    updatePauseButton();
    pumpUploads();
  });

  el.uploadFiles.addEventListener('change', function () {
    queueUploads(el.uploadFiles.files);
    el.uploadFiles.value = '';
  });
  el.uploadFolder.addEventListener('change', function () {
    queueUploads(el.uploadFolder.files);
    el.uploadFolder.value = '';
  });

  // ---------- transport ----------
  function transportToggle() {
    if (outputPhone) {
      if (phoneAudio.paused) playPhone().catch(function () {});
      else phoneAudio.pause();
    } else {
      cmd('toggle');
    }
  }
  el.btnToggle.addEventListener('click', transportToggle);
  el.btnNext.addEventListener('click', function () {
    if (outputPhone) { nextPhoneTrack(1); return; }
    cmd('next');
  });
  el.btnPrev.addEventListener('click', function () {
    if (outputPhone) { nextPhoneTrack(-1); return; }
    cmd('prev');
  });

  // ---------- extra options row ----------
  el.btnPlayMode.addEventListener('click', function () {
    if (outputPhone) { showToast('Play mode follows the PC while casting', 1800); return; }
    var order = ['loop', 'shuffle', 'single'];
    var next = order[(order.indexOf(lastPlayModeShown) + 1) % order.length] || 'loop';
    cmd('setPlayMode', { mode: next });
    updatePlayModeDisplay(next); // optimistic; PC state confirms on next snapshot
  });
  el.btnDownload.addEventListener('click', function () {
    if (outputPhone) { showToast('Switch output to PC first', 1800); return; }
    showToast('Saving to PC Downloads…', 2000);
    cmd('download').then(function () {
      setTimeout(function () { showToast('Saved (check PC status)', 1600); }, 1200);
    });
  });
  el.btnRefresh.addEventListener('click', manualReconnect);

  el.progress.addEventListener('input', function () {
    seeking = true;
    el.timeCur.textContent = fmtTime(el.progress.value);
    paintRange(el.progress);
  });
  el.progress.addEventListener('change', function () {
    if (outputPhone && phoneAudio && isFinite(phoneAudio.duration) && phoneAudio.duration > 0) {
      phoneAudio.currentTime = Number(el.progress.value);
      setTimeout(function () { seeking = false; }, 800);
    } else {
      cmd('seek', { position: Number(el.progress.value) });
      setTimeout(function () { seeking = false; }, 800);
    }
  });

  el.volume.addEventListener('input', function () {
    paintRange(el.volume);
    phoneVolTouched = outputPhone;
    if (outputPhone && phoneAudio) phoneAudio.volume = clamp01(Number(el.volume.value) / 100);
  });
  el.volume.addEventListener('change', function () {
    if (phoneVolTouched) { phoneVolTouched = false; return; }
    // Desktop clamps volume to 0-1, so send a fraction of the 0-100 slider.
    cmd('volume', { value: clamp01(Number(el.volume.value) / 100) });
  });

  el.tapChip.addEventListener('click', function () {
    playPhone().catch(function () {});
  });

  // ---------- phone output (Spotify-style cast toggle) ----------
  function clamp01(v) { v = Number(v); if (!(v >= 0)) return 0; return v > 1 ? 1 : v; }

  function setOutputMode(phone, silent) {
    outputPhone = !!phone;
    el.outputLabel.textContent = outputPhone ? 'PHONE' : 'PC';
    el.btnOutput.classList.toggle('phone', outputPhone);
    el.btnOutput.setAttribute('aria-pressed', outputPhone ? 'true' : 'false');
    if (!silent) showToast(outputPhone ? 'Playing on this phone' : 'Playing on PC', 1600);
  }

  el.btnOutput.addEventListener('click', function () {
    if (!deviceToken || deadToken || el.viewPlayer.hidden) return;
    if (!outputPhone) {
      cmd('pause');                       // silence the PC speakers first
      setOutputMode(true);
      startPlayablePolling();
      syncPhoneFromState();
    } else {
      setOutputMode(false);
      stopPhoneOutput();                  // pauses local audio, stops polling
      cmd('play');                        // resume playback on the PC
    }
  });

  function startPlayablePolling() {
    stopPlayablePolling();
    pollPlayable();
    playableTimer = setInterval(pollPlayable, PLAYABLE_POLL_MS);
  }
  function stopPlayablePolling() {
    if (playableTimer) { clearInterval(playableTimer); playableTimer = null; }
  }

  function absSrc(src) {
    if (!src) return '';
    if (/^https?:\/\//i.test(src)) return src;
    try { return new URL(src, location.origin).href; } catch (_) { return src; }
  }

  function trackKey(s) {
    if (!s) return '';
    return String(s.title || s.name || (s.song && (s.song.name || s.song.title)) || '') + '|' +
      String(s.duration || s.dt || '');
  }

  function pollPlayable() {
    if (!outputPhone || !deviceToken) return;
    api('/api/remote/playable').then(function (r) {
      if (r.status === 401) { logout(true); return; }
      if (!outputPhone) return;
      if (!r.ok) return;
      var d = r.data || {};
      if (d.kind == null || !d.src) {
        if (trackKey(snapshot) && !lastPlayableKeyWarned()) {
          showToast("This track can't stream to phone", 2000);
          setLastPlayableKeyWarned();
        }
        return;
      }
      loadPhoneSrc(d.src);
    }).catch(function () { /* transient network issue — next tick retries */ });
  }

  var lastWarnKey = '';
  function lastPlayableKeyWarned() { return lastWarnKey === trackKey(snapshot); }
  function setLastPlayableKeyWarned() { lastWarnKey = trackKey(snapshot); }

  function loadPhoneSrc(src) {
    var url = absSrc(src);
    if (url === lastPlayableSrc) return;
    lastPlayableSrc = url;
    phoneAudio.src = url;
    phoneAudio.load();
    playPhone().catch(function () {});
  }

  function playPhone() {
    autoplayBlocked = false;
    el.tapChip.hidden = true;
    var p = phoneAudio.play();
    if (p && typeof p.catch === 'function') {
      return p.catch(function () {
        autoplayBlocked = true;
        el.tapChip.hidden = false;
      });
    }
    return Promise.resolve();
  }

  function stopPhoneOutput() {
    stopPlayablePolling();
    lastPlayableSrc = '';
    lastWarnKey = '';
    autoplayBlocked = false;
    el.tapChip.hidden = true;
    if (phoneAudio) {
      try { phoneAudio.pause(); } catch (_) {}
      try { phoneAudio.removeAttribute('src'); phoneAudio.load(); } catch (_) {}
    }
    if (deviceToken && !deadToken) {
      // Hand control visuals back to PC state.
      el.icPlay.hidden = !(snapshot.playing === true || snapshot.paused === false);
      el.icPause.hidden = !el.icPlay.hidden;
      updateProgressDisplay();
    }
  }

  // The published snapshot has no queueIndex — the queue is a list of title
  // strings — so find the current track by matching its name.
  function currentQueueIndex(queue) {
    if (!Array.isArray(queue)) return -1;
    var cur = textOf(snapshot.title || (snapshot.track && snapshot.track.name));
    if (!cur) return -1;
    for (var i = 0; i < queue.length; i++) {
      if (textOf(queue[i]) === cur) return i;
    }
    return -1;
  }

  function nextPhoneTrack(dir) {
    var q = Array.isArray(snapshot.queue) ? snapshot.queue : [];
    if (!q.length) return;
    var idx = currentQueueIndex(q);
    if (idx < 0) idx = dir > 0 ? -1 : 0; // unknown track: Next starts at top
    idx += dir;
    if (idx < 0 || idx >= q.length) return;
    cmd('playIndex', { index: idx });
  }

  function syncPhoneFromState() {
    // Mirror the PC's play/pause intent onto the local element while casting.
    var playing = snapshot.playing === true || snapshot.paused === false;
    if (!playing && phoneAudio && !phoneAudio.paused) {
      try { phoneAudio.pause(); } catch (_) {}
    }
  }

  function setupPhoneAudio() {
    phoneAudio = $('phone-audio');
    if (!phoneAudio) {
      phoneAudio = document.createElement('audio');
      phoneAudio.id = 'phone-audio';
      phoneAudio.setAttribute('preload', 'none');
      document.body.appendChild(phoneAudio);
    }
    phoneAudio.volume = clamp01(Number(el.volume.value) / 100);
    phoneAudio.addEventListener('play', function () {
      if (!outputPhone) return;
      el.icPlay.hidden = true;
      el.icPause.hidden = false;
      el.tapChip.hidden = true;
      autoplayBlocked = false;
    });
    phoneAudio.addEventListener('pause', function () {
      if (!outputPhone) return;
      el.icPlay.hidden = false;
      el.icPause.hidden = true;
    });
    phoneAudio.addEventListener('ended', function () {
      if (!outputPhone) return;
      nextPhoneTrack(1);
    });
    phoneAudio.addEventListener('timeupdate', function () {
      if (!outputPhone || phoneSeeking || !isFinite(phoneAudio.duration)) return;
      el.progress.max = Math.floor(phoneAudio.duration) || 0;
      el.progress.value = Math.floor(phoneAudio.currentTime);
      el.timeCur.textContent = fmtTime(phoneAudio.currentTime);
      el.timeDur.textContent = fmtTime(phoneAudio.duration);
      paintRange(el.progress);
    });
    phoneAudio.addEventListener('error', function () {
      if (!outputPhone) return;
      showToast('Stream unavailable — check the PC connection', 2000);
    });
  }

  // ---------- ticking + polling fallback ----------
  timers.push(setInterval(function () {
    snapAge += 250;
    if (!seeking && !outputPhone) updateProgressDisplay();
  }, 250));

  timers.push(setInterval(refreshState, POLL_MS));

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshState();
  });
  window.addEventListener('pagehide', stopStream);

  // ---------- reconnect button ----------
  el.btnReconnect.addEventListener('click', manualReconnect);

  // ---------- install prompt ----------
  var deferredInstall = null;

  function installDismissed() {
    var until = 0;
    try { until = Number(localStorage.getItem(INSTALL_LATER_KEY)) || 0; } catch (_) {}
    return Date.now() < until;
  }

  function offerInstall() {
    // Standalone (installed) mode hides #btn-install via CSS media query.
    el.btnInstall.hidden = false;
    if (deferredInstall && !installDismissed()) {
      el.installSheet.hidden = false;
    }
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstall = e;
    // Surface the sheet shortly after connecting, not only at page load —
    // on a fresh phone the prompt often arrives before pairing completes.
    setTimeout(offerInstall, 1500);
  });

  el.installYes.addEventListener('click', function () {
    el.installSheet.hidden = true;
    el.btnInstall.hidden = true;
    if (!deferredInstall) return;
    deferredInstall.prompt();
    deferredInstall.userChoice.finally(function () { deferredInstall = null; });
  });

  el.installLater.addEventListener('click', function () {
    el.installSheet.hidden = true;
    // Ask again tomorrow rather than nagging every load.
    try { localStorage.setItem(INSTALL_LATER_KEY, String(Date.now() + 24 * 60 * 60 * 1000)); } catch (_) {}
  });

  el.btnInstall.addEventListener('click', function () {
    if (!deferredInstall) {
      // iOS Safari never fires beforeinstallprompt — teach the manual path.
      showToast('In Safari: Share menu → "Add to Home Screen"', 3200);
      return;
    }
    el.installSheet.hidden = false;
  });

  window.addEventListener('appinstalled', function () {
    el.installSheet.hidden = true;
    deferredInstall = null;
  });

  // ---------- service worker (only where secure contexts allow it) ----------
  if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || ['localhost', '127.0.0.1'].indexOf(location.hostname) !== -1)) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  // ---------- boot ----------
  setupPhoneAudio();
  paintRange(el.progress);
  paintRange(el.volume);
  if (!consumeMigrateToken() && !pairFromHash()) {
    if (deviceToken) {
      rememberOrigin();
      showPlayer();
      connectStream();
      refreshState();
    } else {
      showPair();
    }
  }
})();
