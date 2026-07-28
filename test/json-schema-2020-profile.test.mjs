import assert from "node:assert/strict";
import test from "node:test";

import { loadLLGuidance } from "../src/llguidance.node.ts";

const llguidance = await loadLLGuidance();
const encoder = new TextEncoder();

function allowed(result, token) {
  return Boolean(result.mask?.[token >>> 5] & (1 << (token & 31)));
}

function interpreterFor(schema, tokens) {
  const tokenizer = llguidance.createTokenizer({
    tokens: [...tokens, []],
    eos_token_id: tokens.length,
  });
  return {
    interpreter: llguidance.createInterpreter({
      tokenizer,
      response_format: { type: "json_schema", json_schema: schema },
    }),
    eos: tokens.length,
  };
}

function assertEveryBytePrefixAccepted(schema, text) {
  const bytes = [...encoder.encode(text)];
  const tokens = Array.from({ length: 256 }, (_, byte) => [byte]);
  const { interpreter, eos } = interpreterFor(schema, tokens);
  for (const [index, byte] of bytes.entries()) {
    assert.equal(
      allowed(interpreter.computeMask(), byte),
      true,
      `byte ${index} of ${JSON.stringify(text)} was pruned`,
    );
    interpreter.commitToken(byte);
  }
  assert.equal(allowed(interpreter.computeMask(), eos), true);
}

function schemaAccepts(schema, text) {
  const bytes = [...encoder.encode(text)];
  const { interpreter, eos } = interpreterFor(schema, [bytes]);
  if (!allowed(interpreter.computeMask(), 0)) return false;
  interpreter.commitToken(0);
  return allowed(interpreter.computeMask(), eos);
}

function compile(schema) {
  return interpreterFor(schema, [[123]]).interpreter;
}

test("validates not and conditional branches without pruning valid prefixes", () => {
  const notSchema = { not: { type: "string" } };
  assertEveryBytePrefixAccepted(notSchema, "42");
  assert.equal(schemaAccepts(notSchema, '"no"'), false);

  const conditional = {
    type: "object",
    properties: {
      kind: { enum: ["text", "count"] },
      value: true,
    },
    required: ["kind", "value"],
    if: { properties: { kind: { const: "text" } }, required: ["kind"] },
    then: { properties: { value: { type: "string" } } },
    else: { properties: { value: { type: "integer" } } },
  };
  assertEveryBytePrefixAccepted(conditional, '{"value":"ok","kind":"text"}');
  assertEveryBytePrefixAccepted(conditional, '{"kind":"count","value":2}');
  assert.equal(schemaAccepts(conditional, '{"kind":"text","value":2}'), false);
  assert.equal(
    schemaAccepts(conditional, '{"kind":"count","value":"no"}'),
    false,
  );
});

test("combines properties and every matching patternProperties schema", () => {
  const schema = {
    type: "object",
    properties: { code: { type: "integer" } },
    patternProperties: {
      "^code$": { minimum: 1 },
      "^x-": { type: "string" },
    },
    additionalProperties: false,
  };
  assertEveryBytePrefixAccepted(schema, '{"x-note":"ok","code":2}');
  assert.equal(schemaAccepts(schema, '{"code":0}'), false);
  assert.equal(schemaAccepts(schema, '{"code":"2"}'), false);
  assert.equal(schemaAccepts(schema, '{"other":2}'), false);
});

test("uses Unicode-aware RegExp semantics for string and property patterns", () => {
  assertEveryBytePrefixAccepted({ type: "string", pattern: "^.$" }, '"😀"');
  assertEveryBytePrefixAccepted(
    {
      type: "object",
      patternProperties: { "^.$": { type: "integer" } },
      additionalProperties: false,
    },
    '{"😀":1}',
  );
});

test("asserts recognized string formats and ignores unknown format names", () => {
  const accepted = {
    uri: "https://example.com/a%20b?x=1#part",
    "uri-reference": "../a/b?x=1#part",
    regex: "^(?:😀|[a-z]+)$",
    "json-pointer": "/a~1b/~0key",
    "relative-json-pointer": "2/items/0",
  };
  for (const [format, value] of Object.entries(accepted))
    assert.equal(
      schemaAccepts({ type: "string", format }, JSON.stringify(value)),
      true,
    );

  const rejected = {
    uri: "http://example.com/%GG",
    "uri-reference": "a:b c",
    regex: "[",
    "json-pointer": "/bad~escape",
    "relative-json-pointer": "01/value",
  };
  for (const [format, value] of Object.entries(rejected))
    assert.equal(
      schemaAccepts({ type: "string", format }, JSON.stringify(value)),
      false,
    );

  assertEveryBytePrefixAccepted(
    { type: "string", format: "vendor-format" },
    '"anything"',
  );
  assertEveryBytePrefixAccepted(
    { type: "string", format: "unknown" },
    '"anything"',
  );
});

test("validates calendar, RFC3339, hostname, and UUID boundaries", () => {
  for (const value of ["2000-02-29", "2024-02-29"])
    assert.equal(
      schemaAccepts({ format: "date" }, JSON.stringify(value)),
      true,
    );
  for (const value of ["1900-02-29", "2021-02-29", "2100-02-29"])
    assert.equal(
      schemaAccepts({ format: "date" }, JSON.stringify(value)),
      false,
    );

  for (const value of ["23:59:60Z", "23:59:60+23:59", "00:00:00-00:00"])
    assert.equal(
      schemaAccepts({ format: "time" }, JSON.stringify(value)),
      true,
    );
  for (const value of [
    "22:59:60Z",
    "23:58:60Z",
    "23:59:60+24:00",
    "23:59:60+00:60",
  ])
    assert.equal(
      schemaAccepts({ format: "time" }, JSON.stringify(value)),
      false,
    );

  assert.equal(
    schemaAccepts(
      { format: "hostname" },
      JSON.stringify(
        `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
      ),
    ),
    true,
  );
  assert.equal(
    schemaAccepts(
      { format: "hostname" },
      JSON.stringify(
        `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
      ),
    ),
    false,
  );
  assert.equal(
    schemaAccepts(
      { format: "uuid" },
      '"urn:uuid:00000000-0000-0000-0000-000000000000"',
    ),
    false,
  );
});

