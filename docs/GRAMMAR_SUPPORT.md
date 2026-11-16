# Grammar Support

The optional `llguidance/grammar` entry implements a practical, deliberately small Lark-compatible subset. It is a static bundle and is not included by the root, regex, or JSON Schema entries.

## Usage

```js
import { loadGrammarGuidance } from "llguidance/grammar";

const runtime = await loadGrammarGuidance();
const interpreter = runtime.createInterpreter({
  tokenizer,
  grammar: String.raw`
    %import common.WS
    %ignore WS
    start: value
    value: WORD | "(" value ")"
    WORD: /[a-z]+/
  `,
});
```

The runtime exposes `createTokenizer`, `createInterpreter`, and `get_version`. Grammar interpreters use the same `computeMask`, `commitToken`, `clone`, `rollback`, `computeFastForward`, `free`, and `dispose` APIs as the other pure TypeScript entries.

## Supported Syntax

- A required `start` rule and recursive named rules or terminals matching `[A-Za-z_][A-Za-z0-9_]*`
- Double-quoted JSON string literals, including escapes and Unicode
- Slash-delimited regex terminals using the subset in [REGEX_SUPPORT.md](REGEX_SUPPORT.md); `\/` matches a literal `/`
- Inline JSON Schemas with `%json { ... }`, described below
- Concatenation, `|` alternatives, parentheses, and `?`, `*`, and `+`
- Empty alternatives and the empty literal `""`
- Comments beginning with `#` outside literals and regexes
- Continuation alternatives whose trimmed line begins with `|`
- `%import common.WS`, `%import common.WS_INLINE`, `%ignore NAME`, and `%ignore /regex/`

Ignored terminals must consume at least one byte. Whitespace is not ignored implicitly.

## Inline JSON Schemas

As in upstream llguidance, `%json` followed by a JSON value embeds a JSON Schema in a rule. It behaves like a non-terminal matching one JSON document accepted by that schema, and can be a whole rule body or an atom inside a sequence, group, or alternative:

```lark
start: "<tool_call>\n<function=" call "\n</function>\n</tool_call>"
call: "get_weather>" city | "search>" query
city: "\n<parameter=city>\n" %json { "type": "string", "minLength": 1 } "\n</parameter>"
query: "\n<parameter=query>\n" args "\n</parameter>"
args: %json {
  "type": "object",
  "properties": { "text": { "type": "string" }, "limit": { "type": "integer" } },
  "required": ["text"]
}
```

```lark
start: "<|tool_call_start|>[" call ("," call)* "]<|tool_call_end|>"
call: "get_weather(city=" %json { "type": "string" } ")"
    | "add(values=" %json { "type": "array", "items": { "type": "integer" } } ")"
```

- The schema is compiled by the JSON Schema engine and supports exactly the profile in [JSON_SCHEMA_PROFILE.md](JSON_SCHEMA_PROFILE.md), including `x-guidance` separators and `whitespace_flexible`. Boolean schemas are accepted. The interpreter's `maxSchemaDepth` and `maxJsonDepth` limits apply.
- The value may span several lines. A `%json` value ends where its JSON value ends, so a rule can continue after it.
- Whitespace inside the JSON document follows the schema's JSON rules. Whitespace before or after the document is not part of it and is only allowed through the grammar's `%ignore`.
- Like a literal or regex terminal, an inline `%json` value is not captured. Give it a named rule, such as `args` above, to capture the generated JSON text.
- As upstream, `%json` cannot be used in a terminal definition (a name such as `ARGS` or `_ARGS`) or named by `%ignore`. An unterminated or invalid JSON value, or a schema outside the supported profile, throws a `SyntaxError`.
- Identical schemas in one grammar share one compiled JSON program.

The grammar entry statically includes the JSON Schema engine for `%json`.

## Captures

Every completed user-defined rule is captured by its rule name. `interpreter.getCapture(name)` returns the last capture with that name, or `null`; `interpreter.getCaptures(name?)` returns all captures, optionally filtered by name. Each capture is:

```ts
{
  name: string;
  value: string;
  start: number;
  end: number;
}
```

`start` and `end` are UTF-8 byte offsets. Nested captures are ordered inner-first, followed by their containing rule. Leading and trailing ignored input is outside a rule capture; ignored input between child symbols remains part of the containing rule's value. Captures are exposed once the complete grammar currently accepts. Ambiguous grammars use the first derivation retained by the incremental parser, so applications requiring specific captures should use an unambiguous grammar.

## Explicitly Unsupported

Unsupported syntax throws a `SyntaxError` during interpreter construction. This includes regex flags, bounded repetition, priorities, aliases, rule templates, Lark directives other than the imports and ignores above, single-quoted literals, range syntax, terminal intersection or negation, rule attributes, `%regex`, `%lark`, `%declare`, `%override`, and `%extend`.

This entry is not intended to provide full upstream Lark or llguidance grammar compatibility.
