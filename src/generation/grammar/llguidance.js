export { extractLLGuidanceTokenizerConfig } from './tokenizer_bridge.js';
import { extractLLGuidanceTokenizerConfig } from './tokenizer_bridge.js';

export async function loadBundledLLGuidance() {
  const mod = await import('./wasm/llguidance_wasm.js');
  await mod.default();
  const llguidanceTokenizers = new WeakSet();

  const createTokenizer = (config) => {
    const tokenizer = new mod.LLGuidanceTokenizer(normalizeTokenizerConfig(config));
    llguidanceTokenizers.add(tokenizer);
    return tokenizer;
  };

  return {
    createTokenizer,
    createInterpreter(config) {
      const { tokenizer, ...interpreterConfig } = config ?? {};
      if (!tokenizer) {
        throw new TypeError('createInterpreter requires a tokenizer');
      }

      const llguidanceTokenizer = llguidanceTokenizers.has(tokenizer)
        ? tokenizer
        : createTokenizer(extractLLGuidanceTokenizerConfig(tokenizer));

      return new mod.LLGuidanceInterpreter(llguidanceTokenizer, interpreterConfig);
    },
  };
}

function normalizeTokenizerConfig(config = {}) {
  return {
    ...config,
    eosTokenId: config.eosTokenId ?? config.eos_token_id,
    bosTokenId: config.bosTokenId ?? config.bos_token_id,
    specialTokenIds: config.specialTokenIds ?? config.special_token_ids,
  };
}
