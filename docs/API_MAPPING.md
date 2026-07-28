# llguidance Python API to JS API

The package exposes a pure-TypeScript runtime with selected names modeled after Python `llguidance`. The loader remains asynchronous for API compatibility. This mapping describes compatibility scaffolding, not full API parity.

```js
import { loadLLGuidance } from "llguidance";

const llguidance = await loadLLGuidance();
const tokenizer = new llguidance.LLTokenizer(tokenizerConfig);
const grammar = llguidance.LLMatcher.grammar_from_regex("[a-z]+");
const matcher = new llguidance.LLMatcher(tokenizer, grammar);
```

## Python Public API

Python `llguidance` exports:

- `LLTokenizer`
- `LLMatcher`
- `LLInterpreter`
- `LLExecutor`
- `LLParserLimits`
- `JsonCompiler`
- `LarkCompiler`
- `RegexCompiler`
- `TokenizerWrapper`
- `grammar_from`
- `GrammarFormat`
- `StructTag`
- `regex_to_lark`
- `get_version`
- `__version__`

## JS Runtime API

After `await loadLLGuidance()` or `await loadBundledLLGuidance()`, the runtime exposes:

- `LLTokenizer`
- `LLMatcher`
- `LLInterpreter`
- `JsonCompiler`
- `LarkCompiler`
- `RegexCompiler`
- `grammar_from(format, text)`
- `grammarFrom(format, text)`
- `regex_to_lark(regex)`
- `get_version()`
- `createTokenizer(config)`
- `createInterpreter(config)`

## Mapping

