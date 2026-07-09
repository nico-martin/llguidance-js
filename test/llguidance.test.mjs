import test from 'node:test';
import assert from 'node:assert/strict';

import { loadBundledLLGuidance } from '../src/llguidance.js';

test('exports the public JS API', () => {
  assert.equal(typeof loadBundledLLGuidance, 'function');
});
