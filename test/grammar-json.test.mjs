import assert from "node:assert/strict";
import test from "node:test";

import { loadGrammarGuidance } from "../src/grammar.ts";

const runtime = await loadGrammarGuidance();
const encoder = new TextEncoder();

function allowed(result, token) {
  return Boolean(result.mask?.[token >>> 5] & (1 << (token & 31)));
}

// One token per byte, EOS last.
const bytes = runtime.createTokenizer({
  tokens: [...Array.from({ length: 256 }, (_, byte) => [byte]), []],
  eosTokenId: 256,
});

function run(grammar, text) {
  const interpreter = runtime.createInterpreter({ tokenizer: bytes, grammar });
  for (const byte of encoder.encode(text)) {
    if (!allowed(interpreter.computeMask(), byte)) return null;
    interpreter.commitToken(byte);
  }
  return allowed(interpreter.computeMask(), 256) ? interpreter : null;
}

function assertGrammar(grammar, passing, failing) {
  for (const text of passing)
    assert.notEqual(
      run(grammar, text),
      null,
      `accepts ${JSON.stringify(text)}`,
    );
  for (const text of failing)
    assert.equal(run(grammar, text), null, `rejects ${JSON.stringify(text)}`);
}

const qwenToolCalls = String.raw`
  start: "<tool_call>\n<function=" call "\n</function>\n</tool_call>"
  call: "get_weather>" city unit? | "search>" query
  city: "\n<parameter=city>\n" city_value "\n</parameter>"
  unit: "\n<parameter=unit>\n" unit_value "\n</parameter>"
  query: "\n<parameter=query>\n" query_value "\n</parameter>"
  city_value: %json { "type": "string", "minLength": 1 }
  unit_value: %json { "enum": ["celsius", "fahrenheit"] }
  query_value: %json {
    "type": "object",
    "properties": {
      "text": { "type": "string" },
      "limit": { "type": "integer", "minimum": 1 }
    },
    "required": ["text"],
    "additionalProperties": false
  }
`;

test("%json constrains tool-call arguments inside literal markup", () => {
  const call = (name, params) =>
    `<tool_call>\n<function=${name}>${params
      .map(([key, value]) => `\n<parameter=${key}>\n${value}\n</parameter>`)
      .join("")}\n</function>\n</tool_call>`;
  assertGrammar(
    qwenToolCalls,
    [
      call("get_weather", [["city", '"Paris"']]),
      call("get_weather", [
        ["city", '"New York"'],
        ["unit", '"fahrenheit"'],
      ]),
      call("search", [["query", '{"text":"llguidance","limit":3}']]),
      call("search", [["query", '{ "text": "a\\"b" }']]),
    ],
    [
      call("get_weather", [["city", "Paris"]]),
      call("get_weather", [["city", '""']]),
      call("get_weather", [["city", "12"]]),
      call("get_weather", [
        ["city", '"Paris"'],
        ["unit", '"kelvin"'],
      ]),
      call("search", [["query", '{"limit":3}']]),
      call("search", [["query", '{"text":"x","limit":0}']]),
      call("search", [["query", '{"text":"x","extra":1}']]),
      call("search", [["city", '"Paris"']]),
      call("lookup", [["city", '"Paris"']]),
    ],
  );

  const interpreter = run(
    qwenToolCalls,
    call("get_weather", [
      ["city", '"Paris"'],
      ["unit", '"celsius"'],
    ]),
  );
  assert.equal(interpreter.getCapture("city_value").value, '"Paris"');
  assert.equal(interpreter.getCapture("unit_value").value, '"celsius"');
  assert.equal(
    interpreter.getCapture("call").value.startsWith("get_weather>"),
    true,
  );
});

test("%json masks follow the schema across multi-byte tokens", () => {
  const texts = [
    "<tool_call>\n<function=",
    "get_weather>",
    "search>",
    "\n<parameter=city>\n",
    '"',
    "Paris",
    '"Paris"',
    "12",
    "{",
    '"\n</parameter>',
    "\n</function>\n</tool_call>",
  ];
  const tokenizer = runtime.createTokenizer({
    tokens: [...texts.map((text) => [...encoder.encode(text)]), []],
    eosTokenId: texts.length,
  });
  const interpreter = runtime.createInterpreter({
    tokenizer,
    grammar: qwenToolCalls,
  });
  const mask = () => {
    const result = interpreter.computeMask();
    return texts
      .map((text, token) => (allowed(result, token) ? text : null))
      .filter((text) => text !== null);
  };
  interpreter.commitToken(0);
  assert.deepEqual(mask(), ["get_weather>", "search>"]);
  interpreter.commitToken(1);
  assert.deepEqual(mask(), ["\n<parameter=city>\n"]);
  interpreter.commitToken(3);
  // A JSON string may start; a number, an object, or an empty string may not.
  assert.deepEqual(mask(), ['"', '"Paris"']);
  interpreter.commitToken(4);
  // Any string content may follow; a closing quote would leave it empty.
  assert.deepEqual(mask(), ["get_weather>", "search>", "Paris", "12", "{"]);
  interpreter.commitToken(5);
  assert.equal(mask().includes('"\n</parameter>'), true);
  interpreter.commitToken(9);
  assert.deepEqual(mask(), ["\n</function>\n</tool_call>"]);
  interpreter.commitToken(10);
  assert.equal(allowed(interpreter.computeMask(), texts.length), true);
});

