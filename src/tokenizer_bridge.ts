import type { TokenizerConfig } from "./engine/core.ts";

const textEncoder = new TextEncoder();

type UnknownRecord = Record<string, unknown>;
type Vocabulary = Record<string, unknown>;

export interface ExtractedTokenizerConfig extends TokenizerConfig {
  tokens: Array<readonly number[]>;
  [key: string]: unknown;
}

export function extractLLGuidanceTokenizerConfig(
  tokenizer: unknown,
): ExtractedTokenizerConfig {
  const source = requireObjectLike(tokenizer);
  if (Array.isArray(source.tokens)) return normalizeTokenizerConfig(source);

  const tokenizerJSON = getTokenizerJSON(source);
  const vocab = getVocab(source, tokenizerJSON);
  if (!vocab || Object.keys(vocab).length === 0) {
    throw new TypeError(
      "Could not extract tokenizer vocabulary. Pass { tokens, eos_token_id } to createTokenizer() instead.",
    );
  }

  const tokens = tokensFromVocab(vocab, tokenizerJSON);
  applyAddedTokens(tokens, tokenizerJSON);
  validateDenseTokens(tokens);
  const specialTokenIds = getSpecialTokenIds(source, tokenizerJSON);

  return {
    tokens,
    eosTokenId: getTokenId(source, tokenizerJSON, [
      "eos_token_id",
      "eosTokenId",
      "eos_token",
      "eosToken",
    ]),
    bosTokenId: getTokenId(source, tokenizerJSON, [
      "bos_token_id",
      "bosTokenId",
      "bos_token",
      "bosToken",
    ]),
    specialTokenIds: specialTokenIds.length > 0 ? specialTokenIds : undefined,
  };
}

function requireObjectLike(value: unknown): UnknownRecord {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new TypeError("tokenizer must be an object or callable tokenizer");
  }
  return value as UnknownRecord;
}

function normalizeTokenizerConfig(
  config: UnknownRecord,
): ExtractedTokenizerConfig {
  return {
    ...config,
    tokens: config.tokens as Array<readonly number[]>,
    eosTokenId: config.eosTokenId ?? config.eos_token_id,
    bosTokenId: config.bosTokenId ?? config.bos_token_id,
    specialTokenIds: (config.specialTokenIds ?? config.special_token_ids) as
      readonly number[] | undefined,
  } as ExtractedTokenizerConfig;
}

function getTokenizerJSON(tokenizer: UnknownRecord): unknown {
  const jsonMethod = tokenizer.json;
  const json =
    tokenizer._tokenizerJSON ??
    tokenizer.tokenizerJSON ??
    tokenizer.tokenizer_json ??
    (typeof jsonMethod === "function"
      ? jsonMethod.call(tokenizer)
      : jsonMethod);
  return typeof json === "string" ? (JSON.parse(json) as unknown) : json;
}

function getVocab(
  tokenizer: UnknownRecord,
  tokenizerJSON: unknown,
): Vocabulary | undefined {
  const modelVocab = field(field(tokenizerJSON, "model"), "vocab");
  if (modelVocab !== undefined) return vocabToObject(modelVocab);

  for (const methodName of ["getVocab", "get_vocab"] as const) {
    const method = tokenizer[methodName];
    if (typeof method === "function") {
      return vocabToObject(method.call(tokenizer, true));
    }
  }
  if (tokenizer.vocab !== undefined) return vocabToObject(tokenizer.vocab);

  const idToToken =
    typeof tokenizer.idToToken === "function"
      ? tokenizer.idToToken
      : tokenizer.id_to_token;
  if (typeof idToToken === "function") {
    const vocabSize = getVocabSize(tokenizer);
    if (vocabSize !== undefined) {
      const vocab: Vocabulary = {};
      for (let id = 0; id < vocabSize; ++id) {
        const token = idToToken.call(tokenizer, id);
        if (typeof token === "string") vocab[token] = id;
      }
      return vocab;
    }
  }
  return undefined;
}

function vocabToObject(vocab: unknown): Vocabulary | undefined {
  if (Array.isArray(vocab)) {
    const entries: Array<[string, number]> = [];
    vocab.forEach((entry, id) => {
      if (Array.isArray(entry) && typeof entry[0] === "string") {
        entries.push([entry[0], id]);
      }
    });
    return Object.fromEntries(entries);
  }
  if (vocab instanceof Map) {
    return Object.fromEntries(vocab) as Vocabulary;
  }
  return isRecord(vocab) ? vocab : undefined;
}

function getVocabSize(tokenizer: UnknownRecord): number | undefined {
  for (const value of [tokenizer.vocabSize, tokenizer.vocab_size]) {
    if (isInteger(value)) return value;
  }
  for (const methodName of ["getVocabSize", "get_vocab_size"] as const) {
    const method = tokenizer[methodName];
    if (typeof method === "function") {
      const value: unknown = method.call(tokenizer, true);
      if (isInteger(value)) return value;
    }
  }
  return undefined;
}

function tokensFromVocab(
  vocab: Vocabulary,
  tokenizerJSON: unknown,
): Array<number[] | undefined> {
  const entries = Object.entries(vocab);
  const vocabSize =
    entries.reduce((max, [, id]) => Math.max(max, Number(id)), -1) + 1;
  const tokens = Array.from<number[] | undefined>({ length: vocabSize });
  for (const [token, id] of entries) {
    tokens[Number(id)] = tokenToBytes(token, tokenizerJSON);
  }
  return tokens;
}

