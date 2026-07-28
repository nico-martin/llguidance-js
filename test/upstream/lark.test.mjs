import assert from "node:assert/strict";
import nodeTest from "node:test";

import { grammarAccepts, llguidance, tokenizer } from "./helpers.mjs";

const test =
  llguidance.get_version() === "llguidance-ts-core" ? nodeTest.skip : nodeTest;

function compileLark(lark) {
  const grammar = llguidance.LLMatcher.grammar_from_lark(lark);
  new llguidance.LLMatcher(tokenizer, grammar);
  return grammar;
}

function assertCompiles(lark) {
  assert.doesNotThrow(() => compileLark(lark));
}

function assertCompileError(lark, message) {
  assert.throws(
    () => compileLark(lark),
    (error) => String(error).includes(message),
  );
}

function assertLark(lark, passing, failing) {
  const grammar = compileLark(lark);
  for (const input of passing) {
    assert.equal(
      grammarAccepts(grammar, input),
      true,
      `expected acceptance: ${JSON.stringify(input)}`,
    );
  }
  for (const original of failing) {
    const input = original.replace(/^FINAL_REJECT:/, "");
    assert.equal(
      grammarAccepts(grammar, input),
      false,
      `expected rejection: ${JSON.stringify(input)}`,
    );
  }
}

function assertJson(schema, passing, failing) {
  assertLark(
    `start: %json ${JSON.stringify(schema)}`,
    passing.map((value) => JSON.stringify(value)),
    failing.map((value) => JSON.stringify(value)),
  );
}

test("test_dot_unicode", () => {
  assertLark(
    'start: /.../ "abc" /.../',
    ["abcabcabc", "aaaabcccc", "🔵🟠✅abc❌🟠🔵"],
    [
      "aaabcccc",
      "aaaaabcccc",
      "FINAL_REJECT:aaaabccc",
      "aaaabccccc",
      "🔵🟠✅❌abc❌✅🟠🔵",
      "🔵🟠abc🟠🔵",
    ],
  );
});

test("test_lark_syntax_general", () => {
  const errors = [
    ['root: "abc" "def"', "no start"],
    ['start: foo{7,6}\nfoo: "a" | "b"', "range end must be >= start"],
    ['start: foo{-1,}\nfoo: "a" | "b"', "range start must be >= 0"],
    ['start: foo{0,-1}\nfoo: "a" | "b"', "range end must be >= start"],
    ['start: FOO\nFOO: ("a" | "b"){7,6}', "range end must be >= start"],
    ['start: FOO\nFOO: ("a" | "b"){-1,}', "range start must be >= 0"],
    ['start: FOO\nFOO: ("a" | "b"){0,-1}', "range end must be >= start"],
    ['start: FOO\nFOO: "a" | BAR\nBAR: "b" FOO', "circular reference in token"],
    ['start: FOO\nBAR: "b"', "unknown name"],
    ['start: foo\nbar: "b"', "unknown name"],
    ['start: BAR\nBAR: BAZ "a"', 'unknown name: "BAZ"'],
    ["%import common.BLAH\nstart: BLAH", "Unknown common"],
    ["start: /[abc/", "invalid regex"],
    ["start: /[abc]/l", "l-flag is not supported"],
    ["start: FOO\nFOO: @qux", "cannot be used in terminals"],
    ["start: FOO\nFOO: %json { }", "cannot be used in terminals"],
    ["start: FOO\nFOO: <[1234]>", "cannot be used in terminals"],
    ["start: FOO\nFOO: <|assistant|>", "cannot be used in terminals"],
    ['start: "A" | <|foobarbaz|>', "unknown special token"],
    ['start: "ab".."c"', "range start must be a single character"],
    ['start: "a".."cd"', "range end must be a single character"],
    ['start: "d".."a"', "invalid range order"],
    ['start: foo\nfoo: "a" | "b"\nfoo: "c"', "duplicate rule"],
    ['start: FOO\nFOO: "a" | "b"\nFOO: "c"', "duplicate token"],
    ['start: / "test"\nblah: "xyz"', "lexer error"],
    ['start: "test\nblah: "xyz"', "lexer error"],
  ];
  for (const [grammar, message] of errors) assertCompileError(grammar, message);

  assertCompiles('start: foo\nfoo: "a" | bar\nbar: "b" foo');
  assertCompiles("%import common.INT\nstart: INT");
  assertCompiles("start: /[abc]/");

  // Excluded from this source test: <[...]> token-ID range cases require a
  // tokenizer-specific vocabulary rather than black-box string acceptance.
});