test("inline %json atoms work in sequences, groups, and repetitions", () => {
  const lfm = String.raw`
    start: "<|tool_call_start|>[" call ("," call)* "]<|tool_call_end|>"
    call: "get_weather(city=" %json { "type": "string" } (", unit=" %json { "enum": ["c", "f"] })? ")"
      | "add(values=" %json { "type": "array", "items": { "type": "integer" } } ")"
  `;
  assertGrammar(
    lfm,
    [
      '<|tool_call_start|>[get_weather(city="Paris")]<|tool_call_end|>',
      '<|tool_call_start|>[get_weather(city="Paris", unit="f"),add(values=[1, 2])]<|tool_call_end|>',
      "<|tool_call_start|>[add(values=[])]<|tool_call_end|>",
    ],
    [
      "<|tool_call_start|>[get_weather(city=Paris)]<|tool_call_end|>",
      '<|tool_call_start|>[get_weather(city="Paris", unit="k")]<|tool_call_end|>',
      "<|tool_call_start|>[add(values=[1.5])]<|tool_call_end|>",
      '<|tool_call_start|>[add(values=["1"])]<|tool_call_end|>',
    ],
  );

  const integers = String.raw`
    start: %json { "type": "integer" } ("," %json { "type": "integer" })*
  `;
  assertGrammar(integers, ["1", "12,3", "-4,50,6"], ["", "1,", "1.5", "a"]);
});

test("%json values follow the JSON Schema engine's syntax and whitespace rules", () => {
  // Without %ignore, no whitespace surrounds the value; inside it, the
  // schema's x-guidance whitespace_flexible default (true) applies.
  assertGrammar(
    'start: "<" %json { "type": "object" } ">"',
    ["<{}>", '<{"a": [1, 2]}>', '<{ "a" : 1 }>'],
    ["< {}>", "<{} >", "<[]>", "<{>"],
  );
  assertGrammar(
    String.raw`
      %import common.WS
      %ignore WS
      start: "<" %json { "type": "object" } ">"
    `,
    ["< {} >", "<\n{}\n>"],
    ["<[]>"],
  );
  assertGrammar(
    'start: %json { "type": "object", "x-guidance": { "whitespace_flexible": false } }',
    ['{"a":1}'],
    ['{"a": 1}'],
  );
  // Boolean schemas: true accepts any JSON value, false none.
  assertGrammar(
    'start: "=" %json true',
    ['="x"', "=1", "=null", "=[{}]"],
    ["=", "=x", "=[,]"],
  );
  assertGrammar("start: %json false", [], ["1", '"x"', "{}"]);
});

test("%json string patterns match upstream llguidance anchoring", () => {
  const json = (schema) => `start: %json ${JSON.stringify(schema)}`;
  const quote = (values) => values.map((value) => JSON.stringify(value));
  assertGrammar(
    json({ type: "string", pattern: "^\\d$" }),
    quote(["1", "2"]),
    quote([1, "12", "a", ""]),
  );
  assertGrammar(
    json({ type: "string", pattern: "[ab]" }),
    quote(["a", "foobar", "\nb\n\n"]),
    quote([1, "12", ""]),
  );
  assertGrammar(
    json({ type: "string", pattern: "^foo$" }),
    quote(["foo"]),
    quote([1, "fooa", "afoo", "afooa"]),
  );
});

test("%json bodies may span lines and contain comment and delimiter characters", () => {
  assertGrammar(
    String.raw`
      # a comment
      start: tag body "</x>"   # trailing comment
      tag: "<x>"
      body: %json
        {
          "type": "string",
          "pattern": "^[#/|]+$"
        }
        | %json { "const": "a/b" }
    `,
    ['<x>"#/|"</x>', '<x>"a/b"</x>'],
    ['<x>"a"</x>', '<x>"#"<x>'],
  );
});

test("%json rejects invalid placements and schemas explicitly", () => {
  const rejects = [
    [
      "start: FOO\nFOO: %json { }",
      /%json literals cannot be used in terminals/,
    ],
    ["start: %json {", /unterminated %json value/],
    ['start: %json { "type": "string" ', /unterminated %json value/],
    ["start: %json { foo }", /invalid %json value/],
    ["start: %json", /invalid %json value/],
    ["start: %json []", /failed to compile JSON schema/],
    ['start: %json { "type": "nope" }', /failed to compile JSON schema/],
    [
      'start: "a"\nj: %json { "type": "string" }\n%ignore j',
      /%ignore j must name one literal or regex terminal/,
    ],
  ];
  for (const [grammar, pattern] of rejects) {
    assert.throws(
      () => runtime.createInterpreter({ tokenizer: bytes, grammar }),
      pattern,
      grammar,
    );
  }
});

test("%json honors the interpreter's schema depth limits", () => {
  assert.throws(
    () =>
      runtime.createInterpreter({
        tokenizer: bytes,
        grammar: 'start: %json { "items": { "items": { "type": "integer" } } }',
        limits: { maxSchemaDepth: 1 },
      }),
    /maxSchemaDepth/,
  );
});
