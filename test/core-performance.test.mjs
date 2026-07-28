import assert from "node:assert/strict";
import test from "node:test";

import {
  LLGuidanceTokenizer,
  createEngine,
  grammarFromJsonSchema,
  grammarFromLark,
  grammarFromRegex,
} from "../src/engine/core.ts";
import { compileJsonSchema } from "../src/engine/json-schema.ts";
import { compileRegex } from "../src/engine/regex.ts";

const encoder = new TextEncoder();

function allowed(result, token) {
  return Boolean(result.mask?.[token >>> 5] & (1 << (token & 31)));
}

function tokenizer(tokens) {
  return new LLGuidanceTokenizer({
    tokens: [...tokens.map((token) => encoder.encode(token)), new Uint8Array()],
    eosTokenId: tokens.length,
  });
}

test("compiled regex programs and learned transitions are shared by engine", () => {
  let compiles = 0;
  let advances = 0;
  let compiled;
  const engine = createEngine({
    compileRegex(source, limits) {
      compiles += 1;
      compiled = compileRegex(source, limits);
      return {
        initialState: compiled.initialState,
        advance(state, bytes) {
          advances += bytes.length;
          return compiled.advance(state, bytes);
        },
        viable: (state) => compiled.viable(state),
        accepting: (state) => compiled.accepting(state),
      };
    },
  });
  const tokens = tokenizer(["a"]);
  const grammar = grammarFromRegex("a");
  const first = new engine.LLGuidanceInterpreter(tokens, {
    grammar,
    limits: { maxTokens: 1 },
  });
  first.computeMask();
  const learned = compiled.advance(compiled.initialState, encoder.encode("a"));

  const second = new engine.LLGuidanceInterpreter(tokens, {
    grammar,
    limits: { maxTokens: 2 },
  });
  assert.equal(compiles, 1, "generation-only limits do not split the cache");
  assert.strictEqual(
    compiled.advance(compiled.initialState, encoder.encode("a")),
    learned,
  );
  assert.equal(allowed(second.computeMask(), 0), true);
  const beforeCommit = advances;
  second.commitToken(0);
  assert.equal(
    advances,
    beforeCommit + 1,
    "commit advances the selected token once",
  );

  new engine.LLGuidanceInterpreter(tokens, {
    grammar,
    limits: { maxRegexRepeat: 9_999 },
  });
  assert.equal(compiles, 2, "compile limits are part of the key");
});

test("regex/Lark cache is bounded and keeps compiler kinds separate", () => {
  let regexCompiles = 0;
  let larkCompiles = 0;
  const engine = createEngine({
    compileRegex(source, limits) {
      regexCompiles += 1;
      return compileRegex(source, limits);
    },
    compileLark() {
      larkCompiles += 1;
      const state = {};
      return {
        initialState: state,
        advance: () => state,
        viable: () => true,
        accepting: () => true,
        captures: () => [],
      };
    },
  });
  const tokens = tokenizer(["a"]);
  new engine.LLGuidanceInterpreter(tokens, {
    grammar: grammarFromLark("a"),
  });
  new engine.LLGuidanceInterpreter(tokens, {
    grammar: grammarFromLark("a"),
  });
  assert.equal(larkCompiles, 1);

  for (let index = 0; index <= 64; index += 1) {
    new engine.LLGuidanceInterpreter(tokens, {
      grammar: grammarFromRegex(`a(?:){${index + 1}}`),
    });
  }
  new engine.LLGuidanceInterpreter(tokens, {
    grammar: grammarFromRegex("a(?:){1}"),
  });
  assert.equal(regexCompiles, 66, "the oldest of 65 regex entries was evicted");
});

test("JSON cache supports serialized and identity keys with snapshot mutation", () => {
  let compiles = 0;
  const engine = createEngine({
    compileJsonSchema(schema, limits) {
      compiles += 1;
      return compileJsonSchema(schema, limits);
    },
  });
  const tokens = tokenizer(['"x"', "1"]);
  const serialized = grammarFromJsonSchema({ type: "string" });
  new engine.LLGuidanceInterpreter(tokens, { grammar: serialized });
  new engine.LLGuidanceInterpreter(tokens, { grammar: serialized });
  assert.equal(compiles, 1);

  const schema = { type: "string" };
  const config = {
    response_format: { type: "json_schema", json_schema: schema },
  };
  const first = new engine.LLGuidanceInterpreter(tokens, config);
  assert.equal(allowed(first.computeMask(), 0), true);
  schema.type = "number";
  const cached = new engine.LLGuidanceInterpreter(tokens, config);
  assert.equal(allowed(cached.computeMask(), 0), true);
  assert.equal(allowed(cached.computeMask(), 1), false);

  for (let index = 0; index < 64; index += 1) {
    new engine.LLGuidanceInterpreter(tokens, {
      response_format: {
        type: "json_schema",
        json_schema: { type: "string", title: String(index) },
      },
    });
  }
  const recompiled = new engine.LLGuidanceInterpreter(tokens, config);
  assert.equal(allowed(recompiled.computeMask(), 0), false);
  assert.equal(allowed(recompiled.computeMask(), 1), true);
  assert.equal(compiles, 67);
});

test("computeMaskInto reuses caller storage without changing computeMask", () => {
  const engine = createEngine({ compileRegex });
  const tokens = tokenizer(["a", "b"]);
  const interpreter = new engine.LLGuidanceInterpreter(tokens, {
    grammar: grammarFromRegex("a"),
  });
  const target = new Uint32Array([0xffffffff, 0xffffffff]);

  const result = interpreter.computeMaskInto(target);
  assert.strictEqual(result.mask, target);
  assert.equal(allowed(result, 0), true);
  assert.equal(allowed(result, 1), false);
  assert.equal(target[1], 0, "extra target words are cleared");
  target.fill(0);
  assert.equal(allowed(interpreter.computeMask(), 0), true);
  assert.throws(
    () => interpreter.computeMaskInto(new Uint32Array()),
    /needs at least 1 word/,
  );
  assert.throws(() => interpreter.computeMaskInto([]), /Uint32Array/);
});
