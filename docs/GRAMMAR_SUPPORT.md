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
- Slash-delimited regex terminals using the subset in [REGEX_SUPPORT.md](REGEX_SUPPORT.md)
- Concatenation, `|` alternatives, parentheses, and `?`, `*`, and `+`
- Empty alternatives and the empty literal `""`
- Comments beginning with `#` outside literals and regexes
- Continuation alternatives whose trimmed line begins with `|`
- `%import common.WS`, `%import common.WS_INLINE`, `%ignore NAME`, and `%ignore /regex/`

Ignored terminals must consume at least one byte. Whitespace is not ignored implicitly.

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

Unsupported syntax throws a `SyntaxError` during interpreter construction. This includes regex flags, bounded repetition, priorities, aliases, rule templates, Lark directives other than the imports and ignores above, single-quoted literals, range syntax, terminal intersection or negation, rule attributes, `%json`, `%regex`, `%lark`, `%declare`, `%override`, and `%extend`.

This entry is not intended to provide full upstream Lark or llguidance grammar compatibility.
