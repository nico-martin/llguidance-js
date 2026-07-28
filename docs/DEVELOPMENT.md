# Development

## Setup

```bash
pnpm install
```

## Watch Mode

Build the browser and Node.js bundles, then rebuild when imported source files change:

```bash
pnpm dev
```

## Builds

Build only the JavaScript bundles and source maps:

```bash
pnpm run build:js
```

This writes `dist/browser.js`, `dist/node.js`, and their source maps.

Build the complete staged package:

```bash
pnpm run build:dist
```

`build:dist` recreates `dist/`, runs `build:js`, generates `llguidance.d.ts` and the publishable `package.json`, and copies the README.

## Verification

```bash
pnpm run typecheck
pnpm test
```

The test suite includes direct engine tests, the JSON Schema profile suite, tokenizer bridge tests, public API tests, and selected upstream behavior ports under `test/upstream/`.

## Benchmark

```bash
pnpm run bench:mask
```

Benchmark results are non-contractual and depend on the host runtime. See [PERFORMANCE.md](PERFORMANCE.md).

## Main Files

- `src/engine/index.ts`: tokenizer trie and interpreter masking
- `src/engine/regex.ts`: incremental regex NFA
- `src/engine/json-schema.ts`: JSON prefix parser and schema validator
- `src/runtime.js`: public runtime wrappers
- `src/tokenizer_bridge.js`: tokenizer vocabulary extraction
- `scripts/build-js.mjs`: development bundles and watch mode
- `scripts/build-dist.mjs`: staged package generation
