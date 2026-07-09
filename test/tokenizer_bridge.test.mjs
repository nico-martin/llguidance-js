import test from 'node:test';
import assert from 'node:assert/strict';

import { extractLLGuidanceTokenizerConfig } from '../src/tokenizer_bridge.js';

test('normalizes an explicit llguidance tokenizer config', () => {
  const tokens = [[123], [125]];
  const config = extractLLGuidanceTokenizerConfig({
    tokens,
    eos_token_id: 1,
    bos_token_id: 0,
    special_token_ids: [0, 1],
  });

  assert.equal(config.tokens, tokens);
  assert.equal(config.eosTokenId, 1);
  assert.equal(config.bosTokenId, 0);
  assert.deepEqual(config.specialTokenIds, [0, 1]);
});

test('extracts UTF-8 token bytes from tokenizer JSON vocab', () => {
  const config = extractLLGuidanceTokenizerConfig({
    _tokenizerJSON: {
      model: {
        vocab: {
          hello: 0,
          'é': 1,
        },
      },
    },
    eos_token_id: 1,
  });

  assert.deepEqual(config.tokens, [
    [104, 101, 108, 108, 111],
    [195, 169],
  ]);
  assert.equal(config.eosTokenId, 1);
});

test('parses tokenizer JSON returned as a string', () => {
  const config = extractLLGuidanceTokenizerConfig({
    json() {
      return JSON.stringify({ model: { vocab: { a: 0 } } });
    },
  });

  assert.deepEqual(config.tokens, [[97]]);
});

test('decodes byte-level BPE token alphabet', () => {
  const config = extractLLGuidanceTokenizerConfig({
    _tokenizerJSON: {
      model: { vocab: { 'Ġword': 0, 'Â©': 1 } },
      decoder: { type: 'ByteLevel' },
    },
  });

  assert.deepEqual(config.tokens[0], [32, 119, 111, 114, 100]);
  assert.deepEqual(config.tokens[1], [194, 169]);
});

test('decodes SentencePiece whitespace marker', () => {
  const config = extractLLGuidanceTokenizerConfig({
    _tokenizerJSON: {
      model: {
        type: 'Unigram',
        vocab: {
          '▁hello': 0,
          world: 1,
        },
      },
    },
  });

  assert.deepEqual(config.tokens[0], [32, 104, 101, 108, 108, 111]);
  assert.deepEqual(config.tokens[1], [119, 111, 114, 108, 100]);
});

test('decodes byte fallback tokens', () => {
  const config = extractLLGuidanceTokenizerConfig({
    _tokenizerJSON: {
      model: { vocab: { '<0x00>': 0, '<0xFF>': 1 } },
    },
  });

  assert.deepEqual(config.tokens, [[0], [255]]);
});

test('uses added token content and special token ids', () => {
  const config = extractLLGuidanceTokenizerConfig({
    _tokenizerJSON: {
      model: { vocab: { a: 0, '<|end|>': 1 } },
      added_tokens: [{ id: 1, content: '<|end|>', special: true }],
    },
    eos_token_id: 1,
  });

  assert.deepEqual(config.tokens[1], [60, 124, 101, 110, 100, 124, 62]);
  assert.deepEqual(config.specialTokenIds, [1]);
});

test('supports Map vocabularies from getVocab()', () => {
  const config = extractLLGuidanceTokenizerConfig({
    getVocab() {
      return new Map([
        ['a', 0],
        ['b', 1],
      ]);
    },
  });

  assert.deepEqual(config.tokens, [[97], [98]]);
});

test('supports idToToken plus vocab size APIs', () => {
  const values = ['a', 'b'];
  const config = extractLLGuidanceTokenizerConfig({
    getVocabSize() {
      return values.length;
    },
    idToToken(id) {
      return values[id];
    },
  });

  assert.deepEqual(config.tokens, [[97], [98]]);
});

test('resolves eos and bos ids from token strings', () => {
  const config = extractLLGuidanceTokenizerConfig({
    _tokenizerJSON: {
      eos_token: '</s>',
      bos_token: '<s>',
      model: { vocab: { '<s>': 0, '</s>': 1 } },
    },
  });

  assert.equal(config.bosTokenId, 0);
  assert.equal(config.eosTokenId, 1);
});

test('throws a useful error when no vocab can be extracted', () => {
  assert.throws(
    () => extractLLGuidanceTokenizerConfig({}),
    /Could not extract tokenizer vocabulary/,
  );
});

test('throws when vocabulary ids are sparse', () => {
  assert.throws(
    () => extractLLGuidanceTokenizerConfig({ _tokenizerJSON: { model: { vocab: { a: 0, c: 2 } } } }),
    /missing token id 1/,
  );
});
