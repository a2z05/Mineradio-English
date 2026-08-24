'use strict';
// 02-phone-qr-modal.js — "Control from your phone" modal.
// Shows the pairing QR (/remote/qr.svg) and the LAN URL so a phone can open
// the paired remote. Opened from the titlebar phone button.
(function () {
  var modalEl = null;

  function el(id) { return document.getElementById(id); }

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.id = 'phone-remote-modal';
    modalEl.style.cssText = 'position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;background:rgba(5,7,12,.55);backdrop-filter:blur(8px)';
    modalEl.innerHTML =
      '<div style="width:min(360px,92vw);border-radius:18px;border:1px solid rgba(255,255,255,.09);background:rgba(16,19,28,.9);box-shadow:0 24px 70px rgba(0,0,0,.5);padding:22px;color:#eef1f7;text-align:center">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
          '<b style="font-size:15px">Control from your phone</b>' +
          '<button id="phone-remote-close" type="button" style="background:none;border:0;color:#9aa3b5;font-size:18px;cursor:pointer">✕</button>' +
        '</div>' +
        '<div style="background:#fff;border-radius:14px;padding:12px;display:inline-block;margin-bottom:12px">' +
          '<img id="phone-remote-qr" src="/remote/qr.svg" alt="Pairing QR" style="display:block;width:220px;height:220px">' +
        '</div>' +
        '<div style="margin-bottom:10px;font-size:12px;opacity:.75">Scan with your phone camera → the paired remote opens in the browser.</div>' +
        '<input id="phone-remote-url" readonly onclick="this.select()" value="" style="width:100%;box-sizing:border-box;text-align:center;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:8px 10px;color:#bfc8da;font-size:12px">' +
        '<div id="phone-remote-note" style="margin-top:10px;font-size:11px;opacity:.55">Tip: "Add to Home Screen" on your phone installs it as an app.</div>' +
      '</div>';
    document.body.appendChild(modalEl);
    modalEl.addEventListener('click', function (ev) {
      if (ev.target === modalEl) closePhoneRemoteModal();
    });
    el('phone-remote-close').addEventListener('click', closePhoneRemoteModal);
    return modalEl;
  }

  window.openPhoneRemoteModal = function () {
    ensureModal();
    modalEl.style.display = 'flex';
    apiJson('/api/remote/state').then(function (state) {
      if (state && state.lanUrl) el('phone-remote-url').value = state.lanUrl.replace(/\/remote\/?$/, '/remote/');
    }).catch(function () {
      el('phone-remote-url').value = 'Open Settings → Phone Remote for the address';
    });
  };

  window.closePhoneRemoteModal = function () {
    if (modalEl) modalEl.style.display = 'none';
  };

  document.addEventListener('DOMContentLoaded', function () {
    var btn = el('phone-remote-btn');
    if (btn) btn.addEventListener('click', window.openPhoneRemoteModal);
  });
})();
