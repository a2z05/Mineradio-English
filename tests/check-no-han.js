'use strict';

// EN-FORK: CI gate — fails when user-facing Chinese text sneaks back into the fork
// (e.g. via an upstream merge). Allowlisted paths are data archives / fixtures where
// CJK content is legitimate (lyric data, FX presets shipped by upstream).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const HAN_RE = /[㐀-鿿\u{F900}-\u{FAFF}]/u;

const ALLOWLIST = [
  // upstream data archives with embedded Chinese sample content
  'public/default-user-fx-archive.json',
  'public/js/modules/00-state/05-packaged-fx-archive.js',
  'public/assets/',
  'public/vendor/',
  'docs/',
  'node_modules/',
  'data/',
  '.git/',
  'dist/',
  'CONFLICTS.md',
  // historical upstream release notes (kept verbatim for merge compatibility)
  'CHANGELOG.md',
  // upstream's internal-beta installer (unused by this fork's builds)
  'build/installer-internal-beta.nsh',
];

// Files whose remaining Han is tolerated only until these are cleaned up.
// Keep shrinking this list; new entries require a comment explaining why.
const TEMPORARY_ALLOWLIST = [
  // TODO(i18n): Soda login security-verify page (secondary flow)
  'qishui-auth-v6.js',
  'qishui-auth-v6/',
  'public/css/index.css', // CSS content badges + font-family names
  // Functional-only CJK: provider regexes matching Chinese API values
  // (VIP keywords, favorite-list names), dev scripts asserting upstream text.
  'kugou-api.js',
  'qq-vip-api.js',
  'scripts/',
  // Upstream reference docs kept verbatim (merge compatibility / legal text):
  'NOTICE.md',
  'PRIVACY.md',
  'SECURITY.md',
  'RELEASE.md',
  // Functional CJK that MUST stay Chinese to work:
  // - regexes matching provider/UI content in Chinese APIs (登录, 会员, 现场...)
  // - the login easter-egg password 世界和平
  // - test fixtures exercising Chinese-content handling
  // - electron-builder.internal-beta.json / build/installer-internal-beta.nsh
  //   (upstream's internal-beta channel, unused by this fork)
  'desktop/login-easter-egg-gate.js',
  'desktop/main.js',
  'desktop/wallpaper-engine-library.js',
  'electron-builder.internal-beta.json',
  'build/installer-internal-beta.nsh',
  'lyric-cache.js',
  'public/js/modules/01-scene/02-beat-camera-runtime.js',
  'public/js/modules/02-visual/05-lyrics-fonts-texture.js',
  'public/js/modules/05-playback/00-api-quality-output.js',
  'public/js/modules/05-playback/06-track-detail-lyrics-actions.js',
  'public/js/modules/05-playback/07-search.js',
  'public/js/modules/05-playback/11-provider-fallback.js',
  'public/js/modules/05-playback/12-playback-switch-core.js',
  'public/js/modules/06-lyrics/00-lyrics-fetch-parse.js',
  'public/js/modules/08-account/00-login-easter-egg.js',
  'public/js/modules/08-account/01-login-modal-utils.js',
  'public/js/modules/11-main-loop.js',
  'server.js',
  'tests/',
];

function isAllowlisted(relPath) {
  return ALLOWLIST.some((entry) => relPath === entry || relPath.startsWith(entry))
    || TEMPORARY_ALLOWLIST.some((entry) => relPath === entry || relPath.startsWith(entry));
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (!isAllowlisted(rel + '/')) walk(full, out);
    } else if (/\.(js|html|css|json|md|nsh|txt)$/.test(entry.name)) {
      if (!isAllowlisted(rel)) out.push({ rel, full });
    }
  }
  return out;
}

function stripNonUserFacing(text) {
  // Remove comments (line + block) and console.* lines so diagnostics don't trip the gate.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^[ \t]*console\.(log|warn|error|info|debug)\([^)]*\);?[^\n]*$/gm, '');
}

const files = walk(ROOT, []);
const offenders = [];
for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file.full, 'utf8');
  } catch (_) {
    continue;
  }
  const lines = stripNonUserFacing(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (HAN_RE.test(line)) {
      offenders.push({ file: file.rel, line: i + 1, text: line.trim().slice(0, 80) });
    }
  });
}

if (offenders.length) {
  console.error(`✗ Han census failed — ${offenders.length} offending line(s):`);
  const byFile = {};
  offenders.forEach((o) => {
    byFile[o.file] = byFile[o.file] || [];
    byFile[o.file].push(o);
  });
  for (const [file, items] of Object.entries(byFile)) {
    console.error(`  ${file} (${items.length})`);
    items.slice(0, 5).forEach((o) => console.error(`    :${o.line}  ${o.text}`));
  }
  process.exit(1);
}

console.log(`✓ No unexplained CJK strings across ${files.length} checked files.`);
