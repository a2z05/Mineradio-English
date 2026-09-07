'use strict';
// 03-remote-folders-settings.js — "Folders & devices" section inside the
// phone-QR modal. Shows the effective phone-transfer inbox path and library
// folders (GET /api/local/remote-config) and edits them via
// POST /api/local/remote-config. Registered after 02-phone-qr-modal.js.
(function () {
  var container = null;
  var expanded = false;
  var config = null;
  var libraryDirsSnapshot = []; // index-based removal keeps raw paths out of markup

  function el(id) { return document.getElementById(id); }
  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }
  // For attribute contexts (quotes must be escaped too).
  function escAttr(s) {
    return escHtml(s).replace(/"/g, '&quot;');
  }

  function toast(msg) {
    if (typeof showToast === 'function') showToast(msg);
  }

  // Native folder picker if a future preload exposes it; otherwise the
  // inline "type a path" editor is used instead.
  function hasNativePicker() {
    var api = window.desktopWindow;
    return !!(api && typeof api.pickFolder === 'function');
  }

  function pickFolder() {
    var api = window.desktopWindow;
    if (!hasNativePicker()) return Promise.resolve('');
    try {
      return Promise.resolve(api.pickFolder()).then(function (r) {
        if (r && r.canceled) return '';
        return String((r && (r.path || r.folderPath)) || '');
      });
    } catch (e) {
      return Promise.resolve('');
    }
  }

  function setStatus(text, isError) {
    var s = el('rf-set-status');
    if (!s) return;
    s.textContent = text || '';
    s.style.color = isError ? '#ff5367' : '';
  }

  function applyPatch(patch, okMessage) {
    setStatus('Saving…');
    apiJson('/api/local/remote-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    }).then(function (res) {
      if (res && res.ok) {
        config = res.config || null;
        render();
        setStatus(okMessage || '');
        toast(okMessage || 'Saved ✓');
      } else {
        setStatus('Failed: ' + ((res && res.error) || 'unknown error'), true);
      }
    }).catch(function (err) {
      setStatus('Failed: ' + ((err && err.message) || err), true);
    });
  }

  function hideInboxEdit() {
    var row = el('rf-inbox-edit-row');
    if (row) row.style.display = 'none';
  }

  function startInboxEdit() {
    if (hasNativePicker()) {
      pickFolder().then(function (path) {
        if (path) applyPatch({ inboxDir: path }, 'Inbox folder updated ✓');
      });
      return;
    }
    var row = el('rf-inbox-edit-row');
    if (!row) return;
    row.style.display = '';
    var input = el('rf-inbox-input');
    if (input) { input.value = ''; input.focus(); }
    setStatus('');
  }

  function confirmInboxEdit() {
    var input = el('rf-inbox-input');
    var value = input ? String(input.value || '').trim() : '';
    if (!value) {
      setStatus('Enter a folder path first', true);
      return;
    }
    hideInboxEdit();
    applyPatch({ inboxDir: value }, 'Inbox folder updated ✓');
  }

  function hideLibAdd() {
    var row = el('rf-lib-add-row');
    if (row) row.style.display = 'none';
  }

  function startAddLibraryEdit() {
    if (hasNativePicker()) {
      pickFolder().then(function (path) {
        if (path) applyPatch({ addLibraryDir: path }, 'Library folder added ✓');
      });
      return;
    }
    var row = el('rf-lib-add-row');
    if (!row) return;
    row.style.display = '';
    var input = el('rf-lib-add-input');
    if (input) { input.value = ''; input.focus(); }
    setStatus('');
  }

  function confirmAddLibraryEdit() {
    var input = el('rf-lib-add-input');
    var value = input ? String(input.value || '').trim() : '';
    if (!value) {
      setStatus('Enter a folder path first', true);
      return;
    }
    hideLibAdd();
    applyPatch({ addLibraryDir: value }, 'Library folder added ✓');
  }

  function fetchConfig() {
    return apiJson('/api/local/remote-config').then(function (res) {
      if (res && res.ok) {
        config = res;
        render();
      } else {
        setStatus('Failed to load settings', true);
      }
    }).catch(function () {
      setStatus('Settings unavailable — server unreachable', true);
    });
  }

  function dirRow(path, index) {
    return '' +
      '<div style="display:flex;align-items:center;gap:8px;margin-top:6px">' +
        '<span title="' + escAttr(path) + '" style="flex:1;font-size:11.5px;color:#bfc8da;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:5px 9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left">' + escHtml(path) + '</span>' +
        '<button type="button" data-rf-remove="' + index + '" style="background:none;border:0;color:#ff5367;cursor:pointer;font-size:11px;padding:3px 4px">Remove</button>' +
      '</div>';
  }

  function pathEditorRow(rowId, inputId, confirmId, cancelId) {
    return '' +
      '<div id="' + rowId + '" style="display:none;margin-top:7px">' +
        '<input id="' + inputId + '" type="text" placeholder="C:\\Music\\My folder" spellcheck="false" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:7px 10px;color:#eef1f7;font-size:12px">' +
        '<div style="display:flex;justify-content:flex-end;gap:7px;margin-top:6px">' +
          '<button id="' + cancelId + '" class="modal-btn" type="button">Cancel</button>' +
          '<button id="' + confirmId + '" class="modal-btn primary" type="button">Apply</button>' +
        '</div>' +
      '</div>';
  }

  function removeButtonHandler(ev) {
    var idx = parseInt(ev.currentTarget.getAttribute('data-rf-remove'), 10);
    if (!isFinite(idx) || idx < 0 || idx >= libraryDirsSnapshot.length) return;
    applyPatch({ removeLibraryDir: libraryDirsSnapshot[idx] }, 'Folder removed ✓');
  }

  function bindToggle() {
    var t = el('rf-toggle');
    if (!t) return;
    t.addEventListener('click', function () {
      expanded = !expanded;
      render();
      if (expanded) fetchConfig();
    });
  }

  function render() {
    if (!container) return;
    if (!expanded) {
      container.innerHTML =
        '<button id="rf-toggle" type="button" style="width:100%;background:none;border:0;color:#9aa3b5;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;gap:6px;padding:2px 0">' +
          '<span>Folders &amp; devices</span><span>▸</span>' +
        '</button>';
      bindToggle();
      return;
    }

    var inboxDir = config ? (config.inboxDir != null ? config.inboxDir : config.defaultInboxDir) : null;
    var libs = config && Array.isArray(config.libraryDirs) ? config.libraryDirs.slice() : [];
    libraryDirsSnapshot = libs;
    var paired = config && typeof config.pairedDevices === 'number' ? config.pairedDevices : 0;

    container.innerHTML =
      '<button id="rf-toggle" type="button" style="width:100%;background:none;border:0;color:#cfd6e4;cursor:pointer;font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:6px;padding:0 0 9px 0;text-align:left">' +
        '<span>Folders &amp; devices</span><span>▾</span>' +
      '</button>' +
      '<div style="font-size:11.5px;color:rgba(238,241,247,.62);line-height:1.55">' +
        '<div>Files from your phone are saved to:</div>' +
        '<div title="' + escAttr(inboxDir || '') + '" style="margin-top:3px;color:#f4d28a;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left">' + escHtml(inboxDir || '(not set)') + '</div>' +
        '<div style="display:flex;align-items:center;margin-top:8px;gap:8px">' +
          '<button id="rf-change-inbox" class="modal-btn" type="button">Change inbox…</button>' +
          '<button id="rf-reset-inbox" class="modal-btn" type="button">Reset to default</button>' +
        '</div>' +
        '<div style="margin-top:12px">Also watch these library folders:' + (libs.length ? '' : ' <span style="opacity:.6">(none)</span>') + '</div>' +
        libs.map(function (p, i) { return dirRow(p, i); }).join('') +
        '<button id="rf-add-library" class="modal-btn" type="button" style="margin-top:8px">Add folder…</button>' +
      '</div>' +
      '<div style="margin-top:13px;padding-top:11px;border-top:1px solid rgba(255,255,255,.07);display:flex;align-items:center;gap:8px">' +
        '<span style="font-size:11.5px;color:rgba(238,241,247,.62)">Paired devices: <b style="color:#eef1f7">' + paired + '</b></span>' +
        '<button id="rf-unpair-all" class="modal-btn" type="button"' + (paired > 0 ? '' : ' disabled') + ' style="opacity:' + (paired > 0 ? '1' : '.45') + '">Unpair all</button>' +
      '</div>' +
      pathEditorRow('rf-inbox-edit-row', 'rf-inbox-input', 'rf-inbox-confirm', 'rf-inbox-cancel') +
      pathEditorRow('rf-lib-add-row', 'rf-lib-add-input', 'rf-lib-add-confirm', 'rf-lib-add-cancel') +
      '<div id="rf-set-status" style="min-height:14px;margin-top:7px;font-size:11px;color:rgba(238,241,247,.6)"></div>';

    bindToggle();
    el('rf-change-inbox').addEventListener('click', startInboxEdit);
    el('rf-reset-inbox').addEventListener('click', function () {
      applyPatch({ inboxDir: null }, 'Inbox reset to default ✓');
    });
    el('rf-add-library').addEventListener('click', startAddLibraryEdit);
    var unpairBtn = el('rf-unpair-all');
    unpairBtn.addEventListener('click', function () {
      if (unpairBtn.disabled) return;
      applyPatch({ unpairAll: true }, 'All devices unpaired ✓');
    });
    el('rf-inbox-confirm').addEventListener('click', confirmInboxEdit);
    el('rf-inbox-cancel').addEventListener('click', function () { hideInboxEdit(); setStatus(''); });
    el('rf-lib-add-confirm').addEventListener('click', confirmAddLibraryEdit);
    el('rf-lib-add-cancel').addEventListener('click', function () { hideLibAdd(); setStatus(''); });
    var removes = container.querySelectorAll('[data-rf-remove]');
    for (var i = 0; i < removes.length; i++) {
      removes[i].addEventListener('click', removeButtonHandler);
    }
    var inboxInput = el('rf-inbox-input');
    if (inboxInput) inboxInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') confirmInboxEdit();
      if (ev.key === 'Escape') { hideInboxEdit(); setStatus(''); }
    });
    var libInput = el('rf-lib-add-input');
    if (libInput) libInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') confirmAddLibraryEdit();
      if (ev.key === 'Escape') { hideLibAdd(); setStatus(''); }
    });
  }

  // Mount point is created by 02-phone-qr-modal.js (#remote-folders-settings).
  window.initRemoteFoldersSettings = function (mountEl) {
    if (!mountEl) return;
    if (container !== mountEl) {
      container = mountEl;
      if (!expanded) render(); // collapsed placeholder until opened
    }
    refreshRemoteFoldersSettings();
  };

  window.refreshRemoteFoldersSettings = function () {
    if (!container) return;
    if (!expanded) { render(); return; }
    fetchConfig();
  };
})();
