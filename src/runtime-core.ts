import type {
  HandleEngineModule,
  InterpreterHandle,
  TokenizerConfig,
  TokenizerHandle,
} from "./engine/core.ts";
import { extractLLGuidanceTokenizerConfig } from "./tokenizer_bridge.ts";

export type TokenizerSource = object | ((...args: unknown[]) => unknown);

export interface InterpreterConfig extends Record<string, unknown> {
  tokenizer: TokenizerSource;
}

export interface HandleRuntime<
  TTokenizer extends TokenizerHandle,
  TInterpreter extends InterpreterHandle,
  TConfig extends InterpreterConfig = InterpreterConfig,
> {
  createTokenizer(config?: TokenizerConfig): TTokenizer;
  createInterpreter(config: TConfig): TInterpreter;
  resolveTokenizer(tokenizer: TokenizerSource): TTokenizer;
}

export function createHandleRuntime<
  TTokenizer extends TokenizerHandle,
  TInterpreter extends InterpreterHandle,
  TConfig extends InterpreterConfig = InterpreterConfig,
>(
  mod: HandleEngineModule<TTokenizer, TInterpreter>,
): HandleRuntime<TTokenizer, TInterpreter, TConfig> {
  const ownedTokenizers = new WeakSet<TTokenizer>();
  const externalTokenizerCache = new WeakMap<object, TTokenizer>();

  const createTokenizer = (config: TokenizerConfig = {}): TTokenizer => {
    const tokenizer = new mod.LLGuidanceTokenizer(
      normalizeTokenizerConfig(config),
    );
    ownedTokenizers.add(tokenizer);
    return tokenizer;
  };

  const resolveTokenizer = (tokenizer: TokenizerSource): TTokenizer => {
    const key = requireObjectLike(tokenizer);
    const wrapped = (key as Record<string, unknown>)._tokenizer;
    if (wrapped) return wrapped as TTokenizer;
    if (ownedTokenizers.has(key as TTokenizer)) return key as TTokenizer;

    let converted = externalTokenizerCache.get(key);
    if (!converted) {
      converted = createTokenizer(extractLLGuidanceTokenizerConfig(tokenizer));
      externalTokenizerCache.set(key, converted);
    }
    return converted;
  };

  const createInterpreter = (
    config: TConfig | null | undefined,
  ): TInterpreter => {
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

export function normalizeTokenizerConfig<T extends object>(
  config: T,
): T & TokenizerConfig {
  const values = config as Record<string, unknown>;
  return {
    ...config,
    eosTokenId: values.eosTokenId ?? values.eos_token_id,
    bosTokenId: values.bosTokenId ?? values.bos_token_id,
    specialTokenIds: values.specialTokenIds ?? values.special_token_ids,
  } as T & TokenizerConfig;
}

function requireObjectLike(value: TokenizerSource): object {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new TypeError("tokenizer must be an object or callable tokenizer");
  }
  return value;
}