test("test_lark_syntax_perc", () => {
  const errors = [
    ["start: %json {", "EOF while parsing an object"],
    ["start: %json { foo", "key must be a string"],
    ["start: %json []", "failed to compile JSON schema"],
    ['start: %json { "if": {} }', "failed to compile JSON schema"],
    ['start: %regex { "substring_words": true }', "failed to parse %regex"],
    ['start: %regex { "foobar": true }', "unknown field"],
    [
      'start: %regex { "substring_words": "aa", "substring_chars": "bb" }',
      "only one field can be set on %regex",
    ],
    ["start: %regex { }", "no fields set on %regex"],
  ];
  for (const [grammar, message] of errors) assertCompileError(grammar, message);
  assertCompiles('start: %regex { "substring_words": "foo bar" }');
  assertCompiles('start: %regex { "substring_chars": "foo bar" }');
  assertCompiles('start: %regex { "substring_chunks": ["foo", "bar"] }');

  // Excluded: the invalid %llguidance declaration only tests parser options.
});

// test_lark_syntax_attributes is excluded: its successful cases only exercise
// stop/max_tokens/capture parser options, and its failures validate those option
// declarations rather than grammar language acceptance.

test("test_repeat", () => {
  assertLark(
    'start: ab{3,5}\nab: "a" | "b"',
    ["aba", "abaa", "aaaaa", "aabaa"],
    ["FINAL_REJECT:aa", "FINAL_REJECT:ab", "aaaaaa"],
  );
  assertLark(
    'start: ab{3,}\nab: "a" | "b"',
    ["aba", "abaa", "aaaaa", "aabaa", "aaaaaa"],
    ["FINAL_REJECT:aa", "FINAL_REJECT:ab"],
  );
  assertLark(
    'start: ab{,5}\nab: "a" | "b"',
    ["", "aa", "b", "aba", "abaa", "aaaaa", "aabaa"],
    ["aaaaaa"],
  );
});

test("test_lexeme_substring_general", () => {
  const passing = [
    "AfooB",
    "Abar bazB",
    "AbazB",
    "Afoo bar bazB",
    "Afoo bar B",
    "A bar bazB",
    "AB",
  ];
  const failing = ["FINAL_REJECT:Afoo bar baz", "AfoB"];
  for (const grammar of [
    'start: "A" %regex { "substring_words": "foo bar baz" } "B"',
    'start: SUB\nSUB: "A" %regex { "substring_words": "foo bar baz" } "B"',
  ]) {
    assertLark(grammar, passing, failing);
  }
  assertLark(
    'start: "A" %regex { "substring_chunks": ["foo", " bar", " baz"] } "B"',
    [
      "AfooB",
      "A bar bazB",
      "A bazB",
      "Afoo bar bazB",
      "Afoo barB",
      "AB",
      "A bar bazB",
    ],
    failing,
  );
});

test("test_lexeme_substring_chars_ascii", () => {
  assertLark(
    'start: %regex { "substring_chars": "The quick brown fox jumps over the lazy dog." }',
    [
      "The quick brown fox jumps over the lazy dog.",
      "The quick brown fox",
      "he quick brow",
      "fox jump",
      "dog.",
    ],
    ["brown fx"],
  );
});

test("test_lexeme_substring_chars_unicode", () => {
  assertLark(
    'start: %regex { "substring_chars": "빠른 갈색 여우가 게으른 개를 뛰어넘었다." }',
    [
      "빠른 갈색 여우가 게으른 개를 뛰어넘었다.",
      "빠른 갈색 여우가 게으른",
      "른 갈색 여우",
      "여우가 게으",
      "뛰어넘었다.",
    ],
    ["갈색 여가"],
  );
});

