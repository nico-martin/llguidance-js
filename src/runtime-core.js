import { extractLLGuidanceTokenizerConfig } from "./tokenizer_bridge.js";

export function createHandleRuntime(mod) {
  const ownedTokenizers = new WeakSet();
  const externalTokenizerCache = new WeakMap();

  const createTokenizer = (config = {}) => {
    const tokenizer = new mod.LLGuidanceTokenizer(
      normalizeTokenizerConfig(config),
    );
    ownedTokenizers.add(tokenizer);
    return tokenizer;
  };

  const resolveTokenizer = (tokenizer) => {
    if (tokenizer?._tokenizer) return tokenizer._tokenizer;
    if (ownedTokenizers.has(tokenizer)) return tokenizer;
    if (
      tokenizer === null ||
      (typeof tokenizer !== "object" && typeof tokenizer !== "function")
    ) {
      throw new TypeError("tokenizer must be an object or callable tokenizer");
    }

    let converted = externalTokenizerCache.get(tokenizer);
    if (!converted) {
      converted = createTokenizer(extractLLGuidanceTokenizerConfig(tokenizer));
      externalTokenizerCache.set(tokenizer, converted);
    }
    return converted;
  };

  const createInterpreter = (config) => {
    const { tokenizer, ...interpreterConfig } = config ?? {};
    if (!tokenizer) {
      throw new TypeError("createInterpreter requires a tokenizer");
    }
    return new mod.LLGuidanceInterpreter(
      resolveTokenizer(tokenizer),
      interpreterConfig,
    );
  };

  return { createTokenizer, createInterpreter, resolveTokenizer };
}

export function normalizeTokenizerConfig(config = {}) {
  return {
    ...config,
    eosTokenId: config.eosTokenId ?? config.eos_token_id,
    bosTokenId: config.bosTokenId ?? config.bos_token_id,
    specialTokenIds: config.specialTokenIds ?? config.special_token_ids,
  };
}
