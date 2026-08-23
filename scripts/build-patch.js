#!/usr/bin/env node
/**
 * build-patch.js — build a patch package that turns a STOCK Mineradio install
 * into Mineradio English (this fork), without reinstalling.
 *
 * How it works:
 *   1. Diff the `main` branch (pristine upstream) against `english` (the fork).
 *   2. Copy every added/modified file into patch/files/, record deletions.
 *   3. Emit apply-patch.cmd + scripts/apply-patch.js so a user can run the
 *      patcher against their installed copy (e.g. D:\Mineradio).
 *
 * Usage:  node scripts/build-patch.js [output-dir]   (default: dist/patch)
 * Apply:  node apply-patch.js "D:\Path\To\Installed Mineradio"
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(process.argv[2] || path.join(REPO_ROOT, 'dist', 'patch'));
const FILES_DIR = path.join(OUT_DIR, 'files');
const MARKER_FILE = 'mineradio-english-patch.json';
// Files that must never be overwritten blindly because they carry machine- or
// install-specific state; we keep a backup instead of deleting them outright.
const BACKUP_SUFFIX = '.stock-backup';

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function listBranchFiles(branch) {
  const out = git(['ls-tree', '-r', '--name-only', '-z', branch]);
  return out.split('\0').filter(Boolean);
}

function readBranchFile(branch, file) {
  try {
    return git(['show', `${branch}:${file}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_) {
    return null; // absent on this branch
  }
}

function main() {
  const upstream = listBranchFiles('main');
  const fork = new Set(listBranchFiles('english'));

  const addedOrModified = [];
  const deleted = [];
  for (const file of upstream) {
    if (!fork.has(file)) {
      deleted.push(file);
      continue;
    }
    if (readBranchFile('main', file) !== readBranchFile('english', file)) {
      addedOrModified.push(file);
    }
  }
  for (const file of fork) {
    if (!upstream.includes(file)) addedOrModified.push(file);
  }

  fs.mkdirSync(FILES_DIR, { recursive: true });
  let copied = 0;
  for (const file of addedOrModified.sort()) {
    // Materialize the english-branch version of the file into files/
    const src = path.join(REPO_ROOT, file);
    if (fs.existsSync(src)) {
      copyFileSyncSafe(src, path.join(FILES_DIR, file));
    } else {
      const blob = readBranchFile('english', file);
      if (blob == null) throw new Error(`Cannot materialize ${file}`);
      mkdirp(path.dirname(path.join(FILES_DIR, file)));
      fs.writeFileSync(path.join(FILES_DIR, file), blob);
    }
    copied += 1;
  }

  const manifest = {
    name: 'Mineradio English patch',
    generator: 'scripts/build-patch.js',
    generatedAt: new Date().toISOString(),
    baseUpstreamCommit: git(['rev-parse', 'main']).trim(),
    forkCommit: git(['rev-parse', 'english']).trim(),
    updated: addedOrModified.sort(),
    deleted: deleted.sort(),
    counts: { updated: addedOrModified.length, deleted: deleted.length },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'patch-manifest.json'), JSON.stringify(manifest, null, 2));

  // ---- applier -------------------------------------------------------------
  const applier = `'use strict';
const fs = require('fs');
const path = require('path');

const PATCH_DIR = __dirname;
const FILES_DIR = path.join(PATCH_DIR, 'files');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PATCH_DIR, 'patch-manifest.json'), 'utf8'));
const MARKER_FILE = ${JSON.stringify(MARKER_FILE)};
const BACKUP_SUFFIX = ${JSON.stringify(BACKUP_SUFFIX)};

const target = process.argv[2];
if (!target || !fs.existsSync(target)) {
  console.error('Usage: node apply-patch.js "<path to installed Mineradio>"');
  process.exit(1);
}
const root = path.resolve(target);

function insideRoot(p) {
  const rel = path.relative(root, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

let applied = 0, backedUp = 0, removed = 0;
for (const file of MANIFEST.updated) {
  const src = path.join(FILES_DIR, file);
  const dest = path.join(root, file);
  if (!insideRoot(dest)) throw new Error('refusing to write outside target: ' + file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    fs.copyFileSync(dest, dest + BACKUP_SUFFIX); // keep the stock copy for uninstall
    backedUp += 1;
  }
  fs.copyFileSync(src, dest);
  applied += 1;
}
for (const file of MANIFEST.deleted) {
  const dest = path.join(root, file);
  if (!fs.existsSync(dest)) continue;
  if (!insideRoot(dest)) continue;
  fs.renameSync(dest, dest + BACKUP_SUFFIX); // rename, never hard delete
  removed += 1;
}

fs.writeFileSync(path.join(root, MARKER_FILE), JSON.stringify({
  patchedAt: new Date().toISOString(),
  manifest,
}, null, 2));

console.log('Patch applied to ' + root);
console.log('  updated files: ' + applied + ' (' + backedUp + ' stock copies kept as *.stock-backup)');
console.log('  removed files: ' + removed + ' (renamed to *.stock-backup)');
console.log('Marker: ' + path.join(root, MARKER_FILE));
`;
  fs.writeFileSync(path.join(OUT_DIR, 'apply-patch.js'), applier.replace(/^\n/, ''));

  const cmd = `@echo off
rem Apply the Mineradio English patch to an installed Mineradio copy.
rem Usage: apply-patch.cmd "D:\\Path\\To\\Installed Mineradio"
if "%~1"=="" (
  echo Usage: apply-patch.cmd "path-to-installed-Mineradio"
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found in PATH.
  exit /b 1
)
node "%~dp0apply-patch.js" %~1
`;
  fs.writeFileSync(path.join(OUT_DIR, 'apply-patch.cmd'), cmd.replace(/\n/g, '\r\n'));

  console.log(`Patch built at ${OUT_DIR}`);
  console.log(`  updated: ${manifest.counts.updated} files`);
  console.log(`  deleted: ${manifest.counts.deleted} files`);
}

function copyFileSyncSafe(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

main();