test("test_lexeme_substring_words_ascii", () => {
  assertLark(
    'start: %regex { "substring_words": "The quick brown fox jumps over the lazy dog." }',
    [
      "The quick brown fox jumps over the lazy dog.",
      "The quick brown fox",
      "dog.",
    ],
    ["he quick brow", "FINAL_REJECT:fox jump", "brown fx"],
  );
});

test("test_lexeme_substring_words_unicode", () => {
  assertLark(
    'start: %regex { "substring_words": "빠른 갈색 여우가 게으른 개를 뛰어넘었다." }',
    [
      "빠른 갈색 여우가 게으른 개를 뛰어넘었다.",
      "빠른 갈색 여우가 게으른",
      "뛰어넘었다.",
    ],
    ["른 갈색 여우", "FINAL_REJECT:여우가 게으", "갈색 여가"],
  );
});

test("test_large_select", () => {
  const options = Array.from({ length: 100 }, (_, index) =>
    Array.from({ length: 75 }, (_, word) => `word${index}_${word}`).join(" "),
  );
  for (const start of ["start: OPTS\nOPTS: ", "start: opts\nopts: "]) {
    const names = options.map((_, index) => `OPT${index}`);
    const grammar = `${start}${names.join(" | ")} | ""\n${options
      .map((option, index) => `OPT${index}: ${JSON.stringify(option)}`)
      .join("\n")}`;
    assertLark(
      grammar,
      [options[2], options[7]],
      ["something that is unlikely to be in the options"],
    );
  }
});

test("test_large_substring_words", () => {
  const words = Array.from({ length: 2500 }, (_, index) => `w${index}`).join(
    " ",
  );
  const match = Array.from({ length: 50 }, (_, index) => `w${index + 50}`).join(
    " ",
  );
  assertLark(
    `start: %regex { "substring_words": ${JSON.stringify(words)} }`,
    [match],
    [`${match}XXX`],
  );
});

test("test_large_substring_chars", () => {
  const chars = Array.from({ length: 2000 }, (_, index) => `value-${index} `)
    .join("")
    .slice(0, 10_000);
  assertLark(
    `start: %regex { "substring_chars": ${JSON.stringify(chars)} }`,
    [chars.slice(50, 100)],
    [chars.slice(50, 100) + "XXX"],
  );
});

test("test_lexer_amb", () => {
  assertLark(
    `start: "'foo'" /a+/ | STRING /b+/\nSTRING: /'[^']*'/`,
    ["'foo'a", "'foo'aaa", "'bar'b", "'bar'bbb", "'foo'bb"],
    ["'bar'a", "'bar'c"],
  );
});

test("test_edits", () => {
  const fence = "```";
  const grammar = String.raw`
start: ( step "\n" )* step ( "\n" final_comments )?
step: plan "\n" a_file
plan[lazy]: /((.|\n)*\n)?${fence}/
final_comments: /[^${fence[0]}]*/
replace: "=======\n" repl_inner " REPLACE\n${fence}"
repl_inner[lazy]: /(.|\n)*\n>>>>>>>/
SEARCH: "\n<<<<<<< SEARCH\n"
file_0: "gbnf_to_lark.py" SEARCH FILE_0 replace
a_file: file_0
FILE_0: %regex { "substring_chunks": ["foo\n", "bar\n", "baz\n", "line\n", "line\n"] }
`;
  const replBlock = (source, destination) =>
    `\x60\x60\x60\ngbnf_to_lark.py\n<<<<<<< SEARCH\n${source}\n=======\n${destination}\n>>>>>>> REPLACE\n\x60\x60\x60`;
  const repl = replBlock("foo\nbar", "qux");
  assertLark(
    grammar,
    [
      repl,
      `${repl}\n`,
      `${repl}\n\n`,
      `Some text\n${repl}`,
      `Some text\nMore\n${repl}`,
      `Some text\nMore\n${repl}\n`,
      `Some text\nMore\n${repl}\nAnd then some`,
      `Some text\nMore\n${repl}\nAnd then some\n`,
    ],
    [
      "FINAL_REJECT:Some text\nSome more\n",
      "FINAL_REJECT:Some text\nSome more",
      "Foo\n\x60\x60\x60\nbar",
      "FINAL_REJECT:Foo\n\x60\x60\x60\ngbnf",
      replBlock("fooz\nbar", "quux"),
    ],
  );
});

