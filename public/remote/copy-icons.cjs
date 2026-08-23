// Copies build/icon.png to icon-192.png and icon-512.png (run once: node copy-icons.cjs).
const fs = require('fs');
const path = require('path');
var src = path.join(__dirname, '..', '..', 'build', 'icon.png');
fs.copyFileSync(src, path.join(__dirname, 'icon-192.png'));
fs.copyFileSync(src, path.join(__dirname, 'icon-512.png'));
console.log('icons copied from ' + src);
