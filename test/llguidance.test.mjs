import test from 'node:test';
import assert from 'node:assert/strict';

import { loadBundledLLGuidance } from '../src/llguidance.node.js';

test('exports the public JS API', () => {
  assert.equal(typeof loadBundledLLGuidance, 'function');
});

test('does not export internal runtime helper from node entry', async () => {
  const entry = await import('../src/llguidance.node.js');
  assert.equal('createLLGuidanceRuntime' in entry, false);
});
