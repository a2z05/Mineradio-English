'use strict';
// Pull one function declaration out of a classic-script source file so a test
// can run it in a vm instead of only pattern-matching the text. Brace counting
// has to understand strings, comments and regex literals or it stops at the
// first '/'. Shared by the search tests.
const assert = require('node:assert/strict');

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(declaration, `missing ${name}()`);
  const bodyStart = source.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  let quote = '';
  let regex = false;
  let regexClass = false;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && nextCharacter === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (regex) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '[') regexClass = true;
      else if (character === ']') regexClass = false;
      else if (character === '/' && !regexClass) regex = false;
      continue;
    }
    if (character === '/' && nextCharacter === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '/') {
      let previousIndex = index - 1;
      while (previousIndex >= bodyStart && /\s/.test(source[previousIndex])) previousIndex -= 1;
      const previous = source[previousIndex] || '';
      if (!previous || /[=(,:;!&|?{}\[]/.test(previous)) {
        regex = true;
        regexClass = false;
        continue;
      }
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declaration.index, index + 1);
    }
  }
  throw new Error(`unterminated ${name}()`);
}

function functionBundle(sources, names, prelude, expose) {
  const text = Array.isArray(sources) ? sources.join('\n') : sources;
  return `${prelude || ''}\n${names.map((name) => namedFunctionSource(text, name)).join('\n')}\n${expose || ''}`;
}

module.exports = { namedFunctionSource, functionBundle };
