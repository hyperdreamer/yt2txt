'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const BACKGROUND_PATH = path.join(ROOT, 'extension', 'background.js');
const SOURCE = fs.readFileSync(BACKGROUND_PATH, 'utf8');

test('background: TRANSCRIPT_TIMEOUT_MS is 120 minutes with a keepalive rationale', () => {
  assert.match(SOURCE, /const TRANSCRIPT_TIMEOUT_MS = 120 \* 60 \* 1000;[^\n]*keepalive/i);
});

test('background: BACKEND_TIMEOUT_MS stays at 12 minutes', () => {
  assert.match(SOURCE, /const BACKEND_TIMEOUT_MS = 12 \* 60 \* 1000;/);
});

test('background: formatTimeoutMessage derives minutes from its argument', () => {
  assert.match(SOURCE, /function formatTimeoutMessage\(ms\) \{/);
  assert.match(SOURCE, /Math\.round\(ms \/ 60000\)/);
});

test('background: the abort message is built from TRANSCRIPT_TIMEOUT_MS', () => {
  assert.match(SOURCE, /formatTimeoutMessage\(TRANSCRIPT_TIMEOUT_MS\)/);
});

test('background: no hard-coded timeout duration remains', () => {
  assert.doesNotMatch(SOURCE, /after \d+ minutes/);
  assert.doesNotMatch(SOURCE, /"Request timed out/);
});
