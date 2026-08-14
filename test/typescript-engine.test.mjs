import assert from "node:assert/strict";
import test from "node:test";

import { loadLLGuidance } from "../src/llguidance.node.ts";
import {
  LLGuidanceInterpreter,
  LLGuidanceTokenizer,
  grammarFromRegex,
} from "../src/engine/index.ts";

const llguidance = await loadLLGuidance();
const encoder = new TextEncoder();

function allowed(result, token) {
  return Boolean(result.mask?.[token >>> 5] & (1 << (token & 31)));
}

function schemaCandidateMask(schema, prefix, candidates) {
  const tokenTexts = prefix ? [prefix, ...candidates] : candidates;
  const tokens = tokenTexts.map((text) => [...encoder.encode(text)]);
  tokens.push([]);
  const tokenizer = llguidance.createTokenizer({
    tokens,
    eos_token_id: tokens.length - 1,
  });
  const interpreter = llguidance.createInterpreter({
    tokenizer,
    response_format: { type: "json_schema", json_schema: schema },
  });
  if (prefix) interpreter.commitToken(0);
  const mask = interpreter.computeMask();
  const offset = prefix ? 1 : 0;
  return candidates.map((_, index) => allowed(mask, index + offset));
}

function schemaAccepts(schema, text) {
  const tokenizer = llguidance.createTokenizer({
    tokens: [[...encoder.encode(text)], []],
    eos_token_id: 1,
  });
  const interpreter = llguidance.createInterpreter({
    tokenizer,
    response_format: { type: "json_schema", json_schema: schema },
  });
  if (!allowed(interpreter.computeMask(), 0)) return false;
  interpreter.commitToken(0);
  return allowed(interpreter.computeMask(), 1);
}

test("masks complete multi-byte tokens with the TypeScript regex NFA", () => {
  const tokenizer = llguidance.createTokenizer({
    tokens: [[97], [98], [97, 98], []],
    eos_token_id: 3,
  });
  const interpreter = llguidance.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "ab" },
  });

  const initial = interpreter.computeMask();
  assert.equal(allowed(initial, 0), true);
  assert.equal(allowed(initial, 1), false);
  assert.equal(allowed(initial, 2), true);
  assert.equal(allowed(initial, 3), false);

  interpreter.commitToken(2);
  assert.equal(allowed(interpreter.computeMask(), 3), true);
});

test("matches UTF-8 literal tokens without decoding token boundaries", () => {
  const emoji = [...new TextEncoder().encode("✅")];
  const tokenizer = llguidance.createTokenizer({
    tokens: [emoji.slice(0, 2), emoji.slice(2), emoji, []],
    eos_token_id: 3,
  });
  const interpreter = llguidance.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "✅" },
  });

  assert.equal(allowed(interpreter.computeMask(), 2), true);
  interpreter.commitToken(0);
  assert.equal(allowed(interpreter.computeMask(), 1), true);
  interpreter.commitToken(1);
  assert.equal(allowed(interpreter.computeMask(), 3), true);
});

test("matches Unicode scalars with wildcard and character classes", () => {
  const tokenizer = llguidance.createTokenizer({
    tokens: [
      [...encoder.encode("é")],
      [...encoder.encode("日")],
      [97],
      [98],
      [0xff],
      [],
    ],
    eos_token_id: 5,
  });
  const wildcard = llguidance.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "." },
  });
  assert.deepEqual(
    Array.from({ length: 5 }, (_, token) =>
      allowed(wildcard.computeMask(), token),
    ),
    [true, true, true, true, false],
  );

  const positive = llguidance.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "[é日]" },
  });
  assert.deepEqual(
    Array.from({ length: 5 }, (_, token) =>
      allowed(positive.computeMask(), token),
    ),
    [true, true, false, false, false],
  );

  const negated = llguidance.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "[^a]" },
  });
  assert.deepEqual(
    Array.from({ length: 5 }, (_, token) =>
      allowed(negated.computeMask(), token),
    ),
    [true, true, false, true, false],
  );
});

