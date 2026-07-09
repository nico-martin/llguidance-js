const textEncoder = new TextEncoder();

export function extractLLGuidanceTokenizerConfig(tokenizer) {
  if (!tokenizer || typeof tokenizer !== 'object') {
    throw new TypeError('tokenizer must be an object');
  }

  if (Array.isArray(tokenizer.tokens)) {
    return normalizeTokenizerConfig(tokenizer);
  }

  const tokenizerJSON = getTokenizerJSON(tokenizer);
  const vocab = getVocab(tokenizer, tokenizerJSON);
  if (!vocab || Object.keys(vocab).length === 0) {
    throw new TypeError('Could not extract tokenizer vocabulary. Pass { tokens, eos_token_id } to createTokenizer() instead.');
  }

  const tokens = tokensFromVocab(vocab, tokenizerJSON);
  const addedTokenIds = applyAddedTokens(tokens, tokenizerJSON);
  const specialTokenIds = getSpecialTokenIds(tokenizer, tokenizerJSON, addedTokenIds);

  return {
    tokens,
    eosTokenId: getTokenId(tokenizer, tokenizerJSON, ['eos_token_id', 'eosTokenId', 'eos_token', 'eosToken']),
    bosTokenId: getTokenId(tokenizer, tokenizerJSON, ['bos_token_id', 'bosTokenId', 'bos_token', 'bosToken']),
    specialTokenIds: specialTokenIds.length > 0 ? specialTokenIds : undefined,
  };
}

function normalizeTokenizerConfig(config) {
  return {
    ...config,
    eosTokenId: config.eosTokenId ?? config.eos_token_id,
    bosTokenId: config.bosTokenId ?? config.bos_token_id,
    specialTokenIds: config.specialTokenIds ?? config.special_token_ids,
  };
}

function getTokenizerJSON(tokenizer) {
  const json = tokenizer._tokenizerJSON
    ?? tokenizer.tokenizerJSON
    ?? tokenizer.tokenizer_json
    ?? (typeof tokenizer.json === 'function' ? tokenizer.json() : tokenizer.json);
  return typeof json === 'string' ? JSON.parse(json) : json;
}

function getVocab(tokenizer, tokenizerJSON) {
  if (tokenizerJSON?.model?.vocab) return vocabToObject(tokenizerJSON.model.vocab);
  if (typeof tokenizer.getVocab === 'function') return vocabToObject(tokenizer.getVocab(true));
  if (typeof tokenizer.get_vocab === 'function') return vocabToObject(tokenizer.get_vocab(true));
  if (tokenizer.vocab) return vocabToObject(tokenizer.vocab);
  if (typeof tokenizer.idToToken === 'function' || typeof tokenizer.id_to_token === 'function') {
    const vocabSize = getVocabSize(tokenizer);
    if (Number.isInteger(vocabSize)) {
      const vocab = {};
      for (let id = 0; id < vocabSize; ++id) {
        const token = tokenizer.idToToken?.(id) ?? tokenizer.id_to_token?.(id);
        if (typeof token === 'string') vocab[token] = id;
      }
      return vocab;
    }
  }
  return undefined;
}

function vocabToObject(vocab) {
  return vocab instanceof Map ? Object.fromEntries(vocab) : vocab;
}

function getVocabSize(tokenizer) {
  if (Number.isInteger(tokenizer.vocabSize)) return tokenizer.vocabSize;
  if (Number.isInteger(tokenizer.vocab_size)) return tokenizer.vocab_size;
  if (typeof tokenizer.getVocabSize === 'function') return tokenizer.getVocabSize(true);
  if (typeof tokenizer.get_vocab_size === 'function') return tokenizer.get_vocab_size(true);
  return undefined;
}

function tokensFromVocab(vocab, tokenizerJSON) {
  const entries = Object.entries(vocab);
  const vocabSize = entries.reduce((max, [, id]) => Math.max(max, Number(id)), -1) + 1;
  const tokens = Array.from({ length: vocabSize });

  for (const [token, id] of entries) {
    tokens[Number(id)] = tokenToBytes(token, tokenizerJSON);
  }

  for (let id = 0; id < tokens.length; ++id) {
    if (!tokens[id]) {
      throw new Error(`Tokenizer vocabulary is missing token id ${id}`);
    }
  }

  return tokens;
}

