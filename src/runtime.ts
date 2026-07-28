import type {
  EngineModule,
  InterpreterHandle,
  MaskResult,
  TokenizerConfig,
  TokenizerHandle,
} from "./engine/core.ts";
import {
  createHandleRuntime,
  normalizeTokenizerConfig,
  type InterpreterConfig,
  type TokenizerSource,
} from "./runtime-core.ts";
import { extractLLGuidanceTokenizerConfig } from "./tokenizer_bridge.ts";

type Options = Record<string, unknown>;
type GrammarConfig = Options | null | undefined;
type StopReason = "NotStopped" | "NoExtension";
type EngineTokenizer = InstanceType<EngineModule["LLGuidanceTokenizer"]>;
type EngineInterpreter = InstanceType<EngineModule["LLGuidanceInterpreter"]>;

export type LLGuidanceResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: unknown }
  | { type: "regex"; regex: string };

export type LLGuidanceGrammarFormat =
  | "lark"
  | "json_schema"
  | "json"
  | "json_object"
  | "regex"
  | "choice"
  | "llguidance"
  | "guidance";

export interface LLGuidanceInterpreterConfig extends InterpreterConfig {
  response_format?: LLGuidanceResponseFormat;
  responseFormat?: LLGuidanceResponseFormat;
  grammar?: string;
  grammarFormat?: LLGuidanceGrammarFormat;
  grammar_format?: LLGuidanceGrammarFormat;
}