function applyAddedTokens(
  tokens: Array<number[] | undefined>,
  tokenizerJSON: unknown,
): void {
  const addedTokens = field(tokenizerJSON, "added_tokens");
  if (!Array.isArray(addedTokens)) return;
  for (const candidate of addedTokens) {
    if (!isRecord(candidate) || !isInteger(candidate.id)) continue;
    tokens[candidate.id] = utf8Bytes(
      typeof candidate.content === "string" ? candidate.content : "",
    );
  }
}

function validateDenseTokens(
  tokens: Array<number[] | undefined>,
): asserts tokens is number[][] {
  for (let id = 0; id < tokens.length; ++id) {
    if (!tokens[id]) {
      throw new Error(`Tokenizer vocabulary is missing token id ${id}`);
    }
  }
}

function getSpecialTokenIds(
  tokenizer: UnknownRecord,
  tokenizerJSON: unknown,
): number[] {
  const ids = new Set<number>();
  const addedTokens = field(tokenizerJSON, "added_tokens");
  if (Array.isArray(addedTokens)) {
    for (const token of addedTokens) {
      if (isRecord(token) && token.special && isInteger(token.id)) {
        ids.add(token.id);
      }
    }
  }

  for (const value of [
    tokenizer.special_token_ids,
    tokenizer.specialTokenIds,
    tokenizer.all_special_ids,
    tokenizer.allSpecialIds,
  ]) {
    if (Array.isArray(value)) {
      for (const id of value) ids.add(Number(id));
    }
  }
  for (const key of [
    "eos_token_id",
    "eosTokenId",
    "bos_token_id",
    "bosTokenId",
    "pad_token_id",
    "padTokenId",
  ]) {
    const value = tokenizer[key];
    if (isInteger(value)) ids.add(value);
  }
  return [...ids].filter(isInteger).sort((a, b) => a - b);
}

function getTokenId(
  tokenizer: UnknownRecord,
  tokenizerJSON: unknown,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = tokenizer[key] ?? field(tokenizerJSON, key);
    if (isInteger(value)) return value;
    if (typeof value === "string") {
      const id = tokenStringToId(tokenizer, tokenizerJSON, value);
      if (id !== undefined) return id;
    }
  }
  return undefined;
}

function tokenStringToId(
  tokenizer: UnknownRecord,
  tokenizerJSON: unknown,
  token: string,
): number | undefined {
  for (const methodName of ["tokenToId", "token_to_id"] as const) {
    const method = tokenizer[methodName];
    if (typeof method === "function") {
      const id: unknown = method.call(tokenizer, token);
      if (isInteger(id)) return id;
    }
  }
  const id = Number(getVocab(tokenizer, tokenizerJSON)?.[token]);
  return Number.isInteger(id) ? id : undefined;
}

function tokenToBytes(token: string, tokenizerJSON: unknown): number[] {
  const byteFallback = /^<0x([0-9a-fA-F]{2})>$/.exec(token);
  if (byteFallback) return [Number.parseInt(byteFallback[1], 16)];
  if (usesByteLevel(tokenizerJSON)) return byteLevelTokenToBytes(token);
  if (usesSentencePiece(tokenizerJSON) || token.includes("▁")) {
    return utf8Bytes(token.replaceAll("▁", " "));
  }

  const continuingPrefix = field(
    field(tokenizerJSON, "model"),
    "continuing_subword_prefix",
  );
  if (
    typeof continuingPrefix === "string" &&
    token.startsWith(continuingPrefix)
  ) {
    return utf8Bytes(token.slice(continuingPrefix.length));
  }
  return utf8Bytes(token);
}

function usesByteLevel(tokenizerJSON: unknown): boolean {
  return (
    hasComponentType(field(tokenizerJSON, "decoder"), "ByteLevel") ||
    hasComponentType(field(tokenizerJSON, "pre_tokenizer"), "ByteLevel")
  );
}

function usesSentencePiece(tokenizerJSON: unknown): boolean {
  const modelType = field(field(tokenizerJSON, "model"), "type");
  return modelType === "Unigram" || modelType === "SentencePiece";
}

function hasComponentType(component: unknown, type: string): boolean {
  if (Array.isArray(component)) {
    return component.some((item) => hasComponentType(item, type));
  }
  if (!isRecord(component)) return false;
  if (component.type === type) return true;
  return Object.values(component).some((item) => hasComponentType(item, type));
}

function byteLevelTokenToBytes(token: string): number[] {
  const inverse = byteLevelAlphabetInverse();
  const bytes: number[] = [];
  for (const char of token) {
    const byte = inverse.get(char);
    if (byte === undefined) bytes.push(...utf8Bytes(char));
    else bytes.push(byte);
  }
  return bytes;
}

let cachedByteLevelAlphabetInverse: Map<string, number> | undefined;

function byteLevelAlphabetInverse(): Map<string, number> {
  if (cachedByteLevelAlphabetInverse) return cachedByteLevelAlphabetInverse;
  const bytes: number[] = [];
  for (let code = "!".charCodeAt(0); code <= "~".charCodeAt(0); ++code)
    bytes.push(code);
  for (let code = "¡".charCodeAt(0); code <= "¬".charCodeAt(0); ++code)
    bytes.push(code);
  for (let code = "®".charCodeAt(0); code <= "ÿ".charCodeAt(0); ++code)
    bytes.push(code);

  const chars = [...bytes];
  let next = 0;
  for (let byte = 0; byte < 256; ++byte) {
    if (!bytes.includes(byte)) {
      bytes.push(byte);
      chars.push(256 + next++);
    }
  }
  cachedByteLevelAlphabetInverse = new Map(
    chars.map((code, index) => [String.fromCharCode(code), bytes[index]]),
  );
  return cachedByteLevelAlphabetInverse;
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object";
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function utf8Bytes(value: string): number[] {
  return [...textEncoder.encode(value)];
}