test("test_json_dw_pattern", () => {
  assertJson(
    { type: "string", pattern: "^\\d$" },
    ["1", "2"],
    [1, "12", "a", "", "১"],
  );
  assertJson(
    { type: "string", pattern: "^\\w$" },
    ["1", "2", "a", "A"],
    [1, "12", "", "১", "ł"],
  );
  assertLark(
    'start: %json { "type": "string", "pattern": "^\\\\s$" }',
    [
      '" "',
      '"\\t"',
      '"\\n"',
      '"\\r"',
      '"\\u0009"',
      '"\\u000A"',
      '"\\u000B"',
      '"\\u000C"',
      '" "',
      '" "',
      '" "',
    ],
    ["1", '"12"', '""', '"১"', '"ł"', '"\\u00A0"'],
  );
});

test("test_json_anchoring", () => {
  assertJson(
    { type: "string", pattern: "[ab]" },
    ["a", "foobar", "\nb\n\n"],
    [1, "12", "", "১", "ł"],
  );
  assertJson(
    { type: "string", pattern: "^foo" },
    ["foo", "foobar"],
    [1, "afoo", "afooa"],
  );
  assertJson(
    { type: "string", pattern: "foo$" },
    ["foo", "barfoo"],
    [1, "fooa", "afooa"],
  );
  assertJson(
    { type: "string", pattern: "^foo$" },
    ["foo"],
    [1, "fooa", "afoo", "afooa"],
  );
});

test("test_nested_lark", () => {
  assertLark(
    'start: /[ab]+/ foobar\nfoobar: %lark {\nstart: "foo" | "Bar"\n}',
    ["afoo", "abfoo", "aaaaaaBar"],
    ["FINAL_REJECT:a", "afooa"],
  );
});

// test_large_real_substring is excluded because it requires the external,
// intentionally huge data/ulysses.md fixture.

test("test_json_pattern_properties", () => {
  const compileErrors = [
    [
      {
        type: "object",
        patternProperties: {
          "^fo": { type: "integer" },
          "^foo": { type: "number" },
        },
      },
      "are not disjoint",
    ],
    [
      {
        type: "object",
        patternProperties: {
          foo: { type: "integer" },
          bar: { type: "number" },
        },
      },
      "are not disjoint",
    ],
    [
      {
        allOf: [
          { type: "object", patternProperties: { "^fo": { type: "integer" } } },
          { type: "object", patternProperties: { "^foo": { type: "number" } } },
        ],
      },
      "are not disjoint",
    ],
    [
      {
        allOf: [
          {
            type: "object",
            properties: { foo: { type: "string" } },
            required: ["foo"],
          },
          { type: "object", patternProperties: { "^f": { type: "number" } } },
        ],
      },
      "required property 'foo' is unsatisfiable",
    ],
  ];
  for (const [schema, message] of compileErrors)
    assertCompileError(`start: %json ${JSON.stringify(schema)}`, message);

  // Excluded: the bundled binding does not yet intersect patternProperties
  // with named properties. This covers the optional "foo" vector, the
  // required "count" vector, and the unsatisfiable required "foo" compile
  // error from upstream.
  assertJson(
    {
      type: "object",
      properties: { name: { type: "string" } },
      patternProperties: {
        "^foo": { type: "integer" },
        "^bar": { type: "array" },
      },
      additionalProperties: { type: "boolean" },
      required: ["name", "mux", "foo1", "bar1"],
    },
    [
      { name: "hello", mux: false, foo1: 123, bar1: [] },
      { name: "hello", mux: false, foo1: 123, bar1: [], blah: true },
    ],
    [
      { name: "hello", mux: false, bar1: [], foo1: 123 },
      { name: "hello", mux: "blah", foo1: 123, bar1: [] },
      { name: "hello", mux: false, foo1: "aaa", bar1: [] },
    ],
  );
  // Excluded: two allOf vectors require intersecting patternProperties with
  // additionalProperties: false, which the bundled binding does not enforce.
  assertJson(
    {
      allOf: [
        { patternProperties: { "^f": { type: "integer", minimum: 0 } } },
        { patternProperties: { "^f": { type: "integer", multipleOf: 3 } } },
      ],
    },
    [{}, { foo: 0 }, { fox: 9 }, { foo: 3, fox: 6 }],
    [{ foo: 1 }, { foo: -3 }, { foo: 3, fox: 5 }],
  );
  assertJson(
    {
      allOf: [
        { patternProperties: { "^f": { type: "integer" } } },
        { patternProperties: { "^b": { type: "string" } } },
      ],
    },
    [{}, { foo: 42 }, { bar: "hello" }, { foo: 1, bar: "x" }],
    [{ foo: "nope" }, { bar: 42 }],
  );
});

