import assert from "node:assert/strict";
import test from "node:test";

import {
  LLGuidanceTokenizer,
  createEngine,
  grammarFromJsonSchema,
} from "../src/engine/core.ts";
import { compileJsonSchema } from "../src/engine/json-schema.ts";

const encoder = new TextEncoder();

function tokenAllowed(result, token) {
  return Boolean(result.mask?.[token >>> 5] & (1 << (token & 31)));
}

function interpreterFor(schema, tokens) {
  const engine = createEngine({ compileJsonSchema });
  const tokenizer = new LLGuidanceTokenizer({
    tokens: [...tokens, new Uint8Array(0)],
    eosTokenId: tokens.length,
  });
  return new engine.LLGuidanceInterpreter(tokenizer, {
    grammar: grammarFromJsonSchema(schema),
  });
}

function maskFor(engine, tokenizer, schema, commits, limits) {
  const interpreter = new engine.LLGuidanceInterpreter(tokenizer, {
    grammar: grammarFromJsonSchema(schema),
    limits,
  });
  for (const token of commits) interpreter.commitToken(token);
  const result = interpreter.computeMask();
  assert.ok("mask" in result);
  return { result, stats: interpreter.maskInstrumentation() };
}

function genericJsonEngine() {
  return createEngine({
    compileJsonSchema(schema, limits) {
      const compiled = compileJsonSchema(schema, limits);
      // Exercise the trie implementation without the open-string signal.
      return { ...compiled, maskEquivalenceKey: undefined };
    },
  });
}

test("open unconstrained string fast mask exactly matches generic transitions", () => {
  const tokens = [
    encoder.encode('"'),
    encoder.encode("plain"),
    encoder.encode("é"),
    encoder.encode('"'),
    encoder.encode("\\"),
    Uint8Array.of(0x1f),
    Uint8Array.of(0xc3),
    Uint8Array.of(0xa9),
    Uint8Array.of(0xc3, 0x28),
    encoder.encode("plain"),
    encoder.encode("special"),
    new Uint8Array(0),
  ];
  const tokenizer = new LLGuidanceTokenizer({
    tokens,
    eosTokenId: 11,
    specialTokenIds: [10],
  });
  const schema = { type: "string" };
  const fast = maskFor(
    createEngine({ compileJsonSchema }),
    tokenizer,
    schema,
    [0],
  );
  const generic = maskFor(genericJsonEngine(), tokenizer, schema, [0]);

  assert.deepEqual(fast.result.mask, generic.result.mask);
  assert.equal(fast.stats.trieNodesVisited, 0);
  assert.ok(generic.stats.trieNodesVisited > 0);
  for (const token of [1, 2, 3, 4, 6, 9])
    assert.equal(tokenAllowed(fast.result, token), true, `token ${token}`);
  for (const token of [5, 7, 8, 10, 11])
    assert.equal(tokenAllowed(fast.result, token), false, `token ${token}`);
});

test("open string fast mask stays disabled for constrained parser states and limits", () => {
  const tokens = [
    encoder.encode("{"),
    encoder.encode('"'),
    encoder.encode("a"),
    encoder.encode("\\"),
    Uint8Array.of(0xc3),
    Uint8Array.of(0xa9),
    encoder.encode("ok"),
    new Uint8Array(0),
  ];
  const tokenizer = new LLGuidanceTokenizer({ tokens, eosTokenId: 7 });
  const cases = [
    [{ type: "string", maxLength: 4 }, [1]],
    [
      {
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: false,
      },
      [0, 1],
    ],
    [{ type: "string" }, [1, 3]],
    [{ type: "string" }, [1, 4]],
    [{ type: "string" }, [1]],
  ];
  for (const [schema, commits] of cases) {
    const limits =
      commits.length === 1 && schema.type === "string"
        ? { maxOutputBytes: 2 }
        : undefined;
    const fast = maskFor(
      createEngine({ compileJsonSchema }),
      tokenizer,
      schema,
      commits,
      limits,
    );
    const generic = maskFor(
      genericJsonEngine(),
      tokenizer,
      schema,
      commits,
      limits,
    );
    assert.deepEqual(fast.result.mask, generic.result.mask);
    assert.ok(fast.stats.trieNodesVisited > 0);
  }
});

