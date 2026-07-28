# Compatibility

This package implements a focused JavaScript constrained-decoding runtime. It is not a full port of every upstream llguidance API or behavior.

## Supported Engines

- `json_object`
- The JSON Schema profile documented in [JSON_SCHEMA_PROFILE.md](JSON_SCHEMA_PROFILE.md)
- The regex subset documented in [REGEX_SUPPORT.md](REGEX_SUPPORT.md)

## Public Runtime

The primary JavaScript API is:

- `loadBundledLLGuidance()` and `loadLLGuidance()`
- `runtime.createTokenizer()`
- `runtime.createInterpreter()`
- `interpreter.computeMask()`
- `interpreter.commitToken()`

Python-style class names and helpers are available where they map cleanly to the TypeScript engines. See [API_MAPPING.md](API_MAPPING.md) for method-level details.

## Feature Entries

`llguidance/regex` exports `loadRegexGuidance()` and supports only the `regex` response format. `llguidance/json-schema` exports `loadJsonGuidance()` and supports `json_object` and `json_schema`.

Both return a lean runtime containing `createTokenizer()`, `createInterpreter()`, and `get_version()`. They intentionally omit `LLMatcher`, `LLInterpreter`, and compiler compatibility classes. The full `llguidance` entry retains those APIs and includes both engines.

Feature selection is static: no entry uses a dynamic import, and requesting an unavailable format from a specialized runtime fails explicitly.

## Unsupported Upstream Features

- Lark parsing and general context-free grammar execution
- Raw upstream `llguidance` or `guidance` serialized grammars
- Rollback and interpreter deep copy
- Captures
- Fast-forward token and byte generation
- Stop-controller internals
- Parser warning and limit parity
- Canonical tokenizer slices
- Parallel executors and native framework integrations

`LarkCompiler` and `grammar_from_lark()` remain compatibility scaffolding. Their output is rejected when constructing an interpreter or matcher.

## State Model

An interpreter represents one mutable stream. Batch rows, beams, and forks require separate interpreters. The runtime does not clone or reorder interpreter state automatically.

## Version Identifier

`get_version()` returns `llguidance-ts-core`, which identifies the backend rather than the npm package version.

## Error Policy

Unsupported grammar formats, unavailable feature-bundle engines, and schema assertion keywords fail explicitly. Compatibility stubs are documented in [API_MAPPING.md](API_MAPPING.md) and should not be interpreted as implemented upstream behavior.
