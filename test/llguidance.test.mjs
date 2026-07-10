import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadBundledLLGuidance } from '../src/llguidance.node.js';
import * as wasmFactory from '../src/wasm/llguidance_wasm.js';

test('exports the public JS API', () => {
  assert.equal(typeof loadBundledLLGuidance, 'function');
});

test('does not export internal runtime helper from node entry', async () => {
  const entry = await import('../src/llguidance.node.js');
  assert.equal('createLLGuidanceRuntime' in entry, false);
});

test('loads from a provided wasm factory and wasm bytes', async () => {
  let initCalls = 0;
  const wasm = await readFile(new URL('../src/wasm/llguidance_wasm_bg.wasm', import.meta.url));
  const runtime = await loadBundledLLGuidance({
    wasm,
    wasmFactory: {
      ...wasmFactory,
      default(options) {
        initCalls += 1;
        return wasmFactory.default(options);
      },
    },
  });

  assert.equal(initCalls, 1);
  assert.equal(typeof runtime.createTokenizer, 'function');
});

test('loads from a provided wasm factory URL', async () => {
  const wasm = await readFile(new URL('../src/wasm/llguidance_wasm_bg.wasm', import.meta.url));
  const runtime = await loadBundledLLGuidance({
    wasm,
    wasmFactoryUrl: new URL('../src/wasm/llguidance_wasm.js', import.meta.url),
  });

  assert.equal(typeof runtime.createInterpreter, 'function');
});

test('creates a regex interpreter in node runtime', async () => {
  const runtime = await loadBundledLLGuidance();
  const tokenizer = runtime.createTokenizer({});
  const interpreter = runtime.createInterpreter({
    tokenizer,
    response_format: { type: 'regex', regex: '[a-z]+' },
  });

  const result = interpreter.computeMask();
  assert.ok(result.mask || result.stop || result.ffTokens);
});
