import assert from "node:assert/strict";
import test from "node:test";

import { loadGrammarGuidance } from "../src/grammar.ts";

const encoder = new TextEncoder();

function tokenizer(runtime, texts) {
  return runtime.createTokenizer({
    tokens: [...texts.map((text) => [...encoder.encode(text)]), []],
    eosTokenId: texts.length,
  });
}

function allowed(result, token) {
  return Boolean(result.mask?.[token >>> 5] & (1 << (token & 31)));
}

test("grammar entry supports recursive CFGs, regex terminals, and ignored whitespace", async () => {
  const runtime = await loadGrammarGuidance();
  assert.equal(loadGrammarGuidance(), loadGrammarGuidance());
  const tokens = ["(", ")", "name", "123", " ", "["];
  const interpreter = runtime.createInterpreter({
    tokenizer: tokenizer(runtime, tokens),
    grammar: String.raw`
      %import common.WS
      %ignore WS
      start: value
      value: NAME | NUMBER | "(" value ")"
      NAME: /[a-z]+/
      NUMBER: /[0-9]+/
    `,
  });

  assert.deepEqual(
    tokens.map((_, token) => allowed(interpreter.computeMask(), token)),
    [true, false, true, true, true, false],
  );
  for (const token of [0, 4, 0, 2, 1, 1]) interpreter.commitToken(token);
  assert.equal(allowed(interpreter.computeMask(), tokens.length), true);
  assert.deepEqual(
    interpreter.getCaptures("value").map(({ value }) => value),
    ["name", "(name)", "( (name))"],
  );
  assert.equal(interpreter.getCapture("start").value, "( (name))");
});

test("grammar entry supports alternatives, grouping, and practical quantifiers", async () => {
  const runtime = await loadGrammarGuidance();
  const words = tokenizer(runtime, ["ab", "abab", "c", "d"]);
  for (const accepted of ["ab", "abab", "c", "d"]) {
    const interpreter = runtime.createInterpreter({
      tokenizer: words,
      grammar: 'start: ("ab")+ | /[cd]/?',
    });
    const token = ["ab", "abab", "c", "d"].indexOf(accepted);
    assert.equal(allowed(interpreter.computeMask(), token), true);
    interpreter.commitToken(token);
    assert.equal(allowed(interpreter.computeMask(), 4), true);
  }
});

test("grammar entry allows slashes in literals and escaped in regex terminals", async () => {
  const runtime = await loadGrammarGuidance();
  const tokens = ["</a>", "b/c", "<\\/a>", "b\\/c"];
  const interpreter = runtime.createInterpreter({
    tokenizer: tokenizer(runtime, tokens),
    grammar: String.raw`start: "</a>" /b\/c/`,
  });
  assert.deepEqual(
    tokens.map((_, token) => allowed(interpreter.computeMask(), token)),
    [true, false, false, false],
  );
  interpreter.commitToken(0);
  assert.deepEqual(
    tokens.map((_, token) => allowed(interpreter.computeMask(), token)),
    [false, true, false, false],
  );
  interpreter.commitToken(1);
  assert.equal(allowed(interpreter.computeMask(), tokens.length), true);
});

test("grammar entry captures survive clone and rollback", async () => {
  const runtime = await loadGrammarGuidance();
  const interpreter = runtime.createInterpreter({
    tokenizer: tokenizer(runtime, ["a", "b"]),
    grammar: 'start: pair\npair: "a" "b"',
  });
  interpreter.commitToken(0);
  const clone = interpreter.clone();
  clone.commitToken(1);
  assert.equal(clone.getCapture("pair").value, "ab");
  assert.equal(interpreter.getCapture("pair"), null);
  clone.rollback(1);
  assert.equal(clone.getCapture("pair"), null);
  assert.equal(allowed(clone.computeMask(), 1), true);
});

test("grammar entry rejects unsupported constructs explicitly", async () => {
  const runtime = await loadGrammarGuidance();
  const source = tokenizer(runtime, ["a"]);
  const rejects = [
    ['start: "a"{2}', /unsupported operator '\{'/],
    ['start[capture]: "a"', /unsupported Lark syntax/],
    [
      "%import common.INT\nstart: INT",
      /unsupported Lark construct: %import common.INT/,
    ],
    ["start: /a/i", /regex flags are unsupported/],
    ["start: missing", /unknown rule "missing"/],
    ['root: "a"', /required rule "start" is missing/],
    ["start: /a*/", /regex terminals must consume at least one byte/],
  ];
  for (const [grammar, pattern] of rejects) {
    assert.throws(
      () => runtime.createInterpreter({ tokenizer: source, grammar }),
      pattern,
    );
  }
});