test("regex trie preserves duplicate terminals and per-id special handling", () => {
  const source = Uint8Array.of(97, 98, 99);
  const tokenizer = new LLGuidanceTokenizer({
    tokens: [
      [97],
      [97, 98],
      source,
      [97, 98, 99],
      [97, 98, 100],
      [120],
      [97, 98],
      [],
      [],
    ],
    specialTokenIds: [6],
    eosTokenId: 8,
  });
  source[0] = 120;
  const exposed = tokenizer.token(2);
  exposed[0] = 120;
  assert.deepEqual(tokenizer.token(2), Uint8Array.of(97, 98, 99));

  const interpreter = new LLGuidanceInterpreter(tokenizer, {
    grammar: grammarFromRegex("abc"),
  });
  const mask = interpreter.computeMask();
  assert.deepEqual(
    Array.from({ length: 9 }, (_, token) => allowed(mask, token)),
    [true, true, true, true, false, false, false, false, false],
  );

  interpreter.commitToken(2);
  assert.equal(allowed(interpreter.computeMask(), 8), true);
});

test("JSON trie deduplicates complete byte sequences without merging token ids", () => {
  const text = [...encoder.encode('"x"')];
  const tokenizer = llguidance.createTokenizer({
    tokens: [text, text, text, [], []],
    special_token_ids: [2],
    eos_token_id: 4,
  });
  const interpreter = llguidance.createInterpreter({
    tokenizer,
    response_format: { type: "json_schema", json_schema: { type: "string" } },
  });

  const mask = interpreter.computeMask();
  assert.deepEqual(
    Array.from({ length: 5 }, (_, token) => allowed(mask, token)),
    [true, true, false, false, false],
  );
  interpreter.commitToken(1);
  assert.equal(allowed(interpreter.computeMask(), 4), true);
});

test("cached masks are isolated and invalidate only after state changes", () => {
  const tokenizer = llguidance.createTokenizer({
    tokens: [[97], [98], [97, 98], [120], []],
    eos_token_id: 4,
  });
  const interpreter = llguidance.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "ab" },
  });

  const initial = interpreter.computeMask();
  initial.mask.fill(0);
  const cached = interpreter.computeMask();
  assert.equal(allowed(cached, 0), true);
  assert.equal(allowed(cached, 2), true);
  cached.mask.fill(0);
  assert.equal(allowed(interpreter.computeMask(), 2), true);

  assert.throws(() => interpreter.commitToken(3), /doesn't satisfy/);
  assert.equal(allowed(interpreter.computeMask(), 0), true);
  interpreter.commitToken(0);
  const advanced = interpreter.computeMask();
  assert.equal(allowed(advanced, 0), false);
  assert.equal(allowed(advanced, 1), true);
  interpreter.commitToken(1);
  assert.equal(allowed(interpreter.computeMask(), 4), true);
  interpreter.commitToken(4);
  assert.deepEqual(interpreter.computeMask(), {
    stop: true,
    reason: "accepted",
  });
});

test("validates ranked candidates without advancing interpreter state", () => {
  const tokenizer = llguidance.createTokenizer({
    tokens: [[97], [98], [97, 98], [120], []],
    eos_token_id: 4,
  });
  const interpreter = llguidance.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "ab" },
  });
  const target = new Uint8Array(5);

  assert.equal(
    interpreter.validateCandidates(Uint32Array.of(0, 3, 2, 0, 99), target),
    target,
  );
  assert.deepEqual([...target], [1, 0, 1, 1, 0]);
  interpreter.commitToken(0);
  assert.deepEqual(
    [...interpreter.validateCandidates(Uint32Array.of(0, 1, 4))],
    [0, 1, 0],
  );
  interpreter.commitToken(1);
  assert.deepEqual(
    [...interpreter.validateCandidates(Uint32Array.of(1, 4))],
    [0, 1],
  );
  assert.throws(
    () => interpreter.validateCandidates(Uint32Array.of(0, 1), new Uint8Array(1)),
    /at least 2 bytes/,
  );
});

test("distinguishes dead ends from successful completion", () => {
  const tokenizer = llguidance.createTokenizer({
    tokens: [[120], []],
    eos_token_id: 1,
  });
  const interpreter = llguidance.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "a" },
  });

  assert.deepEqual(interpreter.computeMask(), {
    stop: true,
    reason: "dead_end",
  });
});

test("clones, rolls back, and discovers forced tokens without mutating", () => {
  const tokenizer = llguidance.createTokenizer({
    tokens: [[97], [98], [120], []],
    eos_token_id: 3,
  });
  const interpreter = llguidance.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "ab" },
  });

  assert.deepEqual(interpreter.computeFastForward(), [0, 1]);
  assert.equal(allowed(interpreter.computeMask(), 0), true);
  interpreter.commitToken(0);
  const clone = interpreter.clone();
  clone.commitToken(1);
  assert.equal(allowed(clone.computeMask(), 3), true);
  assert.equal(allowed(interpreter.computeMask(), 1), true);

  interpreter.rollback(1);
  assert.equal(allowed(interpreter.computeMask(), 0), true);
  assert.throws(() => interpreter.commitToken(1), /doesn't satisfy/);
});