function applyAddedTokens(tokens, tokenizerJSON) {
  const addedTokenIds = [];
  for (const token of tokenizerJSON?.added_tokens ?? []) {
    if (!Number.isInteger(token.id)) continue;
    tokens[token.id] = utf8Bytes(token.content ?? '');
    addedTokenIds.push(token.id);
  }
  return addedTokenIds;
}

function getSpecialTokenIds(tokenizer, tokenizerJSON, addedTokenIds) {
  const ids = new Set(addedTokenIds);

  for (const token of tokenizerJSON?.added_tokens ?? []) {
    if (token.special && Number.isInteger(token.id)) ids.add(token.id);
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

  for (const key of ['eos_token_id', 'eosTokenId', 'bos_token_id', 'bosTokenId', 'pad_token_id', 'padTokenId']) {
    if (Number.isInteger(tokenizer[key])) ids.add(tokenizer[key]);
  }

  return [...ids].filter(Number.isInteger).sort((a, b) => a - b);
}

function getTokenId(tokenizer, tokenizerJSON, keys) {
  for (const key of keys) {
    const value = tokenizer[key] ?? tokenizerJSON?.[key];
    if (Number.isInteger(value)) return value;
    if (typeof value === 'string') {
      const id = tokenStringToId(tokenizer, tokenizerJSON, value);
      if (Number.isInteger(id)) return id;
    }
  }
  return undefined;
}

function tokenStringToId(tokenizer, tokenizerJSON, token) {
  if (typeof tokenizer.tokenToId === 'function') return tokenizer.tokenToId(token);
  if (typeof tokenizer.token_to_id === 'function') return tokenizer.token_to_id(token);
  const vocab = getVocab(tokenizer, tokenizerJSON);
  const id = Number(vocab?.[token]);
  return Number.isInteger(id) ? id : undefined;
}

function tokenToBytes(token, tokenizerJSON) {
  const byteFallback = /^<0x([0-9a-fA-F]{2})>$/.exec(token);
  if (byteFallback) return [parseInt(byteFallback[1], 16)];

  if (usesByteLevel(tokenizerJSON)) {
    return byteLevelTokenToBytes(token);
  }

  if (usesSentencePiece(tokenizerJSON) || token.includes('▁')) {
    return utf8Bytes(token.replaceAll('▁', ' '));
  }

  return utf8Bytes(token);
}

function usesByteLevel(tokenizerJSON) {
  return hasComponentType(tokenizerJSON?.decoder, 'ByteLevel') || hasComponentType(tokenizerJSON?.pre_tokenizer, 'ByteLevel');
}

function usesSentencePiece(tokenizerJSON) {
  const modelType = tokenizerJSON?.model?.type;
  return modelType === 'Unigram' || modelType === 'SentencePiece';
}

function hasComponentType(component, type) {
  if (!component) return false;
  if (component.type === type) return true;
  return Array.isArray(component.pre_tokenizers) && component.pre_tokenizers.some((item) => hasComponentType(item, type));
}

function byteLevelTokenToBytes(token) {
  const inverse = byteLevelAlphabetInverse();
  const bytes = [];

  for (const char of token) {
    const byte = inverse.get(char);
    if (byte === undefined) {
      bytes.push(...utf8Bytes(char));
    } else {
      bytes.push(byte);
    }
  }

  return bytes;
}

let cachedByteLevelAlphabetInverse;

function byteLevelAlphabetInverse() {
  if (cachedByteLevelAlphabetInverse) return cachedByteLevelAlphabetInverse;

  const bytes = [];
  for (let code = '!'.charCodeAt(0); code <= '~'.charCodeAt(0); ++code) bytes.push(code);
  for (let code = '¡'.charCodeAt(0); code <= '¬'.charCodeAt(0); ++code) bytes.push(code);
  for (let code = '®'.charCodeAt(0); code <= 'ÿ'.charCodeAt(0); ++code) bytes.push(code);

  const chars = [...bytes];
  let next = 0;
  for (let byte = 0; byte < 256; ++byte) {
    if (!bytes.includes(byte)) {
      bytes.push(byte);
      chars.push(256 + next);
      next += 1;
    }
  }

  cachedByteLevelAlphabetInverse = new Map(chars.map((code, index) => [String.fromCharCode(code), bytes[index]]));
  return cachedByteLevelAlphabetInverse;
}

function utf8Bytes(value) {
  return [...textEncoder.encode(value)];
}
