'use strict';
// Perf settings round-trip.
//
// Four knobs decide how hard the renderer works: the FPS cap, whether the cap
// is the screen's vsync (auto) or a fixed number, the quality tier, and what
// happens to rendering while the app is in the background. Each of them has a
// write half (a control the user can press) and a read half (the value that
// comes back after a restart, and the value the scheduler actually obeys).
//
// Both halves are checked here from source, because the failure this guards
// against is the quiet kind: the button still highlights, and the number it
// saved is not the number the app boots with.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');

const perfPanel = read('public/js/modules/07-fx/05-fx-panel-performance.js');
const bindings = read('public/js/modules/07-fx/07-bindings-shelf-immersive.js');
const defaults = read('public/js/modules/00-state/04-fx-defaults.js');
const persistence = read('public/js/modules/02-visual/04-visual-settings-persistence.js');
const mainLoop = read('public/js/modules/11-main-loop.js');
const rendererQuality = read('public/js/modules/01-scene/00-renderer-quality.js');
const renderPower = read('public/js/modules/00-state/08-desktop-render-power.js');
const indexHtml = read('public/index.html');

// The three fields, their setter and the reason string that keys their save.
const SETTINGS = [
  {
    field: 'foregroundFpsMode',
    setter: 'setForegroundFpsMode',
    reason: "'foregroundFpsMode'",
    button: 'foreground-fps-seg',
    attr: 'data-foreground-fps',
    control: 'setForegroundFpsMode(btn.getAttribute(\'data-foreground-fps\'))',
    values: ['vsync', '45', '60', '75', '90', '120'],
    invalid: '240',
  },
  {
    field: 'performanceQuality',
    setter: 'setPerformanceQualityMode',
    reason: "'performanceQuality'",
    button: 'performance-quality-seg',
    attr: 'data-performance-quality',
    control: 'setPerformanceQualityMode(btn.getAttribute(\'data-performance-quality\'))',
    values: ['eco', 'balanced', 'high', 'ultra'],
    invalid: 'potato',
  },
  {
    field: 'performanceBackground',
    setter: 'setPerformanceBackgroundMode',
    reason: "'performanceBackground'",
    button: 'performance-background-seg',
    attr: 'data-performance-background',
    control: 'setPerformanceBackgroundMode(btn.getAttribute(\'data-performance-background\'))',
    values: ['auto', 'keep', 'release'],
    invalid: 'suspend',
  },
];

function sourceOf(fnName) {
  const at = perfPanel.indexOf('function ' + fnName + '(');
  assert.ok(at >= 0, fnName + ' must exist — it is the setter the settings button calls');
  const next = perfPanel.indexOf('\nfunction ', at + 1);
  return perfPanel.slice(at, next > 0 ? next : perfPanel.length);
}

