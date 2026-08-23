'use strict';
// Mineradio Remote — phone web app for controlling the desktop player over LAN.
// Talks to /api/remote/* on the same origin with a Bearer device token.

(function () {
  var TOKEN_KEY = 'mr_device_token';
  var POLL_MS = 5000;
  var MAX_BACKOFF_MS = 30000;

  // ---------- state ----------
  var deviceToken = localStorage.getItem(TOKEN_KEY) || '';
  var snapshot = {};
  var snapAge = 0;            // ms since last snapshot (for local progress ticking)
  var seeking = false;
  var wantStream = false;     // true while an SSE connection should be alive
  var streamAbort = null;
  var backoffMs = 1000;
  var timers = [];

  // ---------- dom ----------
  function $(id) { return document.getElementById(id); }
  var el = {
    viewPair: $('view-pair'), viewPlayer: $('view-player'),
    pairStatus: $('pair-status'),
    connDot: $('conn-dot'), connBanner: $('conn-banner'), connText: $('conn-text'),
    coverImg: $('cover-img'), coverPh: $('cover-ph'),
    title: $('track-title'), artists: $('track-artists'),
    progress: $('progress'), timeCur: $('time-cur'), timeDur: $('time-dur'),
    icPlay: $('ic-play'), icPause: $('ic-pause'),
    btnPrev: $('btn-prev'), btnToggle: $('btn-toggle'), btnNext: $('btn-next'),
    volume: $('volume'),
    tabQueue: $('tab-queue'), tabSearch: $('tab-search'),
    secQueue: $('sec-queue'), secSearch: $('sec-search'),
    queueList: $('queue-list'), queueEmpty: $('queue-empty'),
    searchForm: $('search-form'), searchInput: $('search-input'),
    searchStatus: $('search-status'), searchResults: $('search-results')
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
    var body = Object.assign({ type: type }, payload || {});
    return api('/api/remote/cmd', { method: 'POST', body: body }).then(function (r) {
      if (r.status === 401) logout();
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

  function textOf(v) {
    if (!v) return '';
    if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join(', ');
    if (typeof v === 'object') return v.name || v.title || v.nickname || '';
    return String(v);
  }

  // ---------- views ----------
  function showPair(msg) {
    el.viewPair.hidden = false;
    el.viewPlayer.hidden = true;
    el.pairStatus.classList.remove('busy');
    el.pairStatus.textContent = msg || 'Scan the QR code shown in the PC app to pair.';
  }
  function showPlayer() {
    el.viewPair.hidden = true;
    el.viewPlayer.hidden = false;
    refreshState();
  }
  function logout() {
    deviceToken = '';
    localStorage.removeItem(TOKEN_KEY);
    stopStream();
    showPair('Session expired. Scan the QR code again to pair.');
  }

  function setConn(up, label) {
    el.connDot.className = 'dot' + (up ? ' on' : ' off');
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

  // ---------- snapshots ----------
  function applySnapshot(s) {
    if (!s || typeof s !== 'object') return;
    snapshot = s;
    snapAge = 0;

    el.title.textContent = textOf(s.title || s.name || (s.song && (s.song.name || s.song.title))) || 'Not playing';
    el.artists.textContent = textOf(s.artists || s.artist || (s.song && (s.song.artists || s.song.artist)));

    var cover = s.cover || s.coverUrl || s.picUrl || (s.song && (s.song.cover || s.song.picUrl)) || '';
    if (cover) {
      el.coverImg.onerror = function () {
        el.coverImg.hidden = true;
        el.coverPh.style.display = 'flex';
      };
      el.coverImg.src = cover;
      el.coverImg.hidden = false;
      el.coverPh.style.display = 'none';
    } else {
      el.coverImg.hidden = true;
      el.coverPh.style.display = 'flex';
    }

    var dur = Number(s.duration) || Number(s.dt) || 0;
    el.progress.max = Math.floor(dur);
    el.timeDur.textContent = fmtTime(dur);
    if (!seeking) updateProgressDisplay();

    var playing = s.playing === true || s.paused === false;
    el.icPlay.hidden = playing;
    el.icPause.hidden = !playing;

    if (!seeking && document.activeElement !== el.volume) {
      el.volume.value = Math.round(Number(s.volume != null ? s.volume : s.volumePercent) || 0);
      paintRange(el.volume);
    }

    if (Array.isArray(s.queue)) {
      renderQueue(s.queue, s.queueIndex != null ? Number(s.queueIndex) : (s.index != null ? Number(s.index) : -1));
    }
    if (Array.isArray(s.searchResults)) {
      el.searchStatus.textContent = s.searchResults.length ? '' : 'No results.';
      renderSearchResults(s.searchResults);
    }
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
      if (r.status === 401) { logout(); return; }
      if (r.ok) applySnapshot(r.data && r.data.snapshot ? r.data.snapshot : r.data);
    }).catch(function () {
      setConn(false, 'Cannot reach the PC — retrying…');
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
      if (res.status === 401) { logout(); return null; }
      if (!res.ok || !res.body) throw new Error('sse http ' + res.status);
      setConn(true);
      streamDown(false);
      backoffMs = 1000;
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
          var data = frame.split('\n').filter(function (l) { return l.indexOf('data:') === 0; })
            .map(function (l) { return l.slice(5).replace(/^ /, ''); }).join('\n');
          if (!data) return;
          try {
            var msg = JSON.parse(data);
            if (msg && msg.type === 'state') applySnapshot(msg.snapshot || msg.state || msg.payload);
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
    setTimeout(connectStream, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }

  function stopStreamOnly() {
    wantStream = false;
    if (streamAbort) { try { streamAbort.abort(); } catch (_) {} streamAbort = null; }
  }
  function stopStream() {
    stopStreamOnly();
  }
  function streamDown(down) {
    setConn(!down);
  }

  // ---------- queue ----------
  function renderQueue(queue, activeIdx) {
    el.queueList.textContent = '';
    el.queueEmpty.hidden = queue.length > 0;
    queue.forEach(function (t, i) {
      var li = document.createElement('li');
      li.className = 'tap' + (i === activeIdx ? ' active' : '');
      li.innerHTML =
        '<span class="idx">' + (i + 1) + '</span>' +
        '<span class="rmain"><div class="rt">' + esc(textOf(t.title || t.name)) + '</div>' +
        '<div class="ra">' + esc(textOf(t.artists || t.artist)) + '</div></span>';
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
    cmd('search', { query: q });
  });

  // ---------- tabs ----------
  function selectTab(which) {
    var q = which === 'queue';
    el.tabQueue.classList.toggle('active', q);
    el.tabSearch.classList.toggle('active', !q);
    el.secQueue.hidden = !q;
    el.secSearch.hidden = q;
  }
  el.tabQueue.addEventListener('click', function () { selectTab('queue'); });
  el.tabSearch.addEventListener('click', function () { selectTab('search'); });

  // ---------- transport ----------
  el.btnToggle.addEventListener('click', function () { cmd('toggle'); });
  el.btnNext.addEventListener('click', function () { cmd('next'); });
  el.btnPrev.addEventListener('click', function () { cmd('prev'); });

  el.progress.addEventListener('input', function () {
    seeking = true;
    el.timeCur.textContent = fmtTime(el.progress.value);
    paintRange(el.progress);
  });
  el.progress.addEventListener('change', function () {
    cmd('seek', { position: Number(el.progress.value) });
    setTimeout(function () { seeking = false; }, 800);
  });

  el.volume.addEventListener('input', function () { paintRange(el.volume); });
  el.volume.addEventListener('change', function () {
    cmd('volume', { value: Number(el.volume.value) });
  });

  // ---------- ticking + polling fallback ----------
  timers.push(setInterval(function () {
    snapAge += 250;
    if (!seeking) updateProgressDisplay();
  }, 250));

  timers.push(setInterval(refreshState, POLL_MS));

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshState();
  });
  window.addEventListener('pagehide', stopStream);

  // ---------- service worker (only where secure contexts allow it) ----------
  if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || ['localhost', '127.0.0.1'].indexOf(location.hostname) !== -1)) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  // ---------- boot ----------
  paintRange(el.progress);
  paintRange(el.volume);
  if (!pairFromHash()) {
    if (deviceToken) {
      showPlayer();
      connectStream();
    } else {
      showPair();
    }
  }
})();
