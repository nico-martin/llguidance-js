# Compatibility

This package implements a focused JavaScript constrained-decoding runtime. It is not a full port of every upstream llguidance API or behavior.

## Supported Engines

- `json_object`
- The JSON Schema profile documented in [JSON_SCHEMA_PROFILE.md](JSON_SCHEMA_PROFILE.md)
- The regex subset documented in [REGEX_SUPPORT.md](REGEX_SUPPORT.md)
- The optional practical Lark subset documented in [GRAMMAR_SUPPORT.md](GRAMMAR_SUPPORT.md)

## Public Runtime

The primary JavaScript API is:

- `loadBundledLLGuidance()` and `loadLLGuidance()`
- `runtime.createTokenizer()`
- `runtime.createInterpreter()`
- `interpreter.computeMask()`
- `interpreter.commitToken()`

Python-style class names and helpers are available where they map cleanly to the TypeScript engines. See [API_MAPPING.md](API_MAPPING.md) for method-level details.

## Feature Entries

`llguidance/regex` exports `loadRegexGuidance()` and supports only the `regex` response format. `llguidance/json-schema` exports `loadJsonGuidance()` and supports `json_object` and `json_schema`. `llguidance/grammar` exports `loadGrammarGuidance()` and accepts a grammar string using the documented Lark subset.

Both return a lean runtime containing `createTokenizer()`, `createInterpreter()`, and `get_version()`. They intentionally omit `LLMatcher`, `LLInterpreter`, and compiler compatibility classes. The full `llguidance` entry retains those APIs and includes both engines.

Feature selection is static: no entry uses a dynamic import, and requesting an unavailable format from a specialized runtime fails explicitly.

## Unsupported Upstream Features

- Full upstream Lark syntax and grammar behavior outside the optional subset
- Raw upstream `llguidance` or `guidance` serialized grammars
- Upstream capture attributes and capture behavior outside grammar rule-name captures
- Upstream fast-forward byte generation; deterministic token fast-forward is supported
- Stop-controller internals
- Parser warning and limit parity
- Canonical tokenizer slices
- Parallel executors and native framework integrations

The root runtime's `LarkCompiler` and `grammar_from_lark()` remain compatibility scaffolding, and their output is rejected there. Lark markers compile only in the statically separate `llguidance/grammar` entry.

## State Model

An interpreter represents one mutable stream. `clone()` creates an independent
branch and `rollback(count)` rewinds committed tokens. Callers still manage
batch rows and beam scheduling; the runtime does not clone or reorder streams
automatically.

## Version Identifier

`get_version()` returns `llguidance-ts-core`, which identifies the backend rather than the npm package version.

## Error Policy

Unsupported grammar formats, unavailable feature-bundle engines, and schema assertion keywords fail explicitly. Compatibility stubs are documented in [API_MAPPING.md](API_MAPPING.md) and should not be interpreted as implemented upstream behavior.
