'use strict';

// ============================================================
//  I18N Runtime (loads BEFORE modules that use t())
// ============================================================
window.I18N = {
  map: {},
  t: function (zhText) {
    return this.map[zhText] || zhText;
  },
  register: function (map) {
    Object.assign(this.map, map);
  }
};
