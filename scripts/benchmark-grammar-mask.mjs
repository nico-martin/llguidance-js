import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { loadGrammarGuidance } from "../src/grammar.ts";

const runtime = await loadGrammarGuidance();
const encoder = new TextEncoder();

// A deterministic synthetic vocabulary: printable ASCII bytes, common
// fragments, and pseudo-random lowercase chunks with shared prefixes.
let seed = 0x2f6b1d;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const vocabulary = new Set();
for (let byte = 0x20; byte < 0x7f; byte += 1)
  vocabulary.add(String.fromCharCode(byte));
for (const text of [
  "\n",
  "\t",
  "  ",
  '{"',
  '":',
  '": "',
  '",',
  '", "',
  '"}',
  "},",
  "}}",
  "[]",
  "{}",
  "true",
  "false",
  "null",
  "<|tool_call_start|>",
  "<|tool_call_end|>",
  "<tool_call>",
  "</tool_call>",
  "<function=",
  "</function>",
  "<parameter=",
  "</parameter>",
  "get_weather",
  "search",
  "city",
  "query",
  "unit",
  "celsius",
  "Paris",
  "London",
  "weather",
  "name",
  "value",
]) {
  vocabulary.add(text);
}
while (vocabulary.size < 1024) {
  let text = random() < 0.3 ? " " : "";
  const length = 2 + Math.floor(random() * 5);
  for (let index = 0; index < length; index += 1)
    text += String.fromCharCode(0x61 + Math.floor(random() * 26));
  vocabulary.add(text);
}
const texts = [...vocabulary];
const tokenBytes = texts.map((text) => encoder.encode(text));
const tokenizer = runtime.createTokenizer({
  tokens: [...tokenBytes.map((bytes) => [...bytes]), []],
  eosTokenId: texts.length,
});

function tokenize(text) {
  const tokens = [];
  let rest = text;
  while (rest.length !== 0) {
    let best = -1;
    for (let id = 0; id < texts.length; id += 1) {
      if (
        rest.startsWith(texts[id]) &&
        (best === -1 || texts[id].length > texts[best].length)
      )
        best = id;
    }
    assert.notEqual(best, -1, `untokenizable input ${JSON.stringify(rest)}`);
    tokens.push(best);
    rest = rest.slice(texts[best].length);
  }
  return tokens;
}

const cases = [
  {
    name: "recursive CFG with %ignore WS",
    grammar: String.raw`
      %import common.WS
      %ignore WS
      start: value
      value: NAME | NUMBER | "(" value (" " value)* ")"
      NAME: /[a-z]+/
      NUMBER: /[0-9]+/
    `,
    text: "(get (weather (search city) (query 12 unit)) (value name 345))",
  },
  {
    name: "LFM-style tool call, regex argument values",
    grammar: String.raw`
      start: "<|tool_call_start|>[" call ("," call)* "]<|tool_call_end|>"
      call: "get_weather(city=" STRING (", unit=" UNIT)? ")" | "search(query=" STRING ", limit=" INT ")"
      STRING: /"([^"\\\n]|\\.)*"/
      UNIT: "\"celsius\"" | "\"fahrenheit\""
      INT: /-?[0-9]+/
    `,
    text: '<|tool_call_start|>[get_weather(city="Paris", unit="celsius"),search(query="London weather", limit=12)]<|tool_call_end|>',
  },
  {
    name: "LFM-style tool call, %json argument values",
    grammar: String.raw`
      start: "<|tool_call_start|>[" call ("," call)* "]<|tool_call_end|>"
      call: "get_weather(city=" %json { "type": "string" } (", unit=" %json { "enum": ["celsius", "fahrenheit"] })? ")"
        | "search(query=" %json { "type": "string" } ", limit=" %json { "type": "integer" } ")"
    `,
    text: '<|tool_call_start|>[get_weather(city="Paris", unit="celsius"),search(query="London weather", limit=12)]<|tool_call_end|>',
  },
  {
    name: "Qwen-style tool call, %json argument values",
    grammar: String.raw`
      start: "<tool_call>\n<function=" call "\n</function>\n</tool_call>"
      call: "get_weather>" param_city param_unit? | "search>" param_query
      param_city: "\n<parameter=city>\n" %json { "type": "string" } "\n</parameter>"
      param_unit: "\n<parameter=unit>\n" %json { "enum": ["celsius", "fahrenheit"] } "\n</parameter>"
      param_query: "\n<parameter=query>\n" %json {
        "type": "object",
        "properties": { "name": { "type": "string" }, "value": { "type": "integer" } },
        "required": ["name"]
      } "\n</parameter>"
    `,
    text: '<tool_call>\n<function=search>\n<parameter=query>\n{"name": "Paris weather", "value": 12}\n</parameter>\n</function>\n</tool_call>',
  },
];

const runs = Number(process.env.BENCH_RUNS ?? 5);
for (const { name, grammar, text } of cases) {
  const tokens = tokenize(text);
  const samples = [];
  const firstMasks = [];
  for (let run = 0; run < runs; run += 1) {
    const interpreter = runtime.createInterpreter({ tokenizer, grammar });
    const start = performance.now();
    for (const [step, token] of tokens.entries()) {
      const before = performance.now();
      const result = interpreter.computeMask();
      if (step === 0) firstMasks.push(performance.now() - before);
      assert.ok(result.mask[token >>> 5] & (1 << (token & 31)));
      interpreter.commitToken(token);
    }
    const final = interpreter.computeMask();
    assert.ok(final.mask[texts.length >>> 5] & (1 << (texts.length & 31)));
    samples.push(performance.now() - start);
    interpreter.free();
  }
  samples.sort((a, b) => a - b);
  firstMasks.sort((a, b) => a - b);
  const median = samples[samples.length >> 1];
  console.log(
    `${name}: ${tokens.length} tokens, median ${median.toFixed(1)} ms per generation (${(
      median /
      (tokens.length + 1)
    ).toFixed(
      2,
    )} ms per mask), first mask ${firstMasks[firstMasks.length >> 1].toFixed(2)} ms`,
  );
}
console.log(
  `Vocabulary: ${texts.length} tokens, ${runs} runs per case (median). Timings are non-contractual.`,
);
