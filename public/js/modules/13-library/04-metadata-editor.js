// ============================================================
//  Metadata editor.
//
//  Two things make this safe rather than merely present. Saving always shows
//  the user the exact old → new values before anything is written, and the
//  write itself is refused by the main process unless that confirmation is
//  carried across the bridge as an explicit opt-in. And an edit that the
//  container cannot hold is labelled as a library-only change instead of
//  pretending the file was updated.
// ============================================================

var libraryEditorState = { songs: [], draft: {}, baseline: {} };

var LIBRARY_EDITOR_FIELDS = [
  { key: 'name', label: 'Title' },
  { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' },
  { key: 'albumArtist', label: 'Album artist' },
  { key: 'genre', label: 'Genre' },
  { key: 'year', label: 'Year', numeric: true },
  { key: 'track', label: 'Track', numeric: true },
  { key: 'disc', label: 'Disc', numeric: true },
  { key: 'composer', label: 'Composer' },
  { key: 'comment', label: 'Comment' }
];

function libraryOpenMetadataEditor(songs) {
  var list = Array.isArray(songs) && songs.length ? songs.slice() : [];
  if (!list.length) {
    showToast('Pick a track first');
    return;
  }
  libraryEditorState.songs = list;
  libraryEditorState.draft = {};
  libraryEditorState.baseline = {};

  var mask = document.getElementById('library-metadata-modal');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'library-metadata-modal';
    mask.className = 'modal-mask';
    mask.innerHTML = '<div class="modal track-detail-modal library-metadata-modal">' +
      '<h2>Edit tags</h2>' +
      '<div id="library-metadata-sub" class="library-metadata-sub"></div>' +
      '<div id="library-metadata-form" class="library-metadata-form"></div>' +
      '<div id="library-metadata-note" class="library-metadata-note"></div>' +
      '<div id="library-metadata-diff" class="library-metadata-diff"></div>' +
      '<div class="btn-row">' +
        '<button class="modal-btn" onclick="closeLibraryMetadataEditor()">Cancel</button>' +
        '<button class="modal-btn" id="library-metadata-save" onclick="librarySaveMetadata()">Review &amp; save</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(mask);
    mask.addEventListener('mousedown', function (event) {
      if (event.target === mask) closeLibraryMetadataEditor();
    });
  }

  var single = list.length === 1 ? list[0] : null;
  var baseline = {};
  for (var i = 0; i < LIBRARY_EDITOR_FIELDS.length; i += 1) {
    var field = LIBRARY_EDITOR_FIELDS[i];
    var value = single ? single[field.key] : '';
    baseline[field.key] = value === undefined || value === null ? '' : String(value);
  }
  libraryEditorState.baseline = baseline;
  libraryEditorState.draft = Object.assign({}, baseline);

  var sub = document.getElementById('library-metadata-sub');
  if (sub) {
    sub.textContent = single
      ? (single.name || 'Track') + ' · ' + (single.localPath || '')
      : list.length + ' tracks — only shared fields can be applied to all of them';
  }

  var container = document.getElementById('library-metadata-form');
  if (container) {
    container.innerHTML = LIBRARY_EDITOR_FIELDS.map(function (field) {
      var editable = single || ['album', 'albumArtist', 'genre', 'year', 'composer', 'comment'].indexOf(field.key) >= 0;
      return '<label class="library-metadata-field">' +
        '<span>' + escHtml(field.label) + '</span>' +
        '<input type="text" data-library-field="' + field.key + '"' +
          (editable ? '' : ' disabled placeholder="single track only"') +
          ' value="' + escHtml(baseline[field.key]) + '" autocomplete="off">' +
        '</label>';
    }).join('');
    container.oninput = function (event) {
      var input = event.target.closest ? event.target.closest('[data-library-field]') : null;
      if (!input) return;
      libraryEditorState.draft[input.getAttribute('data-library-field')] = input.value;
      libraryPaintMetadataDiff();
    };
  }

  libraryPaintMetadataDiff();
  openGsapModal(mask);
  setTimeout(function () {
    var first = mask.querySelector('input:not([disabled])');
    if (first) first.focus();
  }, 140);
}

function closeLibraryMetadataEditor() {
  var mask = document.getElementById('library-metadata-modal');
  if (mask) closeGsapModal(mask);
}