test("validates propertyNames and keeps viable name prefixes", () => {
  const schema = {
    type: "object",
    propertyNames: { pattern: "^[a-z]+$", maxLength: 5 },
    additionalProperties: true,
  };
  assertEveryBytePrefixAccepted(schema, '{"alpha":1}');
  assert.equal(schemaAccepts(schema, '{"Alpha":1}'), false);
  assert.equal(schemaAccepts(schema, '{"toolong":1}'), false);
});

test("validates dependentRequired and dependentSchemas", () => {
  const schema = {
    type: "object",
    properties: {
      card: { type: "string" },
      billing: { type: "string" },
      country: { type: "string" },
    },
    dependentRequired: { card: ["billing"] },
    dependentSchemas: {
      billing: {
        properties: { country: { const: "US" } },
        required: ["country"],
      },
    },
  };
  assertEveryBytePrefixAccepted(
    schema,
    '{"country":"US","billing":"x","card":"1"}',
  );
  assert.equal(schemaAccepts(schema, '{"card":"1"}'), false);
  assert.equal(schemaAccepts(schema, '{"billing":"x","country":"CA"}'), false);
});

test("implements 2020-12 contains bounds and defaults", () => {
  const bounded = {
    type: "array",
    contains: { type: "integer", minimum: 2 },
    minContains: 2,
    maxContains: 2,
  };
  assertEveryBytePrefixAccepted(bounded, '["x",2,3]');
  assert.equal(schemaAccepts(bounded, '[2,"x"]'), false);
  assert.equal(schemaAccepts(bounded, "[2,3,4]"), false);
  assert.equal(schemaAccepts({ contains: { const: 1 } }, "[]"), false);
  assertEveryBytePrefixAccepted({ contains: { const: 1 } }, "[0,1]");

  const ignoredWithoutContains = {
    type: "array",
    minContains: 5,
    maxContains: 0,
  };
  assertEveryBytePrefixAccepted(ignoredWithoutContains, "[]");
});

test("uses exact JsonNode equality for uniqueItems", () => {
  const schema = { type: "array", uniqueItems: true };
  assertEveryBytePrefixAccepted(schema, "[9007199254740992,9007199254740993]");
  assert.equal(schemaAccepts(schema, "[1,1.0]"), false);
  assert.equal(schemaAccepts(schema, '[{"a":[1]},{"a":[1.0]}]'), false);
});

test("resolves general local JSON Pointers, escaped segments, and nested defs", () => {
  const propertyPointer = {
    type: "object",
    properties: {
      template: { type: "integer", minimum: 2 },
      value: { $ref: "#/properties/template" },
    },
    required: ["value"],
  };
  assertEveryBytePrefixAccepted(propertyPointer, '{"value":3}');
  assert.equal(schemaAccepts(propertyPointer, '{"value":1}'), false);

  const escapedPointer = {
    $defs: {
      "a/b": {
        $defs: { "tilde~name": { type: "string", const: "ok" } },
      },
    },
    $ref: "#/$defs/a~1b/$defs/tilde~0name",
  };
  assertEveryBytePrefixAccepted(escapedPointer, '"ok"');
  assert.equal(schemaAccepts(escapedPointer, '"no"'), false);
  assert.throws(
    () => compile({ $ref: "other.json#/value" }),
    /external references/,
  );
});

test("supports draft-07 definitions, dependencies, and tuple items", () => {
  const referenced = {
    definitions: { answer: { type: "integer", minimum: 1 } },
    $ref: "#/definitions/answer",
  };
  assertEveryBytePrefixAccepted(referenced, "2");
  assert.equal(schemaAccepts(referenced, "0"), false);

  const dependencies = {
    type: "object",
    properties: { a: true, b: true, c: { type: "integer" } },
    dependencies: {
      a: ["b"],
      b: { required: ["c"] },
    },
  };
  assertEveryBytePrefixAccepted(dependencies, '{"a":1,"b":2,"c":3}');
  assert.equal(schemaAccepts(dependencies, '{"a":1}'), false);
  assert.equal(schemaAccepts(dependencies, '{"b":2}'), false);

  const tuple = {
    type: "array",
    items: [{ type: "string" }, { type: "integer" }],
    additionalItems: false,
  };
  assertEveryBytePrefixAccepted(tuple, '["x",1]');
  assert.equal(schemaAccepts(tuple, '["x","y"]'), false);
  assert.equal(schemaAccepts(tuple, '["x",1,true]'), false);
});

test("rejects malformed shapes for the production profile at compile time", () => {
  const invalid = [
    { not: [] },
    { if: 1 },
    { then: null },
    { else: "schema" },
    { patternProperties: { "[": true } },
    { propertyNames: [] },
    { dependentRequired: { a: ["b", "b"] } },
    { dependentSchemas: { a: 1 } },
    { contains: [] },
    { minContains: -1 },
    { maxContains: 1.5 },
    { uniqueItems: "yes" },
  ];
  for (const schema of invalid)
    assert.throws(
      () => compile(schema),
      /schema|RegExp|non-negative|uniqueItems/,
    );
});