test("enforces configurable generation and compile limits", () => {
  const tokenizer = llguidance.createTokenizer({
    tokens: [[97], [98], []],
    eos_token_id: 2,
  });
  const byteLimited = llguidance.createInterpreter({
    tokenizer,
    response_format: { type: "regex", regex: "ab" },
    limits: { maxOutputBytes: 1 },
  });
  byteLimited.commitToken(0);
  assert.deepEqual(byteLimited.computeMask(), {
    stop: true,
    reason: "dead_end",
  });

  assert.throws(
    () =>
      llguidance.createInterpreter({
        tokenizer,
        response_format: { type: "regex", regex: "a{3}" },
        limits: { maxRegexRepeat: 2 },
      }),
    /repetition count exceeds 2/,
  );
  assert.throws(
    () =>
      llguidance.createInterpreter({
        tokenizer,
        response_format: {
          type: "json_schema",
          json_schema: { allOf: [{ allOf: [{ type: "string" }] }] },
        },
        limits: { maxSchemaDepth: 2 },
      }),
    /schema nesting exceeds maxSchemaDepth \(2\)/,
  );
  assert.throws(
    () =>
      llguidance.createInterpreter({
        tokenizer,
        response_format: { type: "regex", regex: "a" },
        limits: { maxTokens: 0 },
      }),
    /limits.maxTokens must be a positive safe integer/,
  );
});

test("free rejects access even when a mask was cached", () => {
  const tokenizer = new LLGuidanceTokenizer({
    tokens: [[97], []],
    eosTokenId: 1,
  });
  const interpreter = new LLGuidanceInterpreter(tokenizer, {
    grammar: grammarFromRegex("a"),
  });
  interpreter.computeMask();
  interpreter.free();
  assert.throws(() => interpreter.computeMask(), /has been freed/);
});

test("cached masks still observe tokenizer lifetime", () => {
  const tokenizer = new LLGuidanceTokenizer({
    tokens: [[97], []],
    eosTokenId: 1,
  });
  const interpreter = new LLGuidanceInterpreter(tokenizer, {
    grammar: grammarFromRegex("a"),
  });
  interpreter.computeMask();
  tokenizer.free();
  assert.throws(() => interpreter.computeMask(), /has been freed/);
});

test("fails explicitly for Lark during the TypeScript core phase", () => {
  const tokenizer = new llguidance.LLTokenizer({});
  const grammar = llguidance.LLMatcher.grammar_from_lark('start: "a"');
  assert.throws(
    () => new llguidance.LLMatcher(tokenizer, grammar),
    /Lark grammars are not supported by the pure TypeScript core backend yet/,
  );
});

const answerSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

test("prunes schema-incompatible root values before sampling", () => {
  assert.deepEqual(
    schemaCandidateMask(answerSchema, "", [
      "{",
      "[",
      '"x"',
      "null",
      '{"answer":"ok"}',
      '{"answer":1}',
    ]),
    [true, false, false, false, true, false],
  );
});

test("prunes impossible property names and required closure", () => {
  assert.deepEqual(
    schemaCandidateMask(answerSchema, "{", [
      "}",
      '"a',
      '"b',
      '"answer":',
      '"other":',
    ]),
    [false, true, false, true, false],
  );
});

test("prunes property values across token boundaries", () => {
  assert.deepEqual(
    schemaCandidateMask(answerSchema, '{"answer":', [
      '"',
      "null",
      "1",
      "{",
      '"ok"}',
    ]),
    [true, false, false, false, true],
  );
  assert.deepEqual(
    schemaCandidateMask(answerSchema, '{"ans', ['wer":"ok"}', 'wer":42}']),
    [true, false],
  );
});

test("enforces object closure, uniqueness, and terminal roots", () => {
  assert.deepEqual(
    schemaCandidateMask(answerSchema, '{"answer":"ok"', [
      "}",
      ",",
      ',"answer":"again"}',
      " ",
    ]),
    [true, false, false, true],
  );
  assert.deepEqual(
    schemaCandidateMask(answerSchema, '{"answer":"ok"}', [" ", "x"]),
    [false, false],
  );
});