test("JSON masks advance incremental states once per tokenizer trie edge", () => {
  const tokenCount = 1024;
  const tokens = Array.from({ length: tokenCount }, (_, index) =>
    encoder.encode(`{"shared":"${index.toString(36).padStart(4, "0")}`),
  );
  tokens.push(new Uint8Array(0));

  const prefixes = new Set();
  let perTokenBytes = 0;
  for (const token of tokens.slice(0, -1)) {
    let prefix = "";
    perTokenBytes += token.length;
    for (const byte of token) {
      prefix += String.fromCharCode(byte);
      prefixes.add(prefix);
    }
  }

  let compiled;
  const engine = createEngine({
    compileJsonSchema(schema, limits) {
      compiled = compileJsonSchema(schema, limits);
      return compiled;
    },
  });
  const tokenizer = new LLGuidanceTokenizer({
    tokens,
    eosTokenId: tokenCount,
  });
  const config = {
    grammar: grammarFromJsonSchema({
      type: "object",
      properties: { shared: { type: "string" } },
      required: ["shared"],
      additionalProperties: false,
    }),
  };
  const interpreter = new engine.LLGuidanceInterpreter(tokenizer, config);

  const result = interpreter.computeMask();
  assert.ok("mask" in result);
  assert.ok(prefixes.size < perTokenBytes / 10);
  assert.equal(compiled.instrumentation().incrementalBytes, prefixes.size);
  assert.equal(compiled.instrumentation().fallbackParses, 0);
  assert.equal(compiled.instrumentation().materializedBytes, 0);

  const afterFirstMask = compiled.instrumentation();
  const secondInterpreter = new engine.LLGuidanceInterpreter(tokenizer, config);
  assert.ok("mask" in secondInterpreter.computeMask());
  const afterSecondMask = compiled.instrumentation();
  assert.equal(
    afterSecondMask.incrementalStatesCreated,
    afterFirstMask.incrementalStatesCreated,
  );
  assert.equal(
    afterSecondMask.transitionCacheHits - afterFirstMask.transitionCacheHits,
    prefixes.size,
  );

  const beforeCommit = compiled.instrumentation().incrementalBytes;
  const statesBeforeCommit =
    compiled.instrumentation().incrementalStatesCreated;
  interpreter.commitToken(0);
  assert.equal(
    compiled.instrumentation().incrementalBytes,
    beforeCommit + tokens[0].length,
  );
  assert.equal(
    compiled.instrumentation().incrementalStatesCreated,
    statesBeforeCommit,
  );
});

test("complex schemas retain the full-prefix compatibility fallback", () => {
  const compiled = compileJsonSchema({
    anyOf: [{ type: "string" }, { type: "integer" }],
  });
  const state = compiled.appendUtf8(
    compiled.initialUtf8,
    encoder.encode('"ok"'),
  );
  assert.equal(compiled.accepting(state), true);
  assert.equal(compiled.instrumentation().fallbackParses, 1);
  assert.equal(compiled.instrumentation().transitionCacheEntries, 0);
  assert.equal(compiled.instrumentation().transitionCacheHits, 0);
});

test("multi-byte appends reuse interned transitions and preserve state bytes", () => {
  const compiled = compileJsonSchema({ type: "string" });
  const input = encoder.encode('"cache me"');
  const first = compiled.appendUtf8(compiled.initialUtf8, input);
  const afterFirst = compiled.instrumentation();
  const second = compiled.appendUtf8(compiled.initialUtf8, input);
  const afterSecond = compiled.instrumentation();

  assert.equal(second, first);
  assert.deepEqual(second.bytes, input);
  assert.equal(compiled.accepting(second), true);
  assert.equal(
    afterSecond.transitionCacheHits - afterFirst.transitionCacheHits,
    input.length,
  );
  assert.equal(
    afterSecond.incrementalStatesCreated,
    afterFirst.incrementalStatesCreated,
  );
});

test("transition cache is bounded and evicts old branches", () => {
  const compiled = compileJsonSchema(
    { type: "string" },
    { maxTransitionCacheEntries: 4 },
  );
  const open = compiled.appendUtf8(compiled.initialUtf8, encoder.encode('"'));
  for (const character of "abcdef")
    compiled.appendUtf8(open, encoder.encode(character));

  const stats = compiled.instrumentation();
  assert.equal(stats.transitionCacheEntries, 4);
  assert.ok(stats.transitionCacheEvictions >= 3);
  assert.throws(
    () =>
      compileJsonSchema(true, {
        maxTransitionCacheEntries: 65_537,
      }),
    /maxTransitionCacheEntries/,
  );
});

test("transition caches and branch states remain compiler-independent", () => {
  const first = compileJsonSchema({ type: "string" });
  const second = compileJsonSchema({ type: "string" });
  const quote = encoder.encode('"');
  const firstOpen = first.appendUtf8(first.initialUtf8, quote);
  const firstOtherBranch = first.appendUtf8(
    first.initialUtf8,
    encoder.encode("["),
  );
  const secondOpen = second.appendUtf8(second.initialUtf8, quote);

  assert.notEqual(firstOpen, secondOpen);
  assert.notEqual(firstOpen, firstOtherBranch);
  assert.equal(first.viable(firstOpen), true);
  assert.equal(first.viable(firstOtherBranch), false);
  assert.equal(second.instrumentation().transitionCacheHits, 0);
  first.appendUtf8(first.initialUtf8, quote);
  assert.equal(first.instrumentation().transitionCacheHits, 1);
  assert.equal(second.instrumentation().transitionCacheHits, 0);
});