function libraryMetadataChanges() {
  var changes = [];
  var draft = libraryEditorState.draft || {};
  var baseline = libraryEditorState.baseline || {};
  for (var i = 0; i < LIBRARY_EDITOR_FIELDS.length; i += 1) {
    var field = LIBRARY_EDITOR_FIELDS[i];
    var next = String(draft[field.key] === undefined ? baseline[field.key] : draft[field.key]).trim();
    var before = String(baseline[field.key] || '').trim();
    if (field.numeric && next) {
      var num = Math.max(0, Math.min(9999, Math.round(Number(next) || 0)));
      next = num ? String(num) : '';
    }
    if (next !== before) changes.push({ field: field, before: before, after: next });
  }
  return changes;
}

function libraryPaintMetadataDiff() {
  var changes = libraryMetadataChanges();
  var diff = document.getElementById('library-metadata-diff');
  var save = document.getElementById('library-metadata-save');
  var note = document.getElementById('library-metadata-note');
  var song = libraryEditorState.songs[0];
  var container = song ? canWriteTagsFor(song) : '';

  if (note) {
    if (!container) {
      note.className = 'library-metadata-note warn';
      note.innerHTML = 'Tag editing is supported for MP3 and FLAC in this build. ' +
        'Nothing will be written for this file, so saving is disabled rather than ' +
        'silently keeping a value the next Refresh would throw away.';
    } else {
      note.className = 'library-metadata-note';
      note.innerHTML = 'Writes to the file as ' + (container === 'mp3' ? 'ID3v2.4' : 'FLAC Vorbis comments') +
        '. Album art and every other tag you do not change are kept.';
    }
  }

  if (diff) {
    if (!changes.length) {
      diff.innerHTML = '<div class="library-metadata-empty">No changes yet.</div>';
    } else {
      diff.innerHTML = '<div class="library-metadata-diff-head">' + changes.length +
        ' change' + (changes.length === 1 ? '' : 's') + ' to write</div>' +
        changes.map(function (change) {
          return '<div class="library-metadata-line"><b>' + escHtml(change.field.label) + '</b>' +
            '<span>' + (change.before ? escHtml(change.before) : '<i>empty</i>') + '</span>' +
            '<em>→</em>' +
            '<span class="new">' + (change.after ? escHtml(change.after) : '<i>empty</i>') + '</span></div>';
        }).join('');
    }
  }
  if (save) {
    save.disabled = !changes.length || !container;
    save.textContent = !container ? 'Not writable' : (changes.length ? 'Review & save' : 'Nothing to save');
  }
}

// The renderer only knows the extension — which is exactly what decides
// whether the main process can write — so the label comes from there.
function canWriteTagsFor(song) {
  var name = String(song && (song.localPath || song.name) || '');
  var ext = name.indexOf('.') >= 0 ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  if (ext === '.mp3') return 'mp3';
  if (ext === '.flac') return 'flac';
  return '';
}

async function librarySaveMetadata() {
  var changes = libraryMetadataChanges();
  if (!changes.length) { showToast('Nothing changed'); return; }
  var song = libraryEditorState.songs[0];
  if (!song) return;
  var id = localFileIdOf(song);
  var container = canWriteTagsFor(song);
  // Refuse before asking, not after: there is nothing on disk this can reach.
  if (!container) { showToast('Tag editing is supported for MP3 and FLAC only'); return; }

  var summary = changes.map(function (change) {
    return change.field.label + ': ' + (change.before || '—') + ' → ' + (change.after || '—');
  }).join('\n');
  if (!window.confirm || !window.confirm('Write these tags to the file?\n\n' + summary)) return;

  var draft = libraryEditorState.draft;
  var payload = {};
  for (var i = 0; i < changes.length; i += 1) {
    payload[changes[i].field.key] = draft[changes[i].field.key];
  }

  if (!window.desktopWindow || typeof window.desktopWindow.writeLocalMusicTags !== 'function') {
    showToast('Editing tags needs the desktop app');
    return;
  }

  var result = await window.desktopWindow.writeLocalMusicTags(id, payload, true);
  if (!result || result.ok !== true) {
    showToast(result && result.error === 'TAG_WRITE_UNSUPPORTED_CONTAINER'
      ? 'That file format cannot be rewritten yet'
      : 'Could not write those tags');
    return;
  }
  if (Array.isArray(result.tracks)) setLocalLibraryStoreTracks(result.tracks);
  showToast('Tags written to the file');

  libraryPaintNav();
  if (libraryPage.open) libraryRebuildRows(false);
  closeLibraryMetadataEditor();
}
