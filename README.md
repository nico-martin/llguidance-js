# llguidance

Pure TypeScript constrained decoding for browsers and Node.js, based on [`guidance-ai/llguidance`](https://github.com/guidance-ai/llguidance).

The dependency-free runtime supports regex constraints, `json_object`, and a practical JSON Schema 2020-12 profile. It does not claim full JSON Schema conformance or complete upstream llguidance API parity.

## Install

```bash
pnpm add llguidance
```

## Usage

```js
import { loadBundledLLGuidance } from "llguidance";

const runtime = await loadBundledLLGuidance();
const interpreter = runtime.createInterpreter({
  // Use the exact tokenizer and token IDs used by the model.
  tokenizer: modelTokenizer,
  response_format: {
    type: "json_schema",
    json_schema: {
      type: "object",
      properties: {
        answer: { type: "string" },
      },
      required: ["answer"],
      additionalProperties: false,
    },
  },
});

const result = interpreter.computeMask();
if ("mask" in result) {
  // Apply result.mask to the model logits and sample an allowed token.
  const tokenId = sampleToken(result.mask, result.vocabSize);
  interpreter.commitToken(tokenId);
}
```

Each interpreter represents one mutable generation stream. Use separate interpreters for batch rows, beams, or forks.

## Response Formats

```js
{
  type: "json_object";
}
```

```js
{ type: "json_schema", json_schema: schema }
```

```js
{ type: "regex", regex: "[a-z]+" }
```

See [JSON_SCHEMA_PROFILE.md](docs/JSON_SCHEMA_PROFILE.md) and [REGEX_SUPPORT.md](docs/REGEX_SUPPORT.md) for exact support.

## Tokenizers

The tokenizer vocabulary must match the model vocabulary exactly. Pass a compatible tokenizer object directly or create one from raw token bytes:

```js
const tokenizer = runtime.createTokenizer({
  tokens: rawTokenBytesById,
  eos_token_id,
  bos_token_id,
  special_token_ids,
});
```

An EOS token ID is required for custom token arrays. See [TOKENIZERS.md](docs/TOKENIZERS.md) for supported tokenizer shapes and byte formats.

## API

- `loadBundledLLGuidance()` returns the cached runtime.
- `runtime.createTokenizer(config)` creates a tokenizer handle.
- `runtime.createInterpreter(config)` creates one constrained-decoding stream.
- `interpreter.computeMask()` returns `{ mask, vocabSize }` or `{ stop: true }`.
- `interpreter.commitToken(tokenId)` advances the stream.
- Tokenizer, interpreter, and matcher handles expose idempotent `free()` and `dispose()`.

The runtime also exposes selected Python-style classes and helpers. See [API_MAPPING.md](docs/API_MAPPING.md).

## Documentation

- [JSON Schema profile](docs/JSON_SCHEMA_PROFILE.md)
- [Regex support](docs/REGEX_SUPPORT.md)
- [Tokenizers](docs/TOKENIZERS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Compatibility with upstream llguidance](docs/COMPATIBILITY.md)
- [Python-to-JavaScript API mapping](docs/API_MAPPING.md)
- [Performance](docs/PERFORMANCE.md)
- [Development](docs/DEVELOPMENT.md)

Lark grammars are not implemented by the TypeScript interpreter. See [COMPATIBILITY.md](docs/COMPATIBILITY.md) for unsupported upstream features.

## Development

```bash
pnpm install
pnpm dev
```

See [DEVELOPMENT.md](docs/DEVELOPMENT.md) for build, test, typecheck, distribution, and benchmark commands.
