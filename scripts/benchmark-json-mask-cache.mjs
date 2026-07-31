import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  LLGuidanceTokenizer,
  createEngine,
  grammarFromJsonSchema,
} from "../src/engine/core.ts";
import { compileJsonSchema } from "../src/engine/json-schema.ts";

const encoder = new TextEncoder();
const tokenCount = Number(process.env.MASK_VOCAB_SIZE ?? 262_144);
const width = Math.max(4, (tokenCount - 1).toString(36).length);
const tokens = [
  encoder.encode('"'),
  ...Array.from({ length: tokenCount }, (_, index) =>
    encoder.encode(index.toString(36).padStart(width, "0")),
  ),
  new Uint8Array(0),
];
const eosTokenId = tokens.length - 1;
const tokenizer = new LLGuidanceTokenizer({ tokens, eosTokenId });
const engine = createEngine({ compileJsonSchema });
const config = { grammar: grammarFromJsonSchema({ type: "string" }) };
const first = new engine.LLGuidanceInterpreter(tokenizer, config);

first.commitToken(0);
const coldStart = performance.now();
assert.ok("mask" in first.computeMask());
const coldMs = performance.now() - coldStart;
const afterCold = first.maskInstrumentation();
first.commitToken(1);
first.commitToken(2);
const sharedStart = performance.now();
assert.ok("mask" in first.computeMask());
const sharedMs = performance.now() - sharedStart;
const afterShared = first.maskInstrumentation();
assert.equal(afterShared.sharedJsonMaskCacheHits, 1);
assert.equal(afterShared.trieNodesVisited, afterCold.trieNodesVisited);

console.log(`Vocabulary: ${tokenCount} content tokens`);
console.log(
  `Initial open-string trie nodes visited: ${afterCold.trieNodesVisited}`,
);
console.log(
  "Initial open-string mask: packed safe-token bitmask plus exceptions",
);
console.log(
  "Equivalent open-string mask: shared cache hit, 0 additional trie nodes",
);
console.log(
  `Non-contractual timings: initial open string ${coldMs.toFixed(2)} ms; shared ${sharedMs.toFixed(2)} ms`,
);