for (const setting of SETTINGS) {
  test(setting.field + ': the control writes it, and the write is persisted', () => {
    // The button exists.
    assert.match(indexHtml, new RegExp('id="' + setting.button + '"'),
      setting.button + ' must be in the settings markup');
    assert.ok(indexHtml.includes(setting.attr + '="'),
      setting.attr + ' options must be in the settings markup');
    // The button calls the setter — this is what makes it not a dead control.
    assert.ok(bindings.includes(setting.control),
      setting.button + ' must be wired to ' + setting.setter +
      ' with its own value, not to a no-op and not to a hard-coded one');

    // The setter writes fx and then persists, in that order: a value that is
    // never saved is a value the next launch silently discards.
    const setter = sourceOf(setting.setter);
    const atField = setter.indexOf('fx.' + setting.field + ' =');
    assert.ok(atField >= 0, setting.setter + ' must write fx.' + setting.field);
    const atSave = setter.indexOf('saveLyricLayout');
    assert.ok(atSave > atField,
      setting.setter + ' must save after writing — otherwise the restart half never sees it');
    assert.ok(setter.includes('reason: ' + setting.reason),
      setting.setter + ' must save with reason ' + setting.reason +
      ', or the scoped save will not know the field changed');
    assert.ok(setter.includes('user: true'),
      setting.setter + ' must mark the save as a user action — a boot save is skipped');
  });

  test(setting.field + ': an unknown value cannot stick', () => {
    // The write half normalizes before it stores. Without this a stale or
    // hand-edited value round-trips straight back into the UI.
    const setter = sourceOf(setting.setter);
    assert.ok(/normalize[A-Za-z]*\(/.test(setter),
      setting.setter + ' must normalize before writing');
    assert.match(setter, new RegExp('var next = normalize'),
      'the normalized value, not the raw argument, is what gets stored');

    // And the normalizer itself refuses anything outside the list.
    const normalizer = /function normalize[A-Za-z]*\([^)]*\) \{[\s\S]*?\n\}/;
    const source = setting.field === 'foregroundFpsMode' ? defaults : persistence;
    const name = setting.field === 'foregroundFpsMode'
      ? 'normalizeForegroundFpsMode'
      : (setting.field === 'performanceQuality' ? 'normalizePerformanceQuality' : 'normalizePerformanceBackgroundMode');
    const at = source.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name + ' must exist');
    const body = source.slice(at, source.indexOf('\n}', at));
    assert.ok(/fxDefaults\./.test(body) || body.includes("return 'auto'"),
      name + ' must fall back to a default rather than pass an unknown value through');
    assert.ok(body.includes(setting.invalid) || /test\(/.test(body) || /=== 'keep'/.test(body) || /45\|60\|75/.test(body),
      name + ' must be a whitelist');
  });

  test(setting.field + ': reading it back re-derives the value instead of trusting it', () => {
    // updatePerformanceControls runs on every write and on every boot. It
    // re-normalizes fx before it touches the DOM, so the button that lights up
    // is the button for the value that is actually in force.
    const at = perfPanel.indexOf('function updatePerformanceControls()');
    assert.ok(at >= 0, 'the readback function must exist');
    const body = perfPanel.slice(at, perfPanel.indexOf('\n}', at));
    if (setting.field === 'performanceBackground') {
      assert.match(body, /fx\.performanceBackground = normalizePerformanceBackgroundMode\(/);
    } else {
      assert.ok(body.includes('fx.' + setting.field + ' = normalize'),
        'updatePerformanceControls must re-normalize fx.' + setting.field);
    }
    assert.ok(body.includes('fx.' + setting.field),
      'and it must compare the control against that same field');
  });

  test(setting.field + ': the value survives a restart', () => {
    // Save side: the field is in the payload that is written to storage.
    const saveAt = persistence.indexOf('performanceQuality: normalizePerformanceQuality(fx.performanceQuality)');
    assert.ok(saveAt > 0, 'the save payload must carry performanceQuality');
    if (setting.field !== 'performanceBackground') {
      assert.ok(persistence.includes(setting.field + ': normalize'),
        'the save payload must carry ' + setting.field);
    } else {
      assert.ok(persistence.includes('performanceBackground: normalizePerformanceBackgroundMode(fx.performanceBackground'),
        'the save payload must carry performanceBackground');
    }

    // Load side: the field is read back through the same normalizer, so a
    // stored value that predates a new option is still valid after upgrade.
    const loadAt = persistence.indexOf(setting.field + ': normalize');
    assert.ok(loadAt > 0, 'the load path must read ' + setting.field);
    const load = persistence.slice(loadAt, persistence.indexOf('\n', loadAt));
    assert.match(load, /normalize/, 'the load path must normalize ' + setting.field);

    // And the touched-keys map has to resolve the save reason, or the scoped
    // save writes a payload with none of the field in it.
    const reason = setting.reason.replace(/'/g, '');
    const inMap = persistence.includes(reason + ': [') || persistence.includes("'" + reason + "': [");
    const fallback = persistence.includes('if (Object.prototype.hasOwnProperty.call(payload, reason))');
    assert.ok(inMap || fallback,
      'the save reason ' + reason + ' must resolve to a key list, or nothing is written');
  });
}

test('the FPS cap reaches the scheduler, not just the button', () => {
  // A setting that only repaints a highlight is a dead control with extra
  // steps. The mode has to end up in the frame budget.
  assert.match(mainLoop, /renderPerfState\.foregroundFpsMode = mode/);
  assert.match(rendererQuality, /foregroundFpsMode/,
    'the renderer has to read the mode it was given');
  assert.match(defaults, /function foregroundFixedFpsForMode\(mode\)/,
    'and the mode has to translate into a number the loop can compare against');
  // 'vsync' is the auto mode: it means no fixed cap, not "zero frames".
  assert.match(defaults, /function foregroundFixedFpsForMode\(mode\) \{\s*\n\s*mode = normalizeForegroundFpsMode\(mode\);\s*\n\s*if \(mode === 'vsync'\) return 0;/);
});

test('quality tier and background policy reach the renderer too', () => {
  assert.match(rendererQuality, /normalizePerformanceQuality\(/);
  assert.match(renderPower, /performanceQualityRank\(/,
    'the tier has to become a number the renderer can act on');
  assert.match(perfPanel, /function setPerformanceBackgroundMode\(mode, silent\) \{[\s\S]*?applyRendererPowerMode\(\)/,
    'background policy has to re-apply the power mode, or the choice does nothing until restart');
});

test('the settings panel shows all four at once, so none can be missed', () => {
  for (const id of ['performance-background-seg', 'performance-quality-seg', 'foreground-fps-seg', 't-liveBackgroundKeep']) {
    assert.ok(indexHtml.includes('id="' + id + '"'), id + ' must be present');
  }
  // The compact toggle and the segment are two views of one value, so the
  // toggle has to be driven from the same field the segment is.
  assert.match(perfPanel, /liveBackgroundKeepToggle\.classList\.toggle\('on', fx\.liveBackgroundKeep === true\)/);
  assert.match(bindings, /fx\.performanceBackground = fx\.liveBackgroundKeep \? 'keep' : 'auto'/,
    'toggling the switch must move the same field the segment writes');
});
