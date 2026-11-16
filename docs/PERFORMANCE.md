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

Callers that already own mask storage can use `computeMaskInto(target)` to
reuse the same cached result without allocating a cloned `Uint32Array`.

A successful commit invalidates the cache. EOS and stopped results are cached consistently with ordinary masks.

## JSON Masking

JSON candidate checks advance incremental state through shared trie prefixes.
Duplicate token byte sequences are evaluated once through trie terminals. The
traversal uses reusable parallel node/state stacks and does not retain every
allowed terminal state; commit computes only the selected token transition and
reuses it for the state update.

Compiled JSON programs also keep a bounded byte-transition cache shared by
interpreters using that program. It caches at most 8,192 transitions by
default, has a hard limit of 16,384, retains parent chains only for prefixes up
to 128 bytes, and excludes complex-schema fallback states. This accelerates
hot schemas and common output prefixes without allowing unbounded retention.

For an open value string constrained only by `{ "type": "string" }`, core also
shares completed token masks across interpreters and equal-length content
prefixes. The key includes the compiled program, tokenizer, parser container
context, and remaining generation budgets. This cache is an LRU capped at 64
masks and 262,144 `Uint32` words (1 MiB). It deliberately excludes property
names, escapes/partial UTF-8, numbers, fallback states, and strings with
length, enum/const, pattern, format, or content constraints. Use
`interpreter.maskInstrumentation()` to inspect trie-node visits and shared-mask
cache activity in benchmarks.

Complex schemas and long generated prefixes can therefore cost more than regex masking. Conservative pruning can also leave additional candidates enabled until complete validation.

## Safety Limits

Interpreter configs accept finite generation and compile/parser limits. The
defaults allow 100,000 generated tokens, 1 MiB of output, 100,000 regex NFA
states, repetition counts up to 10,000, and schema/JSON nesting to depth 128.
Use the `limits` config object to lower or raise individual bounds for a
workload.

## Compiled Programs

Each engine bundle keeps bounded 64-entry LRU caches for regex/Lark and JSON
programs. Reusing a regex source and compile limits preserves learned lazy DFA
transitions across interpreters. JSON grammar strings use serialized schema
keys, while direct schema objects use identity and are snapshotted on a cache
miss. Mutation is not observed while that identity remains cached.

## Running The Benchmark

```bash
pnpm run bench:mask
```

For the synthetic high-vocabulary JSON semantic-cache check, run:

```bash
node scripts/benchmark-json-mask-cache.mjs
```

For grammar masks on a synthetic 1,024-token vocabulary, including tool-call
grammars with regex and `%json` argument values, run:

```bash
pnpm run bench:grammar
```

The benchmark verifies mask correctness and operation-count reduction. Printed wall-clock timings are non-contractual and should only be compared on the same machine and runtime.

For meaningful application benchmarks, use the actual model tokenizer and representative constraints. Include cold first-mask time, masks after commits, repeated cached masks, and memory retained by the tokenizer trie.

## Bundle Size

The full entry statically includes both engines and the compatibility runtime. `llguidance/regex` and `llguidance/json-schema` are static single-engine bundles; `llguidance/grammar` includes the grammar engine with the regex and JSON Schema compilers its terminals and `%json` rules use. They do not defer code through dynamic imports.

Minified browser bundle sizes measured with esbuild 0.25 on November 15, 2026:

| Entry                    | Minified raw | Minified gzip |
| ------------------------ | -----------: | ------------: |
| `llguidance`             |       98,323 |        27,678 |
| `llguidance/regex`       |       39,330 |        12,062 |
| `llguidance/json-schema` |       77,843 |        21,623 |
| `llguidance/grammar`     |      102,632 |        29,289 |

Source maps are excluded from these values. Run `pnpm run build:dist` followed by `pnpm run size:js` to measure the current minified browser outputs.
