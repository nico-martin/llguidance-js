# llguidance

Browser and Node.js WASM bindings for [`guidance-ai/llguidance`](https://github.com/guidance-ai/llguidance).

This package loads a bundled WebAssembly build of llguidance and exposes a small JavaScript runtime for constrained decoding with `json_object` and `json_schema` response formats.

## Install

```bash
pnpm add llguidance
```

## Basic Usage

```js
import { loadBundledLLGuidance } from "llguidance";

const runtime = await loadBundledLLGuidance();

// Use the same tokenizer that your LLM uses for inference.
const tokenizer = modelTokenizer;

const interpreter = runtime.createInterpreter({
  // This can be a Hugging Face tokenizer object, a Transformers.js tokenizer,
  // or a tokenizer returned by runtime.createTokenizer().
  tokenizer,
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

const { mask, vocabSize } = interpreter.computeMask();

// Apply `mask` to your model logits, sample an allowed token, then commit it.
const tokenId = 0;
const result = interpreter.commitToken(tokenId);
```

The tokenizer must be the same tokenizer used by the LLM during inference. llguidance constrains model token ids, so its vocabulary must match the model vocabulary exactly.

## Tokenizers

If you already have a compatible tokenizer object, pass it directly to `createInterpreter`:

```js
const interpreter = runtime.createInterpreter({
  tokenizer,
  response_format: { type: "json_object" },
});
```

The runtime will try to extract the raw token byte vocabulary from common Hugging Face tokenizer shapes, including Transformers.js tokenizer JSON and `getVocab()`/`tokenToId()` style APIs.

You can also create an llguidance tokenizer explicitly:

```js
const llgTokenizer = runtime.createTokenizer({
  // Each entry must be the raw byte representation for the token id at that index.
  tokens: [
    [123], // "{"
    [125], // "}"
    [34],  // '"'
    [58],  // ":"
    [44],  // ","
  ],
  eos_token_id: 4,
});

const interpreter = runtime.createInterpreter({
  tokenizer: llgTokenizer,
  response_format: { type: "json_object" },
});
```

## JSON Object Mode

```js
const interpreter = runtime.createInterpreter({
  tokenizer,
  response_format: { type: "json_object" },
});
```

## API

### `loadBundledLLGuidance()`

Loads the bundled WASM module and returns a runtime object.

### `runtime.createTokenizer(config)`

Creates an llguidance tokenizer environment.

Supported config fields:

- `tokens`: array of raw token byte arrays, indexed by token id.
- `eos_token_id` or `eosTokenId`: end-of-sequence token id.
- `bos_token_id` or `bosTokenId`: optional beginning-of-sequence token id.
- `special_token_ids` or `specialTokenIds`: optional list of special token ids.

### `runtime.createInterpreter(config)`

Creates a constrained decoding interpreter.

Supported config fields:

- `tokenizer`: tokenizer returned by `createTokenizer`, or a compatible existing tokenizer object.
- `response_format`: `{ type: "json_object" }` or `{ type: "json_schema", json_schema }`.

### `interpreter.computeMask()`

Computes the next-token constraint.

Returns one of:

- `{ mask, vocabSize }`, where `mask` is a `Uint32Array` bitset.
- `{ stop: true }` when the grammar is complete.
- `{ backtrack, ffTokens }` when llguidance returns an unconditional fast-forward splice.

### `interpreter.commitToken(tokenId)`

Commits the sampled token and advances the grammar state.

Returns `{ stop, backtrack, ffTokens }`.

## Development

Build a fast development WASM artifact:

```bash
pnpm run build:llguidance-wasm:dev
```

Build the release artifact and stage the npm package in `dist/`:

```bash
pnpm run build:dist
```

Publish with an npm one-time password:

```bash
pnpm run publish <otp> [patch|minor|major]
```

The publish script bumps the root `package.json` version, rebuilds `dist/`, and publishes the staged package to npm as `llguidance`.
