import { extractLLGuidanceTokenizerConfig } from "./tokenizer_bridge.js";
import {
  createHandleRuntime,
  normalizeTokenizerConfig,
} from "./runtime-core.js";

export function createLLGuidanceRuntime(mod) {
  const { createTokenizer, createInterpreter, resolveTokenizer } =
    createHandleRuntime(mod);

  class LLTokenizer {
    constructor(tokenizer, options = {}) {
      const config = normalizeTokenizerConfig(
        isPlainTokenizerConfig(tokenizer)
          ? { ...tokenizer, ...options }
          : { ...extractLLGuidanceTokenizerConfig(tokenizer), ...options },
      );
      this._tokenizer = new mod.LLGuidanceTokenizer(config);
      this.vocab_size = this._tokenizer.vocabSize();
      this.eos_token = this._tokenizer.eosToken();
      this.eos_tokens = [this.eos_token];
      this.is_canonical = false;
    }

    free() {
      this._tokenizer.free();
    }

    dispose() {
      this.free();
    }
  }

  class LLInterpreter {
    constructor(tokenizer, grammarOrConfig, options = {}) {
      this._tokenizer = resolveTokenizer(tokenizer);
      this._interpreter = new mod.LLGuidanceInterpreter(
        this._tokenizer,
        normalizeInterpreterConfig(grammarOrConfig, options),
      );
      this._stopped = false;
      this._accepting = false;
      this._stopReason = "NotStopped";
    }

    compute_mask() {
      const result = this._interpreter.computeMask();
      this._stopped = Boolean(result.stop);
      this._accepting = this._stopped;
      if (this._stopped) {
        this._stopReason = "NoExtension";
      }
      return [
        result.mask ? bitsetToBytes(result.mask) : null,
        JSON.stringify(result),
      ];
    }

    compute_mask_into(target) {
      const [mask, info] = this.compute_mask();
      if (mask) {
        target.set(mask.subarray(0, target.length));
      }
      return info;
    }

    commit_token(sampledToken) {
      if (sampledToken == null) {
        return [0, []];
      }
      const result = this._interpreter.commitToken(sampledToken);
      this._stopped = Boolean(result.stop);
      if (this._stopped) {
        this._stopReason = "NoExtension";
      }
      return [result.backtrack ?? 0, result.ffTokens ?? []];
    }

    is_accepting() {
      return this._accepting;
    }

    stop_reason() {
      return this._stopReason;
    }

    has_pending_stop() {
      return this._stopped;
    }

    computeMask() {
      return this._interpreter.computeMask();
    }

    commitToken(sampledToken) {
      return this._interpreter.commitToken(sampledToken);
    }

    free() {
      this._interpreter.free();
    }

    dispose() {
      this.free();
    }
  }

  class LLMatcher {
    constructor(tokenizer, grammar, options = {}) {
      this._tokenizer = resolveTokenizer(tokenizer);
      this._grammar = grammar;
      this._options = options;
      this._interpreter = new mod.LLGuidanceInterpreter(
        this._tokenizer,
        normalizeInterpreterConfig(grammar, options),
      );
      this._error = "";
      this._stopped = false;
      this._accepting = false;
      this._stopReason = "NotStopped";
    }

    static grammar_from_json_schema(schema) {
      return mod.grammarFromJsonSchema(
        typeof schema === "string" ? JSON.parse(schema) : schema,
      );
    }

    static grammar_from_lark(lark) {
      return mod.grammarFromLark(lark);
    }

    static grammar_from_regex(regex) {
      return mod.grammarFromRegex(regex);
    }

    static validate_grammar(grammar, tokenizer = null) {
      if (!tokenizer) {
        return "";
      }
      let matcher;
      try {
        matcher = new LLMatcher(tokenizer, grammar);
        return "";
      } catch (error) {
        return error?.message ?? String(error);
      } finally {
        matcher?.free();
      }
    }

    static validate_grammar_with_warnings(grammar, tokenizer = null) {
      const message = LLMatcher.validate_grammar(grammar, tokenizer);
      return [Boolean(message), message ? [message] : []];
    }

    compute_bitmask() {
      const result = this._interpreter.computeMask();
      this._stopped = Boolean(result.stop);
      this._accepting = this._stopped;
      return result.mask ? bitsetToBytes(result.mask) : new Uint8Array(0);
    }

    compute_logit_bias() {
      return bitmaskToLogitBias(
        this.compute_bitmask(),
        this._tokenizer.vocabSize(),
      );
    }

    consume_token(sampledToken) {
      try {
        const result = this._interpreter.commitToken(sampledToken);
        this._stopped = Boolean(result.stop);
        return true;
      } catch (error) {
        this._error = error?.message ?? String(error);
        return false;
      }
    }

    consume_tokens(sampledTokens) {
      return sampledTokens.every((token) => this.consume_token(token));
    }

    try_consume_tokens(sampledTokens) {
      let consumed = 0;
      for (const token of sampledTokens) {
        if (!this.consume_token(token)) {
          break;
        }
        consumed += 1;
      }
      return consumed;
    }

    validate_tokens(tokens) {
      const matcher = new LLMatcher(
        { _tokenizer: this._tokenizer },
        this._grammar,
        this._options,
      );
      try {
        return matcher.try_consume_tokens(tokens);
      } finally {
        matcher.free();
      }
    }

    is_error() {
      return this._error !== "";
    }

    get_error() {
      return this._error;
    }

    get_grammar_warnings() {
      return [];
    }

    is_accepting() {
      return this._accepting;
    }

    is_stopped() {
      return this._stopped || this.is_error();
    }

    stop_reason() {
      return this._stopReason;
    }

    compute_ff_tokens() {
      const result = this._interpreter.computeMask();
      return result.ffTokens ?? [];
    }

    compute_ff_bytes() {
      return new Uint8Array(0);
    }

    reset() {
      const replacement = new mod.LLGuidanceInterpreter(
        this._tokenizer,
        normalizeInterpreterConfig(this._grammar, this._options),
      );
      this._interpreter.free();
      this._interpreter = replacement;
      this._error = "";
      this._stopped = false;
      this._accepting = false;
      this._stopReason = "NotStopped";
      return true;
    }

    free() {
      this._interpreter.free();
    }

    dispose() {
      this.free();
    }

    rollback() {
      throw new Error(
        "LLMatcher.rollback() is not implemented in the TypeScript core backend yet",
      );
    }

    deep_copy() {
      throw new Error(
        "LLMatcher.deep_copy() is not implemented in the TypeScript core backend yet",
      );
    }

    get_capture() {
      return null;
    }

    get_captures() {
      return [];
    }
  }

  class JsonCompiler {
    constructor(options = {}) {
      this.options = options;
    }

    compile(schema) {
      return LLMatcher.grammar_from_json_schema(
        typeof schema === "string" ? JSON.parse(schema) : schema,
      );
    }
  }

  class LarkCompiler {
    compile(lark) {
      return LLMatcher.grammar_from_lark(lark);
    }
  }

  class RegexCompiler {
    compile(regex) {
      return LLMatcher.grammar_from_regex(regex);
    }
  }

  return {
    LLTokenizer,
    LLInterpreter,
    LLMatcher,
    JsonCompiler,
    LarkCompiler,
    RegexCompiler,
    grammar_from(format, text) {
      return mod.grammarFrom(
        format,
        typeof text === "string" ? text : JSON.stringify(text),
      );
    },
    grammarFrom(format, text) {
      return mod.grammarFrom(
        format,
        typeof text === "string" ? text : JSON.stringify(text),
      );
    },
    regex_to_lark(regex) {
      return String(regex).replaceAll("/", "\\/");
    },
    get_version() {
      return "llguidance-ts-core";
    },
    createTokenizer,
    createInterpreter,
  };
}

function normalizeInterpreterConfig(grammarOrConfig, options = {}) {
  if (typeof grammarOrConfig === "string") {
    return { ...options, grammar: grammarOrConfig };
  }

  if (grammarOrConfig?.response_format || grammarOrConfig?.responseFormat) {
    return {
      ...grammarOrConfig,
      response_format:
        grammarOrConfig.response_format ?? grammarOrConfig.responseFormat,
    };
  }

  return { ...options, ...(grammarOrConfig ?? {}) };
}

function isPlainTokenizerConfig(value) {
  return (
    value == null ||
    (typeof value === "object" &&
      value.constructor === Object &&
      Object.keys(value).length === 0) ||
    Boolean(
      value.tokens || value.eos_token_id != null || value.eosTokenId != null,
    )
  );
}

function bitsetToBytes(mask) {
  return new Uint8Array(
    mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength),
  );
}

function bitmaskToLogitBias(bitmask, vocabSize) {
  const bias = new Uint8Array(vocabSize);
  for (let token = 0; token < vocabSize; token += 1) {
    const byte = bitmask[token >> 3] ?? 0;
    bias[token] = byte & (1 << (token & 7)) ? 200 : 0;
  }
  return bias;
}
