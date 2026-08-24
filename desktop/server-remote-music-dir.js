'use strict';
// Shared definition of the phone-upload inbox directory so both server.js and
// desktop/main.js resolve it identically.
const path = require('path');

module.exports = {
  REMOTE_MUSIC_DIR: path.join(process.env.MINERADIO_MUSIC_DIR || path.join(__dirname, '..', 'data'), 'music-inbox'),
};
