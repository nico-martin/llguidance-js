import assert from "node:assert/strict";
import test from "node:test";

import { compileRegex } from "../src/engine/regex.ts";

const encoder = new TextEncoder();

test("regex byte transitions reuse immutable interned states", () => {
  const regex = compileRegex("^a(?:b|c)*$");
  const a = Uint8Array.of(0x61);
  const b = Uint8Array.of(0x62);

  const afterA = regex.advance(regex.initialState, a);
  assert.strictEqual(regex.advance(regex.initialState, a), afterA);
  assert.strictEqual(
    regex.advance(regex.initialState, encoder.encode("ab")),
    regex.advance(afterA, b),
  );
  assert.equal(Object.isFrozen(afterA), true);
  assert.equal(regex.viable(afterA), true);
  assert.equal(regex.accepting(afterA), true);

  const dead = regex.advance(afterA, a);
  assert.strictEqual(regex.advance(afterA, a), dead);
  assert.equal(regex.viable(dead), false);
  assert.equal(regex.accepting(dead), false);
  assert.strictEqual(regex.advance(dead, b), dead);
  assert.strictEqual(regex.advance(afterA, new Uint8Array()), afterA);
});

test("bounded regex DFA fallback preserves matches after cache saturation", () => {
  const trailing = 12;
  const regex = compileRegex(`(?:a|b)*a(?:a|b){${trailing}}`);
  const early = regex.advance(regex.initialState, Uint8Array.of(0x61));

  for (let value = 0; value < 1 << (trailing + 1); value++) {
    const bytes = new Uint8Array(trailing + 1);
    for (let bit = 0; bit < bytes.length; bit++) {
      bytes[bit] = (value & (1 << bit)) === 0 ? 0x61 : 0x62;
    }
    const state = regex.advance(regex.initialState, bytes);
    assert.equal(regex.viable(state), true);
    assert.equal(regex.accepting(state), bytes[0] === 0x61);
  }

  assert.strictEqual(
    regex.advance(regex.initialState, Uint8Array.of(0x61)),
    early,
  );
});
