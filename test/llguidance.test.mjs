import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadBundledLLGuidance, loadLLGuidance } from '../src/llguidance.node.js';
import * as wasmFactory from '../src/wasm/llguidance_wasm.js';

test('exports the public JS API', () => {
  assert.equal(typeof loadBundledLLGuidance, 'function');
  assert.equal(loadLLGuidance, loadBundledLLGuidance);
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

test('exposes Python-like llguidance runtime API', async () => {
  const llguidance = await loadLLGuidance();
  assert.equal(typeof llguidance.LLTokenizer, 'function');
  assert.equal(typeof llguidance.LLInterpreter, 'function');
  assert.equal(typeof llguidance.LLMatcher, 'function');
  assert.equal(typeof llguidance.grammar_from, 'function');

  const tokenizer = new llguidance.LLTokenizer({});
  const grammar = llguidance.LLMatcher.grammar_from_regex('[a-z]+');
  const interpreter = new llguidance.LLInterpreter(tokenizer, grammar);
  const [mask, info] = interpreter.compute_mask();

  assert.ok(mask instanceof Uint8Array || mask === null);
  assert.equal(typeof info, 'string');
});

test('uses LLMatcher bitmask and consume_token APIs', async () => {
  const llguidance = await loadLLGuidance();
  const tokenizer = new llguidance.LLTokenizer({});
  const grammar = llguidance.grammar_from('choice', ['a', 'b']);
  const matcher = new llguidance.LLMatcher(tokenizer, grammar);

  assert.equal(llguidance.LLMatcher.validate_grammar(grammar, tokenizer), '');
  assert.ok(matcher.compute_bitmask() instanceof Uint8Array);
  assert.ok(matcher.compute_logit_bias() instanceof Uint8Array);
  assert.equal(typeof matcher.consume_token(97), 'boolean');
});