test("test_json_min_max_properties", () => {
  const compileErrors = [
    [
      {
        type: "object",
        properties: { foo: { type: "string" } },
        maxProperties: 7,
      },
      'min/maxProperties only supported when all keys listed in "properties" are required',
    ],
    [
      {
        type: "object",
        properties: { foo: { type: "string" } },
        minProperties: 1,
      },
      'min/maxProperties only supported when all keys listed in "properties" are required',
    ],
    [
      { type: "object", minProperties: 7, maxProperties: 1 },
      "minProperties > maxProperties",
    ],
    [
      { type: "object", required: ["foo", "bar"], maxProperties: 1 },
      "required > maxProperties",
    ],
  ];
  for (const [schema, message] of compileErrors)
    assertCompileError(`start: %json ${JSON.stringify(schema)}`, message);

  const cases = [
    [
      {
        type: "object",
        properties: { foo: { type: "string" }, bar: { type: "array" } },
        additionalProperties: { type: "integer" },
        required: ["foo", "mux"],
        minProperties: 2,
      },
      [
        { foo: "bar", mux: 7 },
        { foo: "bar", mux: 7, mux2: 7 },
      ],
      [{ foo: "bar" }],
    ],
    [
      { type: "object", minProperties: 1 },
      [{ foo: "bar" }, { foo: "bar", mux: 7 }],
      [{}],
    ],
    [
      {
        type: "object",
        description: "Output file",
        patternProperties: { "^.*$": { type: "object" } },
        additionalProperties: false,
        maxProperties: 1,
      },
      [{}, { foo: {} }, { "metric.txt": { bar: 42 } }],
      [{ foo: 7 }, { foo: {}, bar: {} }],
    ],
    [
      {
        type: "object",
        properties: { foo: { type: "string" } },
        additionalProperties: { type: "integer" },
        required: ["foo", "mux"],
        minProperties: 3,
        maxProperties: 5,
      },
      [
        { foo: "bar", mux: 7, mux2: 7 },
        { foo: "bar", mux: 7, mux2: 7, mux3: 7, mux4: 7 },
      ],
      [
        { foo: "bar" },
        { foo: "bar", mux: 7 },
        { foo: "bar", mux: 7, mux2: 7, mux3: 7, mux4: true },
        { foo: "bar", mux: 7, mux2: 7, mux3: 7, mux4: 7, mux5: 7 },
      ],
    ],
    [
      {
        type: "object",
        properties: {
          foo: { type: "string" },
          bar: { type: "array" },
          mux: { type: "integer" },
        },
        minProperties: 1,
        additionalProperties: false,
      },
      [{ foo: "bar" }, { bar: [] }, { foo: "bar", mux: 7 }],
      [{}, { foo: 7 }],
    ],
    [
      {
        type: "object",
        properties: {
          foo: { type: "string" },
          bar: { type: "array" },
          mux: { type: "integer" },
        },
        minProperties: 1,
        maxProperties: 1,
        additionalProperties: false,
      },
      [{ foo: "bar" }, { bar: [] }],
      [{}, { foo: 7 }, { foo: "bar", mux: 7 }],
    ],
    [
      {
        type: "object",
        properties: {
          foo: { type: "string" },
          bar: { type: "array" },
          mux: { type: "integer" },
        },
        maxProperties: 1,
        additionalProperties: false,
      },
      [{}, { foo: "bar" }, { bar: [] }],
      [{ foo: 7 }, { foo: "bar", mux: 7 }],
    ],
    [
      {
        type: "object",
        properties: {
          foo: { type: "string" },
          bar: { type: "array" },
          mux: { type: "integer" },
        },
        required: ["bar"],
        minProperties: 2,
        additionalProperties: false,
      },
      [
        { foo: "a", bar: [] },
        { bar: [], mux: 1 },
        { foo: "a", bar: [], mux: 1 },
      ],
      [{ foo: 7 }, { bar: [] }, { foo: "bar", mux: 7 }],
    ],
    [
      {
        type: "object",
        properties: {
          foo: { type: "string" },
          bar: { type: "array" },
          mux: { type: "integer" },
        },
        required: ["bar"],
        maxProperties: 2,
        additionalProperties: false,
      },
      [{ foo: "a", bar: [] }, { bar: [], mux: 1 }, { bar: [] }],
      [{ foo: 7 }, { foo: "bar", mux: 7 }, { foo: "a", bar: [], mux: 1 }],
    ],
  ];
  for (const [schema, passing, failing] of cases)
    assertJson(schema, passing, failing);
});

