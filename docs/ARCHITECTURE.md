# Architecture

The runtime is implemented in TypeScript and exposes the same engine to browser and Node.js bundles.

## Generation Loop

Each interpreter owns one mutable decoding stream:

1. `computeMask()` determines eligible next-token IDs.
2. The caller applies the mask to model logits and samples one token.
3. `commitToken(tokenId)` validates and advances the interpreter state.
4. The loop repeats until EOS is eligible and sampled.

Callers must use separate interpreters for batch rows, beams, or forks.

## Tokenizer Trie

`LLGuidanceTokenizer` normalizes the vocabulary into immutable raw byte arrays and builds one byte trie. Trie terminals retain every token ID, including IDs with duplicate byte sequences.

Regex masking traverses the trie while carrying one NFA state per shared byte prefix. Nonviable branches are pruned before their descendant tokens are considered.

JSON masking uses trie terminals to evaluate duplicate byte sequences once. JSON internal-prefix traversal is intentionally conservative because the current JSON parser analyzes the full committed prefix rather than exposing a persistent incremental parser state.

## Regex Engine

Regexes compile into a Thompson NFA. A regex state is an immutable opaque snapshot of active NFA states and start-position information.

Advancing a token feeds all of its bytes through the NFA. Viability means at least one active state can still reach a match; acceptance means the current state reaches the match operation.

See [REGEX_SUPPORT.md](REGEX_SUPPORT.md) for syntax details.

## JSON Schema Engine

The JSON engine retains committed bytes. Candidate tokens are appended and analyzed as UTF-8 JSON prefixes.

Analysis has two responsibilities:

- Syntax and schema-aware prefix viability for token masking
- Exact complete-document validation for EOS

The schema validator keeps raw numeric spellings and normalizes them into exact decimal coefficient/exponent pairs for numeric assertions and equality.

See [JSON_SCHEMA_PROFILE.md](JSON_SCHEMA_PROFILE.md) for the supported profile.

## Mask Cache

Each interpreter caches its mask for the current state. Repeated `computeMask()` calls avoid grammar recomputation.

Returned `Uint32Array` masks are cloned, so callers can mutate them without corrupting the cache. A successful token commit invalidates the cache. Failed commits leave the interpreter state and cache unchanged.

## Runtime Layers

- `src/engine/core.ts`: compiler-injected tokenizer, trie, interpreter, and marker factory
- `src/engine/index.ts`: full engine wiring with both compilers
- `src/engine/regex-only.ts` and `src/engine/json-only.ts`: static single-engine wiring
- `src/engine/regex.ts`: regex NFA
- `src/engine/json-schema.ts`: JSON parser and schema validator
- `src/runtime.js`: convenience runtime and Python-style compatibility wrappers
- `src/lean-runtime.js`: low-level feature runtime without compatibility classes
- `src/runtime-core.js`: shared tokenizer conversion, cache, and handle creation
- `src/tokenizer_bridge.js`: extraction of raw token bytes from compatible tokenizer objects
- `src/llguidance.js`: cached runtime loader
- `src/regex.js` and `src/json-schema.js`: cached feature loaders
- `scripts/build-js.mjs`: full and feature browser and Node.js bundling

## Static Bundles

The root entry injects both compilers into the engine factory. The `llguidance/regex` and `llguidance/json-schema` entries inject one compiler each and therefore have no static dependency on the excluded implementation. They do not use dynamic imports. Constructing an interpreter for an excluded response format throws a feature-unavailable error.

## Lifecycle

Tokenizer, interpreter, and matcher handles expose idempotent `free()` and `dispose()` methods. Matchers free replaced interpreter state during `reset()`.
