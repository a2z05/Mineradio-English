'use strict';
// 01-app-proxy-panel.js — per-app proxy settings UI.
// One shared proxy + checkbox per service (Spotify / NetEase / QQ / Kugou /
// Soda), master toggle, live test. Routes: GET/POST /api/spotify/proxy*.
(function () {
  var panelEl = null;
  var backdrops = ['app-proxy-backdrop', 'app-proxy-host', 'app-proxy-port', 'app-proxy-user', 'app-proxy-pass'];
  var APP_LABELS = [
    ['spotify', 'Spotify'],
    ['netease', 'NetEase'],
    ['qq', 'QQ'],
    ['kugou', 'Kugou'],
    ['qishui', 'Soda'],
  ];

  function el(id) { return document.getElementById(id); }

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.id = 'app-proxy-panel';
    panelEl.style.cssText = 'position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;background:rgba(5,7,12,.55);backdrop-filter:blur(8px)';
    panelEl.innerHTML =
      '<div style="width:min(420px,92vw);max-height:86vh;overflow:auto;border-radius:18px;border:1px solid rgba(255,255,255,.09);background:rgba(16,19,28,.88);box-shadow:0 24px 70px rgba(0,0,0,.5);padding:20px 22px;color:#eef1f7;font-size:13px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
          '<b style="font-size:15px">Proxy settings</b>' +
          '<button id="app-proxy-close" type="button" style="background:none;border:0;color:#9aa3b5;font-size:18px;cursor:pointer">✕</button>' +
        '</div>' +
        '<div id="app-proxy-status" style="opacity:.65;margin-bottom:12px;min-height:16px"></div>' +
        '<label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer">' +
          '<input type="checkbox" id="app-proxy-enabled" style="accent-color:#7c5cff;width:16px;height:16px">' +
          '<span>Use proxy</span>' +
        '</label>' +
        '<div style="display:flex;gap:10px;margin-bottom:10px">' +
          '<select id="app-proxy-protocol" style="flex:0 0 96px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:8px;color:inherit">' +
            '<option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option>' +
          '</select>' +
          '<input id="app-proxy-host" placeholder="proxy host" autocomplete="off" style="flex:1;min-width:0;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:8px 10px;color:inherit">' +
          '<input id="app-proxy-port" placeholder="port" type="number" min="1" max="65535" style="flex:0 0 74px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:8px 10px;color:inherit">' +
        '</div>' +
        '<div style="display:flex;gap:10px;margin-bottom:14px">' +
          '<input id="app-proxy-user" placeholder="username (optional)" autocomplete="off" style="flex:1;min-width:0;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:8px 10px;color:inherit">' +
          '<input id="app-proxy-pass" placeholder="password (optional)" type="password" style="flex:1;min-width:0;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:8px 10px;color:inherit">' +
        '</div>' +
        '<div style="margin-bottom:6px;opacity:.75">Use proxy for:</div>' +
        '<div id="app-proxy-apps" style="display:flex;flex-wrap:wrap;gap:8px 14px;margin-bottom:16px"></div>' +
        '<div style="display:flex;gap:10px;align-items:center">' +
          '<button id="app-proxy-test" type="button" style="background:rgba(124,92,255,.16);border:1px solid rgba(124,92,255,.4);border-radius:10px;padding:8px 14px;color:inherit;cursor:pointer">Test</button>' +
          '<button id="app-proxy-save" type="button" style="background:#7c5cff;border:0;border-radius:10px;padding:8px 18px;color:#fff;cursor:pointer;font-weight:600">Save</button>' +
          '<span id="app-proxy-msg" style="flex:1;text-align:right;opacity:.8;min-height:15px"></span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panelEl);

    panelEl.addEventListener('click', function (ev) {
      if (ev.target === panelEl) closeAppProxyPanel();
    });
    el('app-proxy-close').addEventListener('click', closeAppProxyPanel);
    el('app-proxy-save').addEventListener('click', saveProxy);
    el('app-proxy-test').addEventListener('click', testProxy);
    var appsBox = el('app-proxy-apps');
    APP_LABELS.forEach(function (pair) {
      var label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer';
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.app = pair[0];
      box.style.accentColor = '#7c5cff';
      label.appendChild(box);
      label.appendChild(document.createTextNode(pair[1]));
      appsBox.appendChild(label);
    });
    return panelEl;
  }

  function setMsg(text, isError) {
    var msg = el('app-proxy-msg');
    if (msg) {
      msg.textContent = text || '';
      msg.style.color = isError ? '#ff7a7a' : '';
    }
  }

  function refreshStatusLine(status) {
    var line = el('app-proxy-status');
    if (!line) return;
    if (!status.configured) {
      line.textContent = 'No proxy configured.';
      return;
    }
    var selected = APP_LABELS.filter(function (p) { return status.apps && status.apps[p[0]]; }).map(function (p) { return p[1]; });
    line.textContent = (status.enabled ? 'Active' : 'Saved but off') + ' — ' + status.protocol.toUpperCase() + ' ' + status.hostLabel +
      (selected.length ? ' · for: ' + selected.join(', ') : ' · for: nothing');
  }

  function loadIntoForm() {
    apiJson('/api/spotify/proxy').then(function (data) {
      data = data || {};
      var config = data.config || {};
      var status = data.status || {};
      el('app-proxy-enabled').checked = !!config.enabled;
      el('app-proxy-protocol').value = config.protocol || 'http';
      el('app-proxy-host').value = config.host || '';
      el('app-proxy-port').value = config.port || '';
      el('app-proxy-user').value = config.username || '';
      el('app-proxy-pass').value = ''; // masked server-side
      Array.prototype.forEach.call(el('app-proxy-apps').querySelectorAll('input[type=checkbox]'), function (box) {
        box.checked = !!(status.apps && status.apps[box.dataset.app]);
      });
      refreshStatusLine(status);
      setMsg('');
    }).catch(function () {
      setMsg('Could not load proxy settings', true);
    });
  }

  function collectForm() {
    var payload = {
      enabled: el('app-proxy-enabled').checked,
      protocol: el('app-proxy-protocol').value,
      host: el('app-proxy-host').value.trim(),
      port: parseInt(el('app-proxy-port').value, 10) || 0,
      username: el('app-proxy-user').value.trim(),
      password: '',
      apps: {},
    };
    Array.prototype.forEach.call(el('app-proxy-apps').querySelectorAll('input[type=checkbox]'), function (box) {
      payload.apps[box.dataset.app] = box.checked;
    });
    return payload;
  }

  function saveProxy() {
    var payload = collectForm();
    setMsg('Saving…');
    apiJson('/api/spotify/proxy', { method: 'POST', body: JSON.stringify(payload) }).then(function () {
      // Re-load so the server echoes canonical state incl. masked password.
      return apiJson('/api/spotify/proxy');
    }).then(function (data) {
      if (data && data.status) refreshStatusLine(data.status);
      setMsg('Saved ✓');
    }).catch(function (err) {
      setMsg((err && err.message) || 'Save failed', true);
    });
  }

  function testProxy() {
    var appBoxes = el('app-proxy-apps').querySelectorAll('input[type=checkbox]');
    var firstChecked = 'spotify';
    Array.prototype.forEach.call(appBoxes, function (box) {
      if (firstChecked === 'spotify' && !box.checked && box.dataset.app === 'spotify') firstChecked = null;
      if (box.checked) firstChecked = box.dataset.app;
    });
    var target = firstChecked || 'spotify';
    setMsg('Testing ' + target + ' through proxy…');
    apiJson('/api/spotify/proxy/test', { method: 'POST', body: JSON.stringify({ app: target }) })
      .then(function (r) {
        if (r && r.ok) setMsg('OK ✓ (' + target + ', HTTP ' + r.httpStatus + ')');
        else setMsg('Failed: ' + ((r && r.error) || 'unknown'), true);
      })
      .catch(function (err) { setMsg((err && err.message) || 'Test failed', true); });
  }

  window.openAppProxyPanel = function () {
    ensurePanel();
    panelEl.style.display = 'flex';
    loadIntoForm();
  };

  window.closeAppProxyPanel = function () {
    if (panelEl) panelEl.style.display = 'none';
  };
})();