export function createLLGuidanceRuntime(mod: EngineModule) {
  const { createTokenizer, createInterpreter, resolveTokenizer } =
    createHandleRuntime<
      EngineTokenizer,
      EngineInterpreter,
      LLGuidanceInterpreterConfig
    >(mod);

  class LLTokenizer {
    readonly _tokenizer: EngineTokenizer;
    readonly vocab_size: number;
    readonly eos_token: number;
    readonly eos_tokens: number[];
    readonly is_canonical: boolean;

    constructor(
      tokenizer: TokenizerSource | null | undefined,
      options: TokenizerConfig = {},
    ) {
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

    free(): void {
      this._tokenizer.free();
    }

    dispose(): void {
      this.free();
    }
  }

  class LLInterpreter implements InterpreterHandle {
    readonly _tokenizer: EngineTokenizer;
    private readonly _interpreter: EngineInterpreter;
    private _stopped = false;
    private _accepting = false;
    private _stopReason: StopReason = "NotStopped";

    constructor(
      tokenizer: TokenizerSource,
      grammarOrConfig: string | GrammarConfig,
      options: Options = {},
    ) {
      this._tokenizer = resolveTokenizer(tokenizer);
      this._interpreter = new mod.LLGuidanceInterpreter(
        this._tokenizer,
        normalizeInterpreterConfig(grammarOrConfig, options),
      );
    }

    compute_mask(): [Uint8Array | null, string] {
      const result = this._interpreter.computeMask();
      this._stopped = "stop" in result && result.stop;
      this._accepting = this._stopped;
      if (this._stopped) this._stopReason = "NoExtension";
      return [
        "mask" in result ? bitsetToBytes(result.mask) : null,
        JSON.stringify(result),
      ];
    }

    compute_mask_into(target: Uint8Array): string {
      const [mask, info] = this.compute_mask();
      if (mask) target.set(mask.subarray(0, target.length));
      return info;
    }

    commit_token(sampledToken: number | null | undefined): [number, number[]] {
      if (sampledToken == null) return [0, []];
      const result = this._interpreter.commitToken(sampledToken);
      this._stopped = Boolean(result.stop);
      if (this._stopped) this._stopReason = "NoExtension";
      return [result.backtrack ?? 0, result.ffTokens ?? []];
    }

    is_accepting(): boolean {
      return this._accepting;
    }

    stop_reason(): StopReason {
      return this._stopReason;
    }

    has_pending_stop(): boolean {
      return this._stopped;
    }

    computeMask(): MaskResult {
      return this._interpreter.computeMask();
    }

    commitToken(sampledToken: number) {
      return this._interpreter.commitToken(sampledToken);
    }

    free(): void {
      this._interpreter.free();
    }

    dispose(): void {
      this.free();
    }
  }

  class LLMatcher {
    readonly _tokenizer: EngineTokenizer;
    private readonly _grammar: string;
    private readonly _options: Options;
    _interpreter: EngineInterpreter;
    private _error = "";
    private _stopped = false;
    private _accepting = false;
    private _stopReason: StopReason = "NotStopped";

    constructor(
      tokenizer: TokenizerSource,
      grammar: string,
      options: Options = {},
    ) {
      this._tokenizer = resolveTokenizer(tokenizer);
      this._grammar = grammar;
      this._options = options;
      this._interpreter = new mod.LLGuidanceInterpreter(
        this._tokenizer,
        normalizeInterpreterConfig(grammar, options),
      );
    }

    static grammar_from_json_schema(schema: unknown): string {
      return mod.grammarFromJsonSchema(
        typeof schema === "string" ? (JSON.parse(schema) as unknown) : schema,
      );
    }

    static grammar_from_lark(lark: string): string {
      return mod.grammarFromLark(lark);
    }

    static grammar_from_regex(regex: string): string {
      return mod.grammarFromRegex(regex);
    }

    static validate_grammar(
      grammar: string,
      tokenizer: TokenizerSource | null = null,
    ): string {
      if (!tokenizer) return "";
      let matcher: LLMatcher | undefined;
      try {
        matcher = new LLMatcher(tokenizer, grammar);
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        matcher?.free();
      }
    }

    static validate_grammar_with_warnings(
      grammar: string,
      tokenizer: TokenizerSource | null = null,
    ): [boolean, string[]] {
      const message = LLMatcher.validate_grammar(grammar, tokenizer);
      return [Boolean(message), message ? [message] : []];
    }

    compute_bitmask(): Uint8Array {
      const result = this._interpreter.computeMask();
      this._stopped = "stop" in result && result.stop;
      this._accepting = this._stopped;
      return "mask" in result ? bitsetToBytes(result.mask) : new Uint8Array(0);
    }

    compute_logit_bias(): Uint8Array {
      return bitmaskToLogitBias(
        this.compute_bitmask(),
        this._tokenizer.vocabSize(),
      );
    }

    consume_token(sampledToken: number): boolean {
      try {
        const result = this._interpreter.commitToken(sampledToken);
        this._stopped = Boolean(result.stop);
        return true;
      } catch (error) {
        this._error = error instanceof Error ? error.message : String(error);
        return false;
      }
    }

    consume_tokens(sampledTokens: readonly number[]): boolean {
      return sampledTokens.every((token) => this.consume_token(token));
    }

    try_consume_tokens(sampledTokens: readonly number[]): number {
      let consumed = 0;
      for (const token of sampledTokens) {
        if (!this.consume_token(token)) break;
        consumed += 1;
      }
      return consumed;
    }

    validate_tokens(tokens: readonly number[]): number {
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

    is_error(): boolean {
      return this._error !== "";
    }

    get_error(): string {
      return this._error;
    }

    get_grammar_warnings(): string[] {
      return [];
    }

    is_accepting(): boolean {
      return this._accepting;
    }

    is_stopped(): boolean {
      return this._stopped || this.is_error();
    }

    stop_reason(): StopReason {
      return this._stopReason;
    }

    compute_ff_tokens(): number[] {
      this._interpreter.computeMask();
      return [];
    }

    compute_ff_bytes(): Uint8Array {
      return new Uint8Array(0);
    }

    reset(): boolean {
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

    free(): void {
      this._interpreter.free();
    }

    dispose(): void {
      this.free();
    }

    rollback(): never {
      throw new Error(
        "LLMatcher.rollback() is not implemented in the TypeScript core backend yet",
      );
    }

    deep_copy(): never {
      throw new Error(
        "LLMatcher.deep_copy() is not implemented in the TypeScript core backend yet",
      );
    }

    get_capture(): null {
      return null;
    }

    get_captures(): never[] {
      return [];
    }
  }

  class JsonCompiler {
    readonly options: Options;

    constructor(options: Options = {}) {
      this.options = options;
    }

    compile(schema: unknown): string {
      return LLMatcher.grammar_from_json_schema(schema);
    }
  }

  class LarkCompiler {
    compile(lark: string): string {
      return LLMatcher.grammar_from_lark(lark);
    }
  }

  class RegexCompiler {
    compile(regex: string): string {
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
    grammar_from(format: LLGuidanceGrammarFormat, text: unknown): string {
      return mod.grammarFrom(
        format,
        typeof text === "string" ? text : JSON.stringify(text),
      );
    },
    grammarFrom(format: LLGuidanceGrammarFormat, text: unknown): string {
      return mod.grammarFrom(
        format,
        typeof text === "string" ? text : JSON.stringify(text),
      );
    },
    regex_to_lark(regex: unknown): string {
      return String(regex).replaceAll("/", "\\/");
    },
    get_version(): string {
      return "llguidance-ts-core";
    },
    createTokenizer,
    createInterpreter,
  };
}

export type LLGuidanceRuntime = ReturnType<typeof createLLGuidanceRuntime>;

function normalizeInterpreterConfig(
  grammarOrConfig: string | GrammarConfig,
  options: Options = {},
): Options {
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

function isPlainTokenizerConfig(
  value: TokenizerSource | null | undefined,
): value is TokenizerConfig | null | undefined {
  if (value == null) return true;
  if (typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (value.constructor === Object && Object.keys(value).length === 0) ||
    Boolean(
      candidate.tokens ||
      candidate.eos_token_id != null ||
      candidate.eosTokenId != null,
    )
  );
}

function bitsetToBytes(mask: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(mask.byteLength);
  bytes.set(new Uint8Array(mask.buffer, mask.byteOffset, mask.byteLength));
  return bytes;
}

function bitmaskToLogitBias(
  bitmask: Uint8Array,
  vocabSize: number,
): Uint8Array {
  const bias = new Uint8Array(vocabSize);
  for (let token = 0; token < vocabSize; token += 1) {
    const byte = bitmask[token >> 3] ?? 0;
    bias[token] = byte & (1 << (token & 7)) ? 200 : 0;
  }
  return bias;
}
