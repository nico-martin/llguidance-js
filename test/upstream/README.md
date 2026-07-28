# Upstream test ports

These tests port black-box behavior from `guidance-ai/llguidance` to the public
JavaScript surface. They use the built-in single-byte tokenizer so every input
byte can be checked directly against the generated token mask.

The source inventory was taken from the clone at `llguidance-original/`
(`e98236e`). Unsupported pure-TypeScript core features remain as explicit skips
so their vectors can be enabled as each subsystem is implemented.

## Ported suites

| JavaScript file               | Upstream source                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `json-primitives.test.mjs`    | `parser/tests/test_json_primitives.rs`                                                    |
| `json-structures.test.mjs`    | `parser/tests/test_json_arrays.rs`, `test_json_objects.rs`, and `test_json_enum_const.rs` |
| `json-combinations.test.mjs`  | `parser/tests/test_json_schema_combinations.rs`                                           |
| `json-string-format.test.mjs` | `parser/tests/test_json_string_format.rs`                                                 |
| `json-x-guidance.test.mjs`    | `parser/tests/test_json_x_guidance.rs`                                                    |
| `lark.test.mjs`               | Portable acceptance and compilation behavior from `parser/tests/test_lark.rs`             |
| `matcher-api.test.mjs`        | Supported public API behavior from `python/torch_tests/test_matcher.py`                   |

The full `pnpm test` run currently reports 457 tests: 419 passing and 38
explicitly skipped. Lark tests and regex-valued JSON separators are skipped.
Negative `multipleOf` values and URI format vectors run in TypeScript even
though they remain skipped against the older `llguidance 1.2.0` backend.

`test/json-schema-2020-profile.test.mjs` adds TypeScript-profile coverage for
conditionals and `not`, pattern and dependency keywords, recognized formats,
2020-12 `contains` bounds, exact `uniqueItems`, local JSON Pointer references,
and compile-time rejection of malformed schemas. It is a profile suite rather
than a claim of complete JSON Schema conformance.

## Exclusions

Not ported because the JavaScript package does not expose the required API:

- Upstream unit tests for parser internals, regex rewriting, numeric compilation,
  substring matching, token tries, recognizers, bit vectors, and bias caches.
- C ABI tests for pointers, struct sizes, callbacks, buffers, allocation, and
  object lifetime.
- Parallel executor, Torch, NumPy, MLX, CUDA, llama.cpp, tiktoken, and remote
  Hugging Face tokenizer integration tests.
- Rollback, deep copy, captures, parser warnings/options, canonical tokenizer
  slices, stop-controller internals, and fast-forward byte APIs, which are
  currently absent or stubbed in `src/runtime.js`.
- MaskBench and the official JSON Schema Test Suite checkout, which depend on
  separate external repositories and are integration/conformance jobs rather
  than self-contained upstream test vectors.

Numeric JSON spellings such as `1.0` are supplied as raw text where JavaScript's
`JSON.stringify()` would otherwise normalize them to `1`.