test("unconstrained JSON string masks reuse a shared tokenizer/program cache", () => {
  const engine = createEngine({ compileJsonSchema });
  const tokenizer = new LLGuidanceTokenizer({
    tokens: [
      encoder.encode('"'),
      encoder.encode("a"),
      encoder.encode("b"),
      new Uint8Array(0),
    ],
    eosTokenId: 3,
  });
  const config = { grammar: grammarFromJsonSchema({ type: "string" }) };
  const first = new engine.LLGuidanceInterpreter(tokenizer, config);
  const second = new engine.LLGuidanceInterpreter(tokenizer, config);

  first.commitToken(0);
  first.commitToken(1);
  assert.ok("mask" in first.computeMask());
  const afterFirst = first.maskInstrumentation();

  second.commitToken(0);
  second.commitToken(2);
  assert.ok("mask" in second.computeMask());
  const afterSecond = second.maskInstrumentation();

  assert.equal(
    afterSecond.sharedJsonMaskCacheHits,
    afterFirst.sharedJsonMaskCacheHits + 1,
  );
  assert.equal(afterSecond.trieNodesVisited, afterFirst.trieNodesVisited);
});

test("unconstrained string masks stay shared across successive commits", () => {
  const engine = createEngine({ compileJsonSchema });
  const tokenizer = new LLGuidanceTokenizer({
    tokens: [
      encoder.encode('"'),
      encoder.encode("a"),
      encoder.encode("b"),
      new Uint8Array(0),
    ],
    eosTokenId: 3,
  });
  const interpreter = new engine.LLGuidanceInterpreter(tokenizer, {
    grammar: grammarFromJsonSchema({ type: "string" }),
  });

  interpreter.commitToken(0);
  interpreter.commitToken(1);
  assert.ok("mask" in interpreter.computeMask());
  const afterFirst = interpreter.maskInstrumentation();

  interpreter.commitToken(2);
  assert.ok("mask" in interpreter.computeMask());
  const afterSecond = interpreter.maskInstrumentation();

  assert.equal(
    afterSecond.sharedJsonMaskCacheHits,
    afterFirst.sharedJsonMaskCacheHits + 1,
  );
  assert.equal(afterSecond.trieNodesVisited, afterFirst.trieNodesVisited);
});

test("constrained JSON string masks never enter the shared semantic cache", () => {
  const engine = createEngine({ compileJsonSchema });
  const tokenizer = new LLGuidanceTokenizer({
    tokens: [
      encoder.encode('"'),
      encoder.encode("a"),
      encoder.encode("b"),
      new Uint8Array(0),
    ],
    eosTokenId: 3,
  });
  const config = {
    grammar: grammarFromJsonSchema({ type: "string", maxLength: 4 }),
  };
  const first = new engine.LLGuidanceInterpreter(tokenizer, config);
  const second = new engine.LLGuidanceInterpreter(tokenizer, config);

  first.commitToken(0);
  first.commitToken(1);
  assert.ok("mask" in first.computeMask());
  const afterFirst = first.maskInstrumentation();

  second.commitToken(0);
  second.commitToken(2);
  assert.ok("mask" in second.computeMask());
  const afterSecond = second.maskInstrumentation();

  assert.equal(
    afterSecond.sharedJsonMaskCacheHits,
    afterFirst.sharedJsonMaskCacheHits,
  );
  assert.ok(afterSecond.trieNodesVisited > afterFirst.trieNodesVisited);
});

test("partial UTF-8 lead bytes are rejected at an object root", () => {
  const leads = Array.from({ length: 0xf4 - 0xc2 + 1 }, (_, index) =>
    Uint8Array.of(0xc2 + index),
  );
  const interpreter = interpreterFor({ type: "object" }, [
    ...leads,
    encoder.encode("{"),
  ]);
  const mask = interpreter.computeMask();
  for (let token = 0; token < leads.length; token += 1)
    assert.equal(tokenAllowed(mask, token), false, `lead byte token ${token}`);
  assert.equal(tokenAllowed(mask, leads.length), true);
});

test("partial UTF-8 remains viable across token boundaries inside strings", () => {
  const quote = encoder.encode('"');
  const interpreter = interpreterFor({ type: "string" }, [
    quote,
    Uint8Array.of(0xc3),
    Uint8Array.of(0xa9),
  ]);

  interpreter.commitToken(0);
  let mask = interpreter.computeMask();
  assert.equal(tokenAllowed(mask, 1), true);
  assert.equal(tokenAllowed(mask, 2), false);

  interpreter.commitToken(1);
  mask = interpreter.computeMask();
  assert.equal(tokenAllowed(mask, 2), true);
  assert.equal(tokenAllowed(mask, 0), false);

  interpreter.commitToken(2);
  assert.equal(tokenAllowed(interpreter.computeMask(), 0), true);
  interpreter.commitToken(0);
  assert.equal(tokenAllowed(interpreter.computeMask(), 3), true);
});
