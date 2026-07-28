# Performance

Token-mask performance is driven primarily by tokenizer vocabulary size, token-prefix sharing, constraint complexity, and generated-prefix length.

## Token Trie

The tokenizer builds a byte trie once. Regex masks advance one NFA state per unique token-byte prefix rather than repeating work for every complete token.

For the synthetic 4,096-token benchmark in `scripts/benchmark-mask.mjs`:

- Per-token scanning would process 45,056 byte transitions.
- Trie traversal processes 4,222 unique byte-prefix transitions.
- This is a deterministic 10.67x reduction in byte transitions for that vocabulary.

The ratio is specific to the benchmark's shared-prefix vocabulary and is not a universal speedup claim.

## Mask Cache

Repeated `computeMask()` calls without a successful commit reuse an interpreter-local cached result and perform no grammar transitions. Returned masks are cloned to isolate callers from the cache.

A successful commit invalidates the cache. EOS and stopped results are cached consistently with ordinary masks.

## JSON Masking

JSON candidate checks currently analyze the committed prefix plus candidate token. Duplicate token byte sequences are evaluated once through trie terminals, but JSON does not yet carry a persistent incremental parser state through trie edges.

Complex schemas and long generated prefixes can therefore cost more than regex masking. Conservative pruning can also leave additional candidates enabled until complete validation.

## Running The Benchmark

```bash
pnpm run bench:mask
```

The benchmark verifies mask correctness and operation-count reduction. Printed wall-clock timings are non-contractual and should only be compared on the same machine and runtime.

For meaningful application benchmarks, use the actual model tokenizer and representative constraints. Include cold first-mask time, masks after commits, repeated cached masks, and memory retained by the tokenizer trie.

## Bundle Size

The full entry statically includes both engines and the compatibility runtime. `llguidance/regex` and `llguidance/json-schema` are static single-engine bundles; they do not defer code through dynamic imports.

Browser bundle sizes measured with esbuild 0.25 on July 28, 2026:

| Entry                    | Readable raw | Minified raw | Minified gzip |
| ------------------------ | -----------: | -----------: | ------------: |
| `llguidance`             |      120,614 |       65,223 |        18,912 |
| `llguidance/regex`       |       46,926 |       25,498 |         8,206 |
| `llguidance/json-schema` |       90,103 |       48,824 |        14,009 |

Source maps are excluded from these values. Run `pnpm run build:dist` followed by `pnpm run size:js` to measure the current minified browser outputs.
