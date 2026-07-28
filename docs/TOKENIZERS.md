# Tokenizers

llguidance constrains model token IDs, so it must use the exact vocabulary and token IDs used by the model during inference.

## Existing Tokenizer Objects

A compatible tokenizer object can be passed directly:

```js
const interpreter = runtime.createInterpreter({
  tokenizer,
  response_format: { type: "json_object" },
});
```

The bridge looks for common tokenizer representations:

- Tokenizer JSON on `_tokenizerJSON`, `tokenizerJSON`, `tokenizer_json`, or `json`
- Vocabulary methods such as `getVocab()`, `get_vocab()`, `idToToken()`, and `id_to_token()`
- Vocabulary sizes from `vocabSize`, `vocab_size`, `getVocabSize()`, or `get_vocab_size()`
- EOS, BOS, and special-token metadata

Converted tokenizer objects are cached by object identity and reused by later interpreters.

## Token Byte Formats

The bridge handles common vocabulary encodings:

- Raw UTF-8 token text
- Byte-level BPE alphabets such as `Ġword`
- SentencePiece and Unigram whitespace markers such as `▁word`
- Byte fallback tokens such as `<0xFF>`
- WordPiece continuation prefixes such as `##`
- Added tokens and special tokens

Tokenizer vocabularies must have a dense token-ID range after added tokens are merged. Missing IDs cause construction to fail.

## Explicit Configuration

If automatic extraction is unsuitable, pass raw token bytes:

```js
const tokenizer = runtime.createTokenizer({
  tokens: rawTokenBytesById,
  eos_token_id,
  bos_token_id,
  special_token_ids,
});
```

Supported fields:

- `tokens`: raw byte arrays indexed by token ID
- `eos_token_id` or `eosTokenId`: required when `tokens` is provided
- `bos_token_id` or `bosTokenId`: optional beginning-of-sequence token ID
- `special_token_ids` or `specialTokenIds`: optional special-token IDs

Example:

```js
const tokenizer = runtime.createTokenizer({
  tokens: [
    [123], // {
    [125], // }
    [34], // "
    [58], // :
    [], // EOS
  ],
  eos_token_id: 4,
});
```

Empty non-EOS tokens and configured special tokens are never eligible as normal output tokens. EOS is evaluated separately against the completed constraint.

## Raw Bytes

The engine operates on token bytes, not independently decoded token strings. Decoding each token in isolation can produce incorrect bytes for byte-level or subword tokenizers.

The public tokenizer handle returns copies from `token(id)`, so callers cannot mutate the internal vocabulary or invalidate its token trie.

## Lifecycle

Tokenizer handles expose idempotent `free()` and `dispose()` methods. Using a disposed tokenizer throws.