test("prunes array counts and string lengths incrementally", () => {
  assert.deepEqual(
    schemaCandidateMask(
      { type: "array", items: { type: "integer" }, maxItems: 1 },
      "[1",
      ["]", ",", ".0]", "0]"],
    ),
    [true, false, true, true],
  );
  assert.deepEqual(
    schemaCandidateMask({ type: "string", maxLength: 1 }, '"a', ['"', "b"]),
    [true, false],
  );
  assert.deepEqual(
    schemaCandidateMask({ type: "string", minLength: 2 }, '"a', ['"', 'b"']),
    [false, true],
  );
});

test("keeps anyOf object branches coherent", () => {
  const schema = {
    anyOf: [
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "integer" } },
        required: ["a"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { a: { type: "string" }, c: { type: "number" } },
        required: ["a"],
        additionalProperties: false,
      },
    ],
  };
  assert.deepEqual(
    schemaCandidateMask(schema, '{"a":"x",', [
      '"b":1}',
      '"c":1.2}',
      '"b":1,"c":1.2}',
    ]),
    [true, true, false],
  );
});

test("accepts object properties in any order while preserving object constraints", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "integer" }, b: { type: "string" } },
    required: ["a", "b"],
    additionalProperties: false,
    maxProperties: 2,
  };
  assert.deepEqual(
    schemaCandidateMask(schema, "", [
      '{"a":1,"b":"x"}',
      '{"b":"x","a":1}',
      '{"b":"x"}',
      '{"b":"x","a":1,"c":true}',
      '{"a":1,"a":1,"b":"x"}',
    ]),
    [true, true, false, false, false],
  );
});

test("treats complete schema-valid numeric spellings as viable and accepting", () => {
  assert.deepEqual(
    schemaCandidateMask({ type: "integer", const: 1 }, "", [
      "1",
      "1.0",
      "1e0",
      "1.2",
    ]),
    [true, true, true, true],
  );
  assert.equal(schemaAccepts({ type: "integer", const: 1 }, "1.2"), false);
});

test("validates JSON numbers with exact decimal arithmetic", () => {
  assert.equal(
    schemaAccepts({ const: 9007199254740992 }, "9007199254740992"),
    true,
  );
  assert.equal(
    schemaAccepts({ const: 9007199254740992 }, "9007199254740993"),
    false,
  );
  assert.equal(
    schemaAccepts({ const: { n: 9007199254740992 } }, '{"n":9007199254740993}'),
    false,
  );
  assert.equal(schemaAccepts({ enum: [1, 9007199254740992] }, "1e0"), true);
  assert.equal(
    schemaAccepts({ enum: [1, 9007199254740992] }, "9007199254740993"),
    false,
  );
  assert.equal(
    schemaAccepts({ type: "number", maximum: 1e308 }, "1e308"),
    true,
  );
  assert.equal(
    schemaAccepts({ type: "number", maximum: 1e308 }, "1e309"),
    false,
  );
  assert.equal(
    schemaAccepts({ type: "number", minimum: 5e-324 }, "5e-324"),
    true,
  );
  assert.equal(
    schemaAccepts({ type: "number", minimum: 5e-324 }, "4e-324"),
    false,
  );
  assert.equal(
    schemaAccepts({ type: "number", minimum: 5e-324 }, "1e-400"),
    false,
  );
  assert.equal(schemaAccepts({ type: "number", multipleOf: 0.1 }, "0.3"), true);
  assert.equal(
    schemaAccepts({ type: "number", multipleOf: 0.1 }, "0.30000000000000004"),
    false,
  );
  assert.equal(
    schemaAccepts({ type: "number", multipleOf: 0.1 }, "1e400"),
    true,
  );
  assert.equal(schemaAccepts({ type: "integer" }, "1e400"), true);
  assert.equal(schemaAccepts({ type: "integer" }, "1e-400"), false);
});

test("compiles false and contradictory schemas without accepting instances", () => {
  assert.deepEqual(schemaCandidateMask(false, "", ["null", "{}"]), [
    false,
    false,
  ]);
  assert.equal(
    schemaAccepts({ type: "number", minimum: 2, maximum: 1 }, "1"),
    false,
  );
  assert.equal(
    schemaAccepts({ type: "number", minimum: 2, maximum: 1 }, "2"),
    false,
  );
});

test("handles __proto__ as an ordinary object property", () => {
  const schema = {
    type: "object",
    properties: { ["__proto__"]: { type: "integer" } },
    required: ["__proto__"],
    additionalProperties: false,
  };
  assert.deepEqual(schemaCandidateMask(schema, "", ['{"__proto__":1}', "{}"]), [
    true,
    false,
  ]);
});
