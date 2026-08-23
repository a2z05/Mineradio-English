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
];

// Files whose remaining Han is tolerated only until these are cleaned up.
// Keep shrinking this list; new entries require a comment explaining why.
const TEMPORARY_ALLOWLIST = [];

function isAllowlisted(relPath) {
  return ALLOWLIST.some((entry) => relPath === entry || relPath.startsWith(entry));
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