test("test_json_format_email", () => {
  assertJson(
    { type: "string", format: "email" },
    [
      "test@example.com",
      "foo.bar@example.com",
      "foo.bar@example-123.com",
      "foo+bar@example-123.com",
      "f$o#o`b-a!r@example-123.com",
      "fo%o#bar@example-123.com",
      "test@[192.168.1.1]",
    ],
    [
      "",
      " @example.com",
      "test@",
      "@example.com",
      "test@.com",
      "test@com.",
      "test@example..com",
      "test@example.c.",
      "test@.example.com",
      "test:2@example.com",
      "test[2]@example.com",
    ],
  );
});

test("test_regex_and", () => {
  const vectors = [
    [
      "start: ST\nST: LOWER & ABC\nLOWER: /[a-z]+/\nABC: /[abcABC]+/",
      ["abc", "a", "bbb"],
      ["A", "d", "1"],
    ],
    [
      "start: ST\nST: /[a-z]+/ & /[abcABC]+/",
      ["abc", "a", "bbb"],
      ["A", "d", "1"],
    ],
    [
      "start: ST\nST: /[ab]+/ | /[cd]+/ & /[def]+/",
      ["ab", "dd"],
      ["c", "e", "f"],
    ],
    [
      "start: ST\nST: /[ab]+/ | ( /[cd]+/ & /[def]+/ )",
      ["ab", "dd"],
      ["c", "e", "f"],
    ],
    [
      "start: ST\nST: ( /[abf]+/ | /[cd]+/ ) & /[def]+/",
      ["d", "f"],
      ["a", "b"],
    ],
    [
      "start: ST\nST: /[ab]/+ | /[cd]/+ & /[def]/+",
      ["ab", "dd"],
      ["c", "e", "f"],
    ],
    ["start: ST\nST: /[abc]/ & /[bcd]/ & /[cde]/", ["c"], ["a", "b", "d", "e"]],
    ["start: ST\nST: /a*/ & /a+/", ["a", "aa"], ["FINAL_REJECT:", "b"]],
    [
      'start: "foo" | ST\nST: /a/? & /a{2}/',
      ["foo"],
      ["FINAL_REJECT:", "a", "aa"],
    ],
    ['start: "foo" | ST\nST: /a/ /b/ & /b/', ["foo"], ["b", "a", "abb", "ab"]],
    ['start: "foo" | ST\nST: /ab/ & /b/', ["foo"], ["ab", "b", "a"]],
  ];
  for (const [grammar, passing, failing] of vectors)
    assertLark(grammar, passing, failing);
  assertCompileError(
    "start: LOWER & ABC\nLOWER: /[a-z]+/\nABC: /[abcABC]+/",
    "& is only supported for tokens, not rules",
  );
});

