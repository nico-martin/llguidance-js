import assert from "node:assert/strict";
import test from "node:test";

import { grammarAccepts, llguidance, tokenizer } from "./helpers.mjs";

const larkTest =
  llguidance.get_version() === "llguidance-ts-core" ? test.skip : test;

/*
 * Excluded upstream tests: test_slices (tokenizer slices); test_par_errors,
 * test_consume_token_par, test_consume_token_par_errors, test_par_draft_tokens
 * (parallel executor); test_stopping_conditions (matcher stop/accept state);
 * test_rollback (rollback/deep copy); test_fast_forward (fast-forward bytes);
 * test_try_consume_tokens (speculative rollback); test_struct_tag_0 (StructTag
 * and special-token parsing); test_parser_limits (parser limits);
 * test_grammar_warnings (warnings/lenient options); test_get_capture (captures);
 * test_multi_eos_wrapper_override (tokenizer wrappers and multi-EOS override).
 * Omitted portions: test_json (whitespace_flexible compiler option),
 * test_lark_syntax/test_regex_syntax (validation without a tokenizer), and
 * test_consume_token_error (deep copy, bulk validation, and stop reason).
 */

const encoder = new TextEncoder();

function checkGrammar(grammar, passing, failing) {
  for (const input of passing) {
    assert.equal(
      grammarAccepts(grammar, input),
      true,
      `${JSON.stringify(input)} should match`,
    );
  }
  for (const input of failing) {
    assert.equal(
      grammarAccepts(grammar, input),
      false,
      `${JSON.stringify(input)} should not match`,
    );
  }
}

test("test_json", () => {
  const grammar = llguidance.LLMatcher.grammar_from_json_schema({
    type: "object",
    properties: { foo: { type: "integer" } },
    required: ["foo"],
  });

  checkGrammar(
    grammar,
    ['{"foo":1}', '{"foo":1,"bar":2}', '{ "foo" : 1 }'],
    ["{}", "{", ' {"foo":1}', '{"bar":1}'],
  );
});

larkTest("test_lark", () => {
  const grammar = llguidance.LLMatcher.grammar_from_lark(
    'start: /.../ "abc" /.../',
  );

  checkGrammar(
    grammar,
    ["abcabcabc", "aaaabcccc", "🔵🟠✅abc❌🟠🔵"],
    [
      "aaabcccc",
      "aaaaabcccc",
      "aaaabccc",
      "aaaabccccc",
      "🔵🟠✅❌abc❌✅🟠🔵",
      "🔵🟠abc🟠🔵",
    ],
  );
});

test("test_regex_grammar", () => {
  const grammar = llguidance.LLMatcher.grammar_from_regex(String.raw`\d+`);
  checkGrammar(grammar, ["123", "456"], ["abc", "1a2"]);
});

larkTest("test_lark_syntax", () => {
  const grammar = "start: /.../ no_such_rule";
  assert.throws(
    () => new llguidance.LLMatcher(tokenizer, grammar),
    /no_such_rule/,
  );
  assert.match(
    llguidance.LLMatcher.validate_grammar(grammar, tokenizer),
    /no_such_rule/,
  );
});

test("test_regex_syntax", () => {
  const grammar = llguidance.LLMatcher.grammar_from_regex(
    "missing close paren (",
  );
  assert.throws(
    () => new llguidance.LLMatcher(tokenizer, grammar),
    /invalid regex/,
  );
  assert.match(
    llguidance.LLMatcher.validate_grammar(grammar, tokenizer),
    /invalid regex/,
  );
});

test("test_consume_token_error", () => {
  const grammar = llguidance.LLMatcher.grammar_from_regex("(foo[12]23|bar)");
  const matcher = new llguidance.LLMatcher(tokenizer, grammar);

  for (const token of encoder.encode("foo")) {
    assert.equal(matcher.compute_logit_bias()[token], 200);
    assert.equal(matcher.consume_token(token), true);
  }

  const rejectedToken = encoder.encode("7")[0];
  assert.equal(matcher.compute_logit_bias()[rejectedToken], 0);
  assert.equal(matcher.consume_token(rejectedToken), false);
  assert.equal(matcher.is_error(), true);
  assert.match(matcher.get_error(), /doesn't satisfy the grammar/);

  const outOfRangeMatcher = new llguidance.LLMatcher(tokenizer, grammar);
  outOfRangeMatcher.compute_bitmask();
  assert.equal(
    outOfRangeMatcher.consume_token(tokenizer.vocab_size + 100),
    false,
  );
  assert.equal(outOfRangeMatcher.is_error(), true);
  assert.match(outOfRangeMatcher.get_error(), /out of range/);
});

test("test_multi_eos_tokens_property", () => {
  assert.deepEqual(tokenizer.eos_tokens, [tokenizer.eos_token]);
  assert.equal(tokenizer.eos_tokens.length, 1);
});
