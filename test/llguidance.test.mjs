import test from "node:test";
import assert from "node:assert/strict";

import {
  loadBundledLLGuidance,
  loadLLGuidance,
} from "../src/llguidance.node.js";

test("exports the public JS API", () => {
  assert.equal(typeof loadBundledLLGuidance, "function");
  assert.equal(loadLLGuidance, loadBundledLLGuidance);
});

test("does not export internal runtime helper from node entry", async () => {
  const entry = await import("../src/llguidance.node.js");
  assert.equal("createLLGuidanceRuntime" in entry, false);
});

test("loads the pure TypeScript backend", async () => {
  const runtime = await loadBundledLLGuidance();
  assert.equal(typeof runtime.createTokenizer, "function");
  assert.equal(typeof runtime.createInterpreter, "function");
});

test("caches the runtime promise", async () => {
  const first = loadBundledLLGuidance();
  const second = loadBundledLLGuidance();

  assert.equal(first, second);
  assert.equal(await first, await second);
});

test("creates a regex interpreter in node runtime", async () => {
  const runtime = await loadBundledLLGuidance();
  const tokenizer = runtime.createTokenizer({});
  const interpreter = runtime.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "[a-z]+" },
  });

  const result = interpreter.computeMask();
  assert.ok(result.mask || result.stop || result.ffTokens);
});

test("exposes Python-like llguidance runtime API", async () => {
  const llguidance = await loadLLGuidance();
  assert.equal(typeof llguidance.LLTokenizer, "function");
  assert.equal(typeof llguidance.LLInterpreter, "function");
  assert.equal(typeof llguidance.LLMatcher, "function");
  assert.equal(typeof llguidance.grammar_from, "function");

  const tokenizer = new llguidance.LLTokenizer({});
  const grammar = llguidance.LLMatcher.grammar_from_regex("[a-z]+");
  const interpreter = new llguidance.LLInterpreter(tokenizer, grammar);
  const [mask, info] = interpreter.compute_mask();

  assert.ok(mask instanceof Uint8Array || mask === null);
  assert.equal(typeof info, "string");
});

test("uses LLMatcher bitmask and consume_token APIs", async () => {
  const llguidance = await loadLLGuidance();
  const tokenizer = new llguidance.LLTokenizer({});
  const grammar = llguidance.grammar_from("choice", ["a", "b"]);
  const matcher = new llguidance.LLMatcher(tokenizer, grammar);

  assert.equal(llguidance.LLMatcher.validate_grammar(grammar, tokenizer), "");
  assert.ok(matcher.compute_bitmask() instanceof Uint8Array);
  assert.ok(matcher.compute_logit_bias() instanceof Uint8Array);
  assert.equal(typeof matcher.consume_token(97), "boolean");
});

test("runs one exact computeMask then commitToken stream", async () => {
  const runtime = await loadBundledLLGuidance();
  const tokenizer = runtime.createTokenizer({
    tokens: [[97], []],
    eosTokenId: 1,
    specialTokenIds: [1],
  });
  const interpreter = runtime.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "a" },
  });

  const initial = interpreter.computeMask();
  assert.equal("mask" in initial, true);
  assert.equal((initial.mask[0] & 1) !== 0, true);
  assert.deepEqual(interpreter.commitToken(0), {
    stop: false,
    backtrack: 0,
    ffTokens: [],
  });
  const final = interpreter.computeMask();
  assert.equal("mask" in final, true);
  assert.equal((final.mask[0] & 2) !== 0, true);
  assert.deepEqual(interpreter.commitToken(1), {
    stop: true,
    backtrack: 0,
    ffTokens: [],
  });
  assert.deepEqual(interpreter.computeMask(), { stop: true });
});

test("reuses a converted callable tokenizer across single-stream interpreters", async () => {
  const runtime = await loadBundledLLGuidance();
  function tokenizer() {}
  tokenizer._tokenizerJSON = { model: { vocab: { a: 0, "</s>": 1 } } };
  tokenizer.eos_token_id = 1;

  const first = runtime.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "a" },
  });
  delete tokenizer._tokenizerJSON;
  delete tokenizer.eos_token_id;
  const second = runtime.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "a" },
  });

  assert.equal("mask" in first.computeMask(), true);
  assert.equal("mask" in second.computeMask(), true);
});

test("requires a reliable external EOS instead of using the final vocab id", async () => {
  const runtime = await loadBundledLLGuidance();
  function tokenizer() {}
  tokenizer._tokenizerJSON = { model: { vocab: { a: 0, z: 1 } } };

  assert.throws(
    () =>
      runtime.createInterpreter({
        tokenizer,
        response_format: { type: "regex", regex: "a" },
      }),
    /eosTokenId is required/,
  );

  const builtIn = new runtime.LLTokenizer({});
  assert.equal(builtIn.eos_token, 261);
});

test("free and dispose are idempotent and disposed handles fail clearly", async () => {
  const runtime = await loadBundledLLGuidance();
  const tokenizer = runtime.createTokenizer({
    tokens: [[97], []],
    eosTokenId: 1,
  });
  const interpreter = runtime.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "a" },
  });
  interpreter.dispose();
  interpreter.free();
  assert.throws(() => interpreter.computeMask(), /has been freed/);

  const wrapperTokenizer = new runtime.LLTokenizer({});
  const matcher = new runtime.LLMatcher(
    wrapperTokenizer,
    runtime.grammar_from("regex", "a"),
  );
  const replaced = matcher._interpreter;
  matcher.reset();
  assert.throws(() => replaced.computeMask(), /has been freed/);
  matcher.dispose();
  matcher.free();
  assert.throws(() => matcher.compute_bitmask(), /has been freed/);

  wrapperTokenizer.dispose();
  wrapperTokenizer.free();
  assert.throws(
    () => wrapperTokenizer._tokenizer.vocabSize(),
    /has been freed/,
  );
  tokenizer.dispose();
  tokenizer.free();
  assert.throws(() => tokenizer.vocabSize(), /has been freed/);
});