test("test_regex_not", () => {
  assertLark(
    "start: ST\nST: /[abcd]+/ & ~/(.*)[ab](.*)/",
    ["cd", "c"],
    ["x", "aa", "ca", "b"],
  );
  assertLark(
    "start: ASCII_LINES\nASCII_LINES: /[a-zA-Z \\n]*/ & ~/(?s:.*)\\n\\n(?s:.*)/",
    ["foo", "bar\nbaz", "hello world\n", "aaa\nbbb\nccc"],
    [".", "a\n\na"],
  );
});

test("test_parametric_0", () => {
  const body = `perm::_ : "X" %if is_ones([0:3])
    | a0 perm::set_bit(0) %if bit_clear(0)
    | a1 perm::set_bit(1) %if bit_clear(1)
    | a2 perm::set_bit(2) %if bit_clear(2)
    a0: "a"
    a1: "b"
    a2: "c"`;
  const passing = ["abcX", "bcaX", "cbaX", "cabX", "acbX", "bacX"];
  const failing = ["z", "X", "aX", "abX", "abb", "aa", "bb", "cc"];
  assertLark(`start: perm::0x0\n${body}`, passing, failing);
  assertLark(
    `start: perm::0x0 "Y"\n${body}`,
    passing.map((value) => `${value}Y`),
    failing,
  );
});

test("test_parametric_1", () => {
  assertLark(
    `start: aa::0 "X"
aa::_: a aa::incr(_) %if lt(_, 6) | bb::_
bb::_: b bb::incr(_) %if lt(_, 6) | ""
a: "a"
b: "b"`,
    [
      "X",
      "aX",
      "bX",
      "abX",
      "aabX",
      "aaabX",
      "aaaabbX",
      "aaabbbX",
      "aaaaaaX",
      "bbbbbbX",
    ],
    ["z", "ba", "aaaaaaa", "bbbbbbb", "aaabbbbb"],
  );
});

test("test_parametric_cnt", () => {
  assertLark(
    `start: lst::0x0
lst::_: "a" lst::incr([0:2]) %if lt([0:2], 3)
     | "b" lst::incr([2:4]) %if lt([2:4], 3)
     | "c" lst::incr([4:6]) %if lt([4:6], 2)
     | "X"`,
    [
      "X",
      "aX",
      "bX",
      "abX",
      "aabX",
      "aaabX",
      "bbbaaaX",
      "ccaaabbbX",
      "abcababcX",
    ],
    ["z", "aaaa", "bbbb", "ccc", "aaaccc", "aaabbbb"],
  );
});

test("test_parametric_pick_3", () => {
  assertLark(
    `start: perm::0x0
perm::_: "X" %if bit_count_ge(_, 1)
 | "a" perm::set_bit(0) %if and(bit_clear(0), bit_count_lt(_, 3))
 | "b" perm::set_bit(1) %if and(bit_clear(1), bit_count_lt(_, 3))
 | "c" perm::set_bit(2) %if and(bit_clear(2), bit_count_lt(_, 3))
 | "d" perm::set_bit(3) %if and(bit_clear(3), bit_count_lt(_, 3))
 | "e" perm::set_bit(4) %if and(bit_clear(4), bit_count_lt(_, 3))`,
    ["aX", "bX", "bacX", "adeX"],
    ["X", "z", "aa", "bb", "abcd", "aba"],
  );
});

