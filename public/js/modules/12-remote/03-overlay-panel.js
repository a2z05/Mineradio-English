'use strict';
// 03-overlay-panel.js — Now-playing overlay settings UI.
// Configure the mini bar / in-game overlay: hotkeys (via Hotkeys modal),
// position, opacity, and which elements show. Also opens each overlay.
(function () {
  var panelEl = null;
  var api = window.desktopWindow;

  function el(id) { return document.getElementById(id); }
  function hasOverlayApi() {
    return !!(api && typeof api.getOverlayConfig === 'function');
  }

  var POSITIONS = [
    ['top-left', 'Top left'],
    ['top-right', 'Top right'],
    ['bottom-left', 'Bottom left'],
    ['bottom-right', 'Bottom right'],
  ];

  function ensurePanel() {
    if (panelEl || !hasOverlayApi()) return panelEl;
    panelEl = document.createElement('div');
    panelEl.id = 'overlay-settings-panel';
    panelEl.style.cssText = 'position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;background:rgba(5,7,12,.55);backdrop-filter:blur(8px)';
    var posOptions = POSITIONS.map(function (p) {
      return '<option value="' + p[0] + '">' + p[1] + '</option>';
    }).join('');
    panelEl.innerHTML =
      '<div style="width:min(420px,92vw);border-radius:18px;border:1px solid rgba(255,255,255,.09);background:rgba(16,19,28,.94);box-shadow:0 24px 70px rgba(0,0,0,.5);padding:22px;color:#eef1f7">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">' +
          '<b style="font-size:15px">Overlay & second screen</b>' +
          '<button id="overlay-set-close" type="button" style="background:none;border:0;color:#9aa3b5;font-size:18px;cursor:pointer">✕</button>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-bottom:16px">' +
          '<button id="overlay-open-bar" class="modal-btn" type="button" style="flex:1">Show mini bar</button>' +
          '<button id="overlay-open-game" class="modal-btn" type="button" style="flex:1">In-game overlay</button>' +
          '<button id="overlay-open-screen" class="modal-btn" type="button" style="flex:1">Second screen</button>' +
        '</div>' +
        '<div id="overlay-set-status" style="opacity:.65;font-size:12px;margin-bottom:14px;min-height:16px"></div>' +
        '<div style="display:flex;flex-direction:column;gap:11px;font-size:13px">' +
          '<label style="display:flex;align-items:center;gap:10px">Position' +
            '<select id="overlay-pos" style="flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:7px;color:inherit">' + posOptions + '</select></label>' +
          '<label style="display:flex;align-items:center;gap:10px">Opacity' +
            '<input id="overlay-opacity" type="range" min="20" max="100" value="92" style="flex:1"></label>' +
          '<label style="display:flex;align-items:center;gap:9px"><input type="checkbox" id="overlay-show-art" style="accent-color:#7c5cff;width:15px;height:15px"> Album art</label>' +
          '<label style="display:flex;align-items:center;gap:9px"><input type="checkbox" id="overlay-show-artist" style="accent-color:#7c5cff;width:15px;height:15px"> Artist line</label>' +
          '<label style="display:flex;align-items:center;gap:9px"><input type="checkbox" id="overlay-show-progress" style="accent-color:#7c5cff;width:15px;height:15px"> Progress bar</label>' +
        '</div>' +
        '<div style="margin-top:15px;padding-top:13px;border-top:1px solid rgba(255,255,255,.08);font-size:12px;line-height:1.7;color:#aab3c5">' +
          'Hotkeys are configured in <b>Hotkeys</b> settings — look for "Mini Overlay Bar" and "In-Game Overlay". Defaults: Ctrl+Alt+B (bar), Ctrl+Alt+M (in-game).' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;gap:9px;margin-top:16px">' +
          '<button id="overlay-save" class="modal-btn primary" type="button" style="background:#7c5cff;border:0;border-radius:10px;padding:8px 18px;color:#fff;font-weight:600">Save</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panelEl);
    el('overlay-set-close').addEventListener('click', window.closeOverlayPanel);
    panelEl.addEventListener('click', function (ev) { if (ev.target === panelEl) window.closeOverlayPanel(); });
    el('overlay-open-bar').addEventListener('click', function () {
      if (api.openNowPlayingOverlay) api.openNowPlayingOverlay('bar').then(refreshButtons).catch(function () {});
    });
    el('overlay-open-game').addEventListener('click', function () {
      if (api.openNowPlayingOverlay) api.openNowPlayingOverlay('game').catch(function () {});
      setStatus('In-game overlay opened — use its hotkey to close while gaming');
    });
    el('overlay-open-screen').addEventListener('click', function () {
      if (api.openNowPlayingOverlay) api.openNowPlayingOverlay('screen').catch(function () {});
      setStatus('Second screen opened — drag it to your other display');
    });
    el('overlay-save').addEventListener('click', saveConfig);
    return panelEl;
  }

  function setStatus(text) {
    var s = el('overlay-set-status');
    if (s) s.textContent = text || '';
  }

  function refreshButtons() {
    // Reflect current config into inputs.
    api.getOverlayConfig().then(function (config) {
      if (!config) return;
      if (el('overlay-pos')) el('overlay-pos').value = config.barPosition || 'top-right';
      if (el('overlay-opacity')) el('overlay-opacity').value = Math.round((config.barOpacity != null ? config.barOpacity : .92) * 100);
      if (el('overlay-show-art')) el('overlay-show-art').checked = config.showArt !== false;
      if (el('overlay-show-artist')) el('overlay-show-artist').checked = config.showArtist !== false;
      if (el('overlay-show-progress')) el('overlay-show-progress').checked = config.showProgress !== false;
    }).catch(function () { });
  }

  function saveConfig() {
    var patch = {
      barPosition: el('overlay-pos') ? el('overlay-pos').value : undefined,
      barOpacity: el('overlay-opacity') ? (parseInt(el('overlay-opacity').value, 10) / 100) : undefined,
      showArt: el('overlay-show-art') ? el('overlay-show-art').checked : undefined,
      showArtist: el('overlay-show-artist') ? el('overlay-show-artist').checked : undefined,
      showProgress: el('overlay-show-progress') ? el('overlay-show-progress').checked : undefined,
    };
    api.setOverlayConfig(patch).then(function (result) {
      setStatus(result && result.ok ? 'Saved ✓' : 'Save failed');
    }).catch(function () { setStatus('Save failed'); });
  }

  window.openOverlaySettingsPanel = function () {
    if (!ensurePanel()) {
      if (typeof showToast === 'function') showToast('Overlay requires the desktop app');
      return;
    }
    refreshButtons();
    panelEl.style.display = 'flex';
  };

  window.closeOverlayPanel = function () {
    if (panelEl) panelEl.style.display = 'none';
  };
})();