| Python                                                              | JS                                                           | Status                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLTokenizer(tokenizer, n_vocab=None, eos_token=None, slices=None)` | `new llguidance.LLTokenizer(tokenizerOrConfig, options?)`    | Partial. Supports explicit token config and compatible tokenizer extraction. Python slice controls are unsupported.                           |
| `LLTokenizer.vocab_size`                                            | `tokenizer.vocab_size`                                       | Implemented.                                                                                                                                  |
| `LLTokenizer.eos_token`                                             | `tokenizer.eos_token`                                        | Implemented.                                                                                                                                  |
| `LLTokenizer.eos_tokens`                                            | `tokenizer.eos_tokens`                                       | Implemented as `[eos_token]`.                                                                                                                 |
| `LLTokenizer.is_canonical`                                          | `tokenizer.is_canonical`                                     | Present, currently `false` for approximate JS tokenizers.                                                                                     |
| `LLInterpreter(tokenizer, grammar, ...)`                            | `new llguidance.LLInterpreter(tokenizer, grammar, options?)` | Implemented for TypeScript JSON Schema and regex markers or response-format configs.                                                          |
| `LLInterpreter.compute_mask()`                                      | `interpreter.compute_mask()`                                 | Implemented. Returns `[maskBytesOrNull, infoJson]`.                                                                                           |
| `LLInterpreter.compute_mask_into(bytearray)`                        | `interpreter.compute_mask_into(Uint8Array)`                  | Implemented.                                                                                                                                  |
| `LLInterpreter.commit_token(token)`                                 | `interpreter.commit_token(token)`                            | Implemented. Returns `[backtrack, ffTokens]`.                                                                                                 |
| `LLInterpreter.is_accepting()`                                      | `interpreter.is_accepting()`                                 | Partial. Tracks accepting state in the JS wrapper.                                                                                            |
| `LLInterpreter.stop_reason()`                                       | `interpreter.stop_reason()`                                  | Partial. Returns `NotStopped` or `NoExtension`.                                                                                               |
| `LLInterpreter.has_pending_stop()`                                  | `interpreter.has_pending_stop()`                             | Partial. Tracks wrapper stop state.                                                                                                           |
| `LLMatcher(tokenizer, grammar, ...)`                                | `new llguidance.LLMatcher(tokenizer, grammar, options?)`     | Implemented for the TypeScript JSON Schema and regex engines.                                                                                 |
| `LLMatcher.grammar_from_json_schema(schema)`                        | `llguidance.LLMatcher.grammar_from_json_schema(schema)`      | Implemented.                                                                                                                                  |
| `LLMatcher.grammar_from_lark(lark)`                                 | `llguidance.LLMatcher.grammar_from_lark(lark)`               | Scaffolding only. Its marker is rejected when constructing an interpreter or matcher.                                                         |
| `LLMatcher.grammar_from_regex(regex)`                               | `llguidance.LLMatcher.grammar_from_regex(regex)`             | Implemented.                                                                                                                                  |
| `LLMatcher.validate_grammar(grammar, tokenizer=None)`               | `llguidance.LLMatcher.validate_grammar(grammar, tokenizer?)` | Partial. Without a tokenizer returns `""`; with one, attempts construction.                                                                   |
| `LLMatcher.validate_grammar_with_warnings(...)`                     | `llguidance.LLMatcher.validate_grammar_with_warnings(...)`   | Partial. Returns `[isError, messages]`.                                                                                                       |
| `LLMatcher.compute_bitmask()`                                       | `matcher.compute_bitmask()`                                  | Implemented. Returns `Uint8Array` bitmask bytes.                                                                                              |
| `LLMatcher.compute_logit_bias()`                                    | `matcher.compute_logit_bias()`                               | Implemented. Returns a `Uint8Array` containing `0` or `200`.                                                                                  |
| `LLMatcher.consume_token(token)`                                    | `matcher.consume_token(token)`                               | Implemented.                                                                                                                                  |
| `LLMatcher.consume_tokens(tokens)`                                  | `matcher.consume_tokens(tokens)`                             | Implemented.                                                                                                                                  |
| `LLMatcher.try_consume_tokens(tokens)`                              | `matcher.try_consume_tokens(tokens)`                         | Implemented.                                                                                                                                  |
| `LLMatcher.validate_tokens(tokens)`                                 | `matcher.validate_tokens(tokens)`                            | Implemented by replaying on a fresh matcher.                                                                                                  |
| `LLMatcher.reset()`                                                 | `matcher.reset()`                                            | Implemented.                                                                                                                                  |
| `LLMatcher.rollback(num_tokens)`                                    | `matcher.rollback(num_tokens)`                               | Unsupported; throws explicitly.                                                                                                               |
| `LLMatcher.deep_copy()`                                             | `matcher.deep_copy()`                                        | Unsupported; throws explicitly.                                                                                                               |
| `LLMatcher.compute_ff_tokens()`                                     | `matcher.compute_ff_tokens()`                                | Compatibility stub; no fast-forward tokens are produced.                                                                                      |
| `LLMatcher.compute_ff_bytes()`                                      | `matcher.compute_ff_bytes()`                                 | Compatibility stub; returns empty bytes.                                                                                                      |
| `LLMatcher.get_capture(name)`                                       | `matcher.get_capture(name)`                                  | Compatibility stub; returns `null`.                                                                                                           |
| `LLMatcher.get_captures()`                                          | `matcher.get_captures()`                                     | Compatibility stub; returns `[]`.                                                                                                             |
| `JsonCompiler().compile(schema)`                                    | `new llguidance.JsonCompiler().compile(schema)`              | Implemented through `grammar_from_json_schema`.                                                                                               |
| `LarkCompiler().compile(lark)`                                      | `new llguidance.LarkCompiler().compile(lark)`                | Scaffolding only; its result is unsupported at interpreter construction.                                                                      |
| `RegexCompiler().compile(regex)`                                    | `new llguidance.RegexCompiler().compile(regex)`              | Implemented through `grammar_from_regex`.                                                                                                     |
| `grammar_from(format, text)`                                        | `llguidance.grammar_from(format, text)`                      | Implemented for TypeScript formats. `lark` creates unsupported scaffolding; raw upstream grammars must already be TypeScript backend markers. |
| `regex_to_lark(regex)`                                              | `llguidance.regex_to_lark(regex)`                            | Minimal helper; full Python semantics are unsupported.                                                                                        |
| `get_version()`                                                     | `llguidance.get_version()`                                   | Returns `"llguidance-ts-core"`, not the npm package version.                                                                                  |
| `LLExecutor`                                                        | none                                                         | Unsupported.                                                                                                                                  |
| `LLParserLimits`                                                    | plain JS options object                                      | No equivalent class.                                                                                                                          |
| `TokenizerWrapper`                                                  | none                                                         | Compatible tokenizer objects can be passed directly.                                                                                          |
| `StructTag`                                                         | none                                                         | Unsupported.                                                                                                                                  |
| `__version__`                                                       | package version                                              | Available through npm metadata, not exported at runtime.                                                                                      |

## Lifecycle And State

`LLTokenizer`, `LLInterpreter`, `LLMatcher`, and the convenience engine handles expose idempotent `free()` and `dispose()`. Using a disposed engine handle throws.

An interpreter represents one mutable decoding stream. Cloning, beams, batches, and rollback require separate caller-managed interpreters.

Lark compilation is intentionally not implemented. Use upstream `llguidance` when general grammar parity is required.

## Convenience API

```js
const runtime = await loadLLGuidance();
const tokenizer = runtime.createTokenizer({ tokens, eos_token_id });
const interpreter = runtime.createInterpreter({
  tokenizer,
  response_format: { type: "regex", regex: "[a-z]+" },
});
```