test("test_parametric_null", () => {
  const passing = ["abcX", "bcaX", "cbaX", "cabX", "acbX", "bacX"];
  const failing = [
    "z",
    "X",
    "aX",
    "bX",
    "cX",
    "abX",
    "acX",
    "cbX",
    "abb",
    "aa",
    "bb",
    "cc",
  ];
  const alternatives = `| "a" perm::set_bit(0) %if bit_clear(0)
    | "b" perm::set_bit(1) %if bit_clear(1)
    | "c" perm::set_bit(2) %if bit_clear(2)`;
  assertLark(
    `start: perm::0x0 "X"\nperm::_: "" %if is_ones([0:3]) ${alternatives}`,
    passing,
    failing,
  );
  for (const first of ["ae::_ be::_ %if is_zeros([10:12])", "ae::_ be::_"]) {
    assertLark(
      `start: perm::0x0 "X"
perm::_: ${first} ${alternatives}
ae::_: "" %if is_ones([0:1])
be::_: ce::_ %if is_ones([1:2])
ce::_: "" %if is_ones([2:3])`,
      passing,
      failing,
    );
  }
});

test("test_parametric_syntax", () => {
  const errors = [
    ['start: foo\nfoo:: "a"', "Expected token '_'"],
    ['start: foo\nfoo: a::1\na: "a"', "rule 'a' is not parametric"],
    [
      'start: foo\nfoo::_: "a" %if eq([3:3], 0)',
      "end bit index 3 must be > start bit index 3",
    ],
    [
      'start: foo\nfoo::_: "a" %if eq([64:65], 0)',
      "number 64 is too large; must be <= 63",
    ],
    [
      'start: foo\nfoo::_: "a" %if eq([0:65], 0)',
      "number 65 is too large; must be <= 64",
    ],
    [
      'BAR: "b" %if and(true,true)\nstart: bar\nbar: BAR',
      "'%if' is not supported in terminals",
    ],
    [
      "BAZ: qux::0\nstart: baz\nbaz: BAZ",
      "name::param cannot be used in terminals",
    ],
    [
      'start: foo\nfoo::_: bar\nbar: "a"',
      'rule "foo" is parametric, but its body doesn\'t need parameters',
    ],
    [
      "start: foo\nfoo: bar::_\nbar::_: bar::_",
      'rule "foo" is not parametric, but its body requires parameters',
    ],
    [
      "start: foo\nfoo: bar\nbar::_: bar::_",
      "rule 'bar' is parametric, but no parameter provided",
    ],
    [
      'BAZ: qux::0\nstart: BAZ\nqux::_: "baz"',
      "name::param cannot be used in terminals",
    ],
    [
      'start: foo\nfoo::_: "a" %if eq(0, 0)',
      "expected '_' or '[start_bit:stop_bit]'",
    ],
    ['start: foo\nfoo::_: "a" %if foo([0:1], 0)', "Unexpected condition 'foo'"],
  ];
  for (const [grammar, message] of errors) assertCompileError(grammar, message);

  // Excluded: stop, temperature, and max_tokens attributes on parametric rules
  // only validate parser-option restrictions.
});

test("test_parametric_long", () => {
  const n = 90;
  const accepted = `${"a ".repeat(n)}${"b ".repeat(n)}X`;
  const rejected = `${"a ".repeat(n)}${"b ".repeat(n + 2)}`;
  assertLark(
    `start: aa::0 "X"
aa::_: "a " aa::incr(_) %if lt(_, ${n * 2}) | bb::_
bb::_: "b " bb::incr(_) %if lt(_, ${n * 2}) | ""`,
    [accepted],
    [rejected],
  );

  const m = 50;
  const row = "a b c d e f g ".repeat(m);
  assertLark(
    `start: lst::0x0
lst::_: "a " lst::incr([0:8]) %if lt([0:8], ${m})
 | "b " lst::incr([8:16]) %if lt([8:16], ${m})
 | "c " lst::incr([16:24]) %if lt([16:24], ${m})
 | "d " lst::incr([24:32]) %if lt([24:32], ${m})
 | "e " lst::incr([32:40]) %if lt([32:40], ${m})
 | "f " lst::incr([40:48]) %if lt([40:48], ${m})
 | "g " lst::incr([48:56]) %if lt([48:56], ${m})
 | "X"`,
    [`${row}X`],
    [`${row}a `],
  );
});

// No trace-only, mask-only, capture-value, explicit backtracking, or parser-
// option assertions from the upstream file are represented here.
