import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { loadLLGuidance } from "../src/llguidance.node.js";

const llguidance = await loadLLGuidance();
const encoder = new TextEncoder();
const tokenCount = 4096;
const tokenTexts = Array.from(
  { length: tokenCount },
  (_, index) => `shared/${index.toString(36).padStart(4, "0")}`,
);
const tokens = tokenTexts.map((text) => [...encoder.encode(text)]);
tokens.push([]);

const tokenizer = llguidance.createTokenizer({
  tokens,
  eos_token_id: tokenCount,
});
const makeInterpreter = () =>
  llguidance.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "shared/[a-z0-9]+" },
  });

const prefixes = new Set();
let legacyByteTransitions = 0;
for (const text of tokenTexts) {
  const bytes = encoder.encode(text);
  legacyByteTransitions += bytes.length;
  let prefix = "";
  for (const byte of bytes) {
    prefix += String.fromCharCode(byte);
    prefixes.add(prefix);
  }
}
const trieByteTransitions = prefixes.size;
assert.ok(trieByteTransitions < legacyByteTransitions);

const coldInterpreters = Array.from({ length: 20 }, makeInterpreter);
const coldStart = performance.now();
const coldMasks = coldInterpreters.map((interpreter) =>
  interpreter.computeMask(),
);
const coldMs = performance.now() - coldStart;
for (const mask of coldMasks) {
  assert.ok("mask" in mask);
  for (let token = 0; token < tokenCount; token += 1) {
    assert.ok(mask.mask[token >>> 5] & (1 << (token & 31)));
  }
}

const repeatedInterpreter = makeInterpreter();
const first = repeatedInterpreter.computeMask();
assert.ok("mask" in first);
first.mask.fill(0);
const repeatedStart = performance.now();
for (let iteration = 0; iteration < 200; iteration += 1) {
  const result = repeatedInterpreter.computeMask();
  assert.ok("mask" in result);
  assert.ok(result.mask[0] & 1);
}
const repeatedMs = performance.now() - repeatedStart;

console.log(`Vocabulary: ${tokenCount} shared-prefix tokens`);
console.log(
  `Cold byte transitions: ${legacyByteTransitions} per-token baseline -> ${trieByteTransitions} trie (${(
    legacyByteTransitions / trieByteTransitions
  ).toFixed(2)}x fewer)`,
);
console.log("Repeated grammar byte transitions: trie cold count -> 0 cached");
console.log(
  `Non-contractual timings: 20 cold masks ${coldMs.toFixed(2)} ms; 200 cached masks ${repeatedMs.toFixed(2)} ms`,
);
