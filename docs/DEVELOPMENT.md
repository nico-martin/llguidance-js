# Development

## Setup

```bash
pnpm install
```

## Watch Mode

Build all full and feature browser/Node.js bundles, then rebuild when imported source files change:

```bash
pnpm dev
```

## Builds

Build only the JavaScript bundles and source maps:

```bash
pnpm run build:js
```

This writes readable full, `regex`, `json-schema`, and `grammar` browser/Node.js bundles and source maps. Pass `--minify` directly to the build script for minified output:

```bash
pnpm run build:js -- --minify
```

Build the complete staged package:

```bash
pnpm run build:dist
```

`build:dist` recreates `dist/`, builds minified bundles with source maps, generates root and feature declarations plus the publishable subpath exports, and copies public documentation.

Report current browser bundle raw and gzip sizes with:

```bash
pnpm run size:js
```

## Verification

```bash
pnpm run typecheck
pnpm test
```

The test suite includes direct engine tests, the JSON Schema profile suite, tokenizer bridge tests, public API tests, and selected upstream behavior ports under `test/upstream/`.

Run the official JSON Schema Test Suite against the supported profile by
passing a checkout's draft directory:

```bash
pnpm run test:schema-suite -- ../JSON-Schema-Test-Suite/tests/draft2020-12
```

The runner reports unsupported groups separately from assertion failures. The
path can also be supplied through `JSON_SCHEMA_TEST_SUITE`.

## Benchmark

```bash
pnpm run bench:mask
```

Benchmark results are non-contractual and depend on the host runtime. See [PERFORMANCE.md](PERFORMANCE.md).

## Main Files

- `src/engine/core.ts`: compiler-injected tokenizer trie and interpreter masking
- `src/engine/index.ts`: full compiler wiring
- `src/engine/regex-only.ts`, `src/engine/json-only.ts`, and `src/engine/grammar-only.ts`: feature compiler wiring
- `src/engine/grammar.ts`: practical Lark parser and incremental CFG engine
- `src/engine/regex.ts`: incremental regex NFA
- `src/engine/json-schema.ts`: JSON prefix parser and schema validator
- `src/runtime.ts`: public runtime wrappers
- `src/lean-runtime.ts` and `src/runtime-core.ts`: feature runtime and shared handles
- `src/tokenizer_bridge.ts`: tokenizer vocabulary extraction
- `scripts/build-js.mjs`: development bundles and watch mode
- `scripts/build-dist.mjs`: staged package generation
