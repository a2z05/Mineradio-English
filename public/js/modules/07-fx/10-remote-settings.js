'use strict';

// ============================================================
//  Phone Remote Settings (FX panel > System > Remote)
// ============================================================
var REMOTE_LAN_STORE_KEY = 'mr_remote_lan';
var remoteLanEnabled = readRemoteLanPreference();

function readRemoteLanPreference() {
  try { return localStorage.getItem(REMOTE_LAN_STORE_KEY) === '1'; } catch (e) {
    return false;
  }
}

function saveRemoteLanPreference() {
  try { localStorage.setItem(REMOTE_LAN_STORE_KEY, remoteLanEnabled ? '1' : '0'); } catch (e) { }
}

function pushRemoteLanConfig() {
  try {
    apiJson('/api/remote/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lanEnabled: remoteLanEnabled })
    }).catch(function () { /* route may be missing; fail soft */ });
  } catch (e) { }
}

function applyRemoteSettingsUi() {
  var toggle = document.getElementById('t-remoteLan');
  if (toggle) toggle.classList.toggle('on', !!remoteLanEnabled);
  refreshRemoteLanUrl();
}

function refreshRemoteLanUrl() {
  var urlNode = document.getElementById('remote-lan-url');
  if (!urlNode) return;
  try {
    fetch('/api/remote/info').then(function (res) { return res.json(); }).then(function (info) {
      var lanUrl = info && (info.lanUrl || info.url);
      if (lanUrl) {
        urlNode.textContent = String(lanUrl);
        return;
      }
      urlNode.textContent = location.hostname ? ('http://' + location.host) : 'Start playback to detect LAN address';
    }).catch(function () {
      urlNode.textContent = location.hostname ? ('http://' + location.host) : 'LAN address unavailable';
    });
  } catch (e) {
    urlNode.textContent = 'LAN address unavailable';
  }
}

function toggleRemoteLan() {
  remoteLanEnabled = !remoteLanEnabled;
  saveRemoteLanPreference();
  applyRemoteSettingsUi();
  showToast(remoteLanEnabled ? 'Phone remote enabled on LAN' : 'Phone remote disabled');
  pushRemoteLanConfig();
}
window.toggleRemoteLan = toggleRemoteLan;

function buildRemoteSettingsPanel() {
  var panel = document.getElementById('fx-panel');
  if (!panel || document.getElementById('remote-settings-panel')) return;
  var host = null;
  var systemPage = document.getElementById('fx-console-page-system');
  if (systemPage) {
    var groups = systemPage.querySelectorAll('.fx-console-group-body');
    host = groups.length ? groups[groups.length - 1] : systemPage;
  } else {
    var cachePanel = document.getElementById('cache-storage-panel');
    host = cachePanel ? cachePanel.parentNode : panel;
  }
  if (!host) return;
  var wrap = document.createElement('div');
  wrap.className = 'cache-storage-panel';
  wrap.id = 'remote-settings-panel';
  wrap.innerHTML =
    '<div class="fx-toggle-grid"><div class="fx-toggle" id="t-remoteLan" onclick="toggleRemoteLan()" title="Let phones and other devices on this network control playback">' +
    '<span>Phone remote: allow LAN connections</span><span class="dot"></span></div></div>' +
    '<code class="cache-storage-path small" id="remote-lan-url">Detecting LAN address...</code>' +
    '<img id="remote-qr-img" src="/remote/qr.svg" alt="Scan to open the phone remote" loading="lazy" style="width:132px;height:132px;background:rgba(255,255,255,0.06);border-radius:10px;padding:6px">';
  host.appendChild(wrap);
  applyRemoteSettingsUi();
}

setTimeout(buildRemoteSettingsPanel, 900);

// ============================================================